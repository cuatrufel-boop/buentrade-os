-- Real, explicit ask: "como voy a ver la diferencia de que si vale la pena apoyarnos en esto" —
-- rather than asking the trader to trust a one-time demo, both extraction methods (the rule-based
-- parser already built, and the new Claude-based extractor) run on every real email from now on,
-- and BOTH item counts get recorded here, permanently. If the two numbers are always equal, that's
-- real, standing proof the AI step isn't earning its keep; if the AI number is consistently higher
-- (confirmed real case: Wholestone's prose sentence — regex found 0 items, the AI found 3), that's
-- the proof it's worth the cost. extraction_method records which one's results actually got applied
-- this run (llm normally; regex_fallback only when the AI call itself failed, e.g. no credit).
alter table plant_price_emails_processed
  add column text_items_regex int,
  add column text_items_llm int,
  add column extraction_method text;
