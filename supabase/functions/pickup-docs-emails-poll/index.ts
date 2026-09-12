// pickup-docs-emails-poll — point 6 of the frozen order-lifecycle flow: the plant AND/OR carrier
// email BOL, packing list, label photos (always), and USDA papers (if the order is "Docs") once
// they pick up. Reads the SAME Gmail inbox plant-price-emails-poll already reads (the only inbox
// this project has OAuth access to — same GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN, no new credential),
// matches the sender to a plant OR a carrier, pulls a BT-#### order number out of the subject/body
// if the sender stated one, and saves every real attachment to the same order-documents storage
// bucket the PO/SO/FO/Factura PDFs already live in.
//
// Never auto-forwards to customs — that's a separate, explicit trader action (see offers.html's
// pickup-docs review UI). This function only collects and matches; matching to the WRONG order
// would be a serious business mistake, so an email with no detectable order number is queued
// unmatched (shipment_id null) rather than guessed at.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });

const GMAIL_CLIENT_ID = Deno.env.get("GMAIL_CLIENT_ID")!;
const GMAIL_CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET")!;
const GMAIL_REFRESH_TOKEN = Deno.env.get("GMAIL_REFRESH_TOKEN")!;
const STORAGE_API_KEY = Deno.env.get("API_PUBLISHABLE_KEY") || "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe";
const STORAGE_ROOT = "https://geqhjykbxvxugvnpnygn.supabase.co/storage/v1/object";

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

// Real, honest attachments only — a filename present (inline logos/signatures in HTML mail
// normally don't carry one the way a deliberately-attached file does).
function findAttachmentParts(p: any): any[] {
  const out: any[] = [];
  if (p.filename && p.body?.attachmentId) out.push(p);
  for (const part of p.parts || []) out.push(...findAttachmentParts(part));
  return out;
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
      const [already] = await sql`select message_id from pickup_docs_emails_processed where message_id = ${m.id}`;
      if (already) { results.push({ id: m.id, skipped: "already_processed" }); continue; }

      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: authHeaders });
      const msgData = await msgRes.json();
      if (!msgRes.ok) { results.push({ id: m.id, skipped: "gmail_fetch_failed" }); continue; }

      const fromHeader = headerValue(msgData.payload.headers, "From");
      const subject = headerValue(msgData.payload.headers, "Subject");
      const emailMatch = fromHeader.match(/<([^>]+)>/);
      const fromEmail = (emailMatch ? emailMatch[1] : fromHeader).trim().toLowerCase();

      const [plant] = await sql`select id, name from plants where lower(email) = ${fromEmail}`;
      const [carrier] = plant ? [null] : await sql`select id, name from providers where lower(email) = ${fromEmail}`;
      const source: "plant" | "carrier" | "unknown" = plant ? "plant" : carrier ? "carrier" : "unknown";

      if (source === "unknown") {
        await sql`insert into pickup_docs_emails_processed (message_id, from_email, subject) values (${m.id}, ${fromEmail}, ${subject}) on conflict (message_id) do nothing`;
        results.push({ id: m.id, skipped: "no_matching_plant_or_carrier", from: fromEmail });
        continue;
      }

      const attachmentParts = findAttachmentParts(msgData.payload);
      if (!attachmentParts.length) {
        await sql`insert into pickup_docs_emails_processed (message_id, from_email, subject) values (${m.id}, ${fromEmail}, ${subject}) on conflict (message_id) do nothing`;
        results.push({ id: m.id, skipped: "no_attachments", from: fromEmail });
        continue;
      }

      // A real order number stated by the sender is the only thing this ever matches on — never
      // guessed from which plant/carrier sent it, since a plant/carrier can easily have more than
      // one open shipment at once. Real change 2026-09-12: order_number dropped the old "BT-0042"
      // scheme for a single per-order consecutive ("2026-1001") shared by its PO/SO/FO/Invoice —
      // each document reads "PO-BT-2026-1001" (doc type, then BT-, then the consecutive) — a
      // plant/carrier realistically quotes back whichever document we sent them, so this matches
      // any of the four prefixes and strips them before comparing against shipments.order_number,
      // which stores the bare consecutive only.
      const bodyText = extractPlainText(msgData.payload);
      const orderMatch = (subject + " " + bodyText).match(/(?:PO|SO|FO|INV)-BT-(\d{4}-\d+)/i);
      const orderNumber = orderMatch ? orderMatch[1] : null;

      let shipmentId: string | null = null;
      if (orderNumber) {
        const [shipment] = await sql`select id from shipments where order_number = ${orderNumber}`;
        if (shipment) shipmentId = shipment.id;
      }

      let savedCount = 0;
      for (const part of attachmentParts) {
        try {
          const attRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/attachments/${part.body.attachmentId}`,
            { headers: authHeaders },
          );
          const attData = await attRes.json();
          if (!attRes.ok || !attData.data) continue;
          const b64 = (attData.data as string).replace(/-/g, "+").replace(/_/g, "/");
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

          const storagePath = `pickup-docs/${orderNumber || "unmatched-" + m.id}/${part.filename}`;
          const uploadRes = await fetch(`${STORAGE_ROOT}/order-documents/${storagePath}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${STORAGE_API_KEY}`, apikey: STORAGE_API_KEY,
              "Content-Type": part.mimeType || "application/octet-stream", "x-upsert": "true",
            },
            body: bytes,
          });
          if (!uploadRes.ok) continue;
          const storageUrl = `https://geqhjykbxvxugvnpnygn.supabase.co/storage/v1/object/public/order-documents/${storagePath}`;

          await sql`
            insert into shipment_pickup_documents (shipment_id, order_number, message_id, from_email, source, filename, storage_url)
            values (${shipmentId}, ${orderNumber}, ${m.id}, ${fromEmail}, ${source}, ${part.filename}, ${storageUrl})
            on conflict (message_id, filename) do nothing
          `;
          savedCount++;
        } catch { /* one attachment failing never blocks the others */ }
      }

      await sql`
        insert into pickup_docs_emails_processed (message_id, from_email, subject, order_number_detected, shipment_matched, attachments_found)
        values (${m.id}, ${fromEmail}, ${subject}, ${orderNumber}, ${shipmentId !== null}, ${savedCount})
        on conflict (message_id) do nothing
      `;
      results.push({ id: m.id, source, order_number: orderNumber, shipment_matched: shipmentId !== null, attachments_saved: savedCount });
    }

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
