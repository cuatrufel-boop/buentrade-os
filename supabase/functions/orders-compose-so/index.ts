// orders.composeSO — read-only. "Confirmación de Venta" (Spanish, customer-facing). Same porting
// rule as composePO — the MXN-conversion logic in particular is deliberately conservative: only
// computed when the customer's preferred_currency_id is MXN AND a real exchange_rates row exists
// for that date — never fabricated when no rate is on file, matching the original behavior exactly.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    if (!body.order_number) return jsonResponse({ error: "order_number is required" }, 400);
    const { order_number } = body;

    const [so] = await sql`select * from sales_orders where order_number = ${order_number}`;
    if (!so) return jsonResponse({ error: "unknown order_number" }, 404);
    const [offer] = await sql`select * from sent_offers where id = ${so.sent_offer_id}`;
    const [customer] = await sql`select * from customers where id = ${so.customer_id}`;
    const [plant] = offer?.plant_id ? await sql`select * from plants where id = ${offer.plant_id}` : [null];

    let entregarA = customer ? [customer.trade_name, customer.address].filter(Boolean).join("\n") : null;
    let incoterms = "FCA";
    let customsAgency = null;
    if (customer?.usual_delivery_type === "Border" && customer.customs_agency_provider_id) {
      const [agency] = await sql`select * from providers where id = ${customer.customs_agency_provider_id}`;
      if (agency) {
        customsAgency = agency;
        entregarA = [agency.name, agency.city].filter(Boolean).join("\n");
        incoterms = `DAP – ${agency.name}`;
      }
    }

    let mxnEquivalent = null;
    if (customer?.preferred_currency_id) {
      const [currency] = await sql`select code from currencies where id = ${customer.preferred_currency_id}`;
      if (currency?.code === "MXN" && so.total_sale != null) {
        const [rate] = await sql`
          select rate from exchange_rates where from_currency = 'USD' and to_currency = 'MXN'
          order by rate_date desc limit 1
        `;
        if (rate) mxnEquivalent = { rate: rate.rate, amount: Number(so.total_sale) * Number(rate.rate) };
      }
    }

    const trader = offer?.won_by ? offer.won_by.split("@")[0] : null;

    const doc = {
      order_number,
      date: so.created_at,
      entrega_estimada: Array.isArray(so.delivery_dates) && so.delivery_dates[0] ? so.delivery_dates[0] : null,
      condiciones_pago: customer?.payment_days ? `${customer.payment_days} días` : "Por confirmar",
      incoterms,
      pais_origen: plant?.country || null,
      moneda: "USD",
      mxn_equivalente: mxnEquivalent,
      ejecutivo: trader,
      cliente: [customer?.trade_name, customer?.address].filter(Boolean).join("\n"),
      entregar_a: entregarA,
      customs_agency: customsAgency,
      linea: {
        descripcion_es: so.product_spec_es || so.product_name_es,
        descripcion_en: so.product_spec || so.product_name,
        peso: so.weight,
        precio: so.sale_price,
        total: so.total_sale,
      },
    };

    const text = [
      `CONFIRMACIÓN DE VENTA ${order_number}`,
      `Fecha: ${new Date(doc.date).toLocaleDateString()}`,
      doc.entrega_estimada ? `Entrega estimada: ${doc.entrega_estimada}` : null,
      `Condiciones de pago: ${doc.condiciones_pago}`,
      `Incoterms: ${doc.incoterms}`,
      doc.pais_origen ? `País de origen: ${doc.pais_origen}` : null,
      doc.ejecutivo ? `Ejecutivo: ${doc.ejecutivo}` : null,
      ``,
      `CLIENTE:`, doc.cliente,
      ``,
      `ENTREGAR A:`, doc.entregar_a,
      ``,
      `PRODUCTO: ${doc.linea.descripcion_es}${doc.linea.descripcion_en && doc.linea.descripcion_en !== doc.linea.descripcion_es ? ` (${doc.linea.descripcion_en})` : ""}`,
      `Peso: ${doc.linea.peso} lbs`,
      `Precio: $${doc.linea.precio}/lb USD`,
      `Total: $${doc.linea.total} USD`,
      mxnEquivalent ? `Equivalente: $${mxnEquivalent.amount.toLocaleString(undefined, {maximumFractionDigits:0})} MXN (tipo de cambio ${mxnEquivalent.rate})` : null,
      ``,
      `Documento preliminar sujeto a confirmación final.`,
    ].filter((l) => l !== null).join("\n");

    return jsonResponse({ document: doc, text });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
