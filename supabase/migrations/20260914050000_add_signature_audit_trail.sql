-- Real ask 2026-09-14: "busca la mejor forma en el mercado mejores practicas como lo hacen las
-- grandes empresas" — the invoice e-signature flow (sign-invoice.html) only ever recorded WHO
-- signed and WHEN. Industry e-signature tools (DocuSign, HelloSign) also capture an audit trail
-- (IP, device/user-agent, when the link was first opened, an expiry on the link) and a tamper
-- evidence hash of the signed document. These columns are the storage for that — applied first,
-- ahead of the backend/frontend changes that populate them.
alter table shipments
  add column if not exists invoice_signed_ip text,
  add column if not exists invoice_signed_user_agent text,
  add column if not exists invoice_signed_pdf_hash text,
  add column if not exists invoice_link_opened_at timestamptz,
  add column if not exists invoice_link_expires_at timestamptz,
  add column if not exists invoice_consent_confirmed boolean,
  -- A separate one-page "Certificate of Signature" PDF (who/when/from where/consent text/hash),
  -- same idea as DocuSign's Certificate of Completion — kept as its own small file rather than a
  -- second page appended to the invoice, since the certificate needs the invoice PDF's own hash as
  -- one of its fields (computing it first, then appending pages, would just re-hash a different
  -- file and defeat the point).
  add column if not exists invoice_certificate_url text;
