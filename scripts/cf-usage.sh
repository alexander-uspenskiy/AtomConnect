#!/usr/bin/env bash
# Daily Cloudflare Workers usage check (Free plan: 100k requests/day, shared by all Workers).
# Uses the Wrangler OAuth login (run `npx wrangler login` once in server/).
# Also reports Realtime TURN egress this month (free tier: 1,000 GB/month, resets on the 1st UTC).
# Usage: scripts/cf-usage.sh [--notify]   (exit 1 when over WARN_PCT, default 50)
set -euo pipefail
ACC="${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID (Cloudflare account ID)}"
LIMIT=100000; WARN_PCT="${WARN_PCT:-50}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="${CF_API_TOKEN:-$(cd "$HERE/server" && npx --no-install wrangler auth token 2>/dev/null | tail -1)}"
D="$(date -u +%F)"; M="$(date -u +%Y-%m-01)"
Q="{viewer{accounts(filter:{accountTag:\"$ACC\"}){w:workersInvocationsAdaptive(limit:100,filter:{date_geq:\"$D\"}){sum{requests errors} dimensions{scriptName}} do:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{date_geq:\"$D\"}){sum{requests} dimensions{scriptName}} turn:callsTurnUsageAdaptiveGroups(limit:10000,filter:{date_geq:\"$M\"}){sum{egressBytes ingressBytes}}}}}"
JSON="$(curl -s https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$(python3 -c 'import json,sys;print(json.dumps({"query":sys.argv[1]}))' "$Q")")"
python3 - "$JSON" "$LIMIT" "$WARN_PCT" "${1:-}" <<'PY'
import json, sys, subprocess
d = json.loads(sys.argv[1]); limit, warn, notify = int(sys.argv[2]), int(sys.argv[3]), sys.argv[4] == "--notify"
if d.get("errors") or not d.get("data"): sys.exit(f"API error: {d.get('errors')}")
a = d["data"]["viewer"]["accounts"][0]
rows = {r["dimensions"]["scriptName"]: r["sum"] for r in a["w"]}
total = sum(r["requests"] for r in rows.values())
pct = 100 * total / limit
print(f"Workers requests today (UTC): {total:,} / {limit:,} ({pct:.1f}%)")
for n, r in sorted(rows.items(), key=lambda x: -x[1]["requests"]): print(f"  {n:28} {r['requests']:>8,}  errors {r['errors']}")
do = sum(r["sum"]["requests"] for r in a.get("do", []))
print(f"Durable Object requests today: {do:,} (free limit 100,000/day)")
turn = a.get("turn") or []
eg = sum(r["sum"]["egressBytes"] for r in turn) / 1e9
ing = sum(r["sum"]["ingressBytes"] for r in turn) / 1e9
TURN_FREE_GB = 1000
tpct = 100 * eg / TURN_FREE_GB
print(f"TURN egress this month (UTC): {eg:,.2f} GB / {TURN_FREE_GB:,} GB ({tpct:.1f}%)  [ingress {ing:,.2f} GB]")
if pct >= warn or do >= warn * limit / 100 or tpct >= warn:
    msg = f"Cloudflare usage {pct:.0f}% of daily Workers limit / TURN {tpct:.0f}% of monthly"
    print("WARNING:", msg)
    if notify: subprocess.run(["osascript", "-e", f'display notification "{msg}" with title "AtomConnect"'])
    sys.exit(1)
PY
