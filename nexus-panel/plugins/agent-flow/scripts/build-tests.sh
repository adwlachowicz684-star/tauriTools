#!/usr/bin/env bash
# 把 src/engine 下的 TS 逻辑剥离成 ESM，供 node --test 直接跑。
# 沙盒里装不全 tsc/tsx 时用它；正常环境请直接用 npm test。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-/tmp/aftest}"
mkdir -p "$OUT"
S="python3 scripts/strip-ts.py"

# 注意：每个文件都带上 ../types=./types.mjs。
# condition.ts 会 import 运行时的 OP_META / DEFAULT_BRANCH（不只是 type），
# 少了这条映射就会解析到 /tmp/types 而报 ERR_MODULE_NOT_FOUND。
for f in topo template condition cron canvasOps parallel canvasStore loop updates files params llm; do
  [ -f "engine/$f.ts" ] && $S "engine/$f.ts" "$OUT/$f.mjs" \
    --import-map ../types=./types.mjs >/dev/null
done
# types.ts 里有运行时值（isCondition / DEFAULT_BRANCH / TRIGGER_META），也要生成
$S types.ts "$OUT/types.mjs" >/dev/null
# 每个映射单独一个 --import-map，避免只有第一个生效
$S engine/parallel.ts "$OUT/parallel.mjs" --import-map ./condition=./condition.mjs >/dev/null
$S engine/params.ts "$OUT/params.mjs" --import-map ./files=./files.mjs >/dev/null
$S engine/loop.ts "$OUT/loop.mjs" \
   --import-map ../types=./types.mjs >/dev/null
$S engine/runner.ts "$OUT/runner.mjs" \
   --import-map ./llm=./llm.mjs \
   --import-map ./files=./files.mjs \
   --import-map ./params=./params.mjs \
   --import-map ./topo=./topo.mjs \
   --import-map ./template=./template.mjs \
   --import-map ./condition=./condition.mjs \
   --import-map ./parallel=./parallel.mjs \
   --import-map ./loop=./loop.mjs \
   --import-map ./updates=./updates.mjs \
   --import-map ../types=./types.mjs >/dev/null
$S engine/triggers.ts "$OUT/triggers.mjs" \
   --import-map ./cron=./cron.mjs \
   --import-map ../types=./types.mjs >/dev/null
echo "已生成到 $OUT"
