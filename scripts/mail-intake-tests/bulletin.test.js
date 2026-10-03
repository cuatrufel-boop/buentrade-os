// Market Flash bulletin by email: recognition, why a candidate is turned away (and that a person can see it), AI outage = retry, incomplete
// commentary = visible. Gmail, the PDF reader, the bulletin store and the database are faked.
const state = { ingest: null, pdf: null };
globalThis.__stubs = {
  'pdf.ts': { readPdfItems: async (...a) => state.pdf(...a) },
  'store.ts': { ingestBulletin: async (...a) => state.ingest(...a) },
};
const P = require('./harness.js');
const root = P.__root;
const inbox = P.__load(root + '_shared/marketFlash/emailInbox.ts');
const mail = P.__load(root + '_shared/mailIntake.ts');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(20000, 65)]);
const notPdf = Buffer.alloc(20000, 66);
const j = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
function gmail(messages, attachmentBytes = pdfBytes) {
  const calls = { self: [] };
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('oauth2.googleapis.com')) return j({ access_token: 't' });
    if (url.includes('price-history-search')) { calls.self.push(url); return j({}); }
    const a = url.match(/messages\/([^/?]+)\/attachments\//); if (a) return j({ data: b64u(attachmentBytes) });
    const g = url.match(/messages\/([^/?]+)\?format=full/);
    if (g) {
      const x = messages[g[1]];
      return j({ id: g[1], labelIds: x.labels || [], payload: { headers: Object.entries({ From: x.from, Subject: x.subject, 'Authentication-Results': x.auth || '' }).map(([name, value]) => ({ name, value })), parts: (x.parts || []).map((p) => ({ filename: p.filename, mimeType: p.mimeType || 'application/pdf', body: { attachmentId: 'att-' + p.filename, size: 50000 } })) } });
    }
    if (url.includes('/messages?')) return j({ messages: Object.keys(messages).map((id) => ({ id })) });
    throw new Error('unexpected fetch ' + url);
  };
  return calls;
}
function fakeDb({ dup = false, row = null } = {}) {
  const log = []; const pending = [];
  const db = (strings, ...vals) => {
    const text = Array.from(strings).join('?').replace(/\s+/g, ' ');
    log.push({ text, vals });
    if (/insert into market_flash_email_inbox/.test(text) && vals[3] === 'pending') pending.push(vals[0]);
    if (/select message_id from market_flash_email_inbox where status = 'pending'/.test(text)) return Promise.resolve(pending.map((message_id) => ({ message_id })));
    if (/select id from market_flash_bulletins where file_hash/.test(text)) return Promise.resolve(dup ? [{ id: 'B1' }] : []);
    if (/select message_id, from_email, subject, file_hash, items from market_flash_email_inbox/.test(text)) return Promise.resolve(row ? [row] : []);
    return Promise.resolve([]);
  };
  db.json = (x) => x; db.begin = (f) => f(db); db.log = log;
  db.did = (re) => log.some((l) => re.test(l.text));
  db.statusOf = (id) => { const l = log.find((x) => /insert into market_flash_email_inbox/.test(x.text) && x.vals[0] === id); return l && { status: l.vals[3], reason: l.vals[4] }; };
  return db;
}
const TRADER = 'purchasing@buentradegroup.com';
const REPORT = '_sites_default_files_newsletters_20261003_bi-weekly_report_-_english.pdf';

(async () => {
  state.pdf = async () => [[['Weekly pork production', 10, 10]]];
  // ---------- recognition (shared by every reader)
  const payload = (names) => ({ parts: names.map((n) => ({ filename: n, mimeType: 'application/pdf', body: { attachmentId: 'a' } })) });
  ok(mail.isBulletinEmail('flash', payload(['x.pdf'])) && mail.isBulletinEmail('Re: Market FLASH Oct', payload(['x.pdf'])), 'subject with the word flash + a PDF is the bulletin');
  ok(mail.isBulletinEmail('Steiner Consulting', payload([REPORT])), 'the report PDF by its own file name is the bulletin, whatever the subject (it can arrive directly)');
  ok(!mail.isBulletinEmail('flash', { parts: [] }) && !mail.isBulletinEmail('PO-BT-2026-1015', payload(['PO-BT-2026-1015.pdf'])) && !mail.isBulletinEmail('WP offers', payload(['CPU POLICY 2026 (003).pdf', 'Specs_16011.pdf'])) && !mail.isBulletinEmail('flashy', payload(['x.pdf'])), 'no PDF, other PDFs, and look-alike words are not the bulletin');

  // ---------- poll: accepted
  let db = fakeDb(); let calls = gmail({ m1: { from: `Purchasing <${TRADER}>`, subject: 'flash', labels: ['SENT'], parts: [{ filename: 'report.pdf' }] } });
  let out = await inbox.pollBulletinEmails(db, 10);
  ok(db.statusOf('m1').status === 'pending' && calls.self.length === 1, 'forwarded by the trader with "flash": read and queued for ingest');
  db = fakeDb(); gmail({ m2: { from: `Steiner <${TRADER}>`, subject: 'Bi-weekly report', labels: [], auth: 'mx.google.com; dmarc=pass header.from=buentradegroup.com', parts: [{ filename: REPORT }] } });
  out = await inbox.pollBulletinEmails(db, 10);
  ok(db.statusOf('m2').status === 'pending', 'the report PDF arriving directly (subject without "flash") from a trusted, authenticated sender is read');
  db = fakeDb({ dup: true }); gmail({ m3: { from: TRADER, subject: 'flash', labels: ['SENT'], parts: [{ filename: 'r.pdf' }] } });
  out = await inbox.pollBulletinEmails(db, 10);
  ok(db.statusOf('m3').status === 'ingested' && /already loaded/.test(db.statusOf('m3').reason), 'the same bulletin twice is recognized, not stored twice');

  // ---------- poll: turned away — a person can see why
  db = fakeDb(); gmail({ m4: { from: 'someone@else.com', subject: 'flash', labels: [], auth: 'dmarc=pass', parts: [{ filename: 'r.pdf' }] } });
  await inbox.pollBulletinEmails(db, 10);
  ok(db.statusOf('m4').status === 'rejected' && /not one of the traders/.test(db.statusOf('m4').reason) && db.did(/insert into mail_intake_issues/), 'a bulletin from an address that is not allowed: rejected WITH an issue a person sees');
  db = fakeDb(); gmail({ m5: { from: TRADER, subject: 'flash', labels: [], auth: 'dkim=fail', parts: [{ filename: 'r.pdf' }] } });
  await inbox.pollBulletinEmails(db, 10);
  ok(db.statusOf('m5').status === 'rejected' && /authenticated/.test(db.statusOf('m5').reason) && db.did(/insert into mail_intake_issues/), 'unauthenticated sender: rejected with an issue');
  db = fakeDb(); gmail({ m6: { from: TRADER, subject: 'flash', labels: ['SENT'], parts: [{ filename: 'r.pdf' }] } }, notPdf);
  await inbox.pollBulletinEmails(db, 10);
  ok(db.statusOf('m6').status === 'rejected' && /not a PDF/.test(db.statusOf('m6').reason) && db.did(/insert into mail_intake_issues/), 'an attachment that is not a PDF: rejected with an issue');
  db = fakeDb(); state.pdf = async () => { throw new Error('corrupt xref'); }; gmail({ m7: { from: TRADER, subject: 'flash', labels: ['SENT'], parts: [{ filename: 'r.pdf' }] } });
  await inbox.pollBulletinEmails(db, 10);
  ok(db.statusOf('m7').status === 'rejected' && /could not read the PDF/.test(db.statusOf('m7').reason) && db.did(/insert into mail_intake_issues/), 'a PDF that cannot be read: rejected with an issue');
  state.pdf = async () => [[['x', 1, 1]]];
  db = fakeDb(); gmail({ m8: { from: 'a@b.com', subject: 'Quarterly report', labels: [], parts: [{ filename: 'report.pdf' }] } });
  await inbox.pollBulletinEmails(db, 10);
  ok(db.statusOf('m8').status === 'rejected' && /not the bulletin/.test(db.statusOf('m8').reason) && !db.did(/insert into mail_intake_issues/), 'some other report PDF: recorded (not fetched again) but nobody is bothered');

  // ---------- process: AI outage, errors, incomplete commentary
  const row = { message_id: 'm1', from_email: TRADER, subject: 'flash', file_hash: 'a'.repeat(64), items: [[['x', 1, 1]]] };
  db = fakeDb({ row }); state.ingest = async (_s, p) => { state.lastOpts = p; return { error: 'the AI service is unavailable', retry: true }; };
  out = await inbox.processInboxMessage(db, 'm1');
  ok(out.status === 'pending' && out.will_retry === true && !db.did(/update market_flash_email_inbox/) && state.lastOpts.requireNarrative === true, 'AI service down: NOTHING stored, the message stays pending (its text kept) and is read again next cycle');
  db = fakeDb({ row }); state.ingest = async () => ({ error: 'this does not look like the bi-weekly bulletin' });
  out = await inbox.processInboxMessage(db, 'm1');
  ok(out.status === 'rejected' && db.did(/set status = 'rejected'/) && db.did(/insert into mail_intake_issues/), 'a file that is not the bulletin: rejected with an issue');
  db = fakeDb({ row }); state.ingest = async () => ({ bulletin_id: 'B9', as_of: '2026-10-03', bullets: 300, narrative_error: null });
  out = await inbox.processInboxMessage(db, 'm1');
  ok(out.status === 'ingested' && db.did(/set status = 'ingested'/) && db.did(/update mail_intake_issues set resolved_at/), 'a complete bulletin is stored and any earlier issue for it closes by itself');
  db = fakeDb({ row }); state.ingest = async () => ({ bulletin_id: 'B9', as_of: '2026-10-03', bullets: 280, narrative_error: 'answer was not valid JSON' });
  out = await inbox.processInboxMessage(db, 'm1');
  const upd = db.log.find((l) => /set status = 'ingested'/.test(l.text));
  ok(out.status === 'ingested' && /commentary could not be read/.test(upd.vals[0]), 'stored without its commentary: the reason is written on the message (the bulletin itself is surfaced and repaired separately)');
  db = fakeDb({ row }); state.ingest = async (_s, p) => { state.lastOpts = p; return { bulletin_id: 'B9', as_of: 'x', bullets: 1, narrative_error: null }; };
  await inbox.processInboxMessage(db, 'm1', { requireNarrative: false });
  ok(state.lastOpts.requireNarrative === false, 'the verification mode can continue without the commentary (explicit flag only)');
  db = fakeDb({ row: null }); out = await inbox.processInboxMessage(db, 'zz');
  ok(out.skipped === 'not pending', 'a message that is not pending is never touched');
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
