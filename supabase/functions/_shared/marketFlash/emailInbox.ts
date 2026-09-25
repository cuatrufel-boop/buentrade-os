// Market Flash by email. Same Gmail inbox (and the same OAuth credentials) the other pollers read — no new access.
//
// A message is considered ONLY when its subject contains "Market Flash" and it carries a PDF. Because a doctored
// bulletin mailed to that inbox would end up in front of customers, three checks run before anything is read:
//   1. the sender must be one of the traders in TRADER_NOTIFICATION_EMAILS (the project's existing trusted list),
//   2. the sender must be authenticated (Gmail's Authentication-Results says dmarc=pass, or spf AND dkim pass) so
//      the From line can't simply be forged,
//   3. the PDF must then actually read as the bulletin (ingestBulletin refuses anything without the bulletin's data).
// Every candidate is recorded once in market_flash_email_inbox with its outcome and reason — nothing is invisible.
//
// Two steps, each its own invocation: (a) poll = find the message, download the PDF, read its text items (the heavy
// part, ~140 MB / ~1 s CPU) and store them; (b) process = run the bulletin through ingestBulletin from those stored
// items. Reading the PDF and processing it in ONE invocation was intermittently hitting the Edge compute limit.
import { ingestBulletin } from "./store.ts";
import { readPdfItems } from "./pdf.ts";

const SEARCH = 'subject:"Market Flash" has:attachment filename:pdf newer_than:14d';
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
const trusted = () => (Deno.env.get("TRADER_NOTIFICATION_EMAILS") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const pdfParts = (p: any): any[] => [
  ...(p.filename && p.body?.attachmentId && (p.mimeType === "application/pdf" || p.filename.toLowerCase().endsWith(".pdf")) ? [p] : []),
  ...(p.parts || []).flatMap(pdfParts),
];
// Gmail records how the sender authenticated. Accept a DMARC pass, or SPF and DKIM both passing.
export function senderAuthenticated(authResults: string): boolean {
  const a = authResults.toLowerCase();
  return /dmarc=pass/.test(a) || (/spf=pass/.test(a) && /dkim=pass/.test(a));
}

// Read-only look at what the inbox actually holds (sender, subject, date, attachment names — no bodies), for when a
// bulletin "should have arrived" and did not.
export async function diagnoseInbox(count = 8) {
  const auth = { Authorization: `Bearer ${await accessToken()}` };
  const list = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${count}`, { headers: auth })).json();
  const out: any[] = [];
  for (const m of list.messages || []) {
    const msg = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: auth })).json();
    const hs = msg.payload?.headers || [];
    const files = (function walk(p: any): string[] { return [...(p.filename ? [p.filename] : []), ...(p.parts || []).flatMap(walk)]; })(msg.payload || {});
    out.push({ id: m.id, from: header(hs, "From"), subject: header(hs, "Subject"), date: header(hs, "Date"), labels: msg.labelIds, attachments: files, auth: header(hs, "Authentication-Results").slice(0, 160) });
  }
  const search = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(SEARCH)}&maxResults=5`, { headers: auth })).json();
  const profile = await (await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: auth })).json();
  return { mailbox: profile.emailAddress, search_query: SEARCH, search_hits: (search.messages || []).length, recent: out, trusted_senders_configured: trusted().length };
}

export async function pollBulletinEmails(sql: any, maxResults = 10) {
  const token = await accessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const list = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(SEARCH)}&maxResults=${maxResults}`, { headers: auth })).json();
  const results: any[] = [];
  const record = async (id: string, from: string, subject: string, status: string, reason: string | null, extra: { file_hash?: string; items?: unknown; bulletin_id?: string } = {}) => {
    await sql`
      insert into market_flash_email_inbox (message_id, from_email, subject, status, reason, file_hash, items, bulletin_id, processed_at)
      values (${id}, ${from}, ${subject}, ${status}, ${reason}, ${extra.file_hash ?? null}, ${extra.items ? sql.json(extra.items) : null}, ${extra.bulletin_id ?? null}, ${status === "pending" ? null : sql`now()`})
      on conflict (message_id) do nothing`;
    results.push({ id, status, reason });
  };
  for (const m of list.messages || []) {
    const [seen] = await sql`select 1 from market_flash_email_inbox where message_id = ${m.id}`;
    if (seen) continue;
    const msg = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: auth })).json();
    if (!msg.payload) { results.push({ id: m.id, skipped: "gmail_fetch_failed" }); continue; } // not recorded: try again next cycle
    const hs = msg.payload.headers || [];
    const fromRaw = header(hs, "From"), subject = header(hs, "Subject");
    const from = ((fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw).trim()).toLowerCase();
    if (!/market\s*flash/i.test(subject)) { await record(m.id, from, subject, "rejected", "subject does not contain Market Flash"); continue; }
    if (!trusted().includes(from)) { await record(m.id, from, subject, "rejected", "sender is not one of the traders allowed to send a bulletin"); continue; }
    if (!senderAuthenticated(header(hs, "Authentication-Results"))) { await record(m.id, from, subject, "rejected", "sender could not be authenticated (no dmarc/spf+dkim pass) — not read"); continue; }
    const parts = pdfParts(msg.payload);
    if (!parts.length) { await record(m.id, from, subject, "rejected", "no PDF attached"); continue; }
    parts.sort((a, b) => (b.body.size || 0) - (a.body.size || 0)); // the bulletin is the big one
    const att = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/attachments/${parts[0].body.attachmentId}`, { headers: auth })).json();
    if (!att.data) { results.push({ id: m.id, skipped: "attachment_fetch_failed" }); continue; }
    const bin = atob(att.data.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length < 10000 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "%PDF") { await record(m.id, from, subject, "rejected", "the attachment is not a PDF"); continue; }
    const file_hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const [dup] = await sql`select id from market_flash_bulletins where file_hash = ${file_hash}`;
    if (dup) { await record(m.id, from, subject, "ingested", "this exact bulletin was already loaded", { file_hash, bulletin_id: dup.id }); continue; }
    let items;
    try {
      items = (await readPdfItems(bytes)).map((p) => p.map((i) => [i.str, Math.round(i.x * 10) / 10, Math.round(i.y * 10) / 10]));
    } catch (e) { await record(m.id, from, subject, "rejected", `could not read the PDF: ${(e as Error).message}`, { file_hash }); continue; }
    await record(m.id, from, subject, "pending", null, { file_hash, items });
  }
  // step (b) in its own invocation per message, so its compute budget is separate from the PDF read above
  const pending = await sql`select message_id from market_flash_email_inbox where status = 'pending' order by created_at`;
  for (const p of pending) {
    try {
      await fetch(SELF_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}`, apikey: API_KEY }, body: JSON.stringify({ process_market_flash_inbox: { message_id: p.message_id } }) });
    } catch (e) { results.push({ id: p.message_id, process_call_failed: String((e as Error).message) }); }
  }
  return { results, processed_pending: pending.length };
}

// Step (b): turn one stored message into a bulletin. Idempotent: only a 'pending' row is touched, and ingestBulletin
// itself is idempotent by file hash. A database failure leaves the row pending, so the next cycle retries it.
export async function processInboxMessage(sql: any, messageId: string) {
  const [row] = await sql`select message_id, from_email, file_hash, items from market_flash_email_inbox where message_id = ${messageId} and status = 'pending'`;
  if (!row) return { skipped: "not pending" };
  const r = await ingestBulletin(sql, { items: row.items, file_hash: row.file_hash, actor: `email:${row.from_email}`, source: "email" });
  if ("error" in r) {
    await sql`update market_flash_email_inbox set status = 'rejected', reason = ${r.error}, items = null, processed_at = now() where message_id = ${messageId}`;
    return { message_id: messageId, status: "rejected", reason: r.error };
  }
  await sql`update market_flash_email_inbox set status = 'ingested', reason = ${(r as any).idempotent_replay ? "this exact bulletin was already loaded" : null}, bulletin_id = ${(r as any).bulletin_id}, items = null, processed_at = now() where message_id = ${messageId}`;
  return { message_id: messageId, status: "ingested", ...r };
}
