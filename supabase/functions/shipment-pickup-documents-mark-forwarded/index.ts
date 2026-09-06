// shipment_pickup_documents.markForwarded — called only after the trader has actually confirmed
// sending these real pickup documents (BOL/packing list/photos/USDA) to the customs agency (see
// offers.html's shareCustomsPickupDocs). Marks every listed document id as forwarded so it drops
// off the Status tab's pending-documents list and never gets re-sent on the next visit.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "document_ids"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, document_ids } = body;
    if (!Array.isArray(document_ids) || !document_ids.length) return jsonResponse({ error: "document_ids must be a non-empty array" }, 400);

    const updated = await sql.begin(async (tx) => {
      const rows = await tx`update shipment_pickup_documents set forwarded_to_customs_at = now() where id = any(${document_ids}) returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "shipment_pickup_documents", record_id: document_ids.join(","), after: rows });
      return rows;
    });

    return jsonResponse({ updated: true, documents: updated });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
