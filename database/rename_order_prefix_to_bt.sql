-- BUENTRADE Trading OS — order number prefix: "COT-" (Cotización) -> "BT-" (BuenTrade)
--
-- PO and FO are English-only documents; a Spanish-language prefix ("Cotización") had no
-- place on them. "BT-" is neutral in both languages and matches the company initials.
-- The underlying sequence (order_number_seq) is untouched, so numbering just continues
-- from wherever it left off — only the prefix on new orders changes.

create or replace function next_order_number()
returns text
language sql
as $$
  select 'BT-' || lpad(nextval('order_number_seq')::text, 4, '0');
$$;
