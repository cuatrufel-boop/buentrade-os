-- Notes → products, 2026-09-29 (user: "ese campo debe leer palabra por palabra, ser muy sensible, de ahí debe salir
-- todo lo relevante"). kind 'product' = a product the note says the client buys, checked against the whole catalog:
-- one clear catalog product → added to the client's products (created_link = true, Undo removes it) or already there;
-- several possible / not in the catalog → pending with the catalog candidates.
alter table customer_note_insights drop constraint customer_note_insights_kind_check;
alter table customer_note_insights add constraint customer_note_insights_kind_check check (kind in ('cadence', 'fact', 'product'));
alter table customer_note_insights add column product_id uuid references products(id);
alter table customer_note_insights add column candidate_product_ids uuid[] not null default '{}';
alter table customer_note_insights add column created_link boolean not null default false;
