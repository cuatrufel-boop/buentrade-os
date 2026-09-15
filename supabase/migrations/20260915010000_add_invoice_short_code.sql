-- Real ask 2026-09-15: the sign-invoice link's real 48-hex-char token makes for a long, suspicious-
-- looking URL in the WhatsApp message text (which WhatsApp always shows raw, next to the branded
-- preview card — there's no way to hide it without the paid WhatsApp Business API, already ruled
-- out). This short code is a second, much shorter identifier alongside the real token — the token
-- stays the actual security credential (still checked by track_open/redeem), the short code is
-- purely a lookup key so the OUTBOUND link can read /f/x7k9m2 instead of the long one.
alter table shipments
  add column if not exists invoice_short_code text;

create unique index if not exists shipments_invoice_short_code_idx
  on shipments (invoice_short_code) where invoice_short_code is not null;
