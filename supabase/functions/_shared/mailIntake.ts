// Everything the mailbox readers (plant prices, pickup documents, release numbers) used to copy into each of their own files, once:
// Gmail access, headers, message text, who the sender is, and what is not a plant's message at all (the system's own mails,
// automatic replies, automated senders). A fix here reaches every reader — they no longer drift apart.

export async function getGmailAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GMAIL_CLIENT_ID")!,
      client_secret: Deno.env.get("GMAIL_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GMAIL_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

export function headerValue(headers: { name: string; value: string }[], name: string): string {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

export function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// First text/plain part of a (possibly multipart) Gmail payload. HTML-only mail returns "" — deliberately not scraped from tags.
export function extractPlainText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBase64Url(payload.body.data);
  for (const part of payload.parts || []) {
    const found = extractPlainText(part);
    if (found) return found;
  }
  return "";
}

export function extractHtml(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/html" && payload.body?.data) return decodeBase64Url(payload.body.data);
  for (const part of payload.parts || []) {
    const found = extractHtml(part);
    if (found) return found;
  }
  return "";
}

// "Name <a@b.com>" or "a@b.com" → "a@b.com", lower-cased.
export function senderAddress(fromHeader: string): string {
  const m = (fromHeader || "").match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader || "").trim().toLowerCase();
}

// The system's own mails to the trader. A price submission never carries these phrases or an order number; reading one as a plant's
// message started a real loop (apply → notify → the notice read as a submission → apply …).
export function isOwnNotification(subject: string): boolean {
  return (
    subject.includes("prices you were waiting on just came in") || subject.includes("price you were waiting on just came in") ||
    subject.includes("prices just applied") || subject.includes("price just applied") ||
    /pedir release number/i.test(subject) || /\bBT-\d{4}/i.test(subject)
  );
}

// Out-of-office / automatic replies carry no business content and must not be read as one. Standard markers only (RFC 3834 headers and
// the subject prefixes mail systems add themselves).
export function isAutoReply(subject: string, header: (name: string) => string): boolean {
  if (/^\s*(automatic reply|auto[- ]?reply|autoreply|out of office|undeliverable|delivery status notification|mail delivery (failed|subsystem))\b/i.test(subject)) return true;
  const auto = header("Auto-Submitted").trim().toLowerCase();
  if (auto && auto !== "no") return true;
  if (header("X-Autoreply") || header("X-Autorespond")) return true;
  return /^(auto_reply|auto-reply|bulk|junk)$/i.test(header("Precedence").trim());
}

// Software senders (no-reply style) — nobody to recognize or answer; they are classified, not queued for a person.
export function isAutomatedSender(address: string): boolean {
  const local = address.split("@")[0] || "";
  return /(^|[._-])(no[-_.]?reply|noreply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounce[sd]?)([._-]|$)/i.test(local);
}

export type PlantRef = { id: string; name: string; docs_included: boolean | null };
export type SenderResolution =
  | { kind: "plant"; plant: PlantRef; via: "email" | "email_cc" | "payments_email" | "learned" }
  | { kind: "carrier"; carrier: { id: string; name: string } }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "internal" }
  | { kind: "automated" }
  | { kind: "unknown" };

// A plant is recognized by its primary email, its extra contacts (email_cc), its payments email, or an address a person assigned to it
// (plant_sender_addresses). Primary beats the others. An address that fits two plants is never guessed — it is reported ambiguous.
export async function resolveSender(db: any, address: string): Promise<SenderResolution> {
  const addr = address.trim().toLowerCase();
  const rows = await db`
    select p.id, p.name, p.docs_included,
      (lower(trim(coalesce(p.email, ''))) = ${addr}) as by_email,
      (${addr} = any(string_to_array(regexp_replace(lower(coalesce(p.email_cc, '')), '[[:space:]]', '', 'g'), ','))) as by_cc,
      (lower(trim(coalesce(p.payments_email, ''))) = ${addr}) as by_payments,
      exists (select 1 from plant_sender_addresses a where a.plant_id = p.id and a.email = ${addr}) as by_learned
    from plants p
    where lower(trim(coalesce(p.email, ''))) = ${addr}
       or ${addr} = any(string_to_array(regexp_replace(lower(coalesce(p.email_cc, '')), '[[:space:]]', '', 'g'), ','))
       or lower(trim(coalesce(p.payments_email, ''))) = ${addr}
       or exists (select 1 from plant_sender_addresses a where a.plant_id = p.id and a.email = ${addr})
  `;
  const ref = (r: any): PlantRef => ({ id: r.id, name: r.name, docs_included: r.docs_included });
  const via = (r: any) => (r.by_email ? "email" : r.by_payments ? "payments_email" : r.by_cc ? "email_cc" : "learned") as "email" | "email_cc" | "payments_email" | "learned";
  const primary = rows.filter((r: any) => r.by_email);
  const pool = primary.length ? primary : rows;
  if (pool.length === 1) return { kind: "plant", plant: ref(pool[0]), via: via(pool[0]) };
  if (pool.length > 1) return { kind: "ambiguous", candidates: pool.map((r: any) => String(r.name).trim()) };

  const carriers = await db`
    select id, name from providers
    where lower(trim(coalesce(email, ''))) = ${addr}
       or ${addr} = any(string_to_array(regexp_replace(lower(coalesce(email_cc, '')), '[[:space:]]', '', 'g'), ','))
  `;
  if (carriers.length === 1) return { kind: "carrier", carrier: { id: carriers[0].id, name: carriers[0].name } };
  if (carriers.length > 1) return { kind: "ambiguous", candidates: carriers.map((c: any) => String(c.name).trim()) };

  if (addr.endsWith("@buentradegroup.com")) return { kind: "internal" };
  if (isAutomatedSender(addr)) return { kind: "automated" };
  return { kind: "unknown" };
}

// An address nobody could place is written down (once per message) until a person assigns it to a plant or dismisses it.
// A dismissed address stays dismissed. Never throws into the reader: the caller reports a failure in its own errors.
export async function recordUnrecognizedSender(
  db: any,
  { from, subject, messageId, reason, candidates = [] }: { from: string; subject: string; messageId: string; reason: "unknown_sender" | "ambiguous_sender" | "internal_without_plant"; candidates?: string[] },
): Promise<void> {
  await db`
    insert into mail_unrecognized_senders (from_email, last_subject, last_message_id, last_reason, candidates)
    values (${from}, ${subject}, ${messageId}, ${reason}, ${db.json(candidates)})
    on conflict (from_email) do update set
      last_seen = now(),
      times = case when mail_unrecognized_senders.last_message_id = excluded.last_message_id then mail_unrecognized_senders.times else mail_unrecognized_senders.times + 1 end,
      last_subject = excluded.last_subject, last_message_id = excluded.last_message_id,
      last_reason = excluded.last_reason, candidates = excluded.candidates
    where mail_unrecognized_senders.status = 'open'
  `;
}

// Push notification to the trader about an order (same push-send call every reader used to copy). Best-effort: a failed push never breaks a poll.
export async function sendOrderPush(actor: string, title: string, body: string, orderNumber: string): Promise<void> {
  const root = "https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/";
  const key = Deno.env.get("API_PUBLISHABLE_KEY") || "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe";
  const origin = Deno.env.get("APP_ORIGIN") || "";
  await fetch(root + "push-send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key, apikey: key },
    body: JSON.stringify({ actor, title, body, url: `${origin}/orders.html?focus=${orderNumber}`, actions: [{ action: "open_app", title: "Abrir en BuenTrade OS", url: `${origin}/orders.html?focus=${orderNumber}` }] }),
  }).catch(() => {});
}

// Open the issue (or refresh it) for a message a reader could not finish; one row per message + handler.
export async function openMailIssue(
  db: any,
  { messageId, handler, from, subject, code, detail }: { messageId: string; handler: "pickup_docs" | "release_number"; from: string; subject: string; code: string; detail: string },
): Promise<void> {
  await db`
    insert into mail_intake_issues (message_id, handler, from_email, subject, reason_code, reason_detail)
    values (${messageId}, ${handler}, ${from}, ${subject}, ${code}, ${detail})
    on conflict (message_id, handler) do update set last_seen = now(), reason_code = excluded.reason_code, reason_detail = excluded.reason_detail
    where mail_intake_issues.resolved_at is null
  `;
}
export async function closeMailIssue(db: any, messageId: string, handler: "pickup_docs" | "release_number", by: string): Promise<void> {
  await db`update mail_intake_issues set resolved_at = now(), resolved_by = ${by} where message_id = ${messageId} and handler = ${handler} and resolved_at is null`;
}
