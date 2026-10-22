#!/usr/bin/env bash
# Measures how fast a Worker streams a body, in MiB/s:
#
#   pipe        a 256 MiB request body (chunked, so celld streams it) piped
#               through a TransformStream into the response
#   fetch       a 256 MiB fetch() response body read to the end with a default
#               reader
#   fetch-byob  the same body read with a BYOB reader into one 64 KiB buffer
#
# Usage: scripts/bench/fetch-body.sh [celld binary] (default target/lab/celld;
# build it with `cargo build --profile lab -p celld`). RUNS (default 5) sets
# the runs per measurement, and MIB (default 256) the body size. The script
# prints the median and the best run of each measurement.
#
# It starts `celld dev` on a free port with a throwaway state directory, and a
# Node server on 127.0.0.1 as the fetch() origin. Both stop when it exits.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CELLD=${1:-$ROOT/target/lab/celld}
RUNS=${RUNS:-5}
MIB=${MIB:-256}
[[ -x $CELLD ]] || { echo "no celld binary at $CELLD" >&2; exit 2; }
command -v node >/dev/null || { echo "node is required (the fetch() origin)" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }

WORK=$(mktemp -d)
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# The fetch() origin: MIB MiB of one repeated 1 MiB buffer, with no length.
cat >"$WORK/origin.mjs" <<'EOF'
import { createServer } from "node:http";
const mib = Number(process.argv[2]);
const chunk = Buffer.alloc(1 << 20, 7);
const server = createServer(async (request, response) => {
  response.writeHead(200, { "content-type": "application/octet-stream" });
  for (let i = 0; i < mib; i++) {
    if (!response.write(chunk)) await new Promise((resolve) => response.once("drain", resolve));
  }
  response.end();
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
EOF
node "$WORK/origin.mjs" "$MIB" >"$WORK/origin.port" &
PIDS+=($!)
for _ in $(seq 100); do [[ -s $WORK/origin.port ]] && break; sleep 0.1; done
[[ -s $WORK/origin.port ]] || { echo "the fetch() origin did not start" >&2; exit 1; }
ORIGIN="http://127.0.0.1:$(cat "$WORK/origin.port")/"
# The origin is a private address, which the egress policy of plan item 1.9
# will refuse unless this allows it.
export CELLD_FETCH_PRIVATE_ALLOW="127.0.0.1:$(cat "$WORK/origin.port")"

mkdir -p "$WORK/bench"
cat >"$WORK/bench/wrangler.jsonc" <<'EOF'
{
  "name": "bench",
  "main": "index.js",
  "compatibility_date": "2026-01-01",
  "no_bundle": true
}
EOF
cat >"$WORK/bench/index.js" <<'EOF'
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/pipe") {
      const { readable, writable } = new TransformStream();
      request.body.pipeTo(writable);
      return new Response(readable);
    }
    const response = await fetch(url.searchParams.get("url"));
    let bytes = 0;
    if (url.pathname === "/fetch") {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    } else if (url.pathname === "/fetch-byob") {
      const reader = response.body.getReader({ mode: "byob" });
      let buffer = new ArrayBuffer(64 << 10);
      for (;;) {
        const { done, value } = await reader.read(new Uint8Array(buffer));
        if (done) break;
        bytes += value.byteLength;
        buffer = value.buffer;
      }
    }
    return new Response(String(bytes));
  },
};
EOF

(cd "$WORK/bench" && exec "$CELLD" dev --no-watch --clean --port 0 -c wrangler.jsonc \
  >"$WORK/ready" 2>"$WORK/celld.log") &
PIDS+=($!)

for _ in $(seq 300); do
  grep -q '"event":"ready"' "$WORK/ready" 2>/dev/null && break
  sleep 0.1
done
grep -q '"event":"ready"' "$WORK/ready" || { echo "celld dev did not start:" >&2; cat "$WORK/celld.log" >&2; exit 1; }
PUBLIC=$(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").split("\n").find((l) => l.includes("\"ready\""))); console.log(r.public)' "$WORK/ready")

# One run: prints the seconds it took, after checking the byte count.
run() {
  local name=$1 out seconds bytes
  case $name in
    pipe)
      out=$(head -c "$((MIB << 20))" /dev/zero |
        curl -sS -o /dev/null -T - -H 'transfer-encoding: chunked' \
          -w '%{time_total} %{size_download}' "$PUBLIC/pipe")
      ;;
    *)
      # The Worker answers with the byte count it read.
      out=$(curl -sS -w '\n%{time_total}' "$PUBLIC/$name?url=$ORIGIN")
      out="$(tail -n1 <<<"$out") $(head -n -1 <<<"$out" | tr '\n' ' ')"
      ;;
  esac
  read -r seconds bytes <<<"$out"
  [[ $bytes == $((MIB << 20)) ]] || { echo "$name: expected $((MIB << 20)) bytes, got: $bytes" >&2; return 1; }
  echo "$seconds"
}

echo "celld $("$CELLD" --version 2>/dev/null | head -1) ($CELLD)"
echo "$MIB MiB per run, $RUNS runs"
for name in pipe fetch fetch-byob; do
  run "$name" >/dev/null || { echo "$name: skipped" >&2; continue; }
  times=()
  for _ in $(seq "$RUNS"); do times+=("$(run "$name")") || exit 1; done
  printf '%s\n' "${times[@]}" | sort -g | awk -v mib="$MIB" -v name="$name" '
    { t[NR] = $1 }
    END {
      median = (NR % 2) ? t[(NR + 1) / 2] : (t[NR / 2] + t[NR / 2 + 1]) / 2
      printf "%-11s median %7.1f MiB/s   best %7.1f MiB/s\n", name, mib / median, mib / t[1]
    }'
done
