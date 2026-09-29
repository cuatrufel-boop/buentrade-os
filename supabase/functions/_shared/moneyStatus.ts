// Money status of every load in Pay & Receive — ONE place for the dates that matter (2026-09-29).
// Used by shipment-alerts-poll (the trader's push / email alerts) and by dashboard-summary (the
// Dashboard's "Today" list), so both always say the same thing about the same load.
//
// Rules (confirmed by the user 2026-09-28): a load is in Pay & Receive once delivered AND its invoice
// is signed; customs are due at delivery + the agency's payment days (not set = at delivery); freight
// at delivery + the carrier's days (not set = 30); the customer is collected from day 29; a Summar load
// is done when the customer paid Summar, a direct one when paid_at is set. Days are Miami business days.

export const SUMMAR = { transit: 0.234, base: 1.20, extraDay: 0.0417 };
export const COLLECT_FROM_DAY = 29, FREIGHT_DAYS = 30;

// Miami business day of a timestamp (America/New_York), whatever time zone the server runs in
export const bizDay = (ts: string | Date) => new Date(new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) + "T00:00:00Z");

export async function payReceiveLoads(sql: any) {
  const rows = await sql`
    select sh.id, sh.order_number, sh.sale_amount, sh.delivered_at, sh.paid_at, sh.payment_due_date, sh.amount_paid,
      sh.plant_paid_at, sh.summar_payment_sent_at, o.won_by, c.trade_name as customer_name, c.payment_days as customer_days,
      sh.customer_id, po.financing_method, po.payment_days as summar_days,
      coalesce(o.tramite_aduanal_amount, 0) + coalesce(o.inspection_amount, 0) as customs,
      (select coalesce(f.actual_rate, f.quoted_rate) from freight_orders f where f.order_number = sh.order_number order by f.created_at desc limit 1) as freight,
      (select pr.name from freight_orders f left join providers pr on pr.id = f.carrier_provider_id where f.order_number = sh.order_number order by f.created_at desc limit 1) as carrier,
      (select pr.payment_days from freight_orders f left join providers pr on pr.id = f.carrier_provider_id where f.order_number = sh.order_number order by f.created_at desc limit 1) as carrier_days,
      (select ag.payment_days from providers ag where ag.id = coalesce(o.customs_agency_provider_id, c.customs_agency_provider_id)) as customs_days,
      (select ag.name from providers ag where ag.id = coalesce(o.customs_agency_provider_id, c.customs_agency_provider_id)) as customs_agency,
      coalesce((select sum(amount) from order_extra_costs x where x.order_number = sh.order_number and x.payable_kind = 'freight'), 0) as freight_surcharges,
      coalesce((select sum(amount) from order_extra_costs x where x.order_number = sh.order_number and x.payable_kind = 'customs'), 0) as customs_surcharges,
      sh.invoice_signed_at,
      coalesce((select array_agg(kind) from shipment_money_records r where r.shipment_id = sh.id and r.settles), '{}') as recorded,
      coalesce((select array_agg(alert_key) from money_alerts_sent a where a.shipment_id = sh.id), '{}') as sent
    from shipments sh
    join sent_offers o on o.id = sh.sent_offer_id
    left join customers c on c.id = sh.customer_id
    left join purchase_orders po on po.order_number = sh.order_number
    where o.won_by is not null and sh.paid_at is null
  `;
  const today = bizDay(new Date());
  const out: any[] = [];
  for (const L of rows) {
    if (!(L.delivered_at && L.invoice_signed_at)) continue; // still in Orders
    const summar = L.financing_method === "summar", recorded: string[] = L.recorded;
    if (summar && recorded.includes("client_paid_summar")) continue; // customer paid Summar — load done
    const deliv = bizDay(L.delivered_at), days = Math.round((today.getTime() - deliv.getTime()) / 86400000);
    const at = (n: number) => new Date(deliv.getTime() + n * 86400000);
    const carrierDays = L.carrier_days == null ? FREIGHT_DAYS : Number(L.carrier_days), customsDays = L.customs_days == null ? 0 : Number(L.customs_days);
    const sale = Number(L.sale_amount || 0), sDays = Number(L.summar_days || L.customer_days || 30);
    out.push({
      L, summar, recorded, sent: L.sent as string[], today, deliv, days, at,
      sale, owed: summar ? sale : sale - Number(L.amount_paid || 0), sDays, perDay: sale * SUMMAR.extraDay / 100,
      who: L.customer_name ? String(L.customer_name).trim() : "the customer",
      freight: Number(L.freight || 0), freightTotal: Number(L.freight || 0) + Number(L.freight_surcharges || 0), carrierDays, freightDue: at(carrierDays), freightPaid: recorded.includes("freight"),
      customs: Number(L.customs || 0), customsTotal: Number(L.customs || 0) + Number(L.customs_surcharges || 0), customsDays, customsDue: at(customsDays), customsPaid: recorded.includes("customs"),
      collectOn: at(COLLECT_FROM_DAY),
      customerDue: summar ? at(sDays) : (L.payment_due_date ? new Date(L.payment_due_date) : at(Number(L.customer_days || 0))),
    });
  }
  return out;
}
