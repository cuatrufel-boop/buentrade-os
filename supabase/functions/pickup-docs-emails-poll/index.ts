// pickup-docs-emails-poll — point 6 of the frozen order-lifecycle flow: the plant AND/OR carrier email BOL, packing list, label photos
// (always), and USDA papers (if the order is "Docs") once they pick up. Reads the SAME Gmail inbox as plant-price-emails-poll through the
// same shared reader (_shared/mailIntake.ts): who the sender is (a plant by any of its contacts, or a carrier), automatic replies and the
// system's own mail are classified, never read as documents.
//
// A document is matched to an order ONLY by an order number the sender stated (BT-####-####), never guessed. A plant's email that states
// no order number and is not about pickup documents (its price list, specs, policy PDFs) is NOT filed here — the price reader owns it and
// shows what it cannot read in Pending Matches; filing it here put 19 price-list files in the pickup queue. A carrier's attachments with no
// order number are queued unmatched for a person.
//
// Nothing fails silently: an attachment that cannot be downloaded or saved leaves the message UNPROCESSED (it is retried every cycle) and
// opens an issue that stays visible until a retry succeeds; an address nobody can place is written down for a person to assign or dismiss.
// Never auto-forwards to customs — a separate, explicit trader action.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";
import {
  closeMailIssue, extractPlainText, getGmailAccessToken, headerValue, isAutoReply, openMailIssue, recordUnrecognizedSender,
  resolveSender, senderAddress, sendOrderPush,
} from "../_shared/mailIntake.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const STORAGE_API_KEY = Deno.env.get("API_PUBLISHABLE_KEY") || "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe";
const STORAGE_ROOT = "https://geqhjykbxvxugvnpnygn.supabase.co/storage/v1/object";

export type PickupDeps = {
  fetchAttachment: (msgId: string, attachmentId: string) => Promise<{ ok: boolean; data?: string; detail?: string }>;
  upload: (path: string, bytes: Uint8Array, mime: string) => Promise<{ ok: boolean; detail?: string }>;
  push: (actor: string, title: string, body: string, orderNumber: string) => Promise<void>;
};

// What a pickup-documents email is about, from its subject and attachment names only (never the body: a price email's footer says "pickup").
const PICKUP_DOC_HINT = /\b(bol|bills? of lading|packing (list|slip)|pick-?up|usda|certificates?|release|label)s?\b/i;
export function looksLikePickupDocs(subject: string, filenames: string[]): boolean {
  return PICKUP_DOC_HINT.test(subject) || filenames.some((f) => PICKUP_DOC_HINT.test(f.replace(/[_.\-]+/g, " ")));
}

// Real, honest attachments only — a filename present (inline logos/signatures in HTML mail normally don't carry one).
export function findAttachmentParts(p: any): any[] {
  const out: any[] = [];
  if (p.filename && p.body?.attachmentId) out.push(p);
  for (const part of p.parts || []) out.push(...findAttachmentParts(part));
  return out;
}

export async function processMessage(db: any, deps: PickupDeps, msgData: any, { dryRun = false }: { dryRun?: boolean } = {}): Promise<Record<string, unknown>> {
  const id: string = msgData.id;
  const headers = msgData.payload.headers;
  const subject = headerValue(headers, "Subject");
  const fromEmail = senderAddress(headerValue(headers, "From"));
  const done = async (fields: { order?: string | null; matched?: boolean; saved?: number } = {}) => {
    if (dryRun) return;
    await db`
      insert into pickup_docs_emails_processed (message_id, from_email, subject, order_number_detected, shipment_matched, attachments_found)
      values (${id}, ${fromEmail}, ${subject}, ${fields.order ?? null}, ${fields.matched ?? false}, ${fields.saved ?? 0})
      on conflict (message_id) do nothing
    `;
  };

  const resolved = await resolveSender(db, fromEmail);
  if (resolved.kind === "internal" || resolved.kind === "automated") { await done(); return { id, skipped: `${resolved.kind}_sender` }; }
  if (resolved.kind !== "plant" && resolved.kind !== "carrier") {
    // An address nobody could place is written down for a person to assign to a plant or dismiss — never silently dropped.
    if (!dryRun) {
      await recordUnrecognizedSender(db, {
        from: fromEmail, subject, messageId: id,
        reason: resolved.kind === "ambiguous" ? "ambiguous_sender" : "unknown_sender", candidates: resolved.kind === "ambiguous" ? resolved.candidates : [],
      });
    }
    await done();
    return { id, skipped: "no_matching_plant_or_carrier", from: fromEmail };
  }
  const source: "plant" | "carrier" = resolved.kind;

  if (isAutoReply(subject, (n) => headerValue(headers, n))) { await done(); return { id, skipped: "auto_reply" }; }

  const attachmentParts = findAttachmentParts(msgData.payload);
  if (!attachmentParts.length) { await done(); return { id, skipped: "no_attachments", from: fromEmail }; }

  // A real order number stated by the sender is the only thing this ever matches on — never guessed from which plant/carrier sent it,
  // since one can easily have more than one open shipment. A plant/carrier quotes back whichever document we sent (PO/SO/FO/INV prefix).
  const bodyText = extractPlainText(msgData.payload);
  const orderMatch = (subject + " " + bodyText).match(/(?:PO|SO|FO|INV)-(BT-\d{4}-\d+)/i);
  const orderNumber = orderMatch ? orderMatch[1] : null;

  if (source === "plant" && !orderNumber && !looksLikePickupDocs(subject, attachmentParts.map((p) => p.filename))) {
    await done();
    return { id, skipped: "not_pickup_documents", from: fromEmail };
  }

  let shipmentId: string | null = null;
  let wonBy: string | null = null;
  let plantName: string | null = null;
  if (orderNumber) {
    const [shipment] = await db`
      select sh.id, o.won_by, o.plant_name
      from shipments sh join sent_offers o on o.id = sh.sent_offer_id
      where sh.order_number = ${orderNumber}
    `;
    if (shipment) { shipmentId = shipment.id; wonBy = shipment.won_by; plantName = shipment.plant_name; }
  }

  let savedCount = 0;
  const failed: { filename: string; why: string }[] = [];
  for (const part of attachmentParts) {
    try {
      const att = await deps.fetchAttachment(id, part.body.attachmentId);
      if (!att.ok || !att.data) { failed.push({ filename: part.filename, why: `download: ${att.detail || "no data"}` }); continue; }
      const b64 = att.data.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const storagePath = `pickup-docs/${orderNumber || "unmatched-" + id}/${part.filename}`;
      if (dryRun) { savedCount++; continue; }
      const up = await deps.upload(storagePath, bytes, part.mimeType || "application/octet-stream");
      if (!up.ok) { failed.push({ filename: part.filename, why: `upload: ${up.detail || "failed"}` }); continue; }
      const storageUrl = `https://geqhjykbxvxugvnpnygn.supabase.co/storage/v1/object/public/order-documents/${storagePath}`;
      await db`
        insert into shipment_pickup_documents (shipment_id, order_number, message_id, from_email, source, filename, storage_url)
        values (${shipmentId}, ${orderNumber}, ${id}, ${fromEmail}, ${source}, ${part.filename}, ${storageUrl})
        on conflict (message_id, filename) do nothing
      `;
      savedCount++;
    } catch (e) {
      failed.push({ filename: part.filename, why: String(e).slice(0, 200) });
    }
  }

  if (failed.length) {
    // Not marked processed: the next cycle retries (saving is idempotent). The issue stays visible until a retry succeeds.
    if (!dryRun) {
      await openMailIssue(db, { messageId: id, handler: "pickup_docs", from: fromEmail, subject, code: "attachment_not_saved", detail: failed.map((f) => `${f.filename} (${f.why})`).join("; ").slice(0, 500) });
    }
    return { id, source, order_number: orderNumber, shipment_matched: shipmentId !== null, attachments_saved: savedCount, attachments_failed: failed, will_retry: true };
  }

  if (!dryRun) await closeMailIssue(db, id, "pickup_docs", "auto: saved on retry");
  await done({ order: orderNumber, matched: shipmentId !== null, saved: savedCount });
  if (!dryRun && savedCount > 0 && wonBy && orderNumber) {
    await deps.push(wonBy, `Documentos de pickup recibidos — ${orderNumber} — ${plantName || ""}`,
      `Llegaron ${savedCount} documento${savedCount === 1 ? "" : "s"} (BOL/packing list/fotos). El siguiente paso ya está listo.`, orderNumber);
  }
  return { id, source, order_number: orderNumber, shipment_matched: shipmentId !== null, attachments_saved: savedCount };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const maxResults = body.max_results || 20;
    // Verification aids (nothing else changes): test_message_id reads one specific message; dry_run decides everything but writes,
    // uploads and sends nothing.
    const testMessageId = body.test_message_id || null;
    const dryRun = body.dry_run === true;
    const accessToken = await getGmailAccessToken();
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    const deps: PickupDeps = {
      fetchAttachment: async (msgId, attachmentId) => {
        const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${attachmentId}`, { headers: authHeaders });
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok && !!data.data, data: data.data, detail: res.ok ? undefined : `Gmail answered ${res.status}` };
      },
      upload: async (path, bytes, mime) => {
        const res = await fetch(`${STORAGE_ROOT}/order-documents/${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${STORAGE_API_KEY}`, apikey: STORAGE_API_KEY, "Content-Type": mime, "x-upsert": "true" },
          body: bytes,
        });
        return { ok: res.ok, detail: res.ok ? undefined : `storage answered ${res.status}` };
      },
      push: sendOrderPush,
    };

    let listData: { messages?: { id: string }[] };
    if (testMessageId) listData = { messages: [{ id: testMessageId }] };
    else {
      const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`, { headers: authHeaders });
      listData = await listRes.json();
      if (!listRes.ok) throw new Error(`Gmail list failed: ${JSON.stringify(listData)}`);
    }

    const results = [];
    for (const m of listData.messages || []) {
      const [already] = await sql`select message_id from pickup_docs_emails_processed where message_id = ${m.id}`;
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
