// orders.invoiceSignature — one function, two actions, kept to one to stay under Supabase's
// 100-function project cap (already hit once this week).
//
// action "issue" (called from trading-tool.html's Real Costs panel, "Create Invoice"): generates a
// fresh unguessable token and saves it on the shipment. This is what makes the remote sign link
// safe to email/WhatsApp to the customer — anyone with the order_number alone (BT-0001, BT-0002...
// easily guessable) could otherwise mark someone else's order delivered.
//
// action "redeem" (called from sign-invoice.html, a PUBLIC page with no login — the customer signs
// on their own phone, not a BuenTrade device): verifies the token matches, then records
// invoice_signed_at — the customer's own proof-of-receipt, independent of shipment status.
//
// Real bug found live 2026-09-07: this used to reuse shipments-update-status to ALSO mark the
// shipment 'delivered' here, and used that same status to dedupe ("already delivered = already
// signed, don't re-process"). The user clarified those are two different real-world facts:
// "Delivered" (Carga entregada con Éxito) is the trader confirming the load physically arrived at
// the border — independent of whether the customer has gotten around to signing yet. Once
// "delivered" could be true with no signature on file, that dedupe check would tell the
// customer's real first signature "ya fue firmada," which never happened. invoice_signed_at is
// its own column now, set here directly — this action no longer touches shipment status at all.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const { action, order_number } = body;
    if (!action || !order_number) return jsonResponse({ error: "missing required fields", missing: ["action", "order_number"].filter((k) => !body[k]) }, 400);

    const [shipment] = await sql`select * from shipments where order_number = ${order_number}`;
    if (!shipment) return jsonResponse({ error: "unknown order_number" }, 404);

    if (action === "issue") {
      const { actor } = body;
      if (!actor) return jsonResponse({ error: "missing required fields", missing: ["actor"] }, 400);
      const token = randomToken();
      const [updated] = await sql`update shipments set invoice_token = ${token} where id = ${shipment.id} returning *`;
      await writeAuditLog(sql, HMAC_SECRET, { actor, action: "update", table_name: "shipments", record_id: shipment.id, before: shipment, after: updated });
      return jsonResponse({ issued: true, token });
    }

    if (action === "redeem") {
      const { token, invoice_url, signed_by_name } = body;
      if (!token) return jsonResponse({ error: "missing required fields", missing: ["token"] }, 400);
      if (!shipment.invoice_token || shipment.invoice_token !== token) return jsonResponse({ error: "invalid_token" }, 403);
      if (shipment.invoice_signed_at) return jsonResponse({ already_signed: true });

      const [updated] = await sql`update shipments set invoice_signed_at = now() where id = ${shipment.id} returning *`;
      await writeAuditLog(sql, HMAC_SECRET, {
        actor: "customer-signature", action: "update", table_name: "shipments", record_id: shipment.id,
        before: shipment, after: updated,
      });
      return jsonResponse({ redeemed: true, shipment: updated });
    }

    return jsonResponse({ error: "invalid action", valid_actions: ["issue", "redeem"] }, 400);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
