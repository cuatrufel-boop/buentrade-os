// release-number-emails-poll — real gap found live 2026-09-14: confirmPlantPaymentSent already asks the plant's Payments Contact for the
// release number, right in the same email that confirms payment ("Payment & Release Number" subject) — but nothing ever read the plant's
// REPLY. Same shared reader as the other mailbox readers (_shared/mailIntake.ts: a plant is recognized by any of its contacts; automatic
// replies and the system's own mail are classified), plus one use of the Claude API to read a free-text reply for one specific value.
//
// Deliberately conservative: only ever touches a shipment that is actually waiting on a release number (plant_paid_at set, release_number
// still null) — never overwrites a value the trader already recorded, never guesses when the AI is not confident a real number was stated.
//
// Nothing fails silently: when the AI service is down the reply is left UNPROCESSED and read again next cycle (never marked done unread);
// a reply to the request that holds no release number opens an issue a person can see; an address nobody can place is written down.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";
import { callAnthropic, LLMUnavailableError } from "../_shared/llmExtractor.ts";
import {
  extractPlainText, getGmailAccessToken, headerValue, isAutoReply, isBulletinEmail, openMailIssue, recordUnrecognizedSender, resolveSender, senderAddress, sendOrderPush,
} from "../_shared/mailIntake.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const MODEL = "claude-sonnet-5";

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

export async function extractReleaseNumber(bodyText: string): Promise<{ found: boolean; release_number: string }> {
  const data = await callAnthropic({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: bodyText || "(empty body)" }],
    output_format: { type: "json_schema", schema: RELEASE_SCHEMA },
  });
  const textBlock = (data.content || []).find((b: any) => b.type === "text");
  if (!textBlock) throw new Error(`No text content in Anthropic response: ${JSON.stringify(data)}`);
  return JSON.parse(textBlock.text);
}

export type ReleaseDeps = {
  extract: (bodyText: string) => Promise<{ found: boolean; release_number: string }>;
  push: (actor: string, title: string, body: string, orderNumber: string) => Promise<void>;
};

export async function processMessage(db: any, deps: ReleaseDeps, msgData: any, { dryRun = false }: { dryRun?: boolean } = {}): Promise<Record<string, unknown>> {
  const id: string = msgData.id;
  const headers = msgData.payload.headers;
  const subject = headerValue(headers, "Subject");
  const fromEmail = senderAddress(headerValue(headers, "From"));
  const done = async (fields: { order?: string | null; number?: string | null; updated?: boolean } = {}) => {
    if (dryRun) return;
    await db`
      insert into release_number_emails_processed (message_id, from_email, subject, order_number_detected, release_number_extracted, shipment_updated)
      values (${id}, ${fromEmail}, ${subject}, ${fields.order ?? null}, ${fields.number ?? null}, ${fields.updated ?? false})
      on conflict (message_id) do nothing
    `;
  };

  // The bi-weekly market bulletin (PDF) belongs to Market Flash's own reader.
  if (isBulletinEmail(subject, msgData.payload)) { await done(); return { id, skipped: "market_flash_bulletin" }; }

  const resolved = await resolveSender(db, fromEmail);
  if (resolved.kind === "internal" || resolved.kind === "automated") { await done(); return { id, skipped: `${resolved.kind}_sender` }; }
  if (resolved.kind === "carrier") { await done(); return { id, skipped: "carrier_not_asked_for_release_number", from: fromEmail }; }
  if (resolved.kind !== "plant") {
    if (!dryRun) {
      await recordUnrecognizedSender(db, {
        from: fromEmail, subject, messageId: id,
        reason: resolved.kind === "ambiguous" ? "ambiguous_sender" : "unknown_sender", candidates: resolved.kind === "ambiguous" ? resolved.candidates : [],
      });
    }
    await done();
    return { id, skipped: "no_matching_plant", from: fromEmail };
  }

  if (isAutoReply(subject, (n) => headerValue(headers, n))) { await done(); return { id, skipped: "auto_reply" }; }

  // Same consecutive-order-number match as pickup-docs-emails-poll — the subject we sent was literally "{order_number} — BuenTrade —
  // Payment & Release Number", so a plain reply quotes it back unchanged. order_number is the FULL "BT-2026-1001" string.
  const bodyText = extractPlainText(msgData.payload);
  const orderMatch = (subject + " " + bodyText).match(/(BT-\d{4}-\d+)/);
  const orderNumber = orderMatch ? orderMatch[1] : null;
  if (!orderNumber) { await done(); return { id, skipped: "no_order_number_detected", from: fromEmail }; }

  const [shipment] = await db`
    select sh.*, o.won_by, o.plant_name
    from shipments sh join sent_offers o on o.id = sh.sent_offer_id
    where sh.order_number = ${orderNumber}
  `;
  // Conservative on purpose: only act while this shipment is actually waiting on a release number (paid, none recorded yet).
  if (!shipment || !shipment.plant_paid_at || shipment.release_number) {
    await done({ order: orderNumber });
    return { id, skipped: "shipment_not_awaiting_release_number", order_number: orderNumber };
  }

  let extracted: { found: boolean; release_number: string };
  try { extracted = await deps.extract(bodyText || subject); }
  catch (e) {
    if (e instanceof LLMUnavailableError) {
      // The AI service is down: the reply was NOT read. Left unprocessed so the next cycle reads it — never marked done unread.
      return { id, skipped: "llm_unavailable_will_retry", order_number: orderNumber, detail: String(e).slice(0, 200) };
    }
    if (!dryRun) await openMailIssue(db, { messageId: id, handler: "release_number", from: fromEmail, subject, code: "extraction_failed", detail: `Could not read this reply for ${orderNumber}: ${String(e).slice(0, 300)}` });
    await done({ order: orderNumber });
    return { id, skipped: "extraction_failed", order_number: orderNumber, error: String(e) };
  }

  let updated = false;
  if (extracted.found && extracted.release_number) {
    if (!dryRun) {
      await db.begin(async (tx: any) => {
        const [updatedShipment] = await tx`update shipments set release_number = ${extracted.release_number} where id = ${shipment.id} returning *`;
        await writeAuditLog(tx, HMAC_SECRET, { actor: "release-number-emails-poll", action: "update", table_name: "shipments", record_id: shipment.id, before: shipment, after: updatedShipment });
      });
    }
    updated = true;
    if (!dryRun && shipment.won_by) {
      await deps.push(shipment.won_by, `Release # recibido — ${orderNumber} — ${shipment.plant_name || ""}`,
        `La planta respondió con el release number (${extracted.release_number}). El siguiente paso ya está listo.`, orderNumber);
    }
  } else if (!dryRun) {
    // The plant answered the request but no release number is in the reply: a person has to look — never left only in a log row.
    await openMailIssue(db, { messageId: id, handler: "release_number", from: fromEmail, subject, code: "release_number_not_found", detail: `The plant replied about ${orderNumber} but no release number was found in the reply` });
  }
  await done({ order: orderNumber, number: extracted.found ? extracted.release_number : null, updated });
  return { id, order_number: orderNumber, found: extracted.found, updated };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const maxResults = body.max_results || 20;
    // Verification aids: test_message_id reads one specific message; dry_run decides everything but writes and sends nothing.
    const testMessageId = body.test_message_id || null;
    const dryRun = body.dry_run === true;
    const accessToken = await getGmailAccessToken();
    const authHeaders = { Authorization: `Bearer ${accessToken}` };
    const deps: ReleaseDeps = { extract: extractReleaseNumber, push: sendOrderPush };

    let listData: { messages?: { id: string }[] };
    if (testMessageId) listData = { messages: [{ id: testMessageId }] };
    else {
      const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`, { headers: authHeaders });
      listData = await listRes.json();
      if (!listRes.ok) throw new Error(`Gmail list failed: ${JSON.stringify(listData)}`);
    }

    const results = [];
    for (const m of listData.messages || []) {
      const [already] = await sql`select message_id from release_number_emails_processed where message_id = ${m.id}`;
      if (already && !(dryRun && testMessageId)) { results.push({ id: m.id, skipped: "already_processed" }); continue; }
      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: authHeaders });
      const msgData = await msgRes.json();
      if (!msgRes.ok) { results.push({ id: m.id, skipped: "gmail_fetch_failed" }); continue; }
      results.push(await processMessage(sql, deps, msgData, { dryRun }));
    }
    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
