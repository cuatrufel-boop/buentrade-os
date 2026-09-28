-- Pay & Receive, 2026-09-28 ("el tema esta en el pago del cliente a summar para que no nos maten
-- los intereses. CONTROL total de la carga hasta que el cliente paga"): on a Summar load the
-- customer pays SUMMAR, not us — but every day past day 30 after delivery Summar charges us
-- 0.0417% of the sale. The trader records the day the customer paid Summar; that closes the load
-- and fixes the real Summar fee (days from delivery to that date). direction 'watch' = money that
-- moves between the customer and Summar, never through our bank.
alter table shipment_money_records drop constraint shipment_money_records_kind_check;
alter table shipment_money_records add constraint shipment_money_records_kind_check
  check (kind in ('freight', 'customs', 'summar_remanente', 'client_paid_summar'));
alter table shipment_money_records drop constraint shipment_money_records_direction_check;
alter table shipment_money_records add constraint shipment_money_records_direction_check
  check (direction in ('in', 'out', 'watch'));
alter table shipment_money_records drop constraint shipment_money_records_check;
alter table shipment_money_records add constraint shipment_money_records_direction_matches_kind check (
  (kind = 'summar_remanente' and direction = 'in')
  or (kind = 'client_paid_summar' and direction = 'watch')
  or (kind in ('freight', 'customs') and direction = 'out')
);
