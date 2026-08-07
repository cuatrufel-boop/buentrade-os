-- Mismo permiso base para todas las tablas que todavía no tenían
-- política — evita el error "permission denied" cuando construyamos
-- sus pantallas más adelante.

create policy "authenticated_full_access_packaging" on packaging for all to authenticated using (true) with check (true);
grant select, insert, update, delete on packaging to authenticated;

create policy "authenticated_full_access_temperature" on temperature for all to authenticated using (true) with check (true);
grant select, insert, update, delete on temperature to authenticated;

create policy "authenticated_full_access_cost_types" on cost_types for all to authenticated using (true) with check (true);
grant select, insert, update, delete on cost_types to authenticated;

create policy "authenticated_full_access_incoterms" on incoterms for all to authenticated using (true) with check (true);
grant select, insert, update, delete on incoterms to authenticated;

create policy "authenticated_full_access_exchange_rates" on exchange_rates for all to authenticated using (true) with check (true);
grant select, insert, update, delete on exchange_rates to authenticated;

create policy "authenticated_full_access_plants" on plants for all to authenticated using (true) with check (true);
grant select, insert, update, delete on plants to authenticated;

create policy "authenticated_full_access_plant_products" on plant_products for all to authenticated using (true) with check (true);
grant select, insert, update, delete on plant_products to authenticated;
