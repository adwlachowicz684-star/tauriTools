#!/usr/bin/env bash
# 把 src/engine 下的 TS 逻辑剥离成 ESM，供 node --test 直接跑。
# 沙盒里装不全 tsc/tsx 时用它；正常环境请直接用 npm test。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-/tmp/aftest}"
mkdir -p "$OUT"
# strip-ts.py 不会自动建子目录，输出路径带子目录时会直接报
# FileNotFoundError —— 在全新环境（/tmp 被清空）第一次跑必炸。
# 这里按源目录结构一次性建好。
mkdir -p "$OUT/runners" "$OUT/tests" "$OUT/defs"
S="python3 scripts/strip-ts.py"
      $S engine/exportDir.ts "$OUT/exportDir.mjs" --import-map ./kv=./kv.mjs >/dev/null
      $S engine/githubEvents.ts "$OUT/githubEvents.mjs" >/dev/null
      $S engine/githubHook.ts "$OUT/githubHook.mjs" >/dev/null
      $S engine/layout.ts "$OUT/layout.mjs" >/dev/null
      $S engine/runtimeKeys.ts "$OUT/runtimeKeys.mjs" >/dev/null
      $S engine/moduleTypes.ts "$OUT/moduleTypes.mjs" >/dev/null
      $S engine/canvasRef.ts "$OUT/canvasRef.mjs" --import-map ./moduleTypes=./moduleTypes.mjs >/dev/null
      $S engine/canvasGroups.ts "$OUT/canvasGroups.mjs" --import-map ./kv=./kv.mjs >/dev/null
      $S engine/triggerRegistry.ts "$OUT/triggerRegistry.mjs" >/dev/null

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
  --import-map ../upstream=./upstream.mjs \
  --import-map ../passCheck=./passCheck.mjs \
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
  --import-map ../runnerKit=./runnerKit.mjs \
  --import-map ../sleep=./sleep.mjs \
  --import-map ../beep=./beep.mjs \
  --import-map ../clock=./clock.mjs \
  --import-map ../ops=./ops.mjs \
  --import-map ../table=./table.mjs"
for f in task trigger condition parallel loop fs ocr translate update githubUpdate githubPush genericHttp extract wait log beep playAudio clock const join gate throttle timeout retry ops table; do
  [ -f "engine/runners/$f.ts" ] && $S "engine/runners/$f.ts" "$OUT/runners_$f.mjs" $RUNNER_IMPORTS >/dev/null
done
$S engine/extract.ts "$OUT/extract.mjs" >/dev/null
# 工具节点的两个支撑模块（纯逻辑，被执行器引用）
$S engine/sleep.ts "$OUT/sleep.mjs" >/dev/null
$S engine/beep.ts "$OUT/beep.mjs" --import-map ../types=./types.mjs >/dev/null
$S engine/clock.ts "$OUT/clock.mjs" >/dev/null
$S engine/nodeRequires.ts "$OUT/nodeRequires.mjs" >/dev/null
$S engine/runnerKit.ts "$OUT/runnerKit.mjs" \
  --import-map ./nodeRequires=./nodeRequires.mjs >/dev/null
$S engine/runners/canvasPort.ts "$OUT/runners/canvasPort.mjs" --import-map ../runnerKit=../runnerKit.mjs --import-map ../upstream=../upstream.mjs >/dev/null
      $S engine/runnerRegistry.ts "$OUT/runnerRegistry.mjs" --import-map ./runners/canvasPort=./runners/canvasPort.mjs \
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
  --import-map ./runners/extract=./runners_extract.mjs \
  --import-map ./runners/wait=./runners_wait.mjs --import-map ./runners/log=./runners_log.mjs --import-map ./runners/beep=./runners_beep.mjs --import-map ./runners/playAudio=./runners_playAudio.mjs --import-map ./runners/clock=./runners_clock.mjs --import-map ./runners/const=./runners_const.mjs \
  --import-map ./runners/join=./runners_join.mjs \
  --import-map ./runners/gate=./runners_gate.mjs \
  --import-map ./runners/throttle=./runners_throttle.mjs \
  --import-map ./runners/timeout=./runners_timeout.mjs \
  --import-map ./runners/retry=./runners_retry.mjs \
  --import-map ./runners/ops=./runners_ops.mjs \
  --import-map ./runners/table=./runners_table.mjs >/dev/null
$S engine/runner.ts "$OUT/runner.mjs" \
   --import-map ./stack=./stack.mjs \
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
$S engine/modules.ts "$OUT/modules.mjs" --import-map ./runtimeKeys=./runtimeKeys.mjs \
   --import-map ./duplicate=./duplicate.mjs --import-map ./kv=./kv.mjs \
   --import-map ./sanitize=./sanitize.mjs --import-map ./stack=./stack.mjs >/dev/null
$S engine/nodeValidate.ts "$OUT/nodeValidate.mjs" \
   --import-map ../types=./types.mjs >/dev/null
$S engine/kv.ts "$OUT/kv.mjs" >/dev/null
$S engine/nodeSpec.ts "$OUT/nodeSpec.mjs" --import-map ./nodeRequires=./nodeRequires.mjs >/dev/null
$S engine/topo.ts "$OUT/topo.mjs" >/dev/null
$S engine/scriptExport.ts "$OUT/scriptExport.mjs" --import-map ./topo=./topo.mjs >/dev/null
$S engine/mcp.ts "$OUT/mcp.mjs" >/dev/null
$S engine/mcpTools.ts "$OUT/mcpTools.mjs" >/dev/null
$S engine/ops.ts "$OUT/ops.mjs" >/dev/null
$S engine/expr.ts "$OUT/expr.mjs" >/dev/null
      $S engine/excelBatch.ts "$OUT/excelBatch.mjs" --import-map ./mcpTools=./mcpTools.mjs >/dev/null
      $S engine/mcpClient.ts "$OUT/mcpClient.mjs" --import-map ./mcpTools=./mcpTools.mjs >/dev/null
$S engine/table.ts "$OUT/table.mjs" --import-map ./expr=./expr.mjs >/dev/null
$S engine/mcpStore.ts "$OUT/mcpStore.mjs" --import-map ./kv=./kv.mjs --import-map ./mcpTools=./mcpTools.mjs >/dev/null
$S engine/canvasConfig.ts "$OUT/canvasConfig.mjs" >/dev/null
$S engine/blockApi.ts "$OUT/blockApi.mjs" --import-map ./nodeSpec=./nodeSpec.mjs >/dev/null
$S engine/upstream.ts "$OUT/upstream.mjs" >/dev/null
$S engine/passCheck.ts "$OUT/passCheck.mjs" >/dev/null
$S engine/sanitize.ts "$OUT/sanitize.mjs" >/dev/null
$S engine/stack.ts "$OUT/stack.mjs" >/dev/null
$S engine/canvasRefName.ts "$OUT/canvasRefName.mjs" >/dev/null
$S engine/fieldLike.ts "$OUT/fieldLike.mjs" --import-map ./blockApi=./blockApi.mjs \
   --import-map ./nodeSpec=./nodeSpec.mjs >/dev/null
$S engine/mcpServers.ts "$OUT/mcpServers.mjs" --import-map ./kv=./kv.mjs \
   --import-map ./sanitize=./sanitize.mjs >/dev/null
$S engine/stack.ts "$OUT/stack.mjs" >/dev/null
$S engine/nodeDefaults.ts "$OUT/nodeDefaults.mjs" \
   --import-map ./duplicate=./duplicate.mjs --import-map ./sanitize=./sanitize.mjs --import-map ./kv=./kv.mjs >/dev/null
# paramCards / duplicate 是纯逻辑模块，单独生成
$S engine/paramCards.ts "$OUT/paramCards.mjs" \
   --import-map ./duplicate=./duplicate.mjs --import-map ./kv=./kv.mjs >/dev/null
# duplicate.ts 是纯逻辑（不 import 任何东西），单独生成即可
$S engine/duplicate.ts "$OUT/duplicate.mjs" --import-map ./runtimeKeys=./runtimeKeys.mjs >/dev/null
# customPresets 复用了 duplicate 的 stripRuntime，要指到生成物
$S engine/customPresets.ts "$OUT/customPresets.mjs" \
   --import-map ../types=./types.mjs \
   --import-map ./duplicate=./duplicate.mjs \
   --import-map ./sanitize=./sanitize.mjs --import-map ./kv=./kv.mjs >/dev/null
