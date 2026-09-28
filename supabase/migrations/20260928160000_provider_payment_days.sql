-- Pay & Receive, 2026-09-28 ("no todos los carriers son a 30, no todas las aduanas de contado —
-- unos si unos no"): each carrier / customs agency has its own payment term, in days after
-- delivery; 0 = cash (paid at delivery). Null = not set yet — the Pay & Receive flow asks for it
-- the first time that provider shows up on a load.
alter table providers add column payment_days integer check (payment_days between 0 and 180);
