// orders.invoiceSignature — one function, two actions, kept to one to stay under Supabase's
// 100-function project cap (already hit once this week).
//
// action "issue" (called from trading-tool.html's Real Costs panel, "Create Invoice"): generates a
// fresh unguessable token and saves it on the shipment. This is what makes the remote sign link
// safe to email/WhatsApp to the customer — anyone with the order_number alone (BT-0001, BT-0002...
// easily guessable) could otherwise mark someone else's order delivered.
//
// action "redeem" (called from sign-invoice.html, a PUBLIC page with no login — the customer signs
// on their own phone, not a BuenTrade device): verifies the token matches, then reuses
// shipments-update-status (rather than duplicating its payment_due_date/event-logging logic) to
// actually mark the shipment delivered. Real correction 2026-09-06: "es en ese mismo momento que
// debe enviar para firmar" — BuenTrade never rides the truck, so the old in-person signature pad
// never made sense; this link (sent by both email and WhatsApp, same message as the Invoice
// itself) is what actually gets signed, and the trader can follow up for it in the same WhatsApp
// thread.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const API_ROOT = "https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/";
const API_KEY = Deno.env.get("API_PUBLISHABLE_KEY") || "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe";

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
      if (shipment.status === "delivered") return jsonResponse({ already_delivered: true });

      const res = await fetch(API_ROOT + "shipments-update-status", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + API_KEY, apikey: API_KEY },
        body: JSON.stringify({
          actor: "customer-signature", shipment_id: shipment.id, status: "delivered",
          notes: `Factura firmada remotamente por ${signed_by_name || "el cliente"}${invoice_url ? " — " + invoice_url : ""}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) return jsonResponse({ error: data.error || "failed to mark delivered" }, 500);
      return jsonResponse({ redeemed: true, shipment: data.shipment });
    }

    return jsonResponse({ error: "invalid action", valid_actions: ["issue", "redeem"] }, 400);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
