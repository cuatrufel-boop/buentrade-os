-- Collections module. "la tasa queda como un valor configurable, no fija en el codigo" — a tiny
-- generic key/value table instead of a dedicated column anywhere, since this is the first global
-- (not per-row) setting the app has needed. Seeded with the one real value discussed: the annual
-- interest rate used for the Collections profit-impact calc, validated against market A/R
-- financing rates (~11-22% annualized) — 15% sits in the middle, matches the user's own historical
-- Excel rate exactly.
create table app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into app_settings (key, value) values ('collections_interest_rate_annual', '0.15');
