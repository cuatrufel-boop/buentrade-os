// orders.composeSO — read-only. "Confirmación de Venta" (Spanish, customer-facing). Same porting
// rule as composePO — the MXN-conversion logic in particular is deliberately conservative: only
// computed when the customer's preferred_currency_id is MXN AND a real exchange_rates row exists
// for that date — never fabricated when no rate is on file, matching the original behavior exactly.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

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
    // The real INCOTERMS field is the customer's own stored text (e.g. "FOB", "CIF", "DAP
    // planta") — re-verified directly against buildSODoc()'s source, 2026-08-28. It was
    // previously computed here as FCA/DAP, which doesn't match: this is a fact on file per
    // customer, not derived from delivery_type.
    const incoterms = customer?.usual_incoterm_text || null;
    let customsAgency = null;
    if (customer?.usual_delivery_type === "Border" && customer.customs_agency_provider_id) {
      const [agency] = await sql`select * from providers where id = ${customer.customs_agency_provider_id}`;
      if (agency) {
        customsAgency = agency;
        entregarA = [agency.name, agency.city].filter(Boolean).join("\n");
      }
    }

    // preferred_currency_id is the real forward field (customers.preferred_currency, the older
    // text column, is only ever populated for legacy-imported rows, never by customers.create/
    // update going forward) — resolved once here and reused for both MONEDA and the MXN check.
    let currencyCode = null;
    if (customer?.preferred_currency_id) {
      const [currency] = await sql`select code from currencies where id = ${customer.preferred_currency_id}`;
      currencyCode = currency?.code ?? null;
    }
    let mxnEquivalent = null;
    if (currencyCode === "MXN" && so.total_sale != null) {
      const [rate] = await sql`
        select rate from exchange_rates where from_currency = 'USD' and to_currency = 'MXN'
        order by rate_date desc limit 1
      `;
      if (rate) mxnEquivalent = { rate: rate.rate, amount: Number(so.total_sale) * Number(rate.rate) };
    }

    const trader = offer?.won_by ? offer.won_by.split("@")[0] : null;

    const doc = {
      order_number,
      date: so.created_at,
      entrega_estimada: Array.isArray(so.delivery_dates) && so.delivery_dates[0] ? so.delivery_dates[0] : null,
      condiciones_pago: customer?.payment_days ? `${customer.payment_days} días` : "Por confirmar",
      incoterms,
      pais_origen: plant?.country || null,
      moneda: currencyCode || "USD",
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
      doc.incoterms ? `Incoterms: ${doc.incoterms}` : null,
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

    // Raw rows alongside the composed document — offers.html's WhatsApp-card and email-send flows
    // need the actual so/customer fields (whatsapp, phone, email, email_cc…), not just the
    // rendered text, so one call here serves every consumer instead of needing a second endpoint.
    return jsonResponse({ document: doc, text, so, customer, offer });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
