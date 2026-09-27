-- 2026-09-28: Messaging angles from our own side — a better price / fresh availability of his cut ('offer'), his last load or
-- an unanswered quote ('followup') — and dated news ('news') are tracked as their own kinds, so "what works" can tell them apart.
alter table customer_messages drop constraint customer_messages_reason_kind_check;
alter table customer_messages add constraint customer_messages_reason_kind_check
  check (reason_kind in ('cycle', 'ask_volume', 'personal', 'market', 'season', 'business', 'news', 'offer', 'followup'));
