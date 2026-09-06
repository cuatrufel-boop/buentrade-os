-- Real bug, confirmed live: matchProductFromPlantText already knows when its one remaining
-- candidate doesn't actually satisfy something the line said (e.g. line says "Boneless", the only
-- Fresh+Combo Ham on file is Bone-In — no Boneless Ham exists at all) and correctly refuses to call
-- that a confident match. But that signal never reached plant_pending_matches, so plants.html's
-- "exactly one candidate → pre-check it" UI (both the Pending Matches tab and Price List Review)
-- had no way to tell a genuinely confident single suggestion from "this is the only thing that
-- exists, despite not matching what the line actually said" — auto-checking the wrong one either way.
alter table plant_pending_matches add column if not exists candidates_conflicted boolean not null default false;
