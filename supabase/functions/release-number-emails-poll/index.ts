// release-number-emails-poll — real gap found live 2026-09-14: confirmPlantPaymentSent already
// asks the plant's Payments Contact for the release number, right in the same email that confirms
// payment ("Payment & Release Number" subject) — but nothing ever read the plant's REPLY. The
// trader had to open the email themselves and type the value into a prompt() (recordReleaseNumber).
// Same architecture as pickup-docs-emails-poll (same Gmail inbox, same sender→plant matching, same
// order-number-in-subject/body regex) plus one real use of the Claude API extraction pattern
// already established in _shared/llmExtractor.ts — reading a free-text reply for one specific real
// value, not deciding anything on its own (the WHEN to alert/poll stays deterministic, per the
// standing rule in project_order_lifecycle_and_alerting_spec).
//
// Deliberately conservative: only ever touches a shipment that's actually waiting on a release
// number (plant_paid_at set, release_number still null) — never overwrites a value the trader
// already recorded by hand, and never guesses when the LLM isn't confident a real release number
// was actually stated.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const GMAIL_CLIENT_ID = Deno.env.get("GMAIL_CLIENT_ID")!;
const GMAIL_CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET")!;
const GMAIL_REFRESH_TOKEN = Deno.env.get("GMAIL_REFRESH_TOKEN")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = "claude-sonnet-5";

async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN, grant_type: "refresh_token",
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
function extractPlainText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBase64Url(payload.body.data);
  for (const part of payload.parts || []) { const found = extractPlainText(part); if (found) return found; }
  return "";
}

const RELEASE_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean", description: "true only if this email genuinely states a real release number (also called release #, pickup number, PU number, authorization/auth number) for a load pickup." },
    release_number: { type: "string", description: "The exact release number as written (digits/letters, whatever the plant sent) — empty string if found is false." },
  },
  required: ["found", "release_number"],
  additionalProperties: false,
};
const SYSTEM_PROMPT = `You read one email reply from a meat-packing plant's payments/logistics contact, replying to BuenTrade's request for a "release number" (also called release #, pickup number, PU number, or authorization number) needed for a carrier to pick up a paid-for load.

Decide whether this email states a real release number, and if so, extract it exactly as written.
- Only extract a genuine release/pickup/authorization number for THIS pickup — never a PO number, invoice number, order number, phone number, or any other unrelated number that happens to appear.
- A short reply like "Release # is 48213" or just "48213" (when the quoted original message clearly asked for the release number) both count.
- If the email doesn't actually contain a release number (e.g. it just confirms receipt, asks a question, or is unrelated), set found to false and release_number to an empty string. Do not guess.`;

async function extractReleaseNumber(bodyText: string): Promise<{ found: boolean; release_number: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "structured-outputs-2025-11-13",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: bodyText || "(empty body)" }],
      output_format: { type: "json_schema", schema: RELEASE_SCHEMA },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic API failed: ${JSON.stringify(data)}`);
  const textBlock = (data.content || []).find((b: any) => b.type === "text");
  if (!textBlock) throw new Error(`No text content in Anthropic response: ${JSON.stringify(data)}`);
  return JSON.parse(textBlock.text);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const maxResults = body.max_results || 20;
    const accessToken = await getAccessToken();
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`, { headers: authHeaders });
    const listData = await listRes.json();
    if (!listRes.ok) throw new Error(`Gmail list failed: ${JSON.stringify(listData)}`);

    const results = [];
    for (const m of listData.messages || []) {
      const [already] = await sql`select message_id from release_number_emails_processed where message_id = ${m.id}`;
      if (already) { results.push({ id: m.id, skipped: "already_processed" }); continue; }

      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: authHeaders });
      const msgData = await msgRes.json();
      if (!msgRes.ok) { results.push({ id: m.id, skipped: "gmail_fetch_failed" }); continue; }

      const fromHeader = headerValue(msgData.payload.headers, "From");
      const subject = headerValue(msgData.payload.headers, "Subject");
      const emailMatch = fromHeader.match(/<([^>]+)>/);
      const fromEmail = (emailMatch ? emailMatch[1] : fromHeader).trim().toLowerCase();

      const [plant] = await sql`select id, name from plants where lower(email) = ${fromEmail} or lower(payments_email) = ${fromEmail}`;
      if (!plant) {
        await sql`insert into release_number_emails_processed (message_id, from_email, subject) values (${m.id}, ${fromEmail}, ${subject}) on conflict (message_id) do nothing`;
        results.push({ id: m.id, skipped: "no_matching_plant", from: fromEmail });
        continue;
      }

      // Same consecutive-order-number match as pickup-docs-emails-poll — the subject we sent was
      // literally "{order_number} — BuenTrade — Payment & Release Number", so a plain reply quotes
      // it back unchanged (still matches even without a PO-/SO-/FO- prefix).
      const bodyText = extractPlainText(msgData.payload);
      const orderMatch = (subject + " " + bodyText).match(/(\d{4}-\d+)/);
      const orderNumber = orderMatch ? orderMatch[1] : null;

      if (!orderNumber) {
        await sql`insert into release_number_emails_processed (message_id, from_email, subject) values (${m.id}, ${fromEmail}, ${subject}) on conflict (message_id) do nothing`;
        results.push({ id: m.id, skipped: "no_order_number_detected", from: fromEmail });
        continue;
      }

      const [shipment] = await sql`select * from shipments where order_number = ${orderNumber}`;
      // Conservative on purpose: only act while this shipment is actually waiting on a release
      // number (paid, none recorded yet) — never overwrite a value the trader already entered by
      // hand, and never touch a shipment that never asked for one.
      if (!shipment || !shipment.plant_paid_at || shipment.release_number) {
        await sql`insert into release_number_emails_processed (message_id, from_email, subject, order_number_detected) values (${m.id}, ${fromEmail}, ${subject}, ${orderNumber}) on conflict (message_id) do nothing`;
        results.push({ id: m.id, skipped: "shipment_not_awaiting_release_number", order_number: orderNumber });
        continue;
      }

      let extracted;
      try { extracted = await extractReleaseNumber(bodyText || subject); }
      catch (e) {
        await sql`insert into release_number_emails_processed (message_id, from_email, subject, order_number_detected) values (${m.id}, ${fromEmail}, ${subject}, ${orderNumber}) on conflict (message_id) do nothing`;
        results.push({ id: m.id, skipped: "extraction_failed", order_number: orderNumber, error: String(e) });
        continue;
      }

      let updated = false;
      if (extracted.found && extracted.release_number) {
        await sql.begin(async (tx) => {
          const [updatedShipment] = await tx`update shipments set release_number = ${extracted.release_number} where id = ${shipment.id} returning *`;
          await writeAuditLog(tx, HMAC_SECRET, { actor: "release-number-emails-poll", action: "update", table_name: "shipments", record_id: shipment.id, before: shipment, after: updatedShipment });
        });
        updated = true;
      }

      await sql`
        insert into release_number_emails_processed (message_id, from_email, subject, order_number_detected, release_number_extracted, shipment_updated)
        values (${m.id}, ${fromEmail}, ${subject}, ${orderNumber}, ${extracted.found ? extracted.release_number : null}, ${updated})
        on conflict (message_id) do nothing
      `;
      results.push({ id: m.id, order_number: orderNumber, found: extracted.found, updated });
    }

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
