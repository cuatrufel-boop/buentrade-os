-- Market Flash (the bi-weekly bulletin PDF that arrives by email) is a mailbox reader too: a bulletin it cannot read or may not trust
-- opens an issue a person can see, like the other readers.
alter table mail_intake_issues drop constraint mail_intake_issues_handler_check;
alter table mail_intake_issues add constraint mail_intake_issues_handler_check check (handler in ('pickup_docs', 'release_number', 'market_flash'));
