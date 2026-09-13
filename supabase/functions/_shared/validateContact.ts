// Shared email/phone format validation for every Edge Function that writes a Customer, Plant,
// Provider/Carrier, or Plant Location — a real backstop, not just client-side politeness: the
// client-side checks (js/contact-validation.js) are easy to bypass with a direct API call, so the
// same class of check runs again here, server-side, where it can't be skipped.
//
// Deliberately permissive on format beyond "this could plausibly be real" — mirrors the client
// checks in js/contact-validation.js exactly (same email/phone shape rules), so a value the form
// accepts is never rejected here, and vice versa.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test((email || "").trim());
}

// Comma/semicolon-separated CC lists — every non-empty entry must be a real email.
export function isValidEmailList(list: string): boolean {
  const entries = (list || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return entries.every(isValidEmail);
}

// Phone/whatsapp values arrive here already joined ("+52 6621234567") by the frontend's own
// joinPhone() — validates the full string: a leading "+" and a sane total digit count (E.164
// allows up to 15).
export function isValidFullPhone(full: string): boolean {
  const trimmed = (full || "").trim();
  if (!trimmed.startsWith("+")) return false;
  const digits = trimmed.slice(1).replace(/[\s\-().]/g, "");
  return /^\d{8,15}$/.test(digits);
}

// Checks whichever of these known field names are present on the object (all optional — a
// missing/null field is never required by this alone, only checked for FORMAT when supplied).
// Covers every email/phone field name used across customers/plants/providers/plant_locations.
// Returns a list of human-readable problems; empty means everything present is valid.
export function validateContactFields(fields: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const email = (key: string, label: string) => {
    const v = fields[key];
    if (v && !isValidEmail(String(v))) problems.push(`${label} doesn't look valid.`);
  };
  const emailList = (key: string, label: string) => {
    const v = fields[key];
    if (v && !isValidEmailList(String(v))) problems.push(`One of the ${label} emails doesn't look valid.`);
  };
  const phone = (key: string, label: string) => {
    const v = fields[key];
    if (v && !isValidFullPhone(String(v))) problems.push(`${label} must include the country code and a real number.`);
  };

  email("email", "Email");
  emailList("email_cc", "CC");
  email("payments_contact_email", "Payments contact email");
  email("payments_email", "Payments email");
  phone("phone", "Phone");
  phone("whatsapp", "WhatsApp");
  // payments_contact_phone is always the same value as payments_contact_whatsapp on the frontend
  // (one input feeds both columns) — checking just one avoids a duplicate message for one typo.
  phone("payments_contact_whatsapp", "Payments contact WhatsApp");
  phone("payments_whatsapp", "Payments WhatsApp");

  return problems;
}
