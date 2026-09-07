// shipments.markDocSent — records that a specific document (PO/SO/FO, customs paperwork, or the
// signed Invoice) was actually emailed for this order. By order_number (not shipment id) so the
// callers — sharePO/shareSO/shareFO/shareCustoms in offers.html, and the invoice-send flow in
// orders.html — which only ever know the order_number, don't need a second lookup. Called once per
// successful send; calling it again on a resend just moves the timestamp forward, which is the
// correct behavior (the doc really was sent again, more recently).
// so/invoice added 2026-09-06, building the Orders "Documents" panel: shareSO never tracked its
// send at all, and the signed Invoice had no tracking whatsoever before this.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const VALID_DOC_TYPES = ["po", "so", "fo", "customs", "invoice", "release_number"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "order_number", "doc_type"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, order_number, doc_type } = body;

    if (!VALID_DOC_TYPES.includes(doc_type)) return jsonResponse({ error: "invalid doc_type", valid_doc_types: VALID_DOC_TYPES }, 400);

    const [existing] = await sql`select * from shipments where order_number = ${order_number}`;
    if (!existing) return jsonResponse({ error: "unknown order_number" }, 404);

    const shipment = await sql.begin(async (tx) => {
      // Explicit per-column branches, not a dynamic identifier — matches how every other update
      // endpoint in this codebase is written (freight-orders-update, shipments-update-status), and
      // keeps a typo in doc_type from ever being able to reach raw SQL as a column name.
      let updated;
      if (doc_type === "po") [updated] = await tx`update shipments set po_sent_at = now() where order_number = ${order_number} returning *`;
      else if (doc_type === "so") [updated] = await tx`update shipments set so_sent_at = now() where order_number = ${order_number} returning *`;
      else if (doc_type === "fo") [updated] = await tx`update shipments set fo_sent_at = now() where order_number = ${order_number} returning *`;
      else if (doc_type === "invoice") [updated] = await tx`update shipments set invoice_sent_at = now() where order_number = ${order_number} returning *`;
      else if (doc_type === "release_number") [updated] = await tx`update shipments set release_number_sent_at = now() where order_number = ${order_number} returning *`;
      else [updated] = await tx`update shipments set customs_sent_at = now() where order_number = ${order_number} returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "shipments", record_id: existing.id, before: existing, after: updated });
      return updated;
    });

    return jsonResponse({ updated: true, shipment });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
