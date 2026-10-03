-- Pending Matches now explain themselves and can hold things that are not product lines:
--  * reason_code / reason_detail / source: why the system could not place this on its own (no price, formula, unreadable
--    picture, spreadsheet it does not understand...) and where it came from.
--  * signal_type 'unread': a file or message the system could not read at all. A person dismisses it; the dismissal is
--    remembered (same plant + same text is not queued again).
-- The control ledger gains outcome 'dismissed' (a candidate a person already dismissed, or automatic-reply noise).
alter table plant_pending_matches
  add column reason_code text,
  add column reason_detail text,
  add column source text;

alter table plant_pending_matches drop constraint plant_pending_matches_signal_type_check;
alter table plant_pending_matches add constraint plant_pending_matches_signal_type_check check (signal_type in ('price', 'declined', 'unread'));

alter table plant_price_email_lines drop constraint plant_price_email_lines_outcome_check;
alter table plant_price_email_lines add constraint plant_price_email_lines_outcome_check check (outcome in ('applied', 'pending', 'declined', 'dropped', 'dismissed'));

drop view plant_price_email_reconciliation;
create view plant_price_email_reconciliation as
select
  l.message_id,
  l.plant_id,
  p.subject,
  p.processed_at,
  count(*)                                       as candidates,
  count(*) filter (where l.outcome = 'applied')   as applied,
  count(*) filter (where l.outcome = 'pending')   as pending,
  count(*) filter (where l.outcome = 'declined')  as declined,
  count(*) filter (where l.outcome = 'dismissed') as dismissed,
  count(*) filter (where l.outcome = 'dropped')   as dropped
from plant_price_email_lines l
left join plant_price_emails_processed p on p.message_id = l.message_id
group by l.message_id, l.plant_id, p.subject, p.processed_at;
grant select on plant_price_email_reconciliation to api_service;
