-- BUENTRADE Trading OS — helper to hand out the next order number as "COT-0001"
--
-- supabase-js has no way to call nextval() on order_number_seq directly, so this
-- tiny function wraps it and formats the result. Called from offers.html when a
-- sent offer is marked "Ganada".

create or replace function next_order_number()
returns text
language sql
as $$
  select 'COT-' || lpad(nextval('order_number_seq')::text, 4, '0');
$$;

grant execute on function next_order_number() to authenticated;
