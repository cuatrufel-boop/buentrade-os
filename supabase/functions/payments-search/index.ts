// payments.search — read-only. The Payments ledger: every payment ever applied, grouped by
// payment_batch_id back into "one payment -> N invoices" (each row in payment_applications is one
// shipment's slice of a payment, see create_payment_applications), with the bank date and
// collection account (Buentrade/Summar) that came with it.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const rows = await sql`
      select pa.*, c.trade_name as customer_name
      from payment_applications pa
      left join customers c on c.id = pa.customer_id
      order by pa.applied_at desc
    `;

    // Group into one payment per payment_batch_id (older rows predating this column each stand
    // alone, keyed by their own id, since they have no batch to join).
    const byBatch = new Map<string, any>();
    for (const r of rows) {
      const key = r.payment_batch_id || r.id;
      if (!byBatch.has(key)) {
        byBatch.set(key, {
          payment_batch_id: r.payment_batch_id,
          customer_id: r.customer_id,
          customer_name: r.customer_name,
          applied_at: r.applied_at,
          bank_entry_date: r.bank_entry_date,
          collection_account: r.collection_account,
          payment_method: r.payment_method,
          payment_reference: r.payment_reference,
          total_amount: 0,
          allocations: [],
        });
      }
      const batch = byBatch.get(key);
      batch.total_amount += Number(r.amount_applied);
      batch.allocations.push({ order_number: r.order_number, shipment_id: r.shipment_id, amount_applied: Number(r.amount_applied) });
    }

    return jsonResponse({ payments: [...byBatch.values()] });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
