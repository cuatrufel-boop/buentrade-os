// Shared email/phone validation for every data-entry form that saves a contact (Customers,
// Plants, Carriers/Providers, plant delivery Locations) — one real implementation instead of
// four separate copies that could drift out of sync, the same class of bug that let three
// different files carry three different (two of them wrong) copies of the email signature.
//
// Deliberately permissive on format beyond "this could plausibly be real" — this only blocks
// obviously-wrong input (missing @, no digits, empty), never tries to fully validate that an
// address/number is truly deliverable (an actual send attempt is the only real proof of that).

const BC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function bcIsValidEmail(email){
  return BC_EMAIL_RE.test((email || '').trim());
}

// Comma/semicolon-separated CC lists — every non-empty entry must be a real email; a trailing or
// doubled separator (empty entry) is ignored rather than rejected.
function bcIsValidEmailList(list){
  const entries = (list || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  return entries.every(bcIsValidEmail);
}

// Phone/WhatsApp numbers in these forms are always a fixed dial code (the closed DIAL_CODES
// dropdown) + a free-typed national number — this validates the national-number half only:
// digits after stripping spaces/dashes/parens, 7-12 digits (covers every DIAL_CODES entry's
// real national-number length, from Central American 8-digit numbers to 10-digit US/MX ones).
function bcIsValidPhoneDigits(number){
  const digits = (number || '').replace(/[\s\-().]/g, '');
  return /^\d{7,12}$/.test(digits);
}

// For the few fields still plain free-text "+countrycode number" (no dial-code dropdown next to
// them) — requires the leading + and a sane total digit count (E.164 allows up to 15).
function bcIsValidFullPhone(full){
  const trimmed = (full || '').trim();
  if (!trimmed.startsWith('+')) return false;
  const digits = trimmed.slice(1).replace(/[\s\-().]/g, '');
  return /^\d{8,15}$/.test(digits);
}
