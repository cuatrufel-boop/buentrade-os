// products.matchFromPlantText — the ONLY place this matching logic is allowed to live.
// Read-only: never inserts, updates, or deletes anything. Its job is to answer one question —
// "does this line from a plant's price list match an existing product, or not?" — and hand back
// either a confident single match or a real list of candidates. It NEVER creates a product and
// NEVER silently picks between two plausible candidates; that decision belongs to the trader,
// made through a separate, explicit call (products.create / an "apply" endpoint), not here.
//
// Ported faithfully from plants.html's matchCatalogProduct/detectTempPackFromLine/
// normalizeForMatchLoose/narrowByTempPack — same behavior, now enforced once, centrally, instead
// of living in browser JS that any future page could get slightly wrong.
//
// Connects directly to Postgres as `api_service` (RLS-forced role, no bypass) — never through
// Supabase's PostgREST/anon/service_role path.
//
// Encodes rules from the permanent business-rules memory (feedback-catalog-matching-is-the-
// core-system), specifically: 1 (never auto-create), 2/10 (category and temperature are absolute
// match boundaries), 3 (an alias is re-validated every use, never trusted blindly), 4/12 (every
// field checked together, never partial), 5 (real candidates, never silence), 11 (plant boundary
// — matching never reaches outside the plant's own aliases/category), 15 (plant's category is a
// fixed fact read from `plants.category_id`, never guessed per line).

import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// % and hyphens stripped here (only in this matcher, not the shared duplicate-detection
// normalize) — real gaps confirmed live 2026-08-30 against an actual Tyson price list: catalog
// "42% Trim" never matched a plant's own "42 Trim" (the % is purely decorative, never typed by a
// plant), and catalog "Bone-In" never matched a plant's own "Bone in" (same word, plants routinely
// drop the hyphen and/or the capital I). Both symbols carry no matching-relevant meaning — a
// hyphen becomes a space so "bone-in"/"bone in" normalize identically.
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
  // No silent default when the line gives no temperature signal — an earlier version of this
  // (ported from plants.html) defaulted a signal-less line to Fresh whenever Fresh was among the
  // candidates. That's a silent guess between two real, different products, which is exactly what
  // rule 10 ("Fresco/Congelado es una frontera absoluta, nunca se asume") and rule 5 ("nunca
  // silencio, siempre opciones reales") forbid — caught by testing this function against a
  // genuinely signal-less line with both a Fresh and a Frozen variant on file, confirmed live
  // 2026-08-25. If the line doesn't say it, this stays ambiguous and the caller shows both.
  const { tempId, packagingId } = detectTempPackFromLine(rawText, temperatures, packagings, plantTermAliasMap);
  return candidates.filter((p) =>
    (!tempId || p.temperature_id === tempId) &&
    (!packagingId || p.packaging_id === packagingId)
  );
}

// Real gap closed 2026-08-29: this matcher checked category + name + temperature + packaging,
// but NEVER Variation (subcategory_en) — so two real products differing ONLY by variation (e.g.
// "Loin Boneless Fresh Box" vs "Loin Boneless Skinless Fresh Box") were narrowed identically by
// everything above, meaning the line's own wording (which might say "Skinless" outright) was
// simply thrown away instead of being used to tell them apart. Subcategory_en is a comma-joined
// list of variation names_en, not a single value, so this is a set-containment check, not an
// equality check like temperature/packaging: the line's detected variation words must ALL be
// present on the candidate, but the candidate is allowed to carry additional variations the line
// didn't bother spelling out (plants often write "Skinless" and never restate "Boneless" even
// when the product genuinely is both) — same "no signal, no filter" rule as temp/pack (rule 10):
// a line with zero variation words narrows nothing, never assumed to mean "no variation."
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
  if (lineVariations.size === 0) return candidates; // no signal in the line — never a silent default
  const narrowed = candidates.filter((p) => {
    const pVariations = candidateVariationSet(p);
    for (const v of lineVariations) if (!pVariations.has(v)) return false;
    return true;
  });
  // Rule 5 — never narrow to zero silently. If nothing on file actually has the variation the line
  // names, that's real information to surface (as candidates, still requiring a human pick), not a
  // reason to pretend the variation signal didn't exist.
  return narrowed.length ? narrowed : candidates;
}

function productSummary(p: any) {
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { plant_id, raw_text, name_en, name_es } = await req.json();
    if (!plant_id || !raw_text) {
      return new Response(JSON.stringify({ error: "plant_id and raw_text are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const [plant] = await sql`select id, category_id from plants where id = ${plant_id}`;
    if (!plant) {
      return new Response(JSON.stringify({ error: "unknown plant_id" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Rule 15 — the plant's species/category is a fixed fact, read here, never guessed per line.
    // A plant with no category_id set yet matches against every category (nothing to filter by
    // until someone sets it) rather than silently matching zero rows.
    const plantCategoryId: string | null = plant.category_id;

    const temperatures = await sql<TempPack[]>`select id, name, name_en from temperature`;
    const packagings = await sql<TempPack[]>`select id, name, name_en from packaging`;
    const variationRows = await sql`select id, name_es, name_en from variations`;
    const variationNames = variationRows.map((v: any) => v.name_en).filter(Boolean) as string[];
    const variationNameById = new Map(variationRows.map((v: any) => [v.id, v.name_en]));
    // cut_names — real gap closed 2026-08-30: a plant's own abbreviation for the CUT ITSELF
    // ("XF Trim" = Cutting Fat) is exactly as arbitrary as a temperature/packaging shorthand, but
    // had nowhere to be taught before. No text-normalization trick (stripping %, hyphens, plurals)
    // can ever bridge "XF" to "Cutting Fat" — they share no characters — only a human-confirmed,
    // remembered alias can.
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

    // Any taught term (of either kind) that appears in this exact line, resolved to real
    // catalog values — computed once, reused by both the alias-cache re-validation below and the
    // full matching cascade further down, so a taught "Bnls" = Boneless behaves identically
    // whether this line hits the fast alias-cache path or the slow name-matching path.
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

    // Rule 3/11 — an alias is scoped to THIS plant only (never another plant's data) and is
    // re-validated against the line's own temp/pack signal every time, never trusted blindly.
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
        // Same re-validation the temp/pack conflict check already does — a remembered alias never
        // overrides what THIS line's own text says. If the line now names a variation the aliased
        // product doesn't have (e.g. it learned "Skinless" pointed at a Boneless-only row, and this
        // line's wording also says "Skinless" but the aliased row lacks it), that's a real conflict.
        const lineVariations = new Set([...detectVariationNamesFromLine(raw_text, variationNames), ...taughtVariationNamesFromLine(raw_text)]);
        const productVariations = candidateVariationSet(product);
        const variationConflict = [...lineVariations].some((v) => !productVariations.has(v));
        if (!tempConflict && !packConflict && !variationConflict) {
          return new Response(JSON.stringify({ matched: true, source: "alias", product: productSummary(product) }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        // Conflict — fall through to normal matching below rather than trusting the cache.
      }
    }

    const allInCategoryProducts = plantCategoryId
      ? await sql`select * from products where category_id = ${plantCategoryId}`
      : await sql`select * from products`;

    // A taught cut-name alias goes first, ahead of every text-normalization trick below — none of
    // them (stripping %, hyphens, plurals, or checking substrings) can ever bridge something like
    // "XF" to "Cutting Fat" on their own, since the words share no characters at all. Only
    // reached for the raw_text-only path; a block-format caller already isolated a clean name_en/
    // name_es and doesn't need this. Rule 3 still applies even to a taught fact — this only picks
    // the CANDIDATE set, every one of them still goes through the exact same temp/pack/variation
    // narrowing below, so a stale or overly-broad alias can never skip that check.
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

    // Real gap confirmed live 2026-08-30: a single-line price list (Tyson's exact format —
    // "Fresh Green Meats — 42 Trim Combos", section header AND "Combos"/"Trim" qualifier baked
    // into the same line by design, so temp/pack detection above has real words to scan) could
    // never satisfy the equality checks above, which require the ENTIRE line to equal a catalog
    // name exactly — real plant wording never is just the bare name alone. Only applies to the
    // raw_text-only path (name_en/name_es null) — the block-format path already isolates a clean
    // name and equality is the right check there. A candidate's name has to appear as a whole
    // phrase (word-boundaried, same technique already used for temp/pack/variation detection)
    // somewhere in the line — "42 Trim" inside "Fresh Green Meats — 42 Trim Combos" — not just
    // share some words with it.
    if (!nameMatches.length && !name_en && !name_es) {
      const rawNorm = normalizeForMatch(raw_text);
      nameMatches = allInCategoryProducts.filter((p: any) => {
        if (!inCategory(p)) return false;
        const candidateNames = [normalizeForMatch(p.name_en), normalizeForMatch(p.name)].filter(Boolean);
        return candidateNames.some((n) => wordBoundary(n).test(rawNorm));
      });
    }

    // Real gap confirmed live 2026-08-30, same Tyson list: the catalog stores singular cut names
    // ("Butt", "Cushion", "Loin", "Sirloin", "Tenderloin") but plants almost always write the
    // plural ("Butts", "Cushions", "Loins"...) since they're quoting a quantity of cuts, not one.
    // Same contains-check as above, one step looser — light regular-plural stemming (drop a
    // trailing "s" from words over 3 letters) applied to BOTH sides before comparing, so "butt"
    // and "butts" line up. Only reached when the exact-phrase contains-check just above found
    // nothing at all, and only for the raw_text-only path — never loosens the block-format
    // (name_en/name_es given) equality checks above, which stay strict on purpose.
    if (!nameMatches.length && !name_en && !name_es) {
      const stem = (s: string) => s.split(" ").map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)).join(" ");
      const rawStemmed = stem(normalizeForMatch(raw_text));
      nameMatches = allInCategoryProducts.filter((p: any) => {
        if (!inCategory(p)) return false;
        const candidateNames = [normalizeForMatch(p.name_en), normalizeForMatch(p.name)].filter(Boolean).map(stem);
        return candidateNames.some((n) => wordBoundary(n).test(rawStemmed));
      });
    }

    // Rule 1/5 — nothing found means "needs a human to confirm creating something new," never an
    // auto-create. Returning an empty candidate list, not an error, so the caller can offer
    // "+ Create new product" as an explicit next step.
    if (!nameMatches.length) {
      return new Response(JSON.stringify({ matched: false, candidates: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rule 4/12 — narrow the name matches by temperature/packaging, AND by variation, never stop
    // at name alone. Two real products differing ONLY by variation (e.g. "Loin Boneless Fresh
    // Box" vs "Loin Boneless Skinless Fresh Box") used to narrow identically through everything
    // above — this is what tells them apart when the line's own wording actually says so.
    const tempPackNarrowed = narrowByTempPack(raw_text, nameMatches, temperatures, packagings, plantTermAliasMap);
    const narrowed = narrowByVariation(raw_text, tempPackNarrowed, variationNames, taughtVariationNamesFromLine(raw_text));

    if (narrowed.length === 1) {
      return new Response(JSON.stringify({ matched: true, source: "name_and_spec", product: productSummary(narrowed[0]) }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rule 5 — genuinely ambiguous: real, pickable candidates, never a silent guess.
    const candidates = (narrowed.length ? narrowed : (tempPackNarrowed.length ? tempPackNarrowed : nameMatches)).map(productSummary);
    return new Response(JSON.stringify({ matched: false, candidates }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
