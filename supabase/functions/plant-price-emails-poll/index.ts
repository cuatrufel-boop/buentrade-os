// The real email-ingestion pipeline: reads recent mail in purchasing@buentradegroup.com, matches
// each message's sender to a known plant, splits the body into lines, and detects items two ways
// (see _shared/priceListLine.ts, both ported faithfully from Load Prices, same order it already
// uses — block-format checked first): single-line "name + $price" (form #1), or block-format
// (Seaboard-style: name-line(s) then a price PER price column below — last column = Delivered,
// so freight_included is set and Quotes never double-charges freight on top of it). The
// single-line scan folds each item's section header into its raw_text ("Frozen Boxed Muscles —
// Bone in Loins" vs "Fresh Boxed Muscles — Bone in Loins") — confirmed real necessity against an
// actual Tyson list, where the same item name appears under both a Fresh and a Frozen header at
// different prices with no other signal to tell them apart; without this, the catalog matcher has
// no way to avoid confusing the two (or worse, silently applying to whichever one has an existing
// alias). A real .xlsx attachment is a third, separate source (see extractXlsxItems below) —
// currently scoped to Wholestone Prestage's real "Freezer List" column layout, not generic. Any
// other real shape (casual short lines, prose sentences with multiple items, an HTML table
// embedded in the body with no plain-text equivalent — confirmed real for Wholestone's own
// "fresh" offers) is deliberately NOT handled yet — skipped, never guessed.
//   - a confident catalog match applies straight to plant_products via the exact same logic Load
//     Prices already uses (_shared/applyPlantProductMatch.ts — also still the real, unchanged HTTP
//     endpoint plant-products-apply-match wraps), including the plant's own docs_included default
//     — never a second copy of that write logic.
//   - an unsure match becomes a plant_pending_matches row for a human to resolve once (see
//     _shared/pendingMatch.ts) — never auto-applied, never guessed.
// plant_price_emails_processed makes every run idempotent — a message already seen is skipped, so
// re-polling never re-applies or re-queues the same line twice. A message from an address that
// doesn't match any plant's email is recorded (so it isn't invisible) but nothing is guessed from
// it — no plant, no safe place to apply anything.
//
// Matching/applying/queuing all run IN-PROCESS now (see the three _shared/ imports below), sharing
// this function's own single Postgres connection — not one HTTP call (and one fresh connection)
// per line via the sibling Edge Functions. Real fix, not premature optimization: a real 51-item
// Tyson list opened ~100 fresh connections in quick succession the old way and hit a genuine rate
// limit partway through. The sibling Edge Functions (products-match-from-plant-text,
// plant-products-apply-match, plant-pending-matches-create) still exist, unchanged in external
// behavior, for Load Prices and anything else that calls them over HTTP.

import postgres from "npm:postgres@3.4.4";
import * as XLSX from "npm:xlsx@0.18.5";
import { jsonResponse, normalize } from "../_shared/matching.ts";
import { detectBlockFormatItems, isSectionHeaderLine, looksLikeBlockFormat, looksLikeContactLine, parsePriceListLineBasic } from "../_shared/priceListLine.ts";
import { matchProductFromPlantText } from "../_shared/productMatcher.ts";
import { applyPlantProductMatch } from "../_shared/applyPlantProductMatch.ts";
import { createPendingMatch } from "../_shared/pendingMatch.ts";
import { extractItemsFromImage, extractItemsWithLLM, LLMUnavailableError } from "../_shared/llmExtractor.ts";
import {
  asTransactionDb, extractHtml, extractPlainText, getGmailAccessToken, headerValue, isAutoReply, isBulletinEmail, isOwnNotification, recordUnrecognizedSender,
  resolveSender, senderAddress, type PlantRef,
} from "../_shared/mailIntake.ts";
import { describeReason } from "../_shared/pendingReasons.ts";
import { routeDropsToPending } from "../_shared/routeDrops.ts";

// Wholestone Prestage-specific: their frozen list arrives as a real .xlsx attachment (columns
// WHS/CATEGORY/CODE/DESC/CASES/LBS/PRICE/Avg Age, confirmed against a real "Freezer List" file) —
// nothing about this is generic to every plant yet, this is the first real attachment-reading
// case, scoped narrowly rather than guessed at for plants that don't do this.
// Every priced row of the sheet is read (2026-09-25, explicit: "debe subir todos los precios de ese excel"). An earlier
// rule dropped any row under 40,000 lb — those rows were silently lost, never even queued; that rule is gone. A row the
// catalog can't confidently match still becomes a pending match for a person, exactly like any other plant's line —
// nothing in the sheet is discarded.

// Real, explicit rule: "no puede leer data vieja" — a plant's price is only good as of the date
// they sent it, and this changes fast: some plants (Seaboard) send daily, prices move within the
// same week (Mondays often price higher as the market resets), and different plants update on
// different real cadences (confirmed by the user, describing the system's rule in general — not
// one plant's behavior). 3 days is the system-wide default. An email older than this is skipped,
// never applied and never even queued to pending — there's nothing to review, it's simply too
// stale to act on. test_message_id bypasses this on purpose (verifying against a real but old
// email is exactly what testing needs) — only the real recency scan enforces it.
const MAX_EMAIL_AGE_DAYS = 3;

// A plant's facilities are DATA: its own locations (plant_locations → the locations catalog, "City, ST") plus any code it prints for them that a
// person taught (plant_term_aliases, meaning type 'location', e.g. "EG" = Eagle Grove). Nothing about one plant lives in this file.
async function loadFacilityMap(db: any, plantId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const own = await db`select l.city, l.state from plant_locations pl join locations l on l.id = pl.location_id where pl.plant_id = ${plantId}`;
  for (const r of own) map.set(String(r.city).trim().toLowerCase(), `${String(r.city).trim()}, ${r.state}`);
  const taught = await db`select t.term, l.city, l.state from plant_term_aliases t join locations l on l.id = t.meaning_id where t.plant_id = ${plantId} and t.meaning_type = 'location'`;
  for (const r of taught) map.set(String(r.term).trim().toLowerCase(), `${String(r.city).trim()}, ${r.state}`);
  return map;
}

// Cut styles the catalog has no product for read close enough to a real product that the matcher would attach them to it — a price on the WRONG
// product. Their words are rows in intake_review_terms (global, or one plant's); a line carrying one always waits for a person.
async function loadReviewPattern(db: any, plantId: string): Promise<RegExp | null> {
  const rows = await db`select pattern from intake_review_terms where plant_id is null or plant_id = ${plantId}`;
  const patterns = rows.map((r: any) => String(r.pattern)).filter(Boolean);
  return patterns.length ? new RegExp(patterns.join("|"), "i") : null;
}

// Temperature is read from the whole email the way a person reads it: the attachment's file name and the subject first, then the
// body ("frozen product offerings"). It only counts when exactly one of frozen / fresh is named; naming both (or neither) says nothing.
const FROZEN_CTX = /\b(freez\w*|frozen|congelad\w*)\b/i;
const FRESH_CTX = /\b(fresh|fresco\w*|chilled)\b/i;
function temperatureFromContext(...sources: string[]): "Frozen" | "Fresh" | null {
  for (const src of sources) {
    const f = FROZEN_CTX.test(src), c = FRESH_CTX.test(src);
    if (f !== c) return f ? "Frozen" : "Fresh";
  }
  return null;
}

type XlsxItem = { rawText: string; price: number; freightIncluded: boolean; locationName: string | null; needsReview?: boolean };

async function extractXlsxItems(
  payload: any, msgId: string, authHeaders: Record<string, string>, subject: string, bodyText: string,
  facilities: Map<string, string>, reviewPattern: RegExp | null,
): Promise<{ items: XlsxItem[]; dropped: Dropped[] }> {
  const dropped: Dropped[] = [];
  const findXlsxParts = (p: any): any[] => {
    const out: any[] = [];
    if (p.filename && p.filename.toLowerCase().endsWith(".xlsx") && p.body?.attachmentId) out.push(p);
    for (const part of p.parts || []) out.push(...findXlsxParts(part));
    return out;
  };
  const [part, ...extraFiles] = findXlsxParts(payload);
  if (!part) return { items: [], dropped };
  // Only the first spreadsheet is read today; every other one is recorded so it is never invisible.
  for (const x of extraFiles) dropped.push({ source: "xlsx", rawText: x.filename, price: null, reasonCode: "xlsx_extra_file", reasonDetail: "only the first .xlsx of a message is read" });

  const attRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${part.body.attachmentId}`,
    { headers: authHeaders },
  );
  const attData = await attRes.json();
  if (!attRes.ok || !attData.data) {
    dropped.push({ source: "xlsx", rawText: part.filename, price: null, reasonCode: "xlsx_fetch_failed", reasonDetail: `Gmail answered ${attRes.status}` });
    return { items: [], dropped };
  }
  const b64 = attData.data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  let wb: any;
  try { wb = XLSX.read(bytes, { type: "array" }); }
  catch (e) {
    dropped.push({ source: "xlsx", rawText: part.filename, price: null, reasonCode: "xlsx_unreadable", reasonDetail: String(e).slice(0, 300) });
    return { items: [], dropped };
  }
  // Sheets after the first are not read yet — recorded with how many rows they hold.
  for (const name of wb.SheetNames.slice(1)) {
    const n = (XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 }) as any[][]).filter((r) => r.some((c) => String(c ?? "").trim() !== "")).length;
    if (n) dropped.push({ source: "xlsx", rawText: `${part.filename} / ${name}`, price: null, reasonCode: "xlsx_extra_sheet", reasonDetail: `${n} row(s) on a sheet that is not read` });
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  if (!rows.length) {
    dropped.push({ source: "xlsx", rawText: part.filename, price: null, reasonCode: "xlsx_empty_sheet", reasonDetail: "the first sheet has no rows" });
    return { items: [], dropped };
  }

  const header = rows[0].map((h: any) => String(h || "").trim().toUpperCase());
  const col = (name: string) => header.indexOf(name);
  const whsCol = col("WHS"), descCol = col("DESC"), priceCol = col("PRICE");
  if (descCol === -1 || priceCol === -1) {
    dropped.push({ source: "xlsx", rawText: part.filename, price: null, reasonCode: "xlsx_layout_not_recognized", reasonDetail: `no DESC/PRICE columns; header row: ${header.filter(Boolean).join(" | ").slice(0, 200)}` });
    return { items: [], dropped };
  }

  const items: XlsxItem[] = [];
  // One source at a time, strongest first: the attachment's own file name ("Freezer List …"), then the subject, then the body. They used
  // to be glued into ONE string (file name + subject), so a subject naming both ("WP Fresh & Frozen Offers") cancelled the file name's
  // clear "Freezer" signal → the lines lost their "Frozen —" prefix and the matcher saw 2–6 candidates per line instead of 0–1
  // (Wholestone, Sept 30: 44 lines went to Pending).
  const listTemp = temperatureFromContext(part.filename || "", subject, bodyText);
  const unknownFacilities = new Set<string>();
  for (const [i, row] of rows.slice(1).entries()) {
    const price = Number(row[priceCol]);
    const priceCell = String(row[priceCol] ?? "").trim();
    const desc = String(row[descCol] || "").trim();
    const priceOk = Number.isFinite(price) && price > 0;
    if (!desc && !priceCell) continue; // an empty row is not a candidate
    if (!desc) {
      dropped.push({ source: "xlsx", rawText: `${part.filename} row ${i + 2}`, price: priceOk ? price : null, reasonCode: "xlsx_row_no_description", reasonDetail: `price cell "${priceCell}" with no description` });
      continue;
    }
    // The email says what temperature the list is (file name, subject, body). Without stating it the catalog matcher was free to
    // pick a Fresh product for a line that names no temperature (a frozen sparerib price landed on Fresh Spareribs).
    const rawText = listTemp ? `${listTemp} — ${desc}` : desc;
    if (!priceOk) {
      dropped.push({ source: "xlsx", rawText, price: null, reasonCode: "xlsx_row_no_price", reasonDetail: `price cell "${priceCell}"` });
      continue;
    }
    const whs = whsCol !== -1 ? String(row[whsCol] || "").trim() : "";
    const facility = whs ? facilities.get(whs.toLowerCase()) : undefined;
    if (whs && !facility) unknownFacilities.add(whs);
    items.push({
      rawText, price,
      needsReview: reviewPattern ? reviewPattern.test(desc) : false,
      freightIncluded: false, // FOB per this plant's own stated terms — never assumed for others
      locationName: facility ?? null,
    });
  }
  // A facility the plant printed that is none of its known locations: the prices were still applied, only the pickup city is unknown — recorded.
  for (const name of unknownFacilities) dropped.push({ source: "xlsx", rawText: `Facility "${name}"`, price: null, reasonCode: "facility_not_recognized", reasonDetail: name });
  return { items, dropped };
}

// A real, confirmed shape (Wholestone's own "fresh offers"): the price list isn't text or an HTML
// table, it's a picture embedded in the body — a small logo is usually embedded too, so every
// inline image is sent through vision extraction rather than guessing which one is the real list;
// an image with no product rows (the logo) just costs one extra Anthropic call and returns nothing.
// Not Wholestone-specific by design: emailContext (the same plain-text body every other extractor
// already reads) goes along with every image so the model can pick up the same kind of "this whole
// picture is our fresh offers, the attachment is frozen" framing text ANY plant might use — not
// just Wholestone's.
async function extractImageItems(
  payload: any, msgId: string, authHeaders: Record<string, string>, emailContext: string, defaultTemp: "Fresh" | "Frozen" | null = null,
  facilities: Map<string, string> = new Map(),
): Promise<{ items: { rawText: string; price: number; freightIncluded: boolean; locationName: string | null }[]; dropped: Dropped[] }> {
  const findImageParts = (p: any): any[] => {
    const out: any[] = [];
    if (p.mimeType?.startsWith("image/") && p.body?.attachmentId) out.push(p);
    for (const part of p.parts || []) out.push(...findImageParts(part));
    return out;
  };
  const parts = findImageParts(payload);
  const items: { rawText: string; price: number; freightIncluded: boolean; locationName: string | null }[] = [];
  const dropped: Dropped[] = [];
  const unknownFacilities = new Set<string>();
  for (const part of parts) {
    const imageName = part.filename || "inline image";
    let b64: string;
    try {
      const attRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${part.body.attachmentId}`,
        { headers: authHeaders },
      );
      const attData = await attRes.json();
      if (!attRes.ok || !attData.data) {
        dropped.push({ source: "image", rawText: imageName, price: null, reasonCode: "image_fetch_failed", reasonDetail: `Gmail answered ${attRes.status}` });
        continue;
      }
      b64 = (attData.data as string).replace(/-/g, "+").replace(/_/g, "/");
    } catch (e) {
      dropped.push({ source: "image", rawText: imageName, price: null, reasonCode: "image_fetch_failed", reasonDetail: String(e).slice(0, 300) });
      continue;
    }
    let extracted;
    try {
      extracted = await extractItemsFromImage(b64, part.mimeType, emailContext);
    } catch (e) {
      if (e instanceof LLMUnavailableError) throw e; // the AI service is down: the whole message waits and is read again, never half-read
      // One image failing never blocks the others — but it is recorded, never ignored.
      dropped.push({ source: "image", rawText: imageName, price: null, reasonCode: "image_unreadable", reasonDetail: String(e).slice(0, 300) });
      continue;
    }
    for (const it of extracted) {
      // Real gap, caught live: the grid image itself never printed the word "Fresh" anywhere (no
      // per-row temperature column) — only the surrounding email prose said so. Without folding
      // that in, the deterministic matcher had no temperature signal at all and returned every
      // temp/pack combination of a name as a candidate. extractItemsFromImage now reads the same
      // email body every other extractor sees and resolves temperature from it when the image
      // itself doesn't state one — same idea as the text path's section-header folding, general to
      // any plant's wording, not hardcoded to Wholestone's.
      // The email's own words did not say (it named both "fresh and frozen"): the structure still does — when the same email
      // attaches the FROZEN list (the file is called "Freezer List"), the unlabeled picture is the fresh one. Never overrides a
      // temperature the image or the text did state.
      const temp = it.temperature !== "Unknown" ? it.temperature : defaultTemp;
      const rawText = temp ? `${temp} — ${it.item} ${it.packStyle}` : `${it.item} ${it.packStyle}`;
      if (it.isFormula) { // never guess a formula's value — recorded so it reaches the review queue
        dropped.push({ source: "image", rawText: rawText.trim(), price: null, reasonCode: "formula_in_image", reasonDetail: "the price cell is a formula, not a number" });
        continue;
      }
      if (it.price == null || !Number.isFinite(it.price) || it.price <= 0) {
        dropped.push({ source: "image", rawText: rawText.trim(), price: null, reasonCode: "image_row_no_price", reasonDetail: "no usable price in this row" });
        continue;
      }
      // City = the facility whose own sub-row carries the load count (the "1" under a date), the way a person reads the grid
      // ("1 carga fob Fremont"). When the picture shows no load on any sub-row, the only facility printed is used; if loads sit on
      // several, or nothing says, the city stays empty rather than guessed.
      // Every printed facility is looked up in the plant's own data; one nobody taught is recorded and never guessed. When the picture shows
      // loads on specific facilities those decide the city; with no loads shown, the only facility printed does. Any unknown name in the
      // deciding set leaves the city empty — it never falls through to some other facility.
      const resolveFacilities = (arr: string[] | undefined) => {
        const known: string[] = [];
        let unknown = 0;
        for (const f of arr || []) {
          const name = f.trim();
          if (!name) continue;
          const loc = facilities.get(name.toLowerCase());
          if (loc) known.push(loc); else { unknown++; unknownFacilities.add(name); }
        }
        return { known: [...new Set(known)], unknown };
      };
      const withLoads = resolveFacilities(it.facilitiesWithLoads);
      const printed = resolveFacilities(it.facilities);
      const deciding = (it.facilitiesWithLoads || []).some((f: string) => f.trim()) ? withLoads : printed;
      const city = deciding.known.length === 1 && deciding.unknown === 0 ? deciding.known[0] : null;
      items.push({
        rawText: rawText.trim(), price: it.price,
        freightIncluded: false, // FOB per this plant's own stated terms — never assumed for others
        locationName: city,
      });
    }
  }
  for (const name of unknownFacilities) dropped.push({ source: "image", rawText: `Facility "${name}"`, price: null, reasonCode: "facility_not_recognized", reasonDetail: name });
  return { items, dropped };
}

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const EMAIL_AUTOMATION_ACTOR = "email-automation@buentradegroup.com";
// Real addition, explicit ask: "avisa a todos los trader ahora solo a mi" — comma-separated so
// this already supports more than one trader the moment there's more than one to notify, without
// another code change; today it's just the one address. No new secret/service needed for this —
// Resend lives only in Netlify (currently suspended, see the project's own standing note), so this
// reuses the SAME Gmail OAuth credentials this function already holds to read plant mail, now also
// used to send from purchasing@buentradegroup.com — one already-authenticated account, one less
// external dependency.
// Same push-send call shape as pickup-docs-emails-poll/shipment-alerts-poll (isolated runtimes, no shared import).
// Opens Quotes on Find Product with that product picked (quotes.html reads ?products=).
const API_ROOT = "https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/";
const API_KEY = Deno.env.get("API_PUBLISHABLE_KEY") || "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe";
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") || "";
async function sendSheetPush(actor: string, title: string, body: string, productId: string) {
  const url = `${APP_ORIGIN}/quotes.html?products=${productId}`;
  await fetch(API_ROOT + "push-send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY, apikey: API_KEY },
    body: JSON.stringify({ actor, title, body, url }),
  }).catch(() => {});
}
const TRADER_NOTIFICATION_EMAILS = (Deno.env.get("TRADER_NOTIFICATION_EMAILS") || "").split(",").map((s) => s.trim()).filter(Boolean);

// ---- Control ledger (plant_price_email_lines): every candidate a reader SEES ends with an outcome and a reason.
// 'dropped' = seen and put nowhere — the leak the system must never have (see the table's migration).
type LedgerSource = "body" | "xlsx" | "image" | "attachment" | "declined";
type LedgerOutcome = "applied" | "pending" | "declined" | "dropped" | "dismissed";
type LedgerRow = {
  source: LedgerSource; rawText: string; price: number | null; outcome: LedgerOutcome;
  reasonCode: string | null; reasonDetail: string | null; pendingMatchId?: string | null; extra?: Record<string, unknown>;
};
type Dropped = { source: LedgerSource; rawText: string; price: number | null; reasonCode: string; reasonDetail?: string };

function pendingReason(matchRes: any): { code: string; detail: string } {
  if (matchRes.matched) return { code: "needs_review_cut_style", detail: "this cut style has no exact catalog product, so a person confirms it" };
  const n = (matchRes.candidates || []).length;
  if (n === 0) return { code: "no_catalog_candidate", detail: "no catalog product matches this text for this plant" };
  if (matchRes.conflicted) return { code: "candidates_conflict_with_line", detail: `${n} candidate(s), none fully agrees with what the line says` };
  return { code: "multiple_candidates", detail: `${n} possible catalog product(s)` };
}

async function saveLedger(db: any, messageId: string, plantId: string, rows: LedgerRow[]) {
  if (!rows.length) return;
  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const line_key = `${r.source}|${r.reasonCode ?? ""}|${normalize(r.rawText)}`;
    byKey.set(line_key, {
      message_id: messageId, plant_id: plantId, source: r.source, line_key, raw_text: r.rawText,
      detected_price: r.price, outcome: r.outcome, reason_code: r.reasonCode, reason_detail: r.reasonDetail,
      pending_match_id: r.pendingMatchId ?? null,
    });
  }
  await db`
    insert into plant_price_email_lines ${db([...byKey.values()], "message_id", "plant_id", "source", "line_key", "raw_text", "detected_price", "outcome", "reason_code", "reason_detail", "pending_match_id")}
    on conflict (message_id, line_key) do update set
      outcome = excluded.outcome, reason_code = excluded.reason_code, reason_detail = excluded.reason_detail,
      detected_price = excluded.detected_price, pending_match_id = excluded.pending_match_id, updated_at = now()
  `;
}

// Files in the message that no reader opens (PDF, Word, CSV...) — each is a candidate that is recorded, never ignored.
function listUnreadAttachments(payload: any): Dropped[] {
  const out: Dropped[] = [];
  const walk = (p: any) => {
    const name = (p.filename || "") as string;
    if (name && p.body?.attachmentId && !p.mimeType?.startsWith("image/") && !name.toLowerCase().endsWith(".xlsx")) {
      out.push({ source: "attachment", rawText: name, price: null, reasonCode: "attachment_type_not_read", reasonDetail: p.mimeType || "unknown type" });
    }
    for (const c of p.parts || []) walk(c);
  };
  walk(payload);
  return out;
}

// Real addition, explicit ask: "el sistema debería avisarle con un correo que ya están
// actualizados los precios que faltaban." One notification per plant per email processed (not one
// per line item, not a giant cross-plant digest) — matches how the poll itself already runs, one
// plant's price list at a time. Uses the same Gmail account/token this function already
// authenticates as to READ mail (see getAccessToken above) to also SEND this one — no new
// credential, no external service dependency.
function buildGmailRawMessage(to: string, subject: string, body: string): string {
  const raw = `To: ${to}\r\nFrom: purchasing@buentradegroup.com\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sendGmailNotification(authHeaders: Record<string, string>, to: string, subject: string, body: string): Promise<void> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: buildGmailRawMessage(to, subject, body) }),
  });
  if (!res.ok) throw new Error(`Gmail send failed: ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const db: any = sql;
    const body = await req.json().catch(() => ({}));
    const maxResults = body.max_results || 20;
    const debugMessageId = body.debug_message_id || null;
    // Verification aid: process one specific message by id, regardless of how far back it is in
    // the inbox — the normal recency scan would need a huge (slow) maxResults to reach an old real
    // test email. Goes through the real apply/pending pipeline exactly like any other message.
    const testMessageId = body.test_message_id || null;
    // dry_run: the whole pipeline runs (every reader, the catalog matcher) but NOTHING is written or sent — no price, no Pending row,
    // no processed mark, no ledger row, no email or push. The answer lists what each candidate WOULD become. Use it with
    // test_message_id to check a real message before (or after) any change, instead of re-running it live.
    const dryRun = body.dry_run === true;
    // execute_rollback: runs the REAL write path (apply price, Pending rows, ledger, processed mark) for a test_message_id inside one
    // database transaction that is always rolled back — proves the writes work on the live schema and leaves no trace. Nothing is
    // sent (no email, no push) and nothing is kept.
    const rollbackMode = body.execute_rollback === true && !!testMessageId && !dryRun;
    // Verification aid only, never touches the real pipeline/DB: sends one real test email through
    // the same Gmail send path the trader-notification feature uses, so its OAuth scope (send, not
    // just read) can be confirmed live without waiting for a genuine "price someone was waiting on
    // just arrived" moment to happen naturally.
    const testNotificationEmail = body.test_notification_email || null;
    // Diagnostic aid, real incident 2026-09-10: "hoy llego seaboard no lo leyo" — the normal
    // recency scan only ever proves an email isn't in the most recent N; it can't prove an email
    // was never delivered to this mailbox at all, or landed somewhere the default list call
    // doesn't reach (e.g. a Gmail filter that skips the inbox but doesn't touch Spam/Trash either
    // still shows up here, but one applied here AND labeled Spam/Trash would not). Read-only,
    // never touches the apply/pending pipeline — just answers "does a message matching this Gmail
    // search exist in this mailbox, and who was it actually addressed to."
    const searchQuery = body.search_query || null;

    const accessToken = await getGmailAccessToken();
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    if (testNotificationEmail) {
      try {
        await sendGmailNotification(authHeaders, testNotificationEmail, "BuenTrade — test notification", "This is a test of the plant-price-emails-poll notification path. If you got this, the Gmail send scope works.");
        return jsonResponse({ test_notification: "sent", to: testNotificationEmail });
      } catch (e) {
        return jsonResponse({ test_notification: "failed", error: String(e) }, 500);
      }
    }

    // Verification aid only: writes two synthetic rows into the control ledger through the normal connection (insert, then upsert to
    // another outcome), reads them back through the reconciliation view, and always deletes them. Touches no price, product or message.
    if (body.ledger_selftest === true) {
      const [aPlant] = await sql`select id from plants limit 1`;
      const mid = `SELFTEST-${crypto.randomUUID()}`;
      try {
        await saveLedger(sql, mid, aPlant.id, [
          { source: "body", rawText: "selftest line A", price: 1.5, outcome: "dropped", reasonCode: "selftest", reasonDetail: "first write" },
          { source: "xlsx", rawText: "selftest line B", price: null, outcome: "pending", reasonCode: "selftest", reasonDetail: null },
        ]);
        await saveLedger(sql, mid, aPlant.id, [{ source: "body", rawText: "selftest line A", price: 1.5, outcome: "applied", reasonCode: "selftest", reasonDetail: "upsert" }]);
        const [rec] = await sql`select candidates, applied, pending, declined, dropped from plant_price_email_reconciliation where message_id = ${mid}`;
        const rows = await sql`select source, outcome, reason_detail from plant_price_email_lines where message_id = ${mid} order by source`;
        return jsonResponse({ ledger_selftest: "ok", reconciliation: rec, rows });
      } catch (e) {
        return jsonResponse({ ledger_selftest: "failed", error: String(e) }, 500);
      } finally {
        await sql`delete from plant_price_email_lines where message_id = ${mid}`;
      }
    }

    // Verification aid only: routes one made-up candidate of EVERY reason code into Pending Matches for a real plant, through the real
    // routing code, inside a transaction that is always rolled back; also proves a dismissed unread file is remembered. Keeps nothing.
    if (body.route_selftest === true) {
      class Roll extends Error {}
      let proof: unknown = null;
      try {
        await sql.begin(async (tx: any) => {
          const txdb = asTransactionDb(tx);
          const [aPlant] = await txdb`select id from plants where name ilike '%smithfield%' limit 1`;
          const mk = (reasonCode: string, rawText: string, price: number | null, detail: string | null, source: LedgerSource = "body"): LedgerRow =>
            ({ source, rawText, price, outcome: "dropped", reasonCode, reasonDetail: detail });
          const rows: LedgerRow[] = [
            mk("text_no_price_stated", "Frozen — Boxed 72% Ham trim", null, "Check with Nora"),
            mk("text_not_available", "Frozen — Ham Ends", null, "N/A"),
            mk("text_formula", "Fresh — Skinless Bellies", null, "DPS*1.2+0.12"),
            mk("text_price_without_product", "$1.45", 1.45, null),
            mk("xlsx_row_no_price", "Frozen — Pork Spareribs no price row", null, 'price cell ""', "xlsx"),
            mk("xlsx_row_no_description", "Freezer List.xlsx row 5", 1.25, 'price cell "1.25" with no description', "xlsx"),
            mk("formula_in_image", "Fresh — SKNLS BELLY CBO", null, null, "image"),
            mk("image_row_no_price", "Fresh — BELLY CBO", null, null, "image"),
            mk("match_error", "Frozen — Pork Loin Backrib", 0.85, "boom"),
            mk("attachment_type_not_read", "CPU POLICY 2026.pdf", null, "application/pdf", "attachment"),
            mk("xlsx_extra_file", "second.xlsx", null, null, "xlsx"),
            mk("xlsx_extra_sheet", "Freezer List.xlsx / Extra", null, "5 row(s) on a sheet that is not read", "xlsx"),
            mk("xlsx_layout_not_recognized", "odd.xlsx", null, "no DESC/PRICE columns", "xlsx"),
            mk("xlsx_unreadable", "bad.xlsx", null, "zip error", "xlsx"),
            mk("xlsx_empty_sheet", "empty.xlsx", null, null, "xlsx"),
            mk("xlsx_fetch_failed", "gone.xlsx", null, "Gmail answered 500", "xlsx"),
            mk("image_fetch_failed", "pic.png", null, "Gmail answered 500", "image"),
            mk("image_unreadable", "pic2.png", null, "Your credit balance is too low", "image"),
            mk("llm_extraction_failed", "WP offers", null, "answer cut off"),
            mk("message_without_candidates", "Hello from the plant", null, null),
            mk("pending_error", "cannot be queued", null, "x"),
          ];
          const errors = await routeDropsToPending(txdb, HMAC_SECRET, EMAIL_AUTOMATION_ACTOR, { plantId: aPlant.id, messageId: "SELFTEST-ROUTE", rows, dryRun: false });
          const ids = rows.map((r) => r.pendingMatchId).filter(Boolean);
          const stored = ids.length ? await txdb`select raw_text, signal_type, detected_price, reason_code, reason_detail, source, jsonb_array_length(candidate_product_ids) as candidates from plant_pending_matches where id = any(${ids}::uuid[]) order by raw_text` : [];
          // A person dismisses the unread PDF; the same file arriving in another email must be remembered, not queued again.
          const pdf = rows.find((r) => r.reasonCode === "attachment_type_not_read")!;
          await txdb`update plant_pending_matches set resolved_at = now(), resolved_by = 'selftest', resolved_product_id = null where id = ${pdf.pendingMatchId}`;
          const again = [mk("attachment_type_not_read", "cpu policy 2026.pdf", null, "application/pdf", "attachment")];
          const errors2 = await routeDropsToPending(txdb, HMAC_SECRET, EMAIL_AUTOMATION_ACTOR, { plantId: aPlant.id, messageId: "SELFTEST-ROUTE-2", rows: again, dryRun: false });
          proof = {
            routed: rows.map((r) => ({ code: r.reasonCode, outcome: r.outcome, pending: !!r.pendingMatchId })),
            errors, stored,
            dismissal_remembered: { outcome: again[0].outcome, detail: again[0].reasonDetail, errors: errors2 },
          };
          throw new Roll();
        });
      } catch (e) {
        if (!(e instanceof Roll)) return jsonResponse({ route_selftest: "failed", error: String(e) }, 500);
      }
      return jsonResponse({ route_selftest: "ok", rolled_back: true, proof });
    }

    if (searchQuery) {
      const searchRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(searchQuery)}&maxResults=10`, { headers: authHeaders });
      const searchData = await searchRes.json();
      if (!searchRes.ok) return jsonResponse({ search_failed: true, error: searchData }, 500);
      const found = [];
      for (const m of searchData.messages || []) {
        const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, { headers: authHeaders });
        const msgData = await msgRes.json();
        const h = (name: string) => headerValue(msgData.payload?.headers || [], name);
        found.push({ id: m.id, from: h("From"), to: h("To"), subject: h("Subject"), date: h("Date"), labelIds: msgData.labelIds });
      }
      return jsonResponse({ search_query: searchQuery, total_found: searchData.resultSizeEstimate ?? found.length, messages: found });
    }

    let listData: { messages?: { id: string }[] };
    if (testMessageId) {
      listData = { messages: [{ id: testMessageId }] };
    } else {
      const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`, { headers: authHeaders });
      listData = await listRes.json();
      if (!listRes.ok) throw new Error(`Gmail list failed: ${JSON.stringify(listData)}`);
    }

    const [{ id: usdCurrencyId }] = await db`select id from currencies where code = 'USD'`;
    const today = new Date().toISOString().slice(0, 10);

    // A message handled by the read-only diagnostic (debug_message_id) answers with its own Response; everything else returns the list.
    const runMessages = async (db: any): Promise<any[] | Response> => {
    const results: any[] = [];
    for (const m of listData.messages || []) {
      const [already] = await db`select message_id from plant_price_emails_processed where message_id = ${m.id}`;
      if (already && debugMessageId !== m.id && !((dryRun || rollbackMode) && testMessageId)) { results.push({ id: m.id, skipped: "already_processed" }); continue; } // the read-only diagnostic may re-read a processed message

      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: authHeaders });
      const msgData = await msgRes.json();
      if (!msgRes.ok) { results.push({ id: m.id, skipped: "gmail_fetch_failed" }); continue; }

      // A price is only as fresh as the email that carried it. Normal cron runs only see emails younger than
      // MAX_EMAIL_AGE_DAYS, so "today" is right; when an OLDER message is deliberately re-run (test_message_id — e.g. a list
      // that was only partly read the first time) its own date is used, so the stale-price rules still see how old it is.
      const messagePriceDate = testMessageId && msgData.internalDate ? new Date(Number(msgData.internalDate)).toISOString().slice(0, 10) : today;
      if (!testMessageId && msgData.internalDate) {
        const ageDays = (Date.now() - Number(msgData.internalDate)) / 86400000;
        if (ageDays > MAX_EMAIL_AGE_DAYS) {
          if (!dryRun) await db`insert into plant_price_emails_processed (message_id, subject) values (${m.id}, ${headerValue(msgData.payload.headers, "Subject")}) on conflict (message_id) do nothing`;
          results.push({ id: m.id, skipped: "too_old", age_days: Math.round(ageDays) });
          continue;
        }
      }

      const fromHeader = headerValue(msgData.payload.headers, "From");
      const subject = headerValue(msgData.payload.headers, "Subject");
      const fromEmail = senderAddress(fromHeader);

      // The system's own mails to the trader are never a plant's message (a real loop happened: apply → notify → the notice read as a
      // submission → apply …, and shipment alerts carrying "Tyson" were read as Tyson price emails). Skipped before any plant matching.
      if (isOwnNotification(subject)) {
        if (!dryRun) await db`insert into plant_price_emails_processed (message_id, from_email, subject) values (${m.id}, ${fromEmail}, ${subject}) on conflict (message_id) do nothing`;
        results.push({ id: m.id, skipped: "self_notification_email" });
        continue;
      }

      // The bi-weekly market bulletin (PDF) belongs to Market Flash's own reader; classified here, never treated as an unknown sender.
      if (isBulletinEmail(subject, msgData.payload)) {
        if (!dryRun) await db`insert into plant_price_emails_processed (message_id, from_email, subject) values (${m.id}, ${fromEmail}, ${subject}) on conflict (message_id) do nothing`;
        results.push({ id: m.id, skipped: "market_flash_bulletin" });
        continue;
      }

      // A plant is recognized by its primary email, its extra contacts (email_cc), its payments email, or an address a person assigned
      // to it. The trader's own forwards (internal sender) resolve the plant by the first real word of the Subject — his own discipline,
      // never a guess from body content.
      const resolved = await resolveSender(db, fromEmail);
      let plant: PlantRef | undefined = resolved.kind === "plant" ? resolved.plant : undefined;
      if (!plant && resolved.kind === "internal") {
        const allPlants = await db`select id, name, docs_included from plants`;
        const subjectLower = subject.toLowerCase().trim();
        plant = allPlants.find((p: { name: string }) => {
          const firstWord = (p.name || "").trim().toLowerCase().split(/\s+/)[0];
          return firstWord && firstWord.length >= 3 && (subjectLower.includes(firstWord) || firstWord.includes(subjectLower));
        });
      }
      if (!plant) {
        // Never silent: an address nobody could place is written down for a person to assign to a plant or dismiss (no-reply style
        // software senders are only classified).
        let recordError: string | null = null;
        if (!dryRun) {
          await db`insert into plant_price_emails_processed (message_id, from_email, subject) values (${m.id}, ${fromEmail}, ${subject}) on conflict (message_id) do nothing`;
          if (resolved.kind !== "automated") {
            try {
              await recordUnrecognizedSender(db, {
                from: fromEmail, subject, messageId: m.id,
                reason: resolved.kind === "ambiguous" ? "ambiguous_sender" : resolved.kind === "internal" ? "internal_without_plant" : "unknown_sender",
                candidates: resolved.kind === "ambiguous" ? resolved.candidates : [],
              });
            } catch (e) { recordError = String(e); }
          }
        }
        results.push({
          id: m.id, skipped: resolved.kind === "automated" ? "automated_sender" : "no_matching_plant", from: fromEmail,
          ...(resolved.kind === "ambiguous" ? { candidates: resolved.candidates } : {}), ...(recordError ? { record_error: recordError } : {}),
        });
        continue;
      }

      // An automatic reply ("Automatic reply: …", out of office) carries no business content: classified and recorded, never read as one.
      if (isAutoReply(subject, (n) => headerValue(msgData.payload.headers, n))) {
        let ledgerError: string | null = null;
        if (!dryRun) {
          try { await saveLedger(db, m.id, plant.id, [{ source: "body", rawText: subject || "(no subject)", price: null, outcome: "dismissed", reasonCode: "auto_reply", reasonDetail: "automatic reply — no price content" }]); }
          catch (e) { ledgerError = String(e); }
          await db`insert into plant_price_emails_processed (message_id, plant_id, from_email, subject) values (${m.id}, ${plant.id}, ${fromEmail}, ${subject}) on conflict (message_id) do nothing`;
        }
        results.push({ id: m.id, plant: plant.name, skipped: "auto_reply", ...(ledgerError ? { ledger_error: ledgerError } : {}) });
        continue;
      }

      const bodyText = extractPlainText(msgData.payload);
      // Correspondence about one of OUR orders (BT-####-####, quoted back by a plant or carrier) belongs to the pickup-document and
      // release-number readers; a price list never carries an order number. Classified and recorded here, not read for prices.
      if (/\bBT-\d{4}-\d+\b/.test(`${subject} ${bodyText}`)) {
        if (!dryRun) await db`insert into plant_price_emails_processed (message_id, plant_id, from_email, subject) values (${m.id}, ${plant.id}, ${fromEmail}, ${subject}) on conflict (message_id) do nothing`;
        results.push({ id: m.id, plant: plant.name, skipped: "order_correspondence" });
        continue;
      }
      // Same preprocessing Load Prices applies before either detector ever sees the text — a blank
      // line (Gmail's plain-text flattening of an HTML table inserts one after every cell) breaks
      // the block-format detector's "consume the whole run of consecutive price lines" step, so
      // skipping this step silently produces wrong names and misses the two-column Delivered price.
      // looksLikeContactLine strips signature phone/fax/extension lines here too — see its own
      // comment for the two real incidents (Wholestone, Tyson) this closes for both the regex path
      // AND the LLM path (cleanedBodyText below), not just the regex path's own separate guard.
      const lines = bodyText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !looksLikeContactLine(l));
      const cleanedBodyText = lines.join("\n");

      if (debugMessageId === m.id) {
        const html = extractHtml(msgData.payload);
        const listImageParts = (p: any): any[] => {
          const out: any[] = [];
          if (p.mimeType?.startsWith("image/") && p.body?.attachmentId) {
            out.push({ partId: p.partId, mimeType: p.mimeType, filename: p.filename, attachmentId: p.body.attachmentId, size: p.body.size, headers: p.headers });
          }
          for (const part of p.parts || []) out.push(...listImageParts(part));
          return out;
        };
        const imageParts = listImageParts(msgData.payload);
        // Gmail's attachmentId is only valid for the messages.get call that returned it, not
        // reusable across a later request — fetch within this same execution's listing, by index,
        // rather than accepting one from a prior debug call (confirmed real: a stale id from an
        // earlier call silently matched nothing).
        let fetchedImage: { filename: string; mimeType: string; base64: string } | null = null;
        let imageExtraction: any = null;
        if (typeof body.fetch_image_index === "number" && imageParts[body.fetch_image_index]) {
          const target = imageParts[body.fetch_image_index];
          const attRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/attachments/${target.attachmentId}`, { headers: authHeaders });
          const attData = await attRes.json();
          fetchedImage = { filename: target.filename, mimeType: target.mimeType, base64: attData.data };
          if (body.extract_image) {
            const b64 = (attData.data as string).replace(/-/g, "+").replace(/_/g, "/");
            try {
              imageExtraction = await extractItemsFromImage(b64, target.mimeType, bodyText);
            } catch (e) {
              imageExtraction = { error: String(e) };
            }
          }
        }
        return jsonResponse({
          debug: true, bodyTextLength: bodyText.length, lineCount: lines.length,
          looksLikeBlockFormat: looksLikeBlockFormat(lines),
          blockItems: detectBlockFormatItems(lines),
          first20Lines: lines.slice(0, 20),
          allLines: lines,
          htmlLength: html.length,
          xlsx: await (async () => { // read-only: every sheet of the first .xlsx, so what the list really contains can be checked
            const findX = (p: any): any => { if (p.filename && p.filename.toLowerCase().endsWith(".xlsx")) return p; for (const c of p.parts || []) { const f = findX(c); if (f) return f; } return null; };
            const part = findX(msgData.payload); if (!part?.body?.attachmentId) return null;
            const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/attachments/${part.body.attachmentId}`, { headers: authHeaders });
            const a = await r.json(); if (!r.ok || !a.data) return null;
            const bin = atob(a.data.replace(/-/g, "+").replace(/_/g, "/")); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const wb = XLSX.read(bytes, { type: "array" });
            return { filename: part.filename, sheets: wb.SheetNames.map((n: string) => ({ name: n, rows: (XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 }) as any[][]).slice(0, 120) })) };
          })(),
          attachments: (function listAtt(p: any): any[] { const o: any[] = []; if (p.filename) o.push({ filename: p.filename, mimeType: p.mimeType, size: p.body?.size }); for (const c of p.parts || []) o.push(...listAtt(c)); return o; })(msgData.payload),
          htmlSnippet: html.slice(0, 6000),
          imageParts,
          fetchedImage: fetchedImage ? { filename: fetchedImage.filename, mimeType: fetchedImage.mimeType, size: fetchedImage.base64.length } : null,
          imageExtraction,
        });
      }

      type Item = { rawText: string; nameEn?: string; nameEs?: string | null; price: number; freightIncluded: boolean; locationName?: string | null; needsReview?: boolean };
      type SourcedItem = Item & { source: LedgerSource };
      const ledger: LedgerRow[] = [];
      const addDropped = (d: Dropped) => ledger.push({ source: d.source, rawText: d.rawText, price: d.price, outcome: "dropped", reasonCode: d.reasonCode, reasonDetail: d.reasonDetail ?? null });

      // Rule-based extraction (block-format checked first, same order Load Prices already uses —
      // a name-line-then-price-line-below list can fool the single-line scanner into latching onto
      // false "prices" like a lead-time line). Kept and run on EVERY email now, alongside the LLM
      // extractor below, purely so text_items_regex vs text_items_llm is a real, standing
      // comparison in the data — not a one-time demo — and so this is the automatic fallback the
      // moment the LLM call fails for any reason (no credit, API outage, etc).
      const regexTextItems: Item[] = [];
      if (looksLikeBlockFormat(lines)) {
        regexTextItems.push(...detectBlockFormatItems(lines).map((it) => ({
          rawText: it.nameEs ? `${it.nameEn} — ${it.nameEs}` : it.nameEn,
          nameEn: it.nameEn, nameEs: it.nameEs, price: it.price, freightIncluded: it.freightIncluded,
        })));
      } else {
        // Real, confirmed risk (not theoretical): a real Tyson list has "Bone in Loins" listed
        // TWICE, once under "Fresh Boxed Muscles:" at one price and once under "Frozen Boxed
        // Muscles:" at a different price — identical text, no other signal to tell them apart. A
        // section header is skipped as its own row (it never has a price) but its text folds into
        // every item under it until the next header, exactly like Load Prices already does — this
        // is what lets the catalog matcher's own temp/pack detection actually disambiguate Fresh
        // from Frozen instead of guessing (or worse, silently matching whichever alias exists).
        let currentSection: string | null = null;
        for (const line of lines) {
          if (isSectionHeaderLine(line)) {
            currentSection = line.replace(/:\s*$/, "").trim();
            continue;
          }
          const parsed = parsePriceListLineBasic(line);
          if (parsed) {
            const rawText = currentSection ? `${currentSection} — ${parsed.rawText}` : parsed.rawText;
            regexTextItems.push({ rawText, price: parsed.price, freightIncluded: false });
          }
        }
      }

      // LLM extraction (see _shared/llmExtractor.ts) — real replacement for the regex step's
      // actual blind spots, confirmed against real mail: a Wholestone email folded three separate
      // product+price pairs into one prose sentence ("Fresh COV $0.95/lb, Frozen COV $0.98/lb,
      // Frozen Poly $0.96/lb") that the regex scanner above cannot split at all (0 items found);
      // the LLM extractor correctly found all 3, right names, right temperatures, right prices,
      // verified live. Never decides which catalog SKU anything maps to — that's still entirely
      // the deterministic matcher below; this only replaces "where is the price in this text."
      let llmTextItems: Item[] | null = null;
      // Real addition, explicit ask, walking the whole off-spec flow end to end: the same LLM call
      // now also returns declined_items — "we don't produce this" statements, distinct from a
      // priced item and distinct from temporary unavailability (see llmExtractor.ts's own prompt
      // for that exact distinction). No regex/block-format equivalent exists for this signal at
      // all (those parsers only ever looked for price lines) — when the LLM call fails and this
      // run falls back to regex, declined-item detection simply doesn't run for that email, same
      // as every other LLM-only capability here.
      let declinedTextItems: { rawText: string }[] = [];
      let llmError: string | null = null;
      const facilities = await loadFacilityMap(db, plant.id);
      const reviewPattern = await loadReviewPattern(db, plant.id);
      // Set when the AI service itself is down (no credit, outage): the message is left UNPROCESSED so the next cycle reads it fully.
      // allow_degraded (only with test_message_id) lets a verification run continue on the rule-based fallback instead.
      let deferReason: string | null = null;
      const degradedTest = body.allow_degraded === true && !!testMessageId;
      try {
        const extracted = await extractItemsWithLLM(cleanedBodyText);
        declinedTextItems = extracted.declinedItems.map((it) => ({
          rawText: it.temperature === "Unknown" ? it.name : `${it.temperature} — ${it.name}`,
        }));
        // A line that names a product but has no usable price (formula, "Check with X", N/A, a price with no product) is recorded
        // with its reason — never left out.
        // The reader can list the same product twice (e.g. its "------" FOB column and its Delivered price): a product that has a real
        // price in this email is never also reported as unpriced — the price wins and nothing is lost.
        const hasRealPrice = (u: { name: string; temperature: string }) => extracted.items.some((it) =>
          normalize(it.name) === normalize(u.name) && (it.temperature === u.temperature || it.temperature === "Unknown" || u.temperature === "Unknown"));
        for (const u of extracted.unpricedItems) {
          if (hasRealPrice(u)) continue;
          addDropped({
            source: "body", rawText: u.temperature === "Unknown" ? u.name : `${u.temperature} — ${u.name}`, price: null,
            reasonCode: `text_${u.reason}`, reasonDetail: u.detail || undefined,
          });
        }
        const mapped = extracted.items.map((it) => ({
          rawText: it.temperature === "Unknown" ? it.name : `${it.temperature} — ${it.name}`,
          price: it.price, freightIncluded: it.delivered,
          locationName: it.location && it.location.trim() ? it.location.trim() : null,
        }));
        // Real bug, caught live against a real Seaboard email: a block-format line quoting both an
        // FOB and a Delivered price for the same product makes the LLM correctly emit two items —
        // same name, one freightIncluded:false, one freightIncluded:true (this is the intended,
        // schema-documented shape, not a mistake in extraction). But applying both in sequence
        // overwrote the same plant_products row twice, so the price that stuck was whichever ran
        // last — not deliberately the Delivered one. Confirmed real: "Frozen Skinless Bellies
        // 13/15" got written at $1.95 then, two seconds later, $2.05 in the same run. The
        // regex/block-format path never had this problem — detectBlockFormatItems already
        // collapses an FOB+Delivered pair into a single item, last column wins. Match that here:
        // when the same rawText appears more than once, keep only the Delivered one if any exists.
        const byName = new Map<string, typeof mapped[number]>();
        for (const it of mapped) {
          const key = normalize(it.rawText);
          const existing = byName.get(key);
          if (!existing || (it.freightIncluded && !existing.freightIncluded)) byName.set(key, it);
        }
        llmTextItems = [...byName.values()];
      } catch (e) {
        llmError = String(e);
        if (e instanceof LLMUnavailableError) deferReason = llmError;
        addDropped({ source: "body", rawText: subject || "(no subject)", price: null, reasonCode: "llm_extraction_failed", reasonDetail: llmError.slice(0, 300) });
      }

      const textItems = llmTextItems ?? regexTextItems;
      const extractionMethod = llmTextItems ? "llm" : "regex_fallback";

      // A real .xlsx attachment (confirmed: Wholestone Prestage's "Freezer List") is a completely
      // separate item source from the body text, always read deterministically (a spreadsheet is
      // already structured data — no LLM needed) — so this adds to whichever text-source won above.
      const { items: xlsxItems, dropped: xlsxDropped } = await extractXlsxItems(msgData.payload, m.id, authHeaders, subject, cleanedBodyText, facilities, reviewPattern);
      xlsxDropped.forEach(addDropped);
      listUnreadAttachments(msgData.payload).forEach(addDropped);
      // A real third source, separate from both body text and the xlsx: an embedded picture of a
      // price grid (confirmed real for Wholestone's "fresh offers" — no plain-text or HTML-table
      // equivalent exists for it at all). extractImageItems no-ops (empty array, no API call) for
      // any message with no inline images, so this costs nothing for every other plant's mail.
      const xlsxIsFrozenList = xlsxItems.length > 0 && xlsxItems.every((it) => /^Frozen — /.test(it.rawText));
      let imageItems: Awaited<ReturnType<typeof extractImageItems>>["items"] = [];
      let imageDropped: Dropped[] = [];
      if (!deferReason || degradedTest) {
        try {
          ({ items: imageItems, dropped: imageDropped } = await extractImageItems(msgData.payload, m.id, authHeaders, bodyText, xlsxIsFrozenList ? "Fresh" : null, facilities));
        } catch (e) {
          if (e instanceof LLMUnavailableError) deferReason = deferReason ?? String(e); else throw e;
        }
      }
      imageDropped.forEach(addDropped);
      if (deferReason && !degradedTest) {
        results.push({ id: m.id, plant: plant.name, skipped: "llm_unavailable_will_retry", detail: deferReason.slice(0, 300) });
        continue;
      }
      // The sentence the trader wrote in the body is applied LAST: a price stated in the message ("Salivary Glands … $0.35/lb FOB no
      // docs") is that day's explicit offer and must be the one that stays current — it used to run first, so the spreadsheet's
      // inventory row for the same product ($0.48) overwrote it (Wholestone, Sept 30). Every price still lands in the history.
      const items: SourcedItem[] = [
        ...xlsxItems.map((it) => ({ ...it, source: "xlsx" as const })),
        ...imageItems.map((it) => ({ ...it, source: "image" as const })),
        ...textItems.map((it) => ({ ...it, source: "body" as const })),
      ];

      let applied = 0, pending = 0, skipped = lines.length - textItems.length;
      const errors: string[] = llmError ? [`llm extraction: ${llmError}`] : [];
      // Real addition, explicit ask: "avisa con un correo que ya están actualizados los precios
      // que faltaban" — collects every applied price that resolves a row someone had actually
      // asked for (last_requested_at set BEFORE this apply — applyPlantProductMatch's own upsert
      // never touches that column, so the value it returns is exactly the pre-apply state), so one
      // notification can go out for this plant's whole batch at the end, not one email per line.
      const resolvedForTrader: { name: string; price: number }[] = [];
      // Real ask 2026-09-15, walking Wholestone's own first live email through end to end: "que
      // reconozca el resto y los suba y me notifique" — a routine price refresh (nothing anyone
      // was specifically waiting on) used to apply completely silently by design. Every item this
      // run actually applied — requested or not — goes here so the notification below always fires
      // once real prices land, not only the narrower "you were waiting on this" case above.
      const allAppliedForNotification: { name: string; price: number }[] = [];
      // Offer Sheets part 4 (2026-09-26): every product whose price this email applied, with the saved row — used below to
      // mark any open sheet that asked this plant as answered and alert whoever opened that sheet.
      const appliedForSheets = new Map<string, { name: string; price: number; locationId: string | null; freightIncluded: boolean }>();
      // Real fix for a real 51-item Tyson list hitting a Postgres connection rate limit partway
      // through: these three now run IN-PROCESS (see _shared/productMatcher.ts,
      // applyPlantProductMatch.ts, pendingMatch.ts) sharing this function's own single `db`
      // connection, instead of one fresh HTTP call — and one fresh Postgres connection — per line
      // via the sibling Edge Functions. No per-item delay needed anymore; that was only ever
      // working around the connection explosion this removes at the root.
      for (const item of items) {
        const note = (outcome: LedgerOutcome, reasonCode: string | null, reasonDetail: string | null, extra: Record<string, unknown> = {}, pendingMatchId: string | null = null) =>
          ledger.push({ source: item.source, rawText: item.rawText, price: item.price, outcome, reasonCode, reasonDetail, pendingMatchId, extra });
        let matchRes;
        try {
          matchRes = await matchProductFromPlantText(db, {
            plant_id: plant.id, raw_text: item.rawText, name_en: item.nameEn || null, name_es: item.nameEs || null, cache_refs: true,
          });
        } catch (e) { skipped++; errors.push(`match ${item.rawText}: ${e}`); note("dropped", "match_error", String(e).slice(0, 300)); continue; }
        if ("error" in matchRes) { skipped++; errors.push(`match ${item.rawText}: ${matchRes.error}`); note("dropped", "match_error", String(matchRes.error)); continue; }
        const matchedName = matchRes.matched ? (matchRes.product.full_name_en || matchRes.product.name_en || matchRes.product.name) : null;
        try {
          if (matchRes.matched && (!item.needsReview || matchRes.source === "alias")) {
            if (dryRun) {
              const [cur] = await db`select current_price, location_id from plant_products where plant_id = ${plant.id} and product_id = ${matchRes.product.id}`;
              applied++;
              note("applied", null, null, {
                product: matchedName, match_source: matchRes.source, previous_price: cur ? cur.current_price : null, location: item.locationName ?? null,
                would_change: !cur || Number(cur.current_price).toFixed(4) !== Number(item.price).toFixed(4),
              });
              continue;
            }
            const applyResult = await applyPlantProductMatch(db, HMAC_SECRET, {
              actor: EMAIL_AUTOMATION_ACTOR, plant_id: plant.id, product_id: matchRes.product.id,
              raw_text: normalize(item.rawText), price: item.price,
              price_currency_id: usdCurrencyId, price_date: messagePriceDate,
              docs_included: plant.docs_included === true, freight_included: item.freightIncluded,
              location_name: item.locationName || null,
              learn: false, // the system's own match — saves the price, never teaches (only the trader teaches)
            });
            if ("error" in applyResult) { skipped++; errors.push(`apply ${item.rawText}: ${applyResult.error}`); note("dropped", "apply_error", String(applyResult.error)); continue; }
            if (applyResult.plant_product.last_requested_at) {
              resolvedForTrader.push({ name: matchedName, price: item.price });
            }
            allAppliedForNotification.push({ name: matchedName, price: item.price });
            appliedForSheets.set(matchRes.product.id, {
              name: matchedName, price: item.price,
              locationId: applyResult.plant_product.location_id || null, freightIncluded: applyResult.plant_product.freight_included === true,
            });
            applied++;
            note("applied", null, null);
          } else {
            const why = pendingReason(matchRes);
            if (dryRun) {
              pending++;
              note("pending", why.code, why.detail, { candidates: matchRes.matched ? [matchedName] : matchRes.candidates.map((p: any) => p.full_name_en || p.name_en || p.name) });
              continue;
            }
            const created = await createPendingMatch(db, HMAC_SECRET, {
              actor: EMAIL_AUTOMATION_ACTOR, plant_id: plant.id, raw_text: item.rawText,
              detected_price: item.price, candidate_product_ids: matchRes.matched ? [matchRes.product.id] : matchRes.candidates.map((p: any) => p.id),
              idempotency_key: `${m.id}|${normalize(item.rawText)}`, candidates_conflicted: matchRes.matched ? true : matchRes.conflicted === true,
              reason_code: why.code, reason_detail: describeReason(why.code), source: item.source,
            });
            if ("error" in created) { skipped++; errors.push(`pending ${item.rawText}: ${created.error}`); note("dropped", "pending_error", String(created.error)); continue; }
            pending++;
            note("pending", why.code, why.detail, {}, created.pending_match.id);
          }
        } catch (e) { skipped++; errors.push(`apply ${item.rawText}: ${e}`); note("dropped", "apply_error", String(e).slice(0, 300)); }
      }

      // Real addition, explicit ask: a "we don't produce this" signal runs through the exact same
      // matcher as a price line (same rules, same candidate narrowing), but — unlike a price —
      // NEVER auto-applies here, no matter how confident the match. A wrong price self-corrects on
      // the next email; a wrong permanent decline (plant_products.declined_at) silently blocks
      // that plant for that product forever with nothing to trigger a second look. Every declined
      // signal becomes a plant_pending_matches row (signal_type: 'declined') for a human to
      // actually set declined_at from plants.html — see that screen's own review queue.
      let declined = 0;
      for (const decl of declinedTextItems) {
        const noteDecl = (outcome: LedgerOutcome, reasonCode: string | null, reasonDetail: string | null, pendingMatchId: string | null = null) =>
          ledger.push({ source: "declined", rawText: decl.rawText, price: null, outcome, reasonCode, reasonDetail, pendingMatchId });
        let matchRes;
        try {
          matchRes = await matchProductFromPlantText(db, { plant_id: plant.id, raw_text: decl.rawText, cache_refs: true });
        } catch (e) { skipped++; errors.push(`declined match ${decl.rawText}: ${e}`); noteDecl("dropped", "declined_match_error", String(e).slice(0, 300)); continue; }
        if ("error" in matchRes) { skipped++; errors.push(`declined match ${decl.rawText}: ${matchRes.error}`); noteDecl("dropped", "declined_match_error", String(matchRes.error)); continue; }
        try {
          if (dryRun) { declined++; noteDecl("declined", null, null); continue; }
          const candidateIds = matchRes.matched ? [matchRes.product.id] : matchRes.candidates.map((p: any) => p.id);
          const created = await createPendingMatch(db, HMAC_SECRET, {
            actor: EMAIL_AUTOMATION_ACTOR, plant_id: plant.id, raw_text: decl.rawText,
            detected_price: null, candidate_product_ids: candidateIds,
            idempotency_key: `${m.id}|declined|${normalize(decl.rawText)}`, signal_type: "declined",
            candidates_conflicted: matchRes.matched ? false : matchRes.conflicted === true,
          });
          if ("error" in created) { skipped++; errors.push(`declined queue ${decl.rawText}: ${created.error}`); noteDecl("dropped", "declined_queue_error", String(created.error)); continue; }
          declined++;
          noteDecl("declined", null, null, created.pending_match.id);
        } catch (e) { skipped++; errors.push(`declined queue ${decl.rawText}: ${e}`); noteDecl("dropped", "declined_queue_error", String(e).slice(0, 300)); }
      }
      pending += declined;
      // A message the reader found NOTHING in is still accounted for: it is recorded as a candidate of its own, never a silent zero.
      if (!ledger.length) addDropped({ source: "body", rawText: subject || "(no subject)", price: null, reasonCode: "message_without_candidates", reasonDetail: "no product line, price, attachment row or unpriced line was found in this message" });

      // One notification per plant whenever this run actually applied real prices — originally
      // scoped to only "something someone was waiting on" (resolvedForTrader), widened 2026-09-15
      // ("que reconozca el resto y los suba y me notifique") so a routine price refresh notifies
      // too, not just a requested one. resolvedForTrader's own wording still wins when it applies
      // (a trader cares more that a specific ask got answered than a generic count). Fire-and-
      // forget on purpose: a notification failing to send should never fail the whole poll run or
      // block the next message from processing.
      // A deliberate re-read of one old message (test_message_id) never alerts anyone: on 2026-10-02 re-running the Sept 30 Wholestone
      // list emailed "32 prices just applied" to the trader's inbox. Alerts are for what the real */15 cron reads.
      if (!testMessageId && !dryRun && allAppliedForNotification.length && TRADER_NOTIFICATION_EMAILS.length) {
        const useRequested = resolvedForTrader.length > 0;
        const items = useRequested ? resolvedForTrader : allAppliedForNotification;
        const lines = items.map((r) => `${r.name} — $${r.price.toFixed(4)}/lb`).join("\n");
        const pendingNote = pending > 0 ? `\n\n${pending} other line${pending === 1 ? "" : "s"} from this email still need${pending === 1 ? "s" : ""} a manual match in Pending Matches.` : "";
        const subject = useRequested
          ? `${plant.name} — ${items.length} price${items.length === 1 ? "" : "s"} you were waiting on just came in`
          : `${plant.name} — ${items.length} price${items.length === 1 ? "" : "s"} just applied`;
        const body = useRequested
          ? `${plant.name} just sent updated pricing, and it included ${items.length} product${items.length === 1 ? "" : "s"} you'd asked them for:\n\n${lines}\n\nOpen Quotes to send ${items.length === 1 ? "it" : "these"} now.${pendingNote}`
          : `${plant.name} just sent updated pricing. ${items.length} product${items.length === 1 ? "" : "s"} applied automatically:\n\n${lines}${pendingNote}`;
        for (const to of TRADER_NOTIFICATION_EMAILS) {
          try { await sendGmailNotification(authHeaders, to, subject, body); }
          catch (e) { errors.push(`notify ${to}: ${e}`); }
        }
      }

      // Offer Sheets part 4: this plant answered an open sheet that asked it → mark answered and alert the sheet's owner.
      // The sheet itself shows the new price as NEW on its own (read live); this is only the "it just came in" signal.
      // Never fails the poll run — a missed alert must not block the next email.
      if (!testMessageId && !dryRun && appliedForSheets.size) {
        try {
          const answered = await db`
            update offer_sheet_plants sp set answered_at = now()
            from offer_sheets s
            where s.id = sp.sheet_id and s.status = 'open' and sp.plant_id = ${plant.id}
              and sp.asked_at is not null and sp.answered_at is null
              and s.product_id = any(${[...appliedForSheets.keys()]}::uuid[])
            returning s.product_id, s.created_by`;
          for (const row of answered) {
            const a = appliedForSheets.get(row.product_id);
            if (!a || !row.created_by) continue;
            let detail = `$${a.price.toFixed(4)}/lb. Pick the freight yourself on the sheet.`;
            if (a.freightIncluded) {
              detail = `$${a.price.toFixed(4)}/lb (freight included). Confirm the sale price to add it to the Outbox.`;
            } else if (a.locationId) {
              const [loc] = await db`select city from locations where id = ${a.locationId}`;
              const [rate] = await db`select id from provider_rates where service_type = 'us_freight' and location_id = ${a.locationId} limit 1`;
              detail = rate
                ? `$${a.price.toFixed(4)}/lb · ${loc?.city || ""} (freight set). Confirm the sale price to add it to the Outbox.`
                : `$${a.price.toFixed(4)}/lb · ${loc?.city || ""}, no freight rate on file. Pick the freight yourself on the sheet.`;
            }
            await sendSheetPush(row.created_by, `${plant.name.trim()} answered — ${a.name}`, detail, row.product_id);
          }
        } catch (e) { errors.push(`offer sheet alert: ${e}`); }
      }

      // Everything the readers saw but could not place goes to Pending Matches with its reason — nothing stays only in the ledger.
      errors.push(...await routeDropsToPending(db, HMAC_SECRET, EMAIL_AUTOMATION_ACTOR, { plantId: plant.id, messageId: m.id, rows: ledger, dryRun }));
      const droppedCount = ledger.filter((r) => r.outcome === "dropped").length;
      if (!dryRun) {
        // The ledger never blocks a price; if it cannot be written the failure is reported in this run's errors, not hidden.
        try { await saveLedger(db, m.id, plant.id, ledger); } catch (e) { errors.push(`ledger: ${e}`); }
        await db`
          insert into plant_price_emails_processed
            (message_id, plant_id, from_email, subject, lines_applied, lines_pending, lines_skipped, text_items_regex, text_items_llm, extraction_method)
          values
            (${m.id}, ${plant.id}, ${fromEmail}, ${subject}, ${applied}, ${pending}, ${skipped}, ${regexTextItems.length}, ${llmTextItems ? llmTextItems.length : null}, ${extractionMethod})
          on conflict (message_id) do nothing
        `;
      }
      let rollbackProof: unknown = null;
      if (rollbackMode) {
        const [rec] = await db`select candidates, applied, pending, declined, dropped from plant_price_email_reconciliation where message_id = ${m.id}`;
        const [{ n }] = await db`select count(*)::int as n from plant_price_email_lines where message_id = ${m.id}`;
        rollbackProof = { ledger_rows_read_back: n, reconciliation: rec ?? null, ledger_rows_expected: new Set(ledger.map((r) => `${r.source}|${r.reasonCode ?? ""}|${normalize(r.rawText)}`)).size };
      }
      results.push({
        id: m.id, plant: plant.name, applied, pending, declined, dropped: droppedCount, dismissed: ledger.filter((r) => r.outcome === "dismissed").length, skipped, errors: errors.slice(0, 5),
        text_items_regex: regexTextItems.length, text_items_llm: llmTextItems ? llmTextItems.length : null, extraction_method: extractionMethod,
        ...(rollbackMode ? { rollback_proof: rollbackProof } : {}),
        ...(dryRun ? {
          dry_run: true,
          candidates: ledger.length,
          would_change_prices: ledger.filter((r) => r.outcome === "applied" && r.extra?.would_change === true).length,
          ledger: ledger.map((r) => ({ source: r.source, raw_text: r.rawText, price: r.price, outcome: r.outcome, reason_code: r.reasonCode, reason_detail: r.reasonDetail, ...(r.extra || {}) })),
        } : {}),
      });
    }

    return results;
    };

    let results: any[] = [];
    let debugResponse: Response | null = null;
    if (rollbackMode) {
      class RollbackSignal extends Error {}
      try {
        await db.begin(async (tx: any) => {
          const out = await runMessages(asTransactionDb(tx));
          if (out instanceof Response) { debugResponse = out; return; }
          results = out;
          throw new RollbackSignal();
        });
      } catch (e) {
        if (!(e instanceof RollbackSignal)) throw e;
      }
      if (debugResponse) return debugResponse;
      return jsonResponse({ execute_rollback: true, rolled_back: true, results });
    }
    const out = await runMessages(db);
    if (out instanceof Response) return out;
    return jsonResponse({ results: out });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
