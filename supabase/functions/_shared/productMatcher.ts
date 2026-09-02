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
  | { matched: false; candidates: ProductRow[] }
  | { error: string };

function normalizeForMatch(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase().replace(/%/g, "").replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeForMatchLoose(s: string | null | undefined): string {
  return normalizeForMatch(s).replace(/\b(pork|beef|chicken|lamb)\b/g, "").replace(/\s+/g, " ").trim();
}

function wordBoundary(w: string): RegExp {
  return new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
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
  if (!packagingId && wordBoundary("COV").test(norm)) {
    const vac = packagings.find((p) => (p.name_en || "").toLowerCase() === "vac");
    if (vac) packagingId = vac.id;
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

function narrowByTempPack(
  rawText: string,
  candidates: any[],
  temperatures: TempPack[],
  packagings: TempPack[],
  plantTermAliasMap: Map<string, { temperature?: string; packaging?: string }>,
) {
  const { tempId, packagingId } = detectTempPackFromLine(rawText, temperatures, packagings, plantTermAliasMap);
  return candidates.filter((p) =>
    (!tempId || p.temperature_id === tempId) &&
    (!packagingId || p.packaging_id === packagingId)
  );
}

function detectVariationNamesFromLine(line: string, variationNames: string[]): Set<string> {
  const norm = line.toLowerCase();
  const matched = new Set<string>();
  for (const name of variationNames) {
    if (name && wordBoundary(name).test(norm)) matched.add(name.toLowerCase());
  }
  return matched;
}

function candidateVariationSet(p: any): Set<string> {
  return new Set(
    (p.subcategory_en || "")
      .split(",")
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function narrowByVariation(rawText: string, candidates: any[], variationNames: string[], taughtNames: Set<string> = new Set()) {
  const lineVariations = new Set([...detectVariationNamesFromLine(rawText, variationNames), ...taughtNames]);
  if (lineVariations.size === 0) return candidates;
  const narrowed = candidates.filter((p) => {
    const pVariations = candidateVariationSet(p);
    for (const v of lineVariations) if (!pVariations.has(v)) return false;
    return true;
  });
  return narrowed.length ? narrowed : candidates;
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

  const termAliasRows = await sql`
    select term, meaning_type, meaning_id from plant_term_aliases where plant_id = ${plant_id}
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
      const productVariations = candidateVariationSet(product);
      const variationConflict = [...lineVariations].some((v) => !productVariations.has(v));
      if (!tempConflict && !packConflict && !variationConflict) {
        return { matched: true, source: "alias", product: productSummary(product) };
      }
    }
  }

  const allInCategoryProducts = plantCategoryId
    ? await sql`select * from products where category_id = ${plantCategoryId}`
    : await sql`select * from products`;

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

  const tempPackNarrowed = narrowByTempPack(raw_text, nameMatches, temperatures, packagings, plantTermAliasMap);
  const narrowed = narrowByVariation(raw_text, tempPackNarrowed, variationNames, taughtVariationNamesFromLine(raw_text));

  if (narrowed.length === 1) {
    return { matched: true, source: "name_and_spec", product: productSummary(narrowed[0]) };
  }

  const candidates = (narrowed.length ? narrowed : (tempPackNarrowed.length ? tempPackNarrowed : nameMatches)).map(productSummary);
  return { matched: false, candidates };
}
