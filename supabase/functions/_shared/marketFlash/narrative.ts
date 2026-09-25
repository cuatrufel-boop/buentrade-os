// The "Market Trends" paragraphs (page 2): prose, so a table parser can't read them. The LLM is
// allowed exactly two jobs, both audited by code and by a second independent pass:
//   1. pick sentences out of a bullet, quoting them VERBATIM (checked as a substring of the source),
//   2. translate each one LITERALLY into Spanish (numbers checked to be identical; a separate
//      auditor pass looks for anything added, omitted or mistranslated).
// Anything that fails is dropped and reported. The LLM never decides species, level, market, or what
// to send — species comes from the section header, the rest from fixed rules.
import type { LlmCall } from "./claude.ts";
import type { Dropped, Species } from "./types.ts";

export interface NarrativeSection { categoryName: string; text: string }
export interface NarrativeClaim {
  species: Species; source_bullet: string; quote_en: string; text_es: string;
  stance: "observed" | "forward_looking"; page: number | null;
}

const SPECIES_BY_HEADER: Record<string, Species> = { Pork: "pork", Beef: "beef", Chicken: "chicken", Turkey: "turkey" };

// Each paragraph is a run of "- Sentence…" bullets; the flat text keeps " - " between them.
export function splitBullets(text: string): string[] {
  return text.split(/(?:^|\s)-\s+(?=[A-Z])/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 20);
}

const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
const numerals = (s: string) => (s.replace(/(\d),(\d{3})/g, "$1$2").match(/\d+(?:\.\d+)?/g) || []).sort();
const percents = (s: string) => (s.match(/%/g) || []).length;

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          bullet_index: { type: "integer", description: "0-based index of the source bullet this claim comes from." },
          quote_en: { type: "string", description: "One sentence (or two consecutive sentences when the second cannot stand without the first) copied CHARACTER FOR CHARACTER from that bullet." },
          text_es: { type: "string", description: "Literal Spanish translation of quote_en, nothing added, nothing omitted." },
          stance: { type: "string", enum: ["observed", "forward_looking"], description: "forward_looking when the sentence states an expectation, forecast, view or risk; observed when it reports something that already happened or a current level." },
        },
        required: ["bullet_index", "quote_en", "text_es", "stance"],
        additionalProperties: false,
      },
    },
  },
  required: ["claims"],
  additionalProperties: false,
};

const EXTRACT_SYSTEM = `You prepare customer-facing Spanish sentences from an industry market bulletin about the ${"{SPECIES}"} market. You are given numbered bullets in English.

For each bullet, split it into sentences and return each sentence as a claim: quote_en copied exactly (same words, numbers, punctuation) from the bullet, and text_es a LITERAL Spanish translation of that quote.
- A claim must make sense on its own. If a sentence depends on the previous one (it starts with a connector such as "As a result", "But", "However", "Currently", or uses a pronoun that points back: "their", "its", "they", "it", "this", "these", "that"), do NOT emit it alone: make ONE claim whose quote_en is the contiguous run of sentences from the one it depends on through it (still copied exactly, still from the same bullet).

Hard rules:
- Never add a fact, a number, a cause, a conclusion, advice, or an adjective that is not in quote_en. Never omit a number or a qualifier ("about", "modest", "expected"). Do not summarize. Do not combine sentences from different bullets.
- Copy every number, percentage and range exactly as written. Do not convert units or reformat numbers.
- Keep these words in English exactly as written, inside the Spanish sentence: Labor Day, USDA, cutout, primal, belly, bellies, picnics, trim, b/s, y/y, Q1, Q2, Q3, Q4, Sep/Oct, and any other trade term, brand or proper name you are not fully certain has a standard Spanish equivalent. Translate ordinary words only.
- Skip a sentence only if it contains no information a buyer could use (there should be almost none). Do not skip sentences to shorten the result.
- Output only the JSON.`;

const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          faithful: { type: "boolean", description: "true only if the Spanish says exactly what the English says." },
          added: { type: "array", items: { type: "string" }, description: "Anything the Spanish states that the English does not." },
          omitted: { type: "array", items: { type: "string" }, description: "Anything the English states (numbers, qualifiers, hedges) that the Spanish leaves out or softens." },
          wrong_terms: { type: "array", items: { type: "string" }, description: "Any term translated incorrectly or ambiguously." },
        },
        required: ["id", "faithful", "added", "omitted", "wrong_terms"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
};
const AUDIT_SYSTEM = `You are a strict translation auditor. For each numbered pair you get an English sentence and a Spanish translation. Judge ONLY whether the Spanish is a faithful, literal rendering of the English: same facts, same numbers, same hedges, same direction (up/down, higher/lower), nothing added, nothing missing. Do not judge whether the English statement is logical, true or well-written — only whether the Spanish matches it. Put something in wrong_terms only for a genuine mistranslation, never for an oddity of the source. Be skeptical about additions and omissions: when the Spanish adds or drops a fact, number or hedge, mark faithful=false. Output only the JSON.`;

export async function readNarrative(sections: NarrativeSection[], llm: LlmCall, page: number | null = 2): Promise<{ claims: NarrativeClaim[]; dropped: Dropped[] }> {
  const results = await Promise.all(sections.map((sec) => readSection(sec, llm, page)));
  return { claims: results.flatMap((r) => r.claims), dropped: results.flatMap((r) => r.dropped) };
}

async function readSection(sec: NarrativeSection, llm: LlmCall, page: number | null): Promise<{ claims: NarrativeClaim[]; dropped: Dropped[] }> {
  const claims: NarrativeClaim[] = [], dropped: Dropped[] = [];
  const species = SPECIES_BY_HEADER[sec.categoryName];
  if (!species) { dropped.push({ kind: "narrative", entity: sec.categoryName, page: page || 0, reason: "out of scope: not pork/beef/chicken/turkey" }); return { claims, dropped }; }
  const bullets = splitBullets(sec.text);
  if (!bullets.length) return { claims, dropped };
  const user = bullets.map((b, i) => `[${i}] ${b}`).join("\n");
  const ext = await llm(EXTRACT_SYSTEM.replace("{SPECIES}", species), user, EXTRACT_SCHEMA, 6000);
  // 0) a sentence that leans on the previous one (connector or back-pointing pronoun) is never sent alone:
  //    join it, in code, with the claim before it when both come from the same bullet and are contiguous there.
  const DEPENDENT = /^(As a result|But|However|Currently|Meanwhile|Also|In addition|Still|Therefore|That said|Even so|This|These|Those|They|Their|Its|It)\b/;
  const merged: any[] = [];
  for (const c of (ext.claims || []) as any[]) {
    const prev = merged[merged.length - 1];
    if (prev && DEPENDENT.test(String(c.quote_en).trim()) && prev.bullet_index === c.bullet_index) {
      const joined = `${prev.quote_en.trim()} ${c.quote_en.trim()}`;
      if (bullets[c.bullet_index] != null && norm(bullets[c.bullet_index]).includes(norm(joined))) {
        prev.quote_en = joined; prev.text_es = `${prev.text_es.trim()} ${c.text_es.trim()}`;
        if (c.stance === "forward_looking") prev.stance = "forward_looking";
        continue;
      }
    }
    merged.push({ ...c });
  }
  // 1) deterministic checks
  const staged: Array<{ id: number; c: any }> = [];
  merged.forEach((c: any) => {
    const src = bullets[c.bullet_index];
    const drop = (reason: string) => dropped.push({ kind: "narrative", entity: `${species}: ${String(c.quote_en).slice(0, 70)}`, page: page || 0, reason });
    if (src == null) return drop("bullet index does not exist");
    if (!norm(src).includes(norm(c.quote_en))) return drop("quote is not a verbatim substring of the bulletin text");
    if (JSON.stringify(numerals(c.quote_en)) !== JSON.stringify(numerals(c.text_es))) return drop(`numbers differ: EN ${numerals(c.quote_en)} vs ES ${numerals(c.text_es)}`);
    if (percents(c.quote_en) !== percents(c.text_es)) return drop("percent signs differ between English and Spanish");
    if (c.text_es.length > c.quote_en.length * 1.6 + 20) return drop("Spanish is much longer than the English (possible elaboration)");
    staged.push({ id: staged.length, c: { ...c, source: src } });
  });
  if (!staged.length) return { claims, dropped };
  // 2) independent audit pass
  const aud = await llm(AUDIT_SYSTEM, staged.map((s) => `[${s.id}]\nEN: ${s.c.quote_en}\nES: ${s.c.text_es}`).join("\n\n"), AUDIT_SCHEMA, 6000);
  const verdict = new Map<number, any>((aud.verdicts || []).map((v: any) => [v.id, v]));
  for (const s of staged) {
    const v = verdict.get(s.id);
    const drop = (reason: string) => dropped.push({ kind: "narrative", entity: `${species}: ${String(s.c.quote_en).slice(0, 70)}`, page: page || 0, reason });
    if (!v) { drop("auditor returned no verdict"); continue; }
    if (!v.faithful || v.added.length || v.omitted.length || v.wrong_terms.length) { drop(`auditor: ${[...v.added.map((x: string) => "added «" + x + "»"), ...v.omitted.map((x: string) => "omitted «" + x + "»"), ...v.wrong_terms.map((x: string) => "term «" + x + "»")].join("; ") || "not faithful"}`); continue; }
    claims.push({ species, source_bullet: s.c.source, quote_en: s.c.quote_en, text_es: s.c.text_es, stance: s.c.stance, page });
  }
  return { claims, dropped };
}
