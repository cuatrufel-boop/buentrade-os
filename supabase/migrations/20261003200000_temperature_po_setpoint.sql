-- The temperature a Purchase Order tells the plant to hold the load at, per product temperature (user 2026-10-03: "20F fresh, frozen -10F").
-- Data, not code: a PO prints the line from the product's own temperature.
alter table temperature add column po_setpoint_f integer;
update temperature set po_setpoint_f = 20  where lower(name_en) = 'fresh';
update temperature set po_setpoint_f = -10 where lower(name_en) = 'frozen';
