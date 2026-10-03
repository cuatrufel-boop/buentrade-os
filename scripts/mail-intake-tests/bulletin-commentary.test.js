// A bulletin stored without its commentary must be repaired later, never silently stay incomplete: completeNarrative with the AI faked.
class LlmUnavailable extends Error {}
const state = { read: null, sections: [{}] };
globalThis.__stubs = {
  'pdf.ts': { itemsFromCompact: (x) => x, layoutText: () => '', narrativeSections: () => state.sections, readPdfItems: async () => [] },
  'narrative.ts': { readNarrative: async (...a) => state.read(...a) },
  'claude.ts': { callClaude: async () => ({}), LlmUnavailable },
};
const P = require('./harness.js');
const store = P.__load(P.__root + '_shared/marketFlash/store.ts');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
function fakeDb(bulletin) {
  const log = [];
  const db = (strings, ...vals) => {
    const text = Array.from(strings).join('?').replace(/\s+/g, ' ');
    log.push({ text, vals });
    if (/select id, as_of, dropped, narrative_error from market_flash_bulletins/.test(text)) return Promise.resolve(bulletin ? [bulletin] : []);
    return Promise.resolve([]);
  };
  db.json = (x) => x; db.begin = (f) => f(db); db.log = log; db.did = (re) => log.some((l) => re.test(l.text));
  return db;
}
const claim = (n) => ({ species: 'pork', quote_en: `We expect hog prices to firm ${n}`, stance: 'forward_looking', text_es: `Esperamos que los precios del cerdo se firmen ${n}`, page: 2 });
const unread = (extra = {}) => ({ id: 'B1', as_of: '2026-09-19', dropped: [{ kind: 'pork_cut', reason: 'x' }], narrative_error: 'not read', ...extra });
(async () => {
  let db = fakeDb(null); let r = await store.completeNarrative(db, 'B1', []);
  ok(r.error === 'unknown bulletin', 'unknown bulletin id');
  db = fakeDb(unread({ narrative_error: null })); r = await store.completeNarrative(db, 'B1', []);
  ok(r.skipped && !db.did(/update|insert/), 'a bulletin whose commentary is already read is never touched');
  db = fakeDb(unread()); state.sections = []; r = await store.completeNarrative(db, 'B1', []);
  ok(r.no_commentary === true && db.did(/set narrative_error = null/), 'a bulletin with no commentary sections is marked complete (nothing to read)');
  state.sections = [{}];
  db = fakeDb(unread()); state.read = async () => { throw new LlmUnavailable('no credit'); }; r = await store.completeNarrative(db, 'B1', []);
  ok(r.retry === true && !db.did(/insert into market_flash_bullets/) && !db.did(/set narrative_error/) && db.did(/set narrative_retry_at/), 'AI service down: nothing written except the retry stamp, the state stays "unread" so it is tried again');
  db = fakeDb(unread()); state.read = async () => { throw new Error('bad json'); }; r = await store.completeNarrative(db, 'B1', []);
  ok(r.error === 'bad json' && db.log.some((l) => /set narrative_error = \?/.test(l.text) && l.vals[0] === 'bad json'), 'an answer that cannot be used: the reason is stored on the bulletin');
  db = fakeDb(unread()); state.read = async () => ({ claims: [claim(1), claim(2), claim(1)], dropped: [{ kind: 'narrative', reason: 'auditor' }] });
  r = await store.completeNarrative(db, 'B1', []);
  const ins = db.log.find((l) => /insert into market_flash_bullets/.test(l.text));
  const upd = db.log.find((l) => /update market_flash_bulletins set dropped/.test(l.text));
  ok(r.narrative_bullets === 2 && ins && ins.vals[1].length === 2 && ins.vals[1].every((x) => x.kind === 'narrative_view' && /^«/.test(x.text_es) && x.quote_en), 'commentary read: its bullets are added (duplicates collapsed), attributed and quoted');
  ok(upd && upd.vals[0].length === 2 && upd.vals[0][1].kind === 'narrative' && /narrative_error = null/.test(upd.text), 'the commentary decisions are appended to what was dropped and the unread state is cleared');
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
