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
for f in topo template condition cron canvasOps parallel canvasStore loop updates files params llm credentials github credentialStore crypto tasks taskGroups history secretVault conversations; do
  [ -f "engine/$f.ts" ] && $S "engine/$f.ts" "$OUT/$f.mjs" \
   --import-map ../types=./types.mjs >/dev/null
done
# types.ts 里有运行时值（isCondition / DEFAULT_BRANCH / TRIGGER_META），也要生成
$S types.ts "$OUT/types.mjs" >/dev/null
# 每个映射单独一个 --import-map，避免只有第一个生效
$S engine/parallel.ts "$OUT/parallel.mjs" --import-map ./condition=./condition.mjs >/dev/null
$S engine/params.ts "$OUT/params.mjs" --import-map ./files=./files.mjs >/dev/null
# history.ts 从 tasks.ts 取值运行时函数（clampOutput），必须映射
$S engine/history.ts "$OUT/history.mjs" \
   --import-map ./tasks=./tasks.mjs >/dev/null
$S engine/loop.ts "$OUT/loop.mjs" \
   --import-map ../types=./types.mjs >/dev/null
# ---- 节点执行器（engine/runners/*）与汇总表 ----
# 执行逻辑已从 runner.ts 的闭包里抽到每个节点一个文件，
# 测试构建要跟着多生成这些模块，否则 runner.mjs 会 ERR_MODULE_NOT_FOUND。
RUNNER_IMPORTS="\
  --import-map ../../types=./types.mjs \
  --import-map ../credentials=./credentials.mjs \
  --import-map ../template=./template.mjs \
  --import-map ../files=./files.mjs \
  --import-map ../llm=./llm.mjs \
  --import-map ../params=./params.mjs \
  --import-map ../condition=./condition.mjs \
  --import-map ../parallel=./parallel.mjs \
  --import-map ../loop=./loop.mjs \
  --import-map ../updates=./updates.mjs \
  --import-map ../extract=./extract.mjs \
  --import-map ../runnerKit=./runnerKit.mjs"
for f in task trigger condition parallel loop fs ocr translate update githubUpdate githubPush genericHttp extract; do
  [ -f "engine/runners/$f.ts" ] && $S "engine/runners/$f.ts" "$OUT/runners_$f.mjs" $RUNNER_IMPORTS >/dev/null
done
$S engine/extract.ts "$OUT/extract.mjs" >/dev/null
$S engine/nodeRequires.ts "$OUT/nodeRequires.mjs" >/dev/null
$S engine/runnerKit.ts "$OUT/runnerKit.mjs" \
  --import-map ./nodeRequires=./nodeRequires.mjs >/dev/null
$S engine/runnerRegistry.ts "$OUT/runnerRegistry.mjs" \
  --import-map ./runners/task=./runners_task.mjs \
  --import-map ./runners/trigger=./runners_trigger.mjs \
  --import-map ./runners/condition=./runners_condition.mjs \
  --import-map ./runners/parallel=./runners_parallel.mjs \
  --import-map ./runners/loop=./runners_loop.mjs \
  --import-map ./runners/fs=./runners_fs.mjs \
  --import-map ./runners/ocr=./runners_ocr.mjs \
  --import-map ./runners/translate=./runners_translate.mjs \
  --import-map ./runners/update=./runners_update.mjs \
  --import-map ./runners/githubUpdate=./runners_githubUpdate.mjs \
  --import-map ./runners/githubPush=./runners_githubPush.mjs \
  --import-map ./runners/genericHttp=./runners_genericHttp.mjs \
  --import-map ./runners/extract=./runners_extract.mjs >/dev/null
$S engine/runner.ts "$OUT/runner.mjs" \
   --import-map ./runnerRegistry=./runnerRegistry.mjs \
   --import-map ./llm=./llm.mjs \
   --import-map ./files=./files.mjs \
   --import-map ./params=./params.mjs \
   --import-map ./topo=./topo.mjs \
   --import-map ./template=./template.mjs \
   --import-map ./condition=./condition.mjs \
   --import-map ./parallel=./parallel.mjs \
   --import-map ./loop=./loop.mjs \
   --import-map ./updates=./updates.mjs \
   --import-map ./credentials=./credentials.mjs \
   --import-map ./github=./github.mjs \
   --import-map ../types=./types.mjs >/dev/null
$S engine/triggers.ts "$OUT/triggers.mjs" \
   --import-map ./cron=./cron.mjs \
   --import-map ../types=./types.mjs >/dev/null
echo "已生成到 $OUT"
$S engine/credentialStore.ts "$OUT/credentialStore.mjs" \
   --import-map ./crypto=./crypto.mjs >/dev/null
$S engine/secretVault.ts "$OUT/secretVault.mjs" \
   --import-map ./crypto=./crypto.mjs \
   --import-map ../types=./types.mjs >/dev/null
$S engine/conversations.ts "$OUT/conversations.mjs" \
   --import-map ../types=./types.mjs >/dev/null
