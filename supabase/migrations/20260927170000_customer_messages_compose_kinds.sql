-- 2026-09-27: Messaging now writes ONE message per client from everything we know about him; its angle can also be the
-- calendar ('season') or his business reality ('business'), besides the four existing reasons.
alter table customer_messages drop constraint customer_messages_reason_kind_check;
alter table customer_messages add constraint customer_messages_reason_kind_check
  check (reason_kind in ('cycle', 'ask_volume', 'personal', 'market', 'season', 'business'));
