// Whole-bulletin deterministic pipeline: text pages → verified facts → Spanish bullets.
// (Narrative sentences are handled separately by the LLM step, narrative.ts.)
import { splitPages } from "./pages.ts";
import { extractPriceCharts } from "./priceCharts.ts";
import { extractMxPorkPrices } from "./mxPorkPrices.ts";
import { extractProduction } from "./production.ts";
import { extractColdStorage, extractColdStorageTotals, extractHogsAndPigs, extractCattleOnFeed, extractWorldHogPrices, extractFutures } from "./tables.ts";
import { extractExports } from "./exports.ts";
import { buildBullets } from "./bullets.ts";
import type { Dropped, Fact } from "./types.ts";

export function runDeterministic(text: string) {
  const pages = splitPages(text);
  const parts = [
    ["cut prices", extractPriceCharts(pages)], ["Mexico pork prices", extractMxPorkPrices(pages)], ["production", extractProduction(pages)],
    ["cold storage", extractColdStorage(pages)], ["cold storage totals", extractColdStorageTotals(pages)], ["hogs & pigs", extractHogsAndPigs(pages)], ["cattle on feed", extractCattleOnFeed(pages)],
    ["world hog prices", extractWorldHogPrices(pages)], ["futures", extractFutures(pages)], ["exports", extractExports(pages)],
  ] as const;
  const facts: Fact[] = [], dropped: Dropped[] = [];
  const perSource: Record<string, { facts: number; dropped: number }> = {};
  for (const [name, r] of parts) { facts.push(...r.facts); dropped.push(...r.dropped); perSource[name] = { facts: r.facts.length, dropped: r.dropped.length }; }
  // as-of = the latest weekly production date (the bulletin's own data date)
  const dates = facts.filter((f) => f.kind === "prod_weekly").map((f) => String(f.values.week_end)).sort();
  const asOf = dates[dates.length - 1] || "";
  return { pages: pages.length, asOf, facts, dropped, perSource, bullets: asOf ? buildBullets(facts, asOf) : [] };
}
