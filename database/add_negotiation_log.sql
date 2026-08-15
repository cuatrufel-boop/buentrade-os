-- BUENTRADE Trading OS — negotiation trail for a pending offer
--
-- Every time the trader sends a counter-number to the plant or back to the customer while
-- negotiating a confirmed bid, one entry gets appended here. Lets the Trading Tool show "you
-- went customer -> plant -> customer" visually instead of the trader having to remember it.

alter table sent_offers add column if not exists negotiation_log jsonb not null default '[]'::jsonb;
