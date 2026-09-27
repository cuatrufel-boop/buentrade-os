-- 2026-09-27 (Messaging test): keep the reason's own "why" line with each sent message, so a message sent earlier today
-- still shows as Sent with its reason even after that reason changes (e.g. the client's volume was filled in since).
alter table customer_messages add column reason_why text;
