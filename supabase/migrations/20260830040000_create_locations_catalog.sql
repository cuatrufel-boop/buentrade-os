-- The real, closed catalog of pickup/delivery cities — confirmed real requirement 2026-08-30:
-- "TODOS los estados TODAS las ciudades deben estar en TODOS los carriers" (every carrier is
-- expected to eventually have a real freight price for every real city, kept current). Before
-- this, a city was just a free-text string independently typed on plant_locations.location_name
-- AND on provider_rates.origin — nothing guaranteed "Gadsden AL" on one side matched "Gadsden AL"
-- (or "Gadsden, AL") on the other, and there was no single place to see "which cities exist at
-- all" or "which carrier is missing which city." Same structural problem the products catalog
-- solves for cut names, applied to cities.
create table locations (
  id uuid primary key default gen_random_uuid(),
  city text not null,
  state text not null,
  created_at timestamptz not null default now(),
  unique (city, state)
);

-- Seeded from every real city already on file anywhere in the system as of 2026-08-30 — never
-- invented, only what a real plant pickup location or a real carrier rate already named. 21 real
-- cities from EBI Logistics' loaded US Freight rates, plus 3 more from real plant pickup locations
-- (Sanderson's Hammond LA/Jack AL/Palestine TX) that EBI hadn't quoted yet — everything else
-- (Denison IA, Gadsden AL, Milan MO, Sioux Falls SD) already existed in EBI's own list.
insert into locations (city, state) values
  ('Beardstown', 'IL'), ('Carthage', 'MS'), ('Clinton', 'NC'), ('Crete', 'NE'),
  ('Delphi', 'IN'), ('Denison', 'IA'), ('Douglas', 'GA'), ('Eagle Grove', 'IA'),
  ('Fort Smith', 'AR'), ('Fremont', 'NE'), ('Gadsden', 'AL'), ('Guymon', 'OK'),
  ('Milan', 'MO'), ('Rantoul', 'IL'), ('Sioux City', 'IA'), ('Sioux Falls', 'SD'),
  ('St Joseph', 'MO'), ('Storm Lake', 'IA'), ('Tar Heel', 'NC'), ('Waco', 'TX'),
  ('Worthington', 'MN'), ('Hammond', 'LA'), ('Jack', 'AL'), ('Palestine', 'TX')
on conflict (city, state) do nothing;

-- provider_rates now points at a real catalog row instead of a free-text origin string, for US
-- Freight rates specifically (Mexican Freight destinations and Customs costs aren't per-city the
-- same way, so origin/destination stay free text for those). Nullable during the transition —
-- existing rows get backfilled by matching their own origin text against the new catalog below;
-- a row whose origin text doesn't cleanly match anything real stays null rather than guessed.
alter table provider_rates add column location_id uuid references locations(id);

update provider_rates pr
set location_id = l.id
from locations l
where pr.service_type = 'us_freight'
  and lower(trim(regexp_replace(pr.origin, '[,\s]+([A-Za-z]{2})$', ''))) = lower(l.city)
  and upper(right(trim(pr.origin), 2)) = l.state;
