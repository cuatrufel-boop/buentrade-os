#!/usr/bin/env python3
"""Scans every Edge Function that inserts a row and flags any that has no recognized
duplicate-protection pattern, then cross-checks every frontend call site against functions that
DO support idempotency_key to catch "backend ready, frontend forgot to send it" gaps (the exact
shape of the providers-create/saveProvider bug found in the 2026-08-29 audit).

Run this after creating or editing ANY Edge Function, or any frontend call to one — before
considering that work done, not as a separate later sweep. Exit code is non-zero when it finds
something, so it can gate a commit/deploy step too.

Usage: python3 scripts/audit-idempotency.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FUNCTIONS_DIR = ROOT / "supabase" / "functions"

# Recognized protection patterns. A function needs at least one to count as covered.
PROTECTION_PATTERNS = [
    r"idempotency_key",
    r"on conflict",
    r"already_\w+",  # already_linked, already_exists, already_assigned, ...
    r"idempotent_replay",
]

# Endpoints that insert rows but are deliberately exempt, with the specific reason each one is —
# never add to this list just to silence the script; every entry here needs a real argument like
# the ones below, and should be revisited if the endpoint's actual behavior changes.
EXEMPT = {
    # Append-only negotiation log — countering with the same price twice can be a real second
    # event, not a retry; guarded by a frontend in-flight lock (trading-tool.html) instead.
    "sent-offers-log-event",
    # Append-only shipment status/event trail — each call records a real state transition, not a
    # duplicable "thing"; re-sending the same status is a rare, low-stakes edge case.
    "shipments-update-status",
    # Inserts a customer_notifications row as a side effect of marking a shipment paid — a
    # duplicate notification on retry is a minor UX annoyance, not a data-integrity problem, and
    # shipments-mark-paid's own core write (the paid_at timestamp) is idempotent by nature.
    "shipments-mark-paid",
}

# (function_name, calling_file) pairs where the frontend deliberately does NOT send an
# idempotency_key even though the backend supports one — because every possible payload is
# identical (a blank row) and the real workflow requires clicking the same action repeatedly on
# purpose. Guarded by a frontend in-flight lock instead. Document the reason inline at the call
# site itself, not just here.
FRONTEND_EXEMPT = {
    ("provider-rates-create", "providers.html"),  # addRateRow() — every blank row is identical
}


def find_functions_that_insert():
    results = {}
    for fn_dir in sorted(FUNCTIONS_DIR.iterdir()):
        if not fn_dir.is_dir() or fn_dir.name.startswith("_"):
            continue
        index_file = fn_dir / "index.ts"
        if not index_file.exists():
            continue
        text = index_file.read_text(encoding="utf-8")
        if re.search(r"\binsert\s+into\b", text, re.IGNORECASE):
            results[fn_dir.name] = text
    return results


def has_protection(text):
    return any(re.search(pat, text, re.IGNORECASE) for pat in PROTECTION_PATTERNS)


def enclosing_function_body(text, call_start):
    """The key can be computed several lines above the call and passed in as a variable (e.g.
    `const idempotencyKey = ...; ...; callApi('x', row)` where row was built earlier) — a fixed
    character window around the call misses that. Instead, walk back to the nearest preceding
    `function`/`async function` declaration and take everything from there to the call, which
    covers every variable the call site could possibly be referencing."""
    fn_starts = [m.start() for m in re.finditer(r"\basync\s+function\b|\bfunction\b", text[:call_start])]
    body_start = fn_starts[-1] if fn_starts else max(0, call_start - 1500)
    return text[body_start:call_start + 200]


def find_frontend_calls(function_names):
    """Map function_name -> list of (file, line_no, snippet) for every callApi('function_name', ...)."""
    calls = {name: [] for name in function_names}
    for html_file in sorted(ROOT.glob("*.html")):
        text = html_file.read_text(encoding="utf-8")
        for name in function_names:
            for m in re.finditer(r"callApi\(\s*['\"]" + re.escape(name) + r"['\"]", text):
                if (name, html_file.name) in FRONTEND_EXEMPT:
                    continue
                start = m.start()
                window = enclosing_function_body(text, start)
                line_no = text.count("\n", 0, start) + 1
                calls[name].append((html_file.name, line_no, window))
    return calls


def main():
    insert_fns = find_functions_that_insert()
    backend_gaps = []
    idempotency_capable = []

    for name, text in insert_fns.items():
        if name in EXEMPT:
            continue
        if has_protection(text):
            if "idempotency_key" in text:
                idempotency_capable.append(name)
        else:
            backend_gaps.append(name)

    frontend_gaps = []
    calls = find_frontend_calls(idempotency_capable)
    for name, sites in calls.items():
        for file_name, line_no, window in sites:
            # Case-insensitive substring match on "idempotency" alone (not the full literal
            # "idempotency_key"/"idempotencyKey") so a differently-named variant like
            # won_idempotency_key / wonIdempotencyKey (a function can have more than one
            # idempotency key guarding different moments, e.g. sent-offers-mark-won) still counts.
            if "idempotency" not in window.lower():
                frontend_gaps.append((name, file_name, line_no))

    print(f"Scanned {len(insert_fns)} functions that insert rows ({len(EXEMPT & insert_fns.keys())} exempt).")
    print()

    if backend_gaps:
        print("BACKEND GAPS — no idempotency_key / on conflict / natural-key check found:")
        for name in backend_gaps:
            print(f"  - {name}")
        print()
    else:
        print("Backend: every insert-capable function has a recognized protection pattern.")
        print()

    if frontend_gaps:
        print("FRONTEND GAPS — backend supports idempotency_key but this call site never sends it:")
        for name, file_name, line_no in frontend_gaps:
            print(f"  - {name} called from {file_name}:{line_no}")
        print()
    else:
        print("Frontend: every call to an idempotency-capable endpoint passes the key.")
        print()

    if backend_gaps or frontend_gaps:
        print("Fix these before considering the feature done — see feedback_api_idempotency_fixed_fields_by_default.")
        return 1
    print("Clean.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
