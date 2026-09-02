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
import { detectBlockFormatItems, isSectionHeaderLine, looksLikeBlockFormat, parsePriceListLineBasic } from "../_shared/priceListLine.ts";
import { matchProductFromPlantText } from "../_shared/productMatcher.ts";
import { applyPlantProductMatch } from "../_shared/applyPlantProductMatch.ts";
import { createPendingMatch } from "../_shared/pendingMatch.ts";

// Wholestone Prestage-specific: their frozen list arrives as a real .xlsx attachment (columns
// WHS/CATEGORY/CODE/DESC/CASES/LBS/PRICE/Avg Age, confirmed against a real "Freezer List" file) —
// nothing about this is generic to every plant yet, this is the first real attachment-reading
// case, scoped narrowly rather than guessed at for plants that don't do this. Explicit real
// business rule (not inferred from the file): only a row with 40,000+ lbs on hand (a full
// truckload) is worth offering — anything less stays out, never applied, never even queued as a
// pending match (there's nothing wrong to review, it's just not enough volume to sell as a load).
const MIN_LOAD_LBS = 40000;

// The Excel's own WHS column is a bare city name ("Fremont", "Eagle Grove") — plant-products-
// apply-match's location matching needs "City, ST" (see _shared/matching.ts parseCityState), and
// there's no state in the file to read this from. Both are real, confirmed facilities already in
// the locations catalog (verified live), not guessed here.
const WHOLESTONE_FACILITY_STATE: Record<string, string> = { Fremont: "NE", "Eagle Grove": "IA" };

async function extractXlsxItems(
  payload: any, msgId: string, authHeaders: Record<string, string>,
): Promise<{ rawText: string; price: number; freightIncluded: boolean; locationName: string | null }[]> {
  const findXlsxPart = (p: any): any => {
    if (p.filename && p.filename.toLowerCase().endsWith(".xlsx")) return p;
    for (const part of p.parts || []) {
      const found = findXlsxPart(part);
      if (found) return found;
    }
    return null;
  };
  const part = findXlsxPart(payload);
  if (!part || !part.body?.attachmentId) return [];

  const attRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${part.body.attachmentId}`,
    { headers: authHeaders },
  );
  const attData = await attRes.json();
  if (!attRes.ok || !attData.data) return [];
  const b64 = attData.data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const wb = XLSX.read(bytes, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  if (!rows.length) return [];

  const header = rows[0].map((h: any) => String(h || "").trim().toUpperCase());
  const col = (name: string) => header.indexOf(name);
  const whsCol = col("WHS"), descCol = col("DESC"), lbsCol = col("LBS"), priceCol = col("PRICE");
  if (descCol === -1 || lbsCol === -1 || priceCol === -1) return [];

  const items: { rawText: string; price: number; freightIncluded: boolean; locationName: string | null }[] = [];
  for (const row of rows.slice(1)) {
    const lbs = Number(row[lbsCol]);
    const price = Number(row[priceCol]);
    const desc = String(row[descCol] || "").trim();
    if (!desc || !Number.isFinite(lbs) || !Number.isFinite(price) || lbs < MIN_LOAD_LBS) continue;
    const whs = whsCol !== -1 ? String(row[whsCol] || "").trim() : "";
    const state = WHOLESTONE_FACILITY_STATE[whs];
    items.push({
      rawText: desc, price,
      freightIncluded: false, // FOB per this plant's own stated terms — never assumed for others
      locationName: state ? `${whs}, ${state}` : null,
    });
  }
  return items;
}

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

const GMAIL_CLIENT_ID = Deno.env.get("GMAIL_CLIENT_ID")!;
const GMAIL_CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET")!;
const GMAIL_REFRESH_TOKEN = Deno.env.get("GMAIL_REFRESH_TOKEN")!;
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const EMAIL_AUTOMATION_ACTOR = "email-automation@buentradegroup.com";

async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

function headerValue(headers: { name: string; value: string }[], name: string): string {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// Walks a (possibly multipart) Gmail message payload for the first text/plain part. HTML-only
// emails (no plain-text alternative) return "" — deliberately not scraped from HTML tags, since
// that's a real source of noise the pasted-text flow never had to deal with.
function extractPlainText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const found = extractPlainText(part);
    if (found) return found;
  }
  return "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const maxResults = body.max_results || 20;
    const debugMessageId = body.debug_message_id || null;
    // Verification aid: process one specific message by id, regardless of how far back it is in
    // the inbox — the normal recency scan would need a huge (slow) maxResults to reach an old real
    // test email. Goes through the real apply/pending pipeline exactly like any other message.
    const testMessageId = body.test_message_id || null;

    const accessToken = await getAccessToken();
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    let listData: { messages?: { id: string }[] };
    if (testMessageId) {
      listData = { messages: [{ id: testMessageId }] };
    } else {
      const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`, { headers: authHeaders });
      listData = await listRes.json();
      if (!listRes.ok) throw new Error(`Gmail list failed: ${JSON.stringify(listData)}`);
    }

    const [{ id: usdCurrencyId }] = await sql`select id from currencies where code = 'USD'`;
    const today = new Date().toISOString().slice(0, 10);

    const results = [];
    for (const m of listData.messages || []) {
      const [already] = await sql`select message_id from plant_price_emails_processed where message_id = ${m.id}`;
      if (already) { results.push({ id: m.id, skipped: "already_processed" }); continue; }

      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: authHeaders });
      const msgData = await msgRes.json();
      if (!msgRes.ok) { results.push({ id: m.id, skipped: "gmail_fetch_failed" }); continue; }

      const fromHeader = headerValue(msgData.payload.headers, "From");
      const subject = headerValue(msgData.payload.headers, "Subject");
      const emailMatch = fromHeader.match(/<([^>]+)>/);
      const fromEmail = (emailMatch ? emailMatch[1] : fromHeader).trim().toLowerCase();

      const [plant] = await sql`select id, name, docs_included from plants where lower(email) = ${fromEmail}`;
      if (!plant) {
        await sql`insert into plant_price_emails_processed (message_id, from_email, subject) values (${m.id}, ${fromEmail}, ${subject}) on conflict (message_id) do nothing`;
        results.push({ id: m.id, skipped: "no_matching_plant", from: fromEmail });
        continue;
      }

      const bodyText = extractPlainText(msgData.payload);
      // Same preprocessing Load Prices applies before either detector ever sees the text — a blank
      // line (Gmail's plain-text flattening of an HTML table inserts one after every cell) breaks
      // the block-format detector's "consume the whole run of consecutive price lines" step, so
      // skipping this step silently produces wrong names and misses the two-column Delivered price.
      const lines = bodyText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

      if (debugMessageId === m.id) {
        return jsonResponse({
          debug: true, bodyTextLength: bodyText.length, lineCount: lines.length,
          looksLikeBlockFormat: looksLikeBlockFormat(lines),
          blockItems: detectBlockFormatItems(lines),
          first20Lines: lines.slice(0, 20),
        });
      }

      // Same order Load Prices already uses: block-format is checked FIRST (a name-line-then-
      // price-line-below list can fool the single-line scanner into latching onto false "prices"
      // like a lead-time line), only falling back to the single-line scan when it doesn't look
      // like a block-format list at all.
      type Item = { rawText: string; nameEn?: string; nameEs?: string | null; price: number; freightIncluded: boolean; locationName?: string | null };
      let items: Item[] = [];
      if (looksLikeBlockFormat(lines)) {
        items = detectBlockFormatItems(lines).map((it) => ({
          rawText: it.nameEs ? `${it.nameEn} — ${it.nameEs}` : it.nameEn,
          nameEn: it.nameEn, nameEs: it.nameEs, price: it.price, freightIncluded: it.freightIncluded,
        }));
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
            items.push({ rawText, price: parsed.price, freightIncluded: false });
          }
        }
      }

      // A real .xlsx attachment (confirmed: Wholestone Prestage's "Freezer List") is a completely
      // separate item source from the body text — a message can have both real text-line items
      // AND a real spreadsheet attached, so this adds to `items` rather than replacing them.
      const xlsxItems = await extractXlsxItems(msgData.payload, m.id, authHeaders);
      items.push(...xlsxItems);

      let applied = 0, pending = 0, skipped = lines.length - (items.length - xlsxItems.length);
      const errors: string[] = [];
      // Real fix for a real 51-item Tyson list hitting a Postgres connection rate limit partway
      // through: these three now run IN-PROCESS (see _shared/productMatcher.ts,
      // applyPlantProductMatch.ts, pendingMatch.ts) sharing this function's own single `sql`
      // connection, instead of one fresh HTTP call — and one fresh Postgres connection — per line
      // via the sibling Edge Functions. No per-item delay needed anymore; that was only ever
      // working around the connection explosion this removes at the root.
      for (const item of items) {
        let matchRes;
        try {
          matchRes = await matchProductFromPlantText(sql, {
            plant_id: plant.id, raw_text: item.rawText, name_en: item.nameEn || null, name_es: item.nameEs || null,
          });
        } catch (e) { skipped++; errors.push(`match ${item.rawText}: ${e}`); continue; }
        if ("error" in matchRes) { skipped++; errors.push(`match ${item.rawText}: ${matchRes.error}`); continue; }
        try {
          if (matchRes.matched) {
            await applyPlantProductMatch(sql, HMAC_SECRET, {
              actor: EMAIL_AUTOMATION_ACTOR, plant_id: plant.id, product_id: matchRes.product.id,
              raw_text: normalize(item.rawText), price: item.price,
              price_currency_id: usdCurrencyId, price_date: today,
              docs_included: plant.docs_included === true, freight_included: item.freightIncluded,
              location_name: item.locationName || null,
            });
            applied++;
          } else {
            await createPendingMatch(sql, HMAC_SECRET, {
              actor: EMAIL_AUTOMATION_ACTOR, plant_id: plant.id, raw_text: item.rawText,
              detected_price: item.price, candidate_product_ids: matchRes.candidates.map((p: any) => p.id),
              idempotency_key: `${m.id}|${normalize(item.rawText)}`,
            });
            pending++;
          }
        } catch (e) { skipped++; errors.push(`apply ${item.rawText}: ${e}`); }
      }

      await sql`
        insert into plant_price_emails_processed (message_id, plant_id, from_email, subject, lines_applied, lines_pending, lines_skipped)
        values (${m.id}, ${plant.id}, ${fromEmail}, ${subject}, ${applied}, ${pending}, ${skipped})
        on conflict (message_id) do nothing
      `;
      results.push({ id: m.id, plant: plant.name, applied, pending, skipped, errors: errors.slice(0, 5) });
    }

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
