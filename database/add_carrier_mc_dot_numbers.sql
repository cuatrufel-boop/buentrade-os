-- BUENTRADE Trading OS — carrier federal motor carrier numbers
--
-- US trucking industry standard: every Freight Confirmation should show the carrier's
-- MC# (Motor Carrier number) and/or DOT# (USDOT number). Nullable — most providers on
-- file today aren't US carriers (customs brokers, freight forwarders) and won't have one.

alter table providers add column if not exists mc_number text;
alter table providers add column if not exists dot_number text;
