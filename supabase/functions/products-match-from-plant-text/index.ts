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

function normalizeForMatch(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
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

    const termAliasRows = await sql`
      select term, meaning_type, meaning_id from plant_term_aliases where plant_id = ${plant_id}
    `;
    const plantTermAliasMap = new Map<string, { temperature?: string; packaging?: string }>();
    for (const a of termAliasRows) {
      const entry = plantTermAliasMap.get(a.term) || {};
      (entry as any)[a.meaning_type] = a.meaning_id;
      plantTermAliasMap.set(a.term, entry);
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
        if (!tempConflict && !packConflict) {
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

    let nameMatches = (name_en || name_es)
      ? allInCategoryProducts.filter((p: any) => inCategory(p) && (
          (name_en && normalizeForMatch(p.name_en) === normalizeForMatch(name_en)) ||
          (name_es && normalizeForMatch(p.name) === normalizeForMatch(name_es))
        ))
      : allInCategoryProducts.filter((p: any) => inCategory(p) && (
          normalizeForMatch(p.name) === key || normalizeForMatch(p.name_en) === key
        ));

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

    // Rule 1/5 — nothing found means "needs a human to confirm creating something new," never an
    // auto-create. Returning an empty candidate list, not an error, so the caller can offer
    // "+ Create new product" as an explicit next step.
    if (!nameMatches.length) {
      return new Response(JSON.stringify({ matched: false, candidates: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rule 4/12 — narrow the name matches by temperature/packaging too, never stop at name alone.
    const narrowed = narrowByTempPack(raw_text, nameMatches, temperatures, packagings, plantTermAliasMap);

    if (narrowed.length === 1) {
      return new Response(JSON.stringify({ matched: true, source: "name_and_spec", product: productSummary(narrowed[0]) }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rule 5 — genuinely ambiguous: real, pickable candidates, never a silent guess.
    const candidates = (narrowed.length ? narrowed : nameMatches).map(productSummary);
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
