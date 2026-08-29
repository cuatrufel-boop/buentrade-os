-- Customers had no field for a postal/zip code — the New Customer form only had one flat
-- Address text box. Splitting the address out (country dropdown, state, city, zip) needs a real
-- column to hold it; nothing existed to reuse.
alter table customers add column if not exists postal_code text;
