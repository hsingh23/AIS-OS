#!/usr/bin/env bash
# End-to-end plumbing test against the local mock (no Google, no model calls).
set -euo pipefail
cd "$(dirname "$0")/.."
export MOCK_PORT=${MOCK_PORT:-8765} MOCK_N=${MOCK_N:-120}
export PHOTOS_HOME="http://127.0.0.1:$MOCK_PORT/" PHOTOS_CHROME_CHANNEL="" DESCRIBE_FAKE=1
export PHOTOS_CHROME_PATH=${PHOTOS_CHROME_PATH:-/opt/pw-browsers/chromium}
export NO_PROXY="127.0.0.1,localhost,${NO_PROXY:-}" no_proxy="127.0.0.1,localhost,${no_proxy:-}"
TMP="$(mktemp -d)"
export PHOTOS_PROFILE_DIR="$TMP/profile" PHOTOS_DB="$TMP/q.sqlite"
node test/mock-server.mjs & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 1
M="http://127.0.0.1:$MOCK_PORT"
RUN="node --no-warnings cli.mjs run --tabs 10 --headless --no-advisor"

echo "== dry run: writes nothing, real queue untouched"
$RUN --dry-run > "$TMP/dry.log" 2>&1 || { cat "$TMP/dry.log"; exit 1; }
[ "$(curl -s $M/_/saves)" = 0 ] || { echo "dry run wrote to the library"; exit 1; }
[ ! -e "$TMP/q.sqlite" ] || { echo "dry run touched the real queue"; exit 1; }

echo "== real run"
$RUN > "$TMP/run.log" 2>&1 || { cat "$TMP/run.log"; exit 1; }
curl -s $M/_/dump > "$TMP/dump.json"
node --no-warnings -e '
const items = JSON.parse(require("fs").readFileSync(process.argv[1]));
const user = items.filter(i => i.desc === "my own note").length;
const ours = items.filter(i => i.desc.startsWith("[ai]")).length;
const vids = items.filter(i => i.kind === "Video" && i.desc.includes("Tags: video")).length;
const empty = items.filter(i => !i.desc).length;
console.log({ total: items.length, ours, user_kept: user, videos_tagged: vids, empty });
if (empty || ours + user !== items.length) process.exit(1);
' "$TMP/dump.json"
grep -q '"failed"' "$TMP/run.log" && { echo "items failed"; grep -A3 last_errors "$TMP/run.log"; exit 1; } || true

echo "== overwrite run: rewrites only AI descriptions"
before=$(curl -s $M/_/saves)
node --no-warnings cli.mjs run --tabs 10 --headless --no-advisor --overwrite --no-enumerate > "$TMP/ow.log" 2>&1 || { cat "$TMP/ow.log"; exit 1; }
after=$(curl -s $M/_/saves)
grep -o "requeued [0-9]* items with earlier AI" "$TMP/ow.log"
[ $((after - before)) -ge 100 ] || { echo "overwrite rewrote only $((after - before))"; exit 1; }
curl -s $M/_/dump | node -e 'const a=JSON.parse(require("fs").readFileSync(0));if(a.filter(i=>i.desc==="my own note").length!==Math.ceil(a.length/11))process.exit(1)'

echo "== crash recovery keeps last attempt claimable"
node --no-warnings test/db.test.mjs

echo E2E PASS
