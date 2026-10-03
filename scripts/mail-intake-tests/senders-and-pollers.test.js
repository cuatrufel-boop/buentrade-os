const P = require('./harness.js');
const root = P.__root;
const mail = P.__load(root + '_shared/mailIntake.ts');
const pickup = P.__load(root + 'pickup-docs-emails-poll/index.ts');
const release = P.__load(root + 'release-number-emails-poll/index.ts');
const LLM = P.__load(root + '_shared/llmExtractor.ts');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

function fakeDb(rules) {
  const log = [];
  const db = (strings, ...vals) => {
    const text = Array.from(strings).join('?').replace(/\s+/g, ' ');
    log.push({ text, vals });
    for (const [re, fn] of rules) if (re.test(text)) return Promise.resolve(fn(vals, text));
    return Promise.resolve([]);
  };
  db.json = (x) => x; db.begin = (f) => f(db); db.log = log;
  db.did = (re) => log.some((l) => re.test(l.text));
  return db;
}
const hdr = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const msg = (id, from, subject, parts = [], extraHeaders = {}, body = '') => ({ id, payload: { headers: hdr({ From: from, Subject: subject, ...extraHeaders }), mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: b64(body) } }, ...parts] } });
const att = (filename, mimeType = 'application/pdf') => ({ filename, mimeType, body: { attachmentId: 'att-' + filename } });
const plantRow = (o = {}) => ({ id: 'P1', name: 'Wholestone', docs_included: true, by_email: true, by_cc: false, by_payments: false, by_learned: false, ...o });
const okDeps = () => { const calls = { push: [], uploaded: [] }; return { calls, deps: { fetchAttachment: async () => ({ ok: true, data: b64('x') }), upload: async (p) => { calls.uploaded.push(p); return { ok: true }; }, push: async (...a) => { calls.push.push(a); } } }; };

(async () => {
  // ---------- mail helpers
  ok(mail.senderAddress('"Marquez, Fernando" <Fernando.Marquez@SeaboardFoods.com>') === 'fernando.marquez@seaboardfoods.com', 'sender address parsed and lower-cased');
  ok(mail.isOwnNotification('Tyson — 3 prices just applied') && mail.isOwnNotification('🔴 CRITICO — Pedir Release Number — BT-2026-1009') && !mail.isOwnNotification('WP Fresh Offers'), 'own notifications recognized, price emails are not');
  const none = () => '';
  ok(mail.isAutoReply('Automatic reply: WP Fresh Offers 9/21', none) && mail.isAutoReply('Out of Office', none) && mail.isAutoReply('hi', (n) => n === 'Auto-Submitted' ? 'auto-replied' : '') && !mail.isAutoReply('WP Fresh Offers', none) && !mail.isAutoReply('hi', (n) => n === 'Auto-Submitted' ? 'no' : ''), 'auto replies recognized by subject and RFC 3834 header');
  ok(mail.isAutomatedSender('no-reply@email.claude.com') && mail.isAutomatedSender('updates-noreply@linkedin.com') && mail.isAutomatedSender('mailer-daemon@x.com') && !mail.isAutomatedSender('fernando.marquez@seaboardfoods.com') && !mail.isAutomatedSender('noah@plant.com'), 'automated senders vs humans');
  // ---------- resolveSender
  let db = fakeDb([[/from plants p/, () => [plantRow()]]]);
  let r = await mail.resolveSender(db, 'A@B.com');
  ok(r.kind === 'plant' && r.via === 'email', 'primary email recognizes the plant');
  db = fakeDb([[/from plants p/, () => [plantRow({ by_email: false, by_cc: true })]]]);
  r = await mail.resolveSender(db, 'x@y.com'); ok(r.kind === 'plant' && r.via === 'email_cc', 'an email_cc contact recognizes the plant');
  db = fakeDb([[/from plants p/, () => [plantRow({ by_email: false, by_learned: true })]]]);
  r = await mail.resolveSender(db, 'x@y.com'); ok(r.kind === 'plant' && r.via === 'learned', 'an address assigned by a person recognizes the plant');
  db = fakeDb([[/from plants p/, () => [plantRow({ id: 'P1', name: 'Peco foods', by_email: false, by_cc: true }), plantRow({ id: 'P2', name: 'Koch Foods', by_email: false, by_cc: true })]]]);
  r = await mail.resolveSender(db, 'x@y.com'); ok(r.kind === 'ambiguous' && r.candidates.length === 2, 'an address that fits two plants is ambiguous, never guessed');
  db = fakeDb([[/from plants p/, () => [plantRow({ id: 'P1', by_email: true }), plantRow({ id: 'P2', by_email: false, by_cc: true })]]]);
  r = await mail.resolveSender(db, 'x@y.com'); ok(r.kind === 'plant' && r.plant.id === 'P1', 'a primary email beats another plant that lists it as a contact');
  db = fakeDb([[/from providers/, () => [{ id: 'C1', name: 'Key Global' }]]]);
  r = await mail.resolveSender(db, 'alex@carrier.com'); ok(r.kind === 'carrier', 'a carrier address is recognized');
  db = fakeDb([]); r = await mail.resolveSender(db, 'purchasing@buentradegroup.com'); ok(r.kind === 'internal', 'own domain -> internal');
  r = await mail.resolveSender(db, 'no-reply@mailer.com'); ok(r.kind === 'automated', 'no-reply sender -> automated');
  r = await mail.resolveSender(db, 'someone@newplant.com'); ok(r.kind === 'unknown', 'unrecognized human -> unknown');

  // ---------- pickup docs
  const shipmentRule = [/from shipments sh/, () => [{ id: 'S1', won_by: 'trader@x.com', plant_name: 'Wholestone' }]];
  const plantRule = [/from plants p/, () => [plantRow()]];
  let { deps, calls } = okDeps();
  db = fakeDb([plantRule, shipmentRule]);
  let out = await pickup.processMessage(db, deps, msg('m1', 'a@w.com', 'RE: PO-BT-2026-1001 pickup', [att('BOL-1001.pdf')]));
  ok(out.attachments_saved === 1 && out.shipment_matched === true && out.order_number === 'BT-2026-1001', 'plant BOL with order number: saved and matched to the shipment');
  ok(db.did(/insert into shipment_pickup_documents/) && db.did(/insert into pickup_docs_emails_processed/) && calls.push.length === 1, 'document row, processed row and trader push all written');
  ({ deps, calls } = okDeps()); db = fakeDb([plantRule]);
  out = await pickup.processMessage(db, deps, msg('m2', 'a@w.com', 'WP Fresh & Frozen Offers Sept 30th', [att('Freezer List - 9-30-26.xlsx', 'application/x'), att('CPU POLICY 2026 (003).pdf')]));
  ok(out.skipped === 'not_pickup_documents' && !db.did(/insert into shipment_pickup_documents/) && calls.uploaded.length === 0, 'a plant price list is NOT filed as pickup documents (the 19-file misfiling)');
  ok(db.did(/insert into pickup_docs_emails_processed/), '...and it is recorded as handled');
  ({ deps, calls } = okDeps()); db = fakeDb([[/from plants p/, () => []], [/from providers/, () => [{ id: 'C1', name: 'Key Global' }]]]);
  out = await pickup.processMessage(db, deps, msg('m3', 'alex@carrier.com', 'Docs for your load', [att('scan.pdf')]));
  ok(out.source === 'carrier' && out.attachments_saved === 1 && !out.shipment_matched && calls.uploaded[0].startsWith('pickup-docs/unmatched-m3/'), 'carrier documents with no order number are queued unmatched for a person');
  ({ deps, calls } = okDeps()); deps.fetchAttachment = async () => ({ ok: false, detail: 'Gmail answered 500' }); db = fakeDb([plantRule, shipmentRule]);
  out = await pickup.processMessage(db, deps, msg('m4', 'a@w.com', 'PO-BT-2026-1001 BOL', [att('BOL-1001.pdf')]));
  ok(out.will_retry === true && db.did(/insert into mail_intake_issues/) && !db.did(/insert into pickup_docs_emails_processed/), 'download failure: issue opened, message NOT marked processed (retried next cycle)');
  ({ deps, calls } = okDeps()); deps.upload = async () => ({ ok: false, detail: 'storage answered 500' }); db = fakeDb([plantRule, shipmentRule]);
  out = await pickup.processMessage(db, deps, msg('m5', 'a@w.com', 'PO-BT-2026-1001 BOL', [att('BOL-1001.pdf')]));
  ok(out.will_retry === true && db.did(/insert into mail_intake_issues/) && !db.did(/insert into pickup_docs_emails_processed/), 'upload failure: issue opened, message NOT marked processed');
  ({ deps, calls } = okDeps()); db = fakeDb([plantRule, shipmentRule]);
  out = await pickup.processMessage(db, deps, msg('m4', 'a@w.com', 'PO-BT-2026-1001 BOL', [att('BOL-1001.pdf')]));
  ok(db.did(/update mail_intake_issues set resolved_at/) && db.did(/insert into pickup_docs_emails_processed/), 'a retry that succeeds closes the issue and marks the message processed');
  ({ deps, calls } = okDeps()); db = fakeDb([]);
  out = await pickup.processMessage(db, deps, msg('m6', 'stranger@new.com', 'Docs', [att('x.pdf')]));
  ok(out.skipped === 'no_matching_plant_or_carrier' && db.did(/insert into mail_unrecognized_senders/) && db.did(/insert into pickup_docs_emails_processed/), 'unknown sender: written down for a person, then handled');
  db = fakeDb([plantRule]);
  out = await pickup.processMessage(db, deps, msg('m7', 'a@w.com', 'Automatic reply: BOL', [att('BOL.pdf')]));
  ok(out.skipped === 'auto_reply' && !db.did(/shipment_pickup_documents/), 'automatic reply is never read as documents');
  db = fakeDb([]); out = await pickup.processMessage(db, deps, msg('m8', 'purchasing@buentradegroup.com', 'x', [att('BOL.pdf')]));
  ok(out.skipped === 'internal_sender', 'our own mail is not a plant document');
  db = fakeDb([plantRule, shipmentRule]); ({ deps, calls } = okDeps());
  out = await pickup.processMessage(db, deps, msg('m9', 'a@w.com', 'PO-BT-2026-1001 BOL', [att('BOL-1001.pdf')]), { dryRun: true });
  ok(out.attachments_saved === 1 && !db.did(/\binsert\b|\bupdate\b/) && calls.uploaded.length === 0 && calls.push.length === 0, 'dry run decides everything but writes, uploads and sends nothing');

  // ---------- release number
  const awaiting = [/from shipments sh/, () => [{ id: 'S1', plant_paid_at: '2026-10-01', release_number: null, won_by: 'trader@x.com', plant_name: 'Tyson' }]];
  const relDeps = (extract) => ({ extract, push: async (...a) => { relDeps.pushes.push(a); } }); relDeps.pushes = [];
  db = fakeDb([plantRule, awaiting, [/select hash from audit_log/, () => []], [/update shipments set release_number/, (v) => [{ id: 'S1', release_number: v[0] }]]]);
  out = await release.processMessage(db, relDeps(async () => ({ found: true, release_number: '48213' })), msg('r1', 'a@w.com', 'BT-2026-1009 — BuenTrade — Payment & Release Number', [], {}, 'Release # is 48213'));
  ok(out.found === true && out.updated === true && db.did(/update shipments set release_number/) && db.did(/insert into audit_log/) && relDeps.pushes.length === 1, 'release number found: shipment updated, audit row written, trader pushed');
  db = fakeDb([plantRule, awaiting]); relDeps.pushes.length = 0;
  out = await release.processMessage(db, relDeps(async () => { throw new LLM.LLMUnavailableError('no credit'); }), msg('r2', 'a@w.com', 'BT-2026-1009', [], {}, 'x'));
  ok(out.skipped === 'llm_unavailable_will_retry' && !db.did(/insert into release_number_emails_processed/), 'AI service down: reply NOT marked processed (read again next cycle)');
  db = fakeDb([plantRule, awaiting]);
  out = await release.processMessage(db, relDeps(async () => ({ found: false, release_number: '' })), msg('r3', 'a@w.com', 'BT-2026-1009', [], {}, 'thanks, received'));
  ok(out.found === false && db.did(/insert into mail_intake_issues/) && db.did(/insert into release_number_emails_processed/), 'reply with no release number: visible issue opened, message handled');
  db = fakeDb([plantRule, awaiting]);
  out = await release.processMessage(db, relDeps(async () => { throw new Error('bad json'); }), msg('r4', 'a@w.com', 'BT-2026-1009', [], {}, 'x'));
  ok(out.skipped === 'extraction_failed' && db.did(/insert into mail_intake_issues/), 'unreadable AI answer: issue opened, never silent');
  db = fakeDb([plantRule, [/from shipments sh/, () => [{ id: 'S1', plant_paid_at: '2026-10-01', release_number: 'MANUAL1', plant_name: 'T' }]]]);
  out = await release.processMessage(db, relDeps(async () => ({ found: true, release_number: '1' })), msg('r5', 'a@w.com', 'BT-2026-1009', [], {}, 'x'));
  ok(out.skipped === 'shipment_not_awaiting_release_number' && !db.did(/update shipments/), 'a release number the trader already recorded is never overwritten');
  db = fakeDb([plantRule]); out = await release.processMessage(db, relDeps(async () => ({})), msg('r6', 'a@w.com', 'WP Offers', [], {}, 'prices'));
  ok(out.skipped === 'no_order_number_detected', 'a price email carries no order number: not this reader\'s job');
  db = fakeDb([[/from plants p/, () => []], [/from providers/, () => [{ id: 'C1', name: 'K' }]]]); out = await release.processMessage(db, relDeps(async () => ({})), msg('r7', 'c@car.com', 'BT-2026-1009', [], {}, 'x'));
  ok(out.skipped === 'carrier_not_asked_for_release_number', 'a carrier is not asked for release numbers');
  db = fakeDb([]); out = await release.processMessage(db, relDeps(async () => ({})), msg('r8', 'who@new.com', 'BT-2026-1009', [], {}, 'x'));
  ok(out.skipped === 'no_matching_plant' && db.did(/insert into mail_unrecognized_senders/), 'unknown sender written down');
  db = fakeDb([plantRule, awaiting, [/select hash from audit_log/, () => []]]); relDeps.pushes.length = 0;
  out = await release.processMessage(db, relDeps(async () => ({ found: true, release_number: '9' })), msg('r9', 'a@w.com', 'BT-2026-1009', [], {}, 'Release 9'), { dryRun: true });
  ok(out.updated === true && !db.did(/\binsert\b|\bupdate\b/) && relDeps.pushes.length === 0, 'release dry run writes and sends nothing');
  // ---------- looksLikePickupDocs
  ok(pickup.looksLikePickupDocs('BOL attached', []) && pickup.looksLikePickupDocs('docs', ['Packing_List_1001.pdf']) && pickup.looksLikePickupDocs('x', ['USDA cert.pdf']) && !pickup.looksLikePickupDocs('WP Offers', ['Freezer List - 9-22-26.xlsx', 'CPU POLICY 2026 (003).pdf', 'Specs_16011 - Butt Plate Skin.pdf', 'image001.png']), 'pickup-document hints: BOL/packing list/USDA yes; price list, CPU policy, specs, logos no');
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
