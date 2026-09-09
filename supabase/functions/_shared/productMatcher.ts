// products.matchFromPlantText's real matching logic, extracted so it can be called two ways:
// over HTTP (products-match-from-plant-text/index.ts, unchanged external behavior, still the ONLY
// path the frontend or any other caller should use) and IN-PROCESS, sharing one already-open `sql`
// connection, by plant-price-emails-poll — which calls this (and applyPlantProductMatch below) for
// every line of a real price email. Confirmed real problem this fixes: calling the HTTP endpoint
// once per line, for a 51-item Tyson list, opened ~100 fresh Postgres connections in quick
// succession and hit a real rate limit partway through; one shared connection for the whole run
// doesn't have that problem. The matching RULES themselves are untouched, copied verbatim — this
// is a call-shape change, not a logic change. See the original file's own header for the full
// rule citations (feedback-catalog-matching-is-the-core-system).

export type ProductRow = Record<string, any>;

export type MatchResult =
  | { matched: true; source: "alias" | "name_and_spec"; product: ProductRow }
  // conflicted: true means every candidate here was already known NOT to fully satisfy the line
  // (see narrowStep's "never narrow to zero" rule) — e.g. the line explicitly said
  // "Boneless" and the only candidate on file for that temp+pack is Bone-In. Still real, useful
  // candidates for a human to look at, but never confident enough to auto-pick even when there's
  // only one — a caller that pre-selects on `candidates.length === 1` must check this first.
  | { matched: false; candidates: ProductRow[]; conflicted?: boolean }
  | { error: string };

function normalizeForMatch(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase().replace(/%/g, "").replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeForMatchLoose(s: string | null | undefined): string {
  return normalizeForMatch(s).replace(/\b(pork|beef|chicken|lamb)\b/g, "").replace(/\s+/g, " ").trim();
}

// Real bug, confirmed live 2026-09-09 against a real Seaboard line ("Frozen — #2 Skinless
// Bellies"): a plain \b boundary never matches next to a symbol like "#" — \b only exists at a
// transition between a word character and a non-word one, and "#" is itself non-word, so a space
// immediately before it ("... — #2 ...") is non-word-to-non-word, no boundary, no match, ever.
// Every "#2" product (Backribs #2, Spareribs #2, Skinless Bellies #2, ...) silently lost its own
// defining variation this way — the line then narrowed on temperature alone and confidently
// landed on a same-temperature product with a completely different size (e.g. "9/11") instead of
// ever seeing "#2" as a real signal. Lookaround assertions on "is this a word character" replace
// \b here — they don't require either side to itself be a word character, so a symbol-led term
// like "#2" is bounded exactly the same way a plain word is.
function wordBoundary(w: string): RegExp {
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(?<![A-Za-z0-9_])" + escaped + "(?![A-Za-z0-9_])", "i");
}

type TempPack = { name: string; name_en: string | null; id: string };

function detectTempPackFromLine(
  line: string,
  temperatures: TempPack[],
  packagings: TempPack[],
  plantTermAliasMap: Map<string, { temperature?: string; packaging?: string }>,
): { tempId: string | null; packagingId: string | null } {
  const norm = line.toLowerCase();
  let tempId: string | null = null;
  let packagingId: string | null = null;

  for (const t of temperatures) {
    const words = [t.name, t.name_en].filter(Boolean) as string[];
    if (words.some((w) => wordBoundary(w).test(norm))) { tempId = t.id; break; }
  }
  for (const p of packagings) {
    const words = [p.name, p.name_en].filter(Boolean) as string[];
    if (words.some((w) => wordBoundary(w).test(norm))) { packagingId = p.id; break; }
  }

  if (!tempId && wordBoundary("FZ").test(norm)) {
    const frozen = temperatures.find((t) => (t.name_en || "").toLowerCase() === "frozen");
    if (frozen) tempId = frozen.id;
  }
  // VAC is the only packaging value that will ever exist in BuenTrade's catalog for vacuum-sealed
  // product — VP, CVP, COV and "Vacuum" are all plant wording for the exact same thing, never a
  // separate catalog entry (explicit, standing rule, confirmed multiple times).
  if (!packagingId && (wordBoundary("COV").test(norm) || wordBoundary("VP").test(norm) || wordBoundary("CVP").test(norm) || wordBoundary("Vacuum").test(norm) || wordBoundary("Cryol").test(norm) || wordBoundary("Cryl").test(norm))) {
    const vac = packagings.find((p) => (p.name_en || "").toLowerCase() === "vac");
    if (vac) packagingId = vac.id;
  }
  // Real bug, confirmed live against a real Wholestone email: the catalog's packaging term is
  // "Poly Bag" (two words), but plants write it as just "Poly" (e.g. "Poly soldier-pack") — the
  // word-boundary check above requires the full phrase, so it never matched, packagingId stayed
  // null, and narrowStep's "no packaging detected → don't filter on packaging" rule let a
  // Frozen-only match through unfiltered, silently applying to a Box candidate when the line
  // explicitly said Poly. Same fix pattern as COV/FZ above — a known plant-wording synonym for an
  // existing catalog term, never a new packaging value.
  if (!packagingId && wordBoundary("Poly").test(norm)) {
    const polyBag = packagings.find((p) => (p.name_en || "").toLowerCase() === "poly bag");
    if (polyBag) packagingId = polyBag.id;
  }

  if (!tempId || !packagingId) {
    for (const [term, meaning] of plantTermAliasMap) {
      if (!wordBoundary(term).test(norm)) continue;
      if (!tempId && meaning.temperature) tempId = meaning.temperature;
      if (!packagingId && meaning.packaging) packagingId = meaning.packaging;
    }
  }

  if (!tempId && packagingId) {
    const combo = packagings.find((p) => (p.name_en || "").toLowerCase() === "combo");
    const fresh = temperatures.find((t) => (t.name_en || "").toLowerCase() === "fresh");
    if (combo && fresh && packagingId === combo.id) tempId = fresh.id;
  }

  return { tempId, packagingId };
}

// Every real-world attribute a line can name (temperature, packaging, variation) narrows the same
// way: filter the current candidate pool by that attribute; if the line didn't mention it at all,
// don't touch the pool. Real bug, confirmed live 2026-09-05 against a real Wholestone line
// ("Frozen — Bone-in sirloins Poly soldier-pack"): an earlier version applied temperature and
// packaging together as one all-or-nothing filter, so a packaging word with no matching catalog
// product at this cut ("Poly" — every Sirloin on file is Box or VAC, a genuine gap) wiped out
// candidates of the CORRECT temperature too, and the fallback that followed reset all the way back
// to the full, un-narrowed name-matches — discarding a perfectly good, already-confirmed
// temperature match along with it. Each attribute now narrows independently and never discards
// the pool collected so far just because IT specifically found nothing (Rule 5, generalized from
// variation to every attribute) — it flags the conflict instead and lets the pool stand.
function narrowStep(pool: any[], matches: (p: any) => boolean, signalPresent: boolean): { pool: any[]; conflicted: boolean } {
  if (!signalPresent) return { pool, conflicted: false };
  const narrowed = pool.filter(matches);
  return narrowed.length ? { pool: narrowed, conflicted: false } : { pool, conflicted: true };
}

// Real bug, confirmed live against real Tyson data: a variation registered as "72%" never matched
// a plant writing the bare number with no percent sign ("72 trim combos") — detectVariationNamesFromLine
// found nothing, narrowByVariation's "no variation named in the line" rule then applied no filter
// at all, and the line silently matched the catalog's ONLY Fresh+Combo Trim product ("42% Trim")
// even though the line said 72, not 42. Confirmed real: BuenTrade's own catalog has both "Pork 42%
// Trim Fresh, Combo" and "Pork 72% Trim Frozen, Box" as genuinely different products — a percent
// variation also needs to be recognized by its bare number, not just the exact "NN%" spelling.
function detectVariationNamesFromLine(line: string, variationNames: string[]): Set<string> {
  const norm = line.toLowerCase();
  const matched = new Set<string>();
  for (const name of variationNames) {
    if (!name) continue;
    if (wordBoundary(name).test(norm)) { matched.add(name.toLowerCase()); continue; }
    const bareNumber = name.match(/^(\d+)%$/)?.[1];
    // Real bug, confirmed live 2026-09-09 against Seaboard's own repeat price list: a plain
    // \b boundary treats "/" as a non-word character, so the bare-number fallback for "15%" also
    // matched the "15" inside a completely unrelated size code like "13/15" or "15/17" — every
    // Skinless Bellies 13/15 or 15/17 line then looked like it named a "15%" trim variation the
    // product doesn't have, permanently defeating its own alias (variationConflict always true, no
    // matter how many times a trader confirmed the exact same match) and re-queuing it as a new
    // pending row on every future email instead of ever learning it. A percent variation's bare
    // number only ever appears as a genuinely standalone number ("72 trim combos"), never
    // slash-adjacent, so exclude a digit sitting next to "/" on either side.
    if (bareNumber && wordBoundary(bareNumber).test(norm) && !new RegExp(`/\\s*${bareNumber}\\b|\\b${bareNumber}\\s*/`).test(norm)) {
      matched.add(name.toLowerCase());
    }
  }
  return matched;
}

// Real bug, confirmed live 2026-09-10: a candidate's real distinguishing qualifier isn't always
// in subcategory_en — the catalog is inconsistent about it (e.g. "Pork Skinless Bellies 13/15
// Frozen, Box" carries "13/15" in name_en with subcategory_en just "Skinless", while "Pork
// Skinless Bellies #2 Frozen, Box" carries "#2" in name_en too, ALSO with subcategory_en just
// "Skinless" — so a line that says "#2" could never match the #2 product's real qualifier via
// subcategory_en alone). Union in whatever registered variation names word-bound-match the
// candidate's own name/name_en, the same way a line's variations are detected, so a candidate
// that carries its qualifier in its name is never invisible to this check just because that
// qualifier isn't ALSO duplicated into subcategory_en.
function candidateVariationSet(p: any, variationNames?: string[]): Set<string> {
  const set = new Set<string>(
    (p.subcategory_en || "")
      .split(",")
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (variationNames) {
    const nameNorm = [p.name_en, p.name].filter(Boolean).join(" ").toLowerCase();
    for (const v of variationNames) {
      if (v && wordBoundary(v).test(nameNorm)) set.add(v.toLowerCase());
    }
  }
  return set;
}

function productSummary(p: any): ProductRow {
  return {
    id: p.id,
    business_id: p.business_id,
    name: p.name,
    name_en: p.name_en,
    category_id: p.category_id,
    subcategory: p.subcategory,
    subcategory_en: p.subcategory_en,
    temperature_id: p.temperature_id,
    packaging_id: p.packaging_id,
    full_name_en: p.full_name_en,
    full_name_es: p.full_name_es,
    brand: p.brand,
  };
}

export async function matchProductFromPlantText(
  sql: any,
  { plant_id, raw_text, name_en, name_es, extra_term_aliases }: {
    plant_id: string; raw_text: string; name_en?: string | null; name_es?: string | null;
    extra_term_aliases?: { term: string; meaning_type: string; meaning_id: string }[];
  },
): Promise<MatchResult> {
  if (!plant_id || !raw_text) return { error: "plant_id and raw_text are required" };

  const [plant] = await sql`select id, category_id from plants where id = ${plant_id}`;
  if (!plant) return { error: "unknown plant_id" };
  const plantCategoryId: string | null = plant.category_id;

  const temperatures = await sql`select id, name, name_en from temperature`;
  const packagings = await sql`select id, name, name_en from packaging`;
  const variationRows = await sql`select id, name_es, name_en from variations`;
  const variationNames = variationRows.map((v: any) => v.name_en).filter(Boolean) as string[];
  const variationNameById = new Map(variationRows.map((v: any) => [v.id, v.name_en]));
  const cutNameRows = await sql`select id, name_es, name_en from cut_names`;
  const cutNameById = new Map(cutNameRows.map((c: any) => [c.id, c.name_en]));

  // Global (plant_id null) rows are industry-standard shorthand any plant could use (confirmed
  // real: BI/BNLS/LGT/MED/SPARES/CBO were first taught scoped to one plant, then explicitly
  // corrected — "esas abreviaciones las puede usar cualquiera... buentrade tiene que match con un
  // solo full name"). Loaded first so a plant-specific row for the same term overrides it.
  const termAliasRows = await sql`
    select term, meaning_type, meaning_id, plant_id from plant_term_aliases
    where plant_id = ${plant_id} or plant_id is null
    order by plant_id nulls first
  `;
  const plantTermAliasMap = new Map<string, { temperature?: string; packaging?: string; variation?: string; cut_name?: string }>();
  for (const a of termAliasRows) {
    const entry = plantTermAliasMap.get(a.term) || {};
    (entry as any)[a.meaning_type] = a.meaning_id;
    plantTermAliasMap.set(a.term, entry);
  }
  if (Array.isArray(extra_term_aliases)) {
    for (const a of extra_term_aliases) {
      if (!a?.term || !a?.meaning_type || !a?.meaning_id) continue;
      const entry = plantTermAliasMap.get(a.term) || {};
      (entry as any)[a.meaning_type] = a.meaning_id;
      plantTermAliasMap.set(a.term, entry);
    }
  }

  function taughtVariationNamesFromLine(line: string): Set<string> {
    const norm = line.toLowerCase();
    const found = new Set<string>();
    for (const [term, meaning] of plantTermAliasMap) {
      if (!meaning.variation) continue;
      if (!wordBoundary(term).test(norm)) continue;
      const name = variationNameById.get(meaning.variation);
      if (name) found.add(String(name).toLowerCase());
    }
    return found;
  }
  function taughtCutNamesFromLine(line: string): Set<string> {
    const norm = line.toLowerCase();
    const found = new Set<string>();
    for (const [term, meaning] of plantTermAliasMap) {
      if (!meaning.cut_name) continue;
      if (!wordBoundary(term).test(norm)) continue;
      const name = cutNameById.get(meaning.cut_name);
      if (name) found.add(String(name));
    }
    return found;
  }

  const inCategory = (p: any) => !plantCategoryId || p.category_id === plantCategoryId;

  const key = normalizeForMatch(raw_text);
  const [aliasRow] = await sql`
    select product_id from plant_product_aliases
    where plant_id = ${plant_id} and lower(raw_text) = ${key}
  `;
  if (aliasRow) {
    const [product] = await sql`select * from products where id = ${aliasRow.product_id}`;
    if (product) {
      const { tempId, packagingId } = detectTempPackFromLine(raw_text, temperatures, packagings, plantTermAliasMap);
      const tempConflict = tempId && product.temperature_id && tempId !== product.temperature_id;
      const packConflict = packagingId && product.packaging_id && packagingId !== product.packaging_id;
      const lineVariations = new Set([...detectVariationNamesFromLine(raw_text, variationNames), ...taughtVariationNamesFromLine(raw_text)]);
      const productVariations = candidateVariationSet(product, variationNames);
      const variationConflict = [...lineVariations].some((v) => !productVariations.has(v));
      if (!tempConflict && !packConflict && !variationConflict) {
        return { matched: true, source: "alias", product: productSummary(product) };
      }
    }
  }

  const allInCategoryProducts = plantCategoryId
    ? await sql`select * from products where category_id = ${plantCategoryId}`
    : await sql`select * from products`;

  // Computed early (not just before the temp/pack/variation narrowing below) so the widening step
  // right after the name tiers can check it too — see that block's own comment for why.
  const lineVariations = new Set([...detectVariationNamesFromLine(raw_text, variationNames), ...taughtVariationNamesFromLine(raw_text)]);

  let nameMatches: any[] = [];
  if (!name_en && !name_es) {
    const taughtNames = taughtCutNamesFromLine(raw_text);
    if (taughtNames.size) {
      const taughtLoose = [...taughtNames].map(normalizeForMatch);
      nameMatches = allInCategoryProducts.filter((p: any) =>
        inCategory(p) && (
          taughtLoose.includes(normalizeForMatch(p.name_en)) ||
          taughtLoose.includes(normalizeForMatch(p.name))
        )
      );
    }
  }

  if (!nameMatches.length) {
    nameMatches = (name_en || name_es)
      ? allInCategoryProducts.filter((p: any) => inCategory(p) && (
          (name_en && normalizeForMatch(p.name_en) === normalizeForMatch(name_en)) ||
          (name_es && normalizeForMatch(p.name) === normalizeForMatch(name_es))
        ))
      : allInCategoryProducts.filter((p: any) => inCategory(p) && (
          normalizeForMatch(p.name) === key || normalizeForMatch(p.name_en) === key
        ));
  }

  if (!nameMatches.length) {
    nameMatches = (name_en || name_es)
      ? allInCategoryProducts.filter((p: any) => inCategory(p) && (
          (name_en && normalizeForMatchLoose(p.name_en) === normalizeForMatchLoose(name_en)) ||
          (name_es && normalizeForMatchLoose(p.name) === normalizeForMatchLoose(name_es))
        ))
      : allInCategoryProducts.filter((p: any) => inCategory(p) && (
          normalizeForMatchLoose(p.name) === normalizeForMatchLoose(raw_text) ||
          normalizeForMatchLoose(p.name_en) === normalizeForMatchLoose(raw_text)
        ));
  }

  if (!nameMatches.length) {
    if (name_en || name_es) {
      if (name_en) {
        const enTarget = normalizeForMatch(name_en);
        nameMatches = allInCategoryProducts.filter((p: any) => {
          if (!inCategory(p)) return false;
          const enName = normalizeForMatch(p.name_en);
          return !!enName && wordBoundary(enName).test(enTarget);
        });
      }
      if (!nameMatches.length && name_es) {
        const esTarget = normalizeForMatch(name_es);
        nameMatches = allInCategoryProducts.filter((p: any) => {
          if (!inCategory(p)) return false;
          const esName = normalizeForMatch(p.name);
          return !!esName && wordBoundary(esName).test(esTarget);
        });
      }
    } else {
      const rawNorm = normalizeForMatch(raw_text);
      nameMatches = allInCategoryProducts.filter((p: any) => {
        if (!inCategory(p)) return false;
        const candidateNames = [normalizeForMatch(p.name_en), normalizeForMatch(p.name)].filter(Boolean);
        return candidateNames.some((n) => wordBoundary(n).test(rawNorm));
      });
    }
  }

  if (!nameMatches.length) {
    const stem = (s: string) => s.split(" ").map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)).join(" ");
    if (name_en || name_es) {
      if (name_en) {
        const enTarget = stem(normalizeForMatch(name_en));
        nameMatches = allInCategoryProducts.filter((p: any) => {
          if (!inCategory(p)) return false;
          const enName = stem(normalizeForMatch(p.name_en));
          return !!enName && wordBoundary(enName).test(enTarget);
        });
      }
      if (!nameMatches.length && name_es) {
        const esTarget = stem(normalizeForMatch(name_es));
        nameMatches = allInCategoryProducts.filter((p: any) => {
          if (!inCategory(p)) return false;
          const esName = stem(normalizeForMatch(p.name));
          return !!esName && wordBoundary(esName).test(esTarget);
        });
      }
    } else {
      const rawStemmed = stem(normalizeForMatch(raw_text));
      nameMatches = allInCategoryProducts.filter((p: any) => {
        if (!inCategory(p)) return false;
        const candidateNames = [normalizeForMatch(p.name_en), normalizeForMatch(p.name)].filter(Boolean).map(stem);
        return candidateNames.some((n) => wordBoundary(n).test(rawStemmed));
      });
    }
  }

  if (!nameMatches.length) {
    const stem = (s: string) => s.split(" ").map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)).join(" ");
    const wordsOf = (s: string) => stem(normalizeForMatchLoose(s || "")).split(" ").filter((w) => w.length > 1);
    const allWordsPresent = (candidateWords: string[], lineNorm: string): boolean =>
      candidateWords.length > 0 && candidateWords.every((w) => wordBoundary(w).test(lineNorm));

    if (name_en || name_es) {
      if (name_en) {
        const enTarget = stem(normalizeForMatchLoose(name_en));
        nameMatches = allInCategoryProducts.filter((p: any) => inCategory(p) && allWordsPresent(wordsOf(p.name_en), enTarget));
      }
      if (!nameMatches.length && name_es) {
        const esTarget = stem(normalizeForMatchLoose(name_es));
        nameMatches = allInCategoryProducts.filter((p: any) => inCategory(p) && allWordsPresent(wordsOf(p.name), esTarget));
      }
    } else {
      const rawTarget = stem(normalizeForMatchLoose(raw_text));
      nameMatches = allInCategoryProducts.filter((p: any) => inCategory(p) && (
        allWordsPresent(wordsOf(p.name_en), rawTarget) || allWordsPresent(wordsOf(p.name), rawTarget)
      ));
    }
  }

  if (!nameMatches.length) return { matched: false, candidates: [] };

  // Real bug, confirmed live 2026-09-10 against a real Seaboard line ("Frozen — #2 Skinless
  // Bellies"): the tiers above stop at the FIRST one that finds anything, so a short generic name
  // ("Bellies" — the 9/11 product's own bare name_en, with no size/count in it at all) can
  // substring-match the line and win before a more specific sibling ("Bellies #2") ever gets a
  // chance — its full name doesn't appear as one contiguous phrase in that word order, so it never
  // even entered the tier-3 pool. The line clearly names a real, already-detected variation ("#2")
  // that only the sibling actually has; if nothing in the current pool satisfies a variation the
  // line clearly names, widen the search (same "every word present, any order" rule as the
  // loosest tier) and add whatever that finds, rather than silently keeping the narrower pool and
  // never even considering the actually-correct product.
  if (lineVariations.size && !nameMatches.some((p: any) => {
    const pv = candidateVariationSet(p, variationNames);
    return [...lineVariations].every((v) => pv.has(v));
  })) {
    const stemW = (s: string) => s.split(" ").map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)).join(" ");
    const wordsOfW = (s: string) => stemW(normalizeForMatchLoose(s || "")).split(" ").filter((w) => w.length > 1);
    const allWordsPresentW = (candidateWords: string[], lineNorm: string): boolean =>
      candidateWords.length > 0 && candidateWords.every((w) => wordBoundary(w).test(lineNorm));
    const rawTarget = stemW(normalizeForMatchLoose(raw_text));
    for (const p of allInCategoryProducts) {
      if (!inCategory(p)) continue;
      if (nameMatches.some((existing: any) => existing.id === p.id)) continue;
      if (allWordsPresentW(wordsOfW(p.name_en), rawTarget) || allWordsPresentW(wordsOfW(p.name), rawTarget)) {
        nameMatches.push(p);
      }
    }
  }

  // Temperature, packaging, then variation — each narrows the pool left by the one before it, and
  // each is independent: a mismatch on ONE attribute (see narrowStep above) never erases progress
  // already made by another. `conflicted` is sticky (true if ANY step conflicted) — a pool that
  // narrowed to exactly one candidate only via a step that couldn't actually satisfy the line is
  // never treated as a confident match, no matter which attribute caused it.
  const { tempId, packagingId } = detectTempPackFromLine(raw_text, temperatures, packagings, plantTermAliasMap);

  const tempStep = narrowStep(nameMatches, (p) => p.temperature_id === tempId, !!tempId);
  const packStep = narrowStep(tempStep.pool, (p) => p.packaging_id === packagingId, !!packagingId);
  const variationStep = narrowStep(packStep.pool, (p) => {
    const pVariations = candidateVariationSet(p, variationNames);
    for (const v of lineVariations) if (!pVariations.has(v)) return false;
    return true;
  }, lineVariations.size > 0);

  const pool = variationStep.pool;
  const conflicted = tempStep.conflicted || packStep.conflicted || variationStep.conflicted;

  if (pool.length === 1 && !conflicted) {
    return { matched: true, source: "name_and_spec", product: productSummary(pool[0]) };
  }
  return { matched: false, candidates: pool.map(productSummary), conflicted };
}
