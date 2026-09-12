-- BUENTRADE Trading OS — order numbering: retire "BT-0001" per-order-sequence display, switch to
-- a single "{year}-{consecutive}" value shared by an order's PO/SO/FO/Invoice, each just wrapped
-- in its own document-type prefix at print/send time (PO-BT-2026-1001, SO-BT-2026-1001, etc — see
-- the frontend's PO/SO/FO/Invoice builders). Explicit, repeated user instruction 2026-09-12:
-- "olvida BT-0019... desde hoy solo existe un consecutivo unico para una orden."
--
-- This migration codifies a change that was already applied live to staging via the Management
-- API earlier the same session (to unblock testing) — the sequence had already been manually
-- restarted at 1001 and the function redefined; this file exists so the migration history matches
-- what's actually live and a fresh environment would come up the same way.
--
-- NOT safe to re-run once real orders exist under the new scheme: `restart with` rewinds the
-- counter, which would hand out numbers that collide with ones already issued. Intended to run
-- exactly once, same as any other migration.

alter sequence order_number_seq restart with 1001;

create or replace function next_order_number()
returns text
language sql
as $$
  select extract(year from now())::text || '-' || nextval('order_number_seq')::text;
$$;
