-- Real ask 2026-09-12: "smithfield habla de midwest y east coast separa las pu locations que
-- tenemos en esos dos areas" — some plants' price lists name a broad region ("FOB Midwest") instead
-- of a specific city, so a manual location pick must be scoped down to just this plant's own real
-- locations in that named region, never mixed with an unrelated one. Freeform text (never a fixed
-- enum) since this is a plant's own wording, exactly like plant_term_aliases' own terms — never
-- guess or invent a plant's vocabulary, see feedback_always_ask_never_guess_terminology.
alter table plant_locations add column region text;
