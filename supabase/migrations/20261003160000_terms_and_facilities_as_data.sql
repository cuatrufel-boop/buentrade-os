-- Knowledge that lived in the code now lives in data, where one fix reaches every plant and a person can teach new words:
--  * global abbreviations the matcher had hard-coded (FZ, Offals → Frozen; COV, VP, CVP, Vacuum, Cryol, Cryl → Vac);
--  * facility codes a plant prints ("EG" = Eagle Grove) are plant terms with meaning type 'location';
--  * cut styles the catalog has no product for (they always wait for a person) are rows, not a regex in the reader.
alter table plant_term_aliases drop constraint plant_term_aliases_meaning_type_check;
alter table plant_term_aliases add constraint plant_term_aliases_meaning_type_check
  check (meaning_type in ('temperature', 'packaging', 'variation', 'cut_name', 'location'));

insert into plant_term_aliases (plant_id, term, meaning_type, meaning_id)
select null, t.term, t.meaning_type, t.meaning_id
from (
  select v.term, 'packaging'::text as meaning_type, (select id from packaging where lower(name_en) = 'vac') as meaning_id
    from (values ('COV'), ('VP'), ('CVP'), ('Vacuum'), ('Cryol'), ('Cryl')) v(term)
  union all
  select v.term, 'temperature', (select id from temperature where lower(name_en) = 'frozen')
    from (values ('FZ'), ('Offals')) v(term)
) t
where t.meaning_id is not null
  and not exists (select 1 from plant_term_aliases a where a.plant_id is null and lower(a.term) = lower(t.term) and a.meaning_type = t.meaning_type);

-- Wholestone prints "EG" for Eagle Grove in its price picture.
insert into plant_term_aliases (plant_id, term, meaning_type, meaning_id)
select p.id, 'EG', 'location', l.id
from plants p, locations l
where p.name ilike '%wholestone%' and l.city = 'Eagle Grove' and l.state = 'IA'
on conflict (plant_id, term, meaning_type) do nothing;

create table intake_review_terms (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid references plants(id) on delete cascade,
  pattern text not null,
  note text,
  created_at timestamptz not null default now()
);
alter table intake_review_terms enable row level security;
create policy api_service_full_access on public.intake_review_terms for all to api_service using (true) with check (true);
grant select, insert, update, delete on intake_review_terms to api_service;
insert into intake_review_terms (plant_id, pattern, note) values
  (null, 'ribend', 'rib end cut — no exact catalog product, a person confirms'),
  (null, 'rib\s*end', 'rib end cut — no exact catalog product, a person confirms'),
  (null, 'cushrmvd', 'cushion-removed cut — no exact catalog product'),
  (null, 'brskt', 'brisket-removed cut — no exact catalog product'),
  (null, 'st\.?\s*louis', 'St. Louis style — reads close to a real product but is not the same');
