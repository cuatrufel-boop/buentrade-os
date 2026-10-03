-- When the AI service is unavailable a price email is still read by the rule-based reader (every line that has a name and a price on it loads),
-- the parts that need the AI (free text, pictures) are listed in Pending Matches, and the message is flagged here so it is read again, in full,
-- once the AI answers — at most once an hour, and only while the prices are still fresh (3 days).
alter table plant_price_emails_processed
  add column needs_completion boolean not null default false,
  add column completion_checked_at timestamptz;
create index plant_price_emails_processed_completion_idx on plant_price_emails_processed (processed_at) where needs_completion;
