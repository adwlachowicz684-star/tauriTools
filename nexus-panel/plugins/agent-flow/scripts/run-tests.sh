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
    --import-map ../engine/history=../history.mjs \
    --import-map ../engine/tasks=../tasks.mjs \
    --import-map ../engine/crypto=../crypto.mjs \
    --import-map ../engine/credentialStore=../credentialStore.mjs \
    --import-map ../engine/secretVault=../secretVault.mjs \
    --import-map ../engine/conversations=../conversations.mjs \
    --import-map ../types=../types.mjs \
    --import-map ../engine/extract=../extract.mjs \
    --import-map ../engine/runnerKit=../runnerKit.mjs \
    --import-map ../engine/customPresets=../customPresets.mjs \
    --import-map ../engine/duplicate=../duplicate.mjs \
    --import-map ../engine/clock=../clock.mjs \
    --import-map ../engine/paramCards=../paramCards.mjs \
    --import-map ../engine/modules=../modules.mjs \
    --import-map ../engine/nodeValidate=../nodeValidate.mjs \
    --import-map ../engine/stack=../stack.mjs \
    --import-map ../engine/nodeDefaults=../nodeDefaults.mjs \
    --import-map ../components/Sidebar=../Sidebar.mjs >/dev/null
done

# 源码级守卫测试（tests/inspectorRemount.test.ts）要读源文件，
# 而测试是在 $OUT/tests 下跑的，相对路径到不了仓库。
#
# 路径必须是 Windows 原生的写法：git bash 下 $(pwd) 返回 /e/_project/... 这种
# MSYS 路径，Windows 的 fs 会把它当成「当前盘的 \e\_project\...」→ ENOENT
# （表现为「测试读不到源码」，而不是报路径错，很容易误判成产品坏了）。
# pwd -W 只有 git bash 有，Linux 上回退到 pwd。
export AF_SRC="$(pwd -W 2>/dev/null || pwd)"

cd "$OUT/tests"
node --test ./*.mjs
