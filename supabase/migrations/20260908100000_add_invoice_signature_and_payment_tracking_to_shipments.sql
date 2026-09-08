-- Collections module. Real gap found live 2026-09-07/08: orders-invoice-signature's "redeem"
-- action already received invoice_url and signed_by_name from sign-invoice.html but never saved
-- them — only invoice_signed_at. "despues de la firma del cliente ya la invoice debe quedar
-- guardada en esa orden entregada" — these two columns are what that fix writes to.
alter table shipments add column invoice_url text;
alter table shipments add column invoice_signed_by text;

-- Real ask: "si entra un pago por 50k deben poderse liberar en el sistema" — payments aren't
-- always full-and-final (the Excel's own "Balance Pending" column proves partial payments are a
-- real thing), so paid_at alone (a binary yes/no) can't represent progress toward payoff.
-- amount_paid tracks cumulative applied amount; the shipment is fully settled once
-- amount_paid >= sale_amount, at which point paid_at gets set (see shipments-apply-payment).
alter table shipments add column amount_paid numeric not null default 0;

-- Real ask: "calcules los intereses dependiendo del dia en que pago la factura... para tener
-- numeros reales en el pnl" — computed once, at the moment a shipment becomes fully paid (not
-- live/accruing — "solo cuando se pague", confirmed explicitly). paid_days mirrors the Excel's
-- own "Dias de Pago" column (DATEDIF invoice_sent_at -> the payment date that settled it).
alter table shipments add column paid_days integer;
alter table shipments add column interest_amount numeric;
alter table shipments add column net_profit numeric;
