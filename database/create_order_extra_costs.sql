-- BUENTRADE Trading OS — post-crossing surcharges on a won order
--
-- Labels, Plastic wrap, IN-LIEU, Storage, Fresh to Frozen, Lumper fee, INBOND Release — these
-- aren't known at the moment a deal closes, they show up later once the load has actually
-- crossed and the real invoices come in. One flexible line-item table instead of a fixed column
-- per cost type, since not every order gets every kind of surcharge and new types come up.

create table if not exists order_extra_costs (
  id uuid primary key default gen_random_uuid(),
  order_number text not null,
  sent_offer_id uuid references sent_offers(id) on delete cascade,
  cost_type text not null,
  amount numeric(12,2) not null,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists order_extra_costs_order_number_idx on order_extra_costs(order_number);

alter table order_extra_costs enable row level security;

create policy "authenticated_full_access_order_extra_costs" on order_extra_costs for all to authenticated using (true) with check (true);

grant usage on schema public to authenticated;
grant select, insert, update, delete on order_extra_costs to authenticated;
