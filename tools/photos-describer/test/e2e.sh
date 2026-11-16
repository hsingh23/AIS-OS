#!/usr/bin/env bash
# End-to-end plumbing test against the local mock (no Google, no model calls).
set -euo pipefail
cd "$(dirname "$0")/.."
export MOCK_PORT=${MOCK_PORT:-8765} MOCK_N=${MOCK_N:-120}
export PHOTOS_HOME="http://127.0.0.1:$MOCK_PORT/" PHOTOS_CHROME_CHANNEL="" DESCRIBE_FAKE=1
export PHOTOS_CHROME_PATH=${PHOTOS_CHROME_PATH:-/opt/pw-browsers/chromium}
export PHOTOS_PROFILE_DIR="$(mktemp -d)" PHOTOS_DB="$(mktemp -d)/q.sqlite"
node test/mock-server.mjs & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 1
node --no-warnings cli.mjs run --tabs 10 --headless --no-advisor > /tmp/e2e-run.log 2>&1 || { cat /tmp/e2e-run.log; exit 1; }
curl -s "http://127.0.0.1:$MOCK_PORT/_/dump" > /tmp/e2e-dump.json
node --no-warnings -e '
const items = JSON.parse(require("fs").readFileSync("/tmp/e2e-dump.json"));
const user = items.filter(i => i.desc === "my own note").length;
const ours = items.filter(i => i.desc.startsWith("[ai]")).length;
const vids = items.filter(i => i.kind === "Video" && i.desc.startsWith("[ai]") && i.desc.includes("Tags: video")).length;
const empty = items.filter(i => !i.desc).length;
console.log({ total: items.length, ours, user_kept: user, videos_tagged: vids, empty });
if (empty || ours + user !== items.length) process.exit(1);
'
PHOTOS_DB="$PHOTOS_DB" node --no-warnings cli.mjs status | head -30
echo E2E PASS
