#!/usr/bin/env bash
# 在装不全 tsx/tsc 的环境里跑 tests/ 下的单元测试：
# 先把 TS 剥离成 ESM，再用 node --test 执行。
# 正常环境下请直接用：npm test
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-/tmp/aftest}"
S="python3 scripts/strip-ts.py"

bash scripts/build-tests.sh >/dev/null

mkdir -p "$OUT/tests"
for f in tests/*.test.ts; do
  name="$(basename "$f" .ts)"
  # 剥离类型，并把 ../engine/x → ../x.mjs、../types → ../types.mjs
  $S "$f" "$OUT/tests/$name.mjs" \
    --import-map ../engine/topo=../topo.mjs \
    --import-map ../engine/template=../template.mjs \
    --import-map ../engine/condition=../condition.mjs \
    --import-map ../engine/cron=../cron.mjs \
    --import-map ../engine/runner=../runner.mjs \
    --import-map ../engine/triggers=../triggers.mjs \
    --import-map ../engine/canvasOps=../canvasOps.mjs \
    --import-map ../engine/parallel=../parallel.mjs \
    --import-map ../engine/loop=../loop.mjs \
    --import-map ../engine/updates=../updates.mjs \
    --import-map ../engine/canvasStore=../canvasStore.mjs \
    --import-map ../engine/files=../files.mjs \
    --import-map ../engine/params=../params.mjs \
    --import-map ../engine/llm=../llm.mjs \
    --import-map ../engine/credentials=../credentials.mjs \
    --import-map ../engine/github=../github.mjs \
    --import-map ../engine/crypto=../crypto.mjs \
    --import-map ../engine/credentialStore=../credentialStore.mjs \
    --import-map ../types=../types.mjs >/dev/null
done

cd "$OUT/tests"
node --test ./*.mjs
