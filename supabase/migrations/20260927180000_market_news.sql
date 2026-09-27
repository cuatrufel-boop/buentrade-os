-- ============================================================================
-- 20260927180000_market_news.sql
--
-- Messaging source #2 (2026-09-27): real, dated news that can affect a client — avian flu / sanitary closures, border
-- crossings, meat prices in his Mexican state, US plant/market events. Found once a day by a web search; every item
-- keeps its source URL (verified to come from the search results, never typed by the model) so the trader can check it
-- before sending. Messages use it only when it touches what the client buys or where he is.
-- ============================================================================
create table market_news (
  id uuid primary key default gen_random_uuid(),
  scan_date date not null,
  topic text not null,
  headline_es text not null,
  fact_es text not null,
  published_on date not null,
  url text not null unique,
  source text,
  mx_states text[] not null default '{}',
  us_states text[] not null default '{}',
  proteins text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index market_news_scan_idx on market_news(scan_date desc);
-- one scan per day (the row is the lock: a second caller sees it and waits for / reuses the result)
create table market_news_scans (
  scan_date date primary key,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  detail text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
grant select, insert, update, delete on market_news, market_news_scans to api_service;
