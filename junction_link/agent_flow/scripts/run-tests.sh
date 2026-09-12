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
  # 剥离类型，并把 ../src/engine/x → ../x.mjs、../src/types → ../types.mjs
  $S "$f" "$OUT/tests/$name.mjs" \
    --import-map ../src/engine/topo=../topo.mjs \
    --import-map ../src/engine/template=../template.mjs \
    --import-map ../src/engine/condition=../condition.mjs \
    --import-map ../src/engine/cron=../cron.mjs \
    --import-map ../src/engine/runner=../runner.mjs \
    --import-map ../src/engine/triggers=../triggers.mjs \
    --import-map ../src/engine/canvasOps=../canvasOps.mjs \
    --import-map ../src/engine/parallel=../parallel.mjs \
    --import-map ../src/engine/canvasStore=../canvasStore.mjs \
    --import-map ../src/types=../types.mjs >/dev/null
done

cd "$OUT/tests"
node --test ./*.mjs
