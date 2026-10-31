#!/usr/bin/env bash
# 跑 agent-flow 的单元测试。
#
# ============ 为什么用 tsc 编译，而不是正则剥离 ============
#
# 以前用 scripts/strip-ts.py（600 行正则）把 .ts 剥成 .mjs。
# 它累计踩了 12 个坑，而且每一类都是**静默产出坏代码**：
#   · 默认参数里的字符串 ',' 被改成 ', ' → CSV 往返悄悄坏掉
#   · 泛型参数列表 <T> 剥不掉 → 生成的文件直接语法错误
#   · 跨行类型断言剥不干净 → SyntaxError
#   · 注释里的 /* 被当成边界 → 字面量正则失效
# 每加一个新函数都可能撞上，代价是持续的。
#
# 而 typescript 本来就是项目的 devDependency —— 用真正的编译器
# 取代正则，那些坑**整体消失**，顺带还能顺手抓出类型错误。
#
# ============ 为什么编译成 CommonJS ============
#
# 测试用 `node --test`，它支持 CJS。
# 而 CJS 的 require 天然支持无扩展名路径（'../engine/stack'），
# 于是**不再需要 import-map 那套手工映射** ——
# 以前每个新模块都要去 build-tests.sh 里补一条 --import-map，
# 漏一条就是 ERR_MODULE_NOT_FOUND。
#
# ============ 用法 ============
#   bash scripts/run-tests.sh             # 跑全部
#   bash scripts/run-tests.sh stackDrop   # 只跑名字含 stackDrop 的
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${AF_OUT:-/tmp/afts}"
TSCONFIG="${AF_TSCONFIG:-/tmp/tsconfig.aftest.json}"

# 源码守卫类测试要靠 AF_SRC 找到仓库里的源文件（它们检查的是源码本身）
#
# ⚠️ 必须用**脚本自身位置**（$HERE），不能用 pwd。
# 用 pwd 的话，`npm run test:af`（= `bash plugins/agent-flow/scripts/run-tests.sh`，
# 在仓库根执行）会把 AF_SRC 指成仓库根 —— 于是 `components/ArgCell.tsx`
# 之类全部读不到，readSrc 返回空串，278 条源码守卫**集体假失败**
# （实测：从 plugins/agent-flow 里跑 2379/0，从根跑 2375 中 278 红）。
#
# 而假失败的样子是"被测代码有问题" —— 会把人引向完全错误的方向。
export AF_SRC="${AF_SRC:-$HERE}"

# 指错了就当场说，别让守卫静默读空串
if [ ! -f "$AF_SRC/App.tsx" ]; then
  echo "✗ AF_SRC 指向的不是插件根目录：$AF_SRC（缺 App.tsx）"
  echo "  源码守卫会读到空串、集体假失败。请用 AF_SRC=<插件根> 覆盖。"
  exit 1
fi

# ------------------------------------------------------------------
# 让产物目录里的 require() 还能找到仓库的 node_modules
#
# 产物默认落在 /tmp/afts，而 CommonJS 是从**文件所在目录**逐级向上找
# node_modules 的：/tmp/afts → /tmp → / ，都没有 —— 装没装依赖都一样。
#
# 于是任何（直接或间接）import 'lib/tauri' 的测试都会 MODULE_NOT_FOUND，
# 报的样子是"依赖没装"，实际是"产物放错了地方"。
# 实测：boardMetaFile.test.js 是第一个踩到的（2875 项中 1 红）。
#
# NODE_PATH 是 CJS 的兜底查找路径，指回仓库即可；不改动产物目录，
# prune-orphans / gen-node-docs 的行为都不受影响。
# ------------------------------------------------------------------
REPO_MODULES="$(cd "$HERE/../.." && pwd)/node_modules"
if [ -d "$REPO_MODULES" ]; then
  export NODE_PATH="${NODE_PATH:+$NODE_PATH:}$REPO_MODULES"
fi

# ------------------------------------------------------------------
# 生成测试专用的 tsconfig。
#
# 放在 /tmp 而不是仓库里：这是**沙盒验证用**的配置，
# 项目本身跑的是 vite build + smoke-test，不需要它。
# ------------------------------------------------------------------
cat > "$TSCONFIG" <<JSON
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "node",
    "rootDir": "$HERE",
    "outDir": "$OUT",
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmitOnError": false,
    "incremental": true,
    "tsBuildInfoFile": "$OUT/.tsbuildinfo",
    "types": [],
    "strict": false
  },
  "include": [
    "$HERE/tests/**/*.ts",
    "$HERE/engine/**/*.ts",
    "$HERE/types.ts"
  ]
}
JSON

# ------------------------------------------------------------------
# 清掉"孤产物"：源文件已经删了、但上次编译留下的 .js
# （详见 scripts/prune-orphans.py）
# ------------------------------------------------------------------
python3 "$HERE/scripts/prune-orphans.py" "$HERE" "$OUT"

echo "== 编译（tsc）=="
# ------------------------------------------------------------------
# 找 tsc：npm script 环境下 node_modules/.bin 在 PATH 里，`command -v tsc` 就能找到。
#
# 以前这里 fallback 写的是**某台机器上的绝对路径**
# （/data/workspace/tsenv2/...）。在别的机器上 tsc 没装时，
# 脚本会拿着那个不存在的路径去执行，报错指向一个谁都不认识的目录 ——
# 看的人只会以为是脚本坏了，想不到是"typescript 没装"。
#
# 所以 fallback 改成仓库内的相对路径，再没有就**明确报错说原因**。
# ------------------------------------------------------------------
TSC="${AF_TSC:-$(command -v tsc || true)}"
if [ -z "$TSC" ]; then
  for c in node_modules/typescript/bin/tsc node_modules/.bin/tsc; do
    if [ -x "$c" ]; then TSC="$c"; break; fi
  done
fi
if [ -z "$TSC" ]; then
  echo "✗ 找不到 tsc：typescript 是本项目的 devDependency，先跑 npm i"
  exit 1
fi
# ⛔ 不能直接写 "$TSC"：AF_TSC 允许带参数（常见写法 `AF_TSC="node .../tsc"`），
# 加引号后整串被当成**一个文件名**去执行 → tsc 根本没跑（退出码 127）。
# 而 $OUT/tests 是上一轮留下的，下面那句"有产物吗"照样通过 ——
# 于是**拿旧产物跑测试，改了被测文件结果也不变**，看着全绿其实一条没验。
read -r -a TSC_ARR <<< "$TSC"
# 先空跑一次 `--version` 确认这串命令真能起来：
# "node /nope/tsc" 这种也能"执行"（退出 1 而不是 127），只查 127 会漏掉它。
if ! "${TSC_ARR[@]}" --version > /dev/null 2>&1; then
  echo "✗ tsc 跑不起来（AF_TSC=\"$TSC\"）—— 继续跑会拿上一轮的旧产物，结果不可信"
  "${TSC_ARR[@]}" --version 2>&1 | head -3
  exit 1
fi
"${TSC_ARR[@]}" -p "$TSCONFIG" > /tmp/afts-tsc.log 2>&1
TSC_RC=$?
# noEmitOnError=false，有类型错误也会照常输出 JS；
# 但编译本身失败（语法错）就没有产物了，要拦住
if [ "$TSC_RC" -eq 127 ]; then
  echo "✗ tsc 没跑起来（AF_TSC=\"$TSC\"）—— 继续跑会拿上一轮的旧产物，结果不可信"
  head -5 /tmp/afts-tsc.log
  exit 1
fi
if [ ! -d "$OUT/tests" ]; then
  echo "✗ 编译没有产出，错误如下："
  head -30 /tmp/afts-tsc.log
  exit 1
fi
echo "   产物在 $OUT"

# ------------------------------------------------------------------
# 重新生成文档（docs/ 是派生产物）
#
# 为什么放在跑测试之前：文档类守卫断言的是 docs/ 里的 md，
# 而 md 是生成器写出来的。不先重新生成的话，把生成器改坏
# **测试照样全绿** —— 它检查的是上次留下的旧产物，不是当前代码。
#
# 这就是"测试全绿不等于代码对"的另一种形态：
# 之前踩过测试不真编译，这次是文档不真生成。
# ------------------------------------------------------------------
echo "== 重新生成文档 =="
# 失败必须**中断**：只打印一句的话，测试会拿上一轮留下的旧 md 去断言，
# 于是"生成器坏了"表现为"测试全绿" —— 比不生成还糟。
AF_OUT="$OUT" node "$HERE/scripts/gen-node-docs.mjs" >> /tmp/afts-gendocs.log 2>&1
if [ $? -ne 0 ]; then
  echo "✗ 文档生成失败，测试中止（见 /tmp/afts-gendocs.log）"
  tail -20 /tmp/afts-gendocs.log
  exit 1
fi

# ------------------------------------------------------------------
# 真实类型检查（strict: true，取自项目 tsconfig）
#
# 为什么必须在跑测试之前：编译用的那份是 strict: false，
# 判别联合窄化失效，真错误查不出来。详见 scripts/check-types.sh。
#
# 耗时约 25 秒；只想快速迭代时用 AF_SKIP_TYPES=1 跳过。
# ------------------------------------------------------------------
if ! bash "$HERE/scripts/check-types.sh"; then
  exit 1
fi

# ------------------------------------------------------------------
# 跑测试
# ------------------------------------------------------------------
cd "$OUT"
if [ $# -gt 0 ]; then
  echo "== 跑测试（筛选：$*）=="
  node --test --test-name-pattern="$1" tests/ 2>&1
else
  echo "== 跑测试 =="
  node --test tests/ 2>&1
fi
