// Market Flash by email. Same Gmail inbox (and the same OAuth credentials) the other pollers read — no new access.
//
// A message is considered ONLY when it carries a PDF AND either its subject contains the word "flash" (how the trader forwards it) or the PDF is
// the report itself (its file name, e.g. "..._bi-weekly_report_-_english.pdf", so it is read when it arrives directly). Because a doctored
// bulletin mailed to that inbox would end up in front of customers, the origin is checked before anything is read:
//   • a message the mailbox owner SENT (Gmail label SENT — only someone with access to the account can create one,
//     e.g. a trader sending the bulletin from the purchasing@ send-as address) is trusted; otherwise
//   • the sender must be info@/purchasing@buentradegroup.com or one of the traders in TRADER_NOTIFICATION_EMAILS AND be
//     authenticated (Authentication-Results: dmarc=pass, or spf AND dkim pass) so the From line can't simply be forged,
//   and finally the PDF must actually read as the bulletin (ingestBulletin refuses anything without its data).
// Every candidate is recorded once in market_flash_email_inbox with its outcome and reason — nothing is invisible.
//
// Two steps, each its own invocation: (a) poll = find the message, download the PDF, read its text items (the heavy
// part, ~140 MB / ~1 s CPU) and store them; (b) process = run the bulletin through ingestBulletin from those stored
// items. Reading the PDF and processing it in ONE invocation was intermittently hitting the Edge compute limit.
import { completeNarrative, ingestBulletin } from "./store.ts";
import { readPdfItems } from "./pdf.ts";
import { asTransactionDb, closeMailIssue, isBulletinEmail, openMailIssue } from "../mailIntake.ts";

// Wide on purpose (any PDF named like a report, or with "flash" in the subject); isBulletinEmail decides what really is the bulletin.
const SEARCH = "has:attachment filename:pdf newer_than:14d (subject:flash OR filename:report OR filename:newsletter)";
const SELF_URL = "https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/price-history-search";
const API_KEY = Deno.env.get("API_PUBLISHABLE_KEY") || "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe";


async function accessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: Deno.env.get("GMAIL_CLIENT_ID")!, client_secret: Deno.env.get("GMAIL_CLIENT_SECRET")!, refresh_token: Deno.env.get("GMAIL_REFRESH_TOKEN")!, grant_type: "refresh_token" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}
const header = (headers: { name: string; value: string }[], name: string) => headers.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value).join(" | ");
// The company's own two addresses (info@ is the mailbox itself, purchasing@ its send-as alias — mail addressed to either
// lands in this inbox) plus the traders already trusted for notifications. A received (not SENT) message from any of them
// must still pass sender authentication.
const COMPANY_ADDRESSES = ["info@buentradegroup.com", "purchasing@buentradegroup.com"];
const trusted = () => [...COMPANY_ADDRESSES, ...(Deno.env.get("TRADER_NOTIFICATION_EMAILS") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)];
const pdfParts = (p: any): any[] => [
  ...(p.filename && p.body?.attachmentId && (p.mimeType === "application/pdf" || p.filename.toLowerCase().endsWith(".pdf")) ? [p] : []),
  ...(p.parts || []).flatMap(pdfParts),
];
// Gmail records how the sender authenticated. Accept a DMARC pass, or SPF and DKIM both passing.
export function senderAuthenticated(authResults: string): boolean {
  const a = authResults.toLowerCase();
  return /dmarc=pass/.test(a) || (/spf=pass/.test(a) && /dkim=pass/.test(a));
}

// Read-only look at what the inbox actually holds (sender, subject, date, attachment names — no bodies; optional Gmail search `query`), for when a
// bulletin "should have arrived" and did not.
export async function diagnoseInbox(count = 8, query = "") {
  const auth = { Authorization: `Bearer ${await accessToken()}` };
  const list = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.min(count, 40)}${query ? `&q=${encodeURIComponent(query)}` : ""}`, { headers: auth })).json();
  const out: any[] = [];
  for (const m of list.messages || []) {
    const msg = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: auth })).json();
    const hs = msg.payload?.headers || [];
    const files = (function walk(p: any): string[] { return [...(p.filename ? [p.filename] : []), ...(p.parts || []).flatMap(walk)]; })(msg.payload || {});
    out.push({ id: m.id, from: header(hs, "From"), to: header(hs, "To"), delivered_to: header(hs, "Delivered-To"), subject: header(hs, "Subject"), date: header(hs, "Date"), labels: msg.labelIds, attachments: files, auth: header(hs, "Authentication-Results").slice(0, 160) });
  }
  const search = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(SEARCH)}&maxResults=5`, { headers: auth })).json();
  const profile = await (await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: auth })).json();
  return { mailbox: profile.emailAddress, search_query: SEARCH, search_hits: (search.messages || []).length, recent: out, trusted_senders_configured: trusted().length };
}

// Read-only: open the .xlsx attached to one message and return its header + every row as the sheet holds it, so what a
// price list REALLY says can be compared with what the poller understood from it.
export async function dumpXlsx(messageId: string) {
  const XLSX = await import("npm:xlsx@0.18.5");
  const auth = { Authorization: `Bearer ${await accessToken()}` };
  const msg = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, { headers: auth })).json();
  const find = (p: any): any => (p.filename && p.filename.toLowerCase().endsWith(".xlsx") ? p : (p.parts || []).map(find).find(Boolean));
  const part = find(msg.payload || {});
  if (!part?.body?.attachmentId) return { error: "no .xlsx attached" };
  const att = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${part.body.attachmentId}`, { headers: auth })).json();
  const bin = atob(att.data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const wb = XLSX.read(bytes, { type: "array" });
  return { filename: part.filename, sheets: wb.SheetNames.map((n: string) => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 }) })) };
}

// onlyMessageId + inline are the verification mode (testBulletinMessage below): look at one specific message and process it in this same call.
export async function pollBulletinEmails(sql: any, maxResults = 10, opts: { onlyMessageId?: string; inline?: boolean; allowDegraded?: boolean } = {}) {
  const token = await accessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const list = opts.onlyMessageId
    ? { messages: [{ id: opts.onlyMessageId }] }
    : await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(SEARCH)}&maxResults=${maxResults}`, { headers: auth })).json();
  const results: any[] = [];
  const record = async (id: string, from: string, subject: string, status: string, reason: string | null, extra: { file_hash?: string; items?: unknown; bulletin_id?: string } = {}) => {
    await sql`
      insert into market_flash_email_inbox (message_id, from_email, subject, status, reason, file_hash, items, bulletin_id, processed_at)
      values (${id}, ${from}, ${subject}, ${status}, ${reason}, ${extra.file_hash ?? null}, ${extra.items ? sql.json(extra.items) : null}, ${extra.bulletin_id ?? null}, ${status === "pending" ? null : sql`now()`})
      on conflict (message_id) do nothing`;
    results.push({ id, status, reason });
  };
  // A bulletin candidate that is turned away is never only a log row: a person sees why, in "Mail needing attention".
  const reject = async (id: string, from: string, subject: string, reason: string, extra: { file_hash?: string } = {}) => {
    await record(id, from, subject, "rejected", reason, extra);
    await openMailIssue(sql, { messageId: id, handler: "market_flash", from, subject, code: "bulletin_not_read", detail: reason.slice(0, 500) });
  };
  for (const m of list.messages || []) {
    const [seen] = await sql`select 1 from market_flash_email_inbox where message_id = ${m.id}`;
    if (seen) continue;
    const msg = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: auth })).json();
    if (!msg.payload) { results.push({ id: m.id, skipped: "gmail_fetch_failed" }); continue; } // not recorded: try again next cycle
    const hs = msg.payload.headers || [];
    const fromRaw = header(hs, "From"), subject = header(hs, "Subject");
    const from = ((fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw).trim()).toLowerCase();
    // Not the bulletin at all (a report PDF from someone else): recorded so it is not fetched every cycle, but nobody needs to look at it.
    if (!isBulletinEmail(subject, msg.payload)) { await record(m.id, from, subject, "rejected", 'not the bulletin: no "flash" in the subject and no bi-weekly report PDF'); continue; }
    const sentByOwner = (msg.labelIds || []).includes("SENT");
    if (!sentByOwner) {
      if (!trusted().includes(from)) { await reject(m.id, from, subject, `a bulletin from ${from}, who is not one of the traders allowed to send it — forward it from purchasing@ to have it read`); continue; }
      if (!senderAuthenticated(header(hs, "Authentication-Results"))) { await reject(m.id, from, subject, "a bulletin whose sender could not be authenticated (no dmarc/spf+dkim pass) — not read; forward it from purchasing@ to have it read"); continue; }
    }
    const parts = pdfParts(msg.payload);
    if (!parts.length) { await reject(m.id, from, subject, "no PDF attached"); continue; }
    parts.sort((a, b) => (b.body.size || 0) - (a.body.size || 0)); // the bulletin is the big one
    const att = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/attachments/${parts[0].body.attachmentId}`, { headers: auth })).json();
    if (!att.data) { results.push({ id: m.id, skipped: "attachment_fetch_failed" }); continue; } // not recorded: tried again next cycle
    const bin = atob(att.data.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length < 10000 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "%PDF") { await reject(m.id, from, subject, "the attachment is not a PDF"); continue; }
    const file_hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const [dup] = await sql`select id from market_flash_bulletins where file_hash = ${file_hash}`;
    if (dup) { await record(m.id, from, subject, "ingested", "this exact bulletin was already loaded", { file_hash, bulletin_id: dup.id }); continue; }
    let items;
    try {
      items = (await readPdfItems(bytes)).map((p) => p.map((i) => [i.str, Math.round(i.x * 10) / 10, Math.round(i.y * 10) / 10]));
    } catch (e) { await reject(m.id, from, subject, `could not read the PDF: ${(e as Error).message}`, { file_hash }); continue; }
    await record(m.id, from, subject, "pending", null, { file_hash, items });
  }
  await surfaceUnreadCommentary(sql);
  // step (b) in its own invocation per message, so its compute budget is separate from the PDF read above
  const pending = await sql`select message_id from market_flash_email_inbox where status = 'pending' ${opts.onlyMessageId ? sql`and message_id = ${opts.onlyMessageId}` : sql``} order by created_at`;
  for (const p of pending) {
    if (opts.inline) { results.push(await processInboxMessage(sql, p.message_id, { requireNarrative: !opts.allowDegraded })); continue; }
    try {
      await fetch(SELF_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}`, apikey: API_KEY }, body: JSON.stringify({ process_market_flash_inbox: { message_id: p.message_id } }) });
    } catch (e) { results.push({ id: p.message_id, process_call_failed: String((e as Error).message) }); }
  }
  // step (c): a bulletin stored without its commentary is read again, at most once an hour, in its own invocation (it re-downloads the PDF)
  const stale = await sql`select id from market_flash_bulletins where narrative_error is not null and (narrative_retry_at is null or narrative_retry_at < now() - interval '1 hour') order by as_of desc limit 1`;
  for (const b of stale) {
    if (opts.inline) { results.push(await repairBulletinNarrative(sql, b.id)); continue; }
    try {
      await fetch(SELF_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}`, apikey: API_KEY }, body: JSON.stringify({ repair_market_flash_narrative: { bulletin_id: b.id } }) });
    } catch (e) { results.push({ id: b.id, repair_call_failed: String((e as Error).message) }); }
  }
  return { results, processed_pending: pending.length, commentary_repairs: stale.length };
}

// A bulletin stored without its commentary must be visible until the commentary is read: one issue per bulletin, closed by the repair itself.
async function surfaceUnreadCommentary(sql: any) {
  const rows = await sql`select b.id, b.as_of, b.narrative_error, exists (select 1 from market_flash_email_inbox i where i.file_hash = b.file_hash) as has_email from market_flash_bulletins b where b.narrative_error is not null`;
  for (const b of rows) {
    const asOf = String(b.as_of instanceof Date ? b.as_of.toISOString().slice(0, 10) : b.as_of);
    await openMailIssue(sql, {
      messageId: `bulletin:${b.id}`, handler: "market_flash", from: "Market Flash", subject: `Bulletin as of ${asOf}`, code: "narrative_not_read",
      detail: (b.has_email
        ? `This bulletin is stored without its commentary (${String(b.narrative_error).slice(0, 160)}). It is read again automatically when the AI service answers.`
        : `This bulletin is stored without its commentary (${String(b.narrative_error).slice(0, 160)}). It came from an upload: upload it again from Messaging → Market when the AI service answers.`),
    });
  }
}

// Reads the commentary of one stored bulletin whose commentary was never read: finds the email it came from, downloads the PDF again, reads it.
export async function repairBulletinNarrative(sql: any, bulletinId: string) {
  const [b] = await sql`select id, as_of, file_hash from market_flash_bulletins where id = ${bulletinId} and narrative_error is not null`;
  if (!b) return { skipped: "nothing to repair", bulletin_id: bulletinId };
  const [inbox] = await sql`select message_id from market_flash_email_inbox where file_hash = ${b.file_hash} order by created_at limit 1`;
  if (!inbox) return { bulletin_id: bulletinId, needs_reupload: true };
  const auth = { Authorization: `Bearer ${await accessToken()}` };
  const msg = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${inbox.message_id}?format=full`, { headers: auth })).json();
  const parts = pdfParts(msg.payload || {});
  if (!parts.length) { await sql`update market_flash_bulletins set narrative_retry_at = now() where id = ${bulletinId}`; return { bulletin_id: bulletinId, error: "the email no longer carries the PDF" }; }
  parts.sort((a, c) => (c.body.size || 0) - (a.body.size || 0));
  const att = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${inbox.message_id}/attachments/${parts[0].body.attachmentId}`, { headers: auth })).json();
  if (!att.data) return { bulletin_id: bulletinId, error: "the PDF could not be downloaded again" };
  const bin = atob(att.data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const items = (await readPdfItems(bytes)).map((p) => p.map((i) => [i.str, Math.round(i.x * 10) / 10, Math.round(i.y * 10) / 10]));
  const r = await completeNarrative(sql, bulletinId, items);
  if (!("retry" in r) && !("error" in r)) await closeMailIssue(sql, `bulletin:${bulletinId}`, "market_flash", "auto: commentary read");
  return { bulletin_id: bulletinId, ...r };
}

// Step (b): turn one stored message into a bulletin. Idempotent: only a 'pending' row is touched, and ingestBulletin itself is idempotent by file hash.
// A database failure leaves the row pending, so the next cycle retries it. The same when the AI service is down: the bulletin's commentary cannot
// be read, so NOTHING is stored and the row stays pending (its PDF text is kept) — a bulletin stored without its commentary would never be read again.
export async function processInboxMessage(sql: any, messageId: string, { requireNarrative = true }: { requireNarrative?: boolean } = {}) {
  const [row] = await sql`select message_id, from_email, subject, file_hash, items from market_flash_email_inbox where message_id = ${messageId} and status = 'pending'`;
  if (!row) return { skipped: "not pending" };
  const r = await ingestBulletin(sql, { items: row.items, file_hash: row.file_hash, actor: `email:${row.from_email}`, source: "email", requireNarrative });
  if ("error" in r) {
    if ((r as any).retry) return { message_id: messageId, status: "pending", will_retry: true, reason: (r as any).error };
    await sql`update market_flash_email_inbox set status = 'rejected', reason = ${r.error}, items = null, processed_at = now() where message_id = ${messageId}`;
    await openMailIssue(sql, { messageId, handler: "market_flash", from: row.from_email, subject: row.subject || "", code: "bulletin_not_read", detail: String(r.error).slice(0, 500) });
    return { message_id: messageId, status: "rejected", reason: r.error };
  }
  const narrativeError = (r as any).narrative_error as string | null;
  const reason = (r as any).idempotent_replay ? "this exact bulletin was already loaded" : narrativeError ? `stored, but its commentary could not be read: ${narrativeError}`.slice(0, 500) : null;
  await sql`update market_flash_email_inbox set status = 'ingested', reason = ${reason}, bulletin_id = ${(r as any).bulletin_id}, items = null, processed_at = now() where message_id = ${messageId}`;
  // A bulletin stored without its commentary is surfaced by surfaceUnreadCommentary (one issue per bulletin) and read again by the repair step.
  if (!narrativeError) await closeMailIssue(sql, messageId, "market_flash", "auto: read on retry");
  return { message_id: messageId, status: "ingested", ...r };
}

// Verification mode: takes ONE real message and runs the whole real path (classification, PDF read, ingest, inbox ledger, issues) inside a
// transaction that is always rolled back. The message and any bulletin made from it are first removed INSIDE the transaction so it is read as if
// brand new; the rollback puts everything back exactly as it was.
// Verification mode for the repair: the real repair of one stored bulletin inside a transaction that is always rolled back.
export async function testBulletinRepair(sql: any, bulletinId: string) {
  class Roll extends Error {}
  let out: any = null;
  try {
    await sql.begin(async (tx: any) => {
      const db = asTransactionDb(tx);
      const [before] = await db`select narrative_error is not null as unread, (select count(*)::int from market_flash_bullets where bulletin_id = ${bulletinId}) as bullets from market_flash_bulletins where id = ${bulletinId}`;
      const repaired = await repairBulletinNarrative(db, bulletinId);
      await surfaceUnreadCommentary(db);
      const [after] = await db`select narrative_error is not null as unread, (select count(*)::int from market_flash_bullets where bulletin_id = ${bulletinId}) as bullets from market_flash_bulletins where id = ${bulletinId}`;
      const issues = await db`select reason_code, left(reason_detail, 400) as detail from mail_intake_issues where message_id = ${"bulletin:" + bulletinId} and resolved_at is null`;
      out = { before, repaired, after, issues };
      throw new Roll();
    });
  } catch (e) { if (!(e instanceof Roll)) throw e; }
  return { rolled_back: true, ...out };
}

export async function testBulletinMessage(sql: any, messageId: string, { allowDegraded = false }: { allowDegraded?: boolean } = {}) {
  class Roll extends Error {}
  let out: any = null;
  try {
    await sql.begin(async (tx: any) => {
      const db = asTransactionDb(tx);
      const [prior] = await db`select file_hash from market_flash_email_inbox where message_id = ${messageId}`;
      await db`delete from market_flash_email_inbox where message_id = ${messageId}`;
      if (prior?.file_hash) await db`delete from market_flash_bulletins where file_hash = ${prior.file_hash}`;
      const polled = await pollBulletinEmails(db, 10, { onlyMessageId: messageId, inline: true, allowDegraded });
      const inbox = await db`select status, left(coalesce(reason, ''), 300) as reason, bulletin_id is not null as has_bulletin from market_flash_email_inbox where message_id = ${messageId}`;
      const bullets = await db`select count(*)::int as n, count(*) filter (where kind = 'narrative' or quote_en is not null)::int as narrative from market_flash_bullets where bulletin_id in (select bulletin_id from market_flash_email_inbox where message_id = ${messageId})`;
      await surfaceUnreadCommentary(db);
      const issues = await db`select handler, reason_code, left(reason_detail, 300) as detail from mail_intake_issues where resolved_at is null and (message_id = ${messageId} or message_id like 'bulletin:%')`;
      out = { polled, inbox, bullets: bullets[0], issues };
      throw new Roll();
    });
  } catch (e) { if (!(e instanceof Roll)) throw e; }
  return { rolled_back: true, ...out };
}
