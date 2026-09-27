/**
 * 依赖清单 —— **由 scripts/scan-deps.mjs 生成，不要手改。**
 * ------------------------------------------------------------
 * 手改的后果：下次跑 npm run deps:scan 就被覆盖，改的内容无声消失；
 * 而界面上显示的还是旧数字，看起来像"改了没生效"。
 *
 * 数据来源：package.json（声明）+ node_modules 下各包的 package.json（实装）
 *           + 源码 import 扫描（谁在用）+ requireDep 扫描（谁取运行时那份）
 *           + Cargo.toml（Rust 侧）
 *
 * （这里刻意不写 node_modules/<星号>/package.json：星号紧跟斜杠会提前闭合
 *   块注释，整个清单文件直接语法错误，且报错指向文件末尾而不是这行。）
 *
 * 之所以在构建期落盘：打包产物里没有 package.json，也没有 node_modules，
 * 运行时再去读只会得到一份空列表，而且不报错。
 */
export const DEPS_MANIFEST = {
  "generatedAt": "2026-09-27T16:53:49.884Z",
  "depsDir": "shared",
  "dirNote": "当前 node_modules 是共享副本（软链接），里面的版本与本仓库无关，故不判定实装版本",
  "summary": {
    "total": 40,
    "npm": 24,
    "crates": 14,
    "missing": 0,
    "mismatch": 0,
    "unused": 0,
    "undeclared": 2,
    "unknown": 24,
    "ok": 0
  },
  "npm": [
    {
      "name": "@plantuml/core",
      "declared": "1.2026.8",
      "installed": null,
      "dev": false,
      "status": "unknown",
      "usedBy": [
        "md"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "≥1.2026.6 才是 MIT，低版本是 GPL-3.0-or-later —— 必须精确锁定，不能加 ^",
      "install": "npm i @plantuml/core@1.2026.8"
    },
    {
      "name": "@tauri-apps/api",
      "declared": "^2",
      "installed": null,
      "dev": false,
      "status": "unknown",
      "usedBy": [
        "agent-flow",
        "外壳"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "与 Cargo 侧的 tauri 必须同为 2.x，跨大版本会有静默的类型漂移",
      "install": "npm i @tauri-apps/api@^2"
    },
    {
      "name": "@xyflow/react",
      "declared": "^12.11.6",
      "installed": null,
      "dev": false,
      "status": "unknown",
      "usedBy": [
        "agent-flow"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i @xyflow/react@^12.11.6"
    },
    {
      "name": "mermaid",
      "declared": "^12.0.0",
      "installed": null,
      "dev": false,
      "status": "unknown",
      "usedBy": [
        "md"
      ],
      "runtimeUsedBy": [
        "md"
      ],
      "pinned": false,
      "note": "mermaid + PlantUML 都用它；被 npm install 裁掉过一次，丢了的表现是图渲染失败",
      "install": "npm i mermaid@^12.0.0"
    },
    {
      "name": "react",
      "declared": "^18.3.1",
      "installed": null,
      "dev": false,
      "status": "unknown",
      "usedBy": [
        "agent-flow",
        "color-picker",
        "demo-react",
        "home",
        "md",
        "md-render",
        "project-group",
        "外壳",
        "测试/脚本",
        "设置"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i react@^18.3.1"
    },
    {
      "name": "react-dom",
      "declared": "^18.3.1",
      "installed": null,
      "dev": false,
      "status": "unknown",
      "usedBy": [
        "agent-flow",
        "color-picker",
        "md-render",
        "project-group",
        "外壳",
        "测试/脚本"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i react-dom@^18.3.1"
    },
    {
      "name": "react-markdown",
      "declared": "^10.1.0",
      "installed": null,
      "dev": false,
      "status": "unknown",
      "usedBy": [
        "md",
        "md-render",
        "测试/脚本"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "MD 渲染核心；不带它 md 与 md-render 两个入口一起失效",
      "install": "npm i react-markdown@^10.1.0"
    },
    {
      "name": "rehype-highlight",
      "declared": "^7.0.0",
      "installed": null,
      "dev": false,
      "status": "unknown",
      "usedBy": [
        "md"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i rehype-highlight@^7.0.0"
    },
    {
      "name": "rehype-slug",
      "declared": "^6.0.0",
      "installed": null,
      "dev": false,
      "status": "unknown",
      "usedBy": [
        "md"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i rehype-slug@^6.0.0"
    },
    {
      "name": "remark-gfm",
      "declared": "^4.0.1",
      "installed": null,
      "dev": false,
      "status": "unknown",
      "usedBy": [
        "md"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i remark-gfm@^4.0.1"
    },
    {
      "name": "@tauri-apps/cli",
      "declared": "^2",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i @tauri-apps/cli@^2 -D"
    },
    {
      "name": "@types/react",
      "declared": "^18.3.12",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i @types/react@^18.3.12 -D"
    },
    {
      "name": "@types/react-dom",
      "declared": "^18.3.1",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i @types/react-dom@^18.3.1 -D"
    },
    {
      "name": "@vitejs/plugin-react",
      "declared": "^4.3.4",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [
        "测试/脚本"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i @vitejs/plugin-react@^4.3.4 -D"
    },
    {
      "name": "jsdom",
      "declared": "^24.1.3",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [
        "mindmap",
        "测试/脚本"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i jsdom@^24.1.3 -D"
    },
    {
      "name": "typescript",
      "declared": "^5.6.3",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [
        "外壳",
        "测试/脚本"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i typescript@^5.6.3 -D"
    },
    {
      "name": "vite",
      "declared": "^5.4.11",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [
        "测试/脚本"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i vite@^5.4.11 -D"
    },
    {
      "name": "tough-cookie",
      "declared": "*",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i tough-cookie@* -D"
    },
    {
      "name": "iconv-lite",
      "declared": "*",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i iconv-lite@* -D"
    },
    {
      "name": "tr46",
      "declared": "*",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i tr46@* -D"
    },
    {
      "name": "cssstyle",
      "declared": "*",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i cssstyle@* -D"
    },
    {
      "name": "rrweb-cssom",
      "declared": "*",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i rrweb-cssom@* -D"
    },
    {
      "name": "parse5",
      "declared": "*",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i parse5@* -D"
    },
    {
      "name": "ws",
      "declared": "*",
      "installed": null,
      "dev": true,
      "status": "unknown",
      "usedBy": [],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "",
      "install": "npm i ws@* -D"
    }
  ],
  "undeclared": [
    {
      "name": "acorn",
      "declared": null,
      "installed": null,
      "dev": false,
      "status": "undeclared",
      "usedBy": [
        "测试/脚本"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "源码里 import 了，但 package.json 没写 —— 换台机器 clone 后才会暴露",
      "install": "npm i acorn"
    },
    {
      "name": "esbuild",
      "declared": null,
      "installed": null,
      "dev": false,
      "status": "undeclared",
      "usedBy": [
        "测试/脚本"
      ],
      "runtimeUsedBy": [],
      "pinned": false,
      "note": "源码里 import 了，但 package.json 没写 —— 换台机器 clone 后才会暴露",
      "install": "npm i esbuild"
    }
  ],
  "crates": [
    {
      "name": "image",
      "declared": "0.25.6",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "Rust"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "",
      "install": "cargo add image@0.25.6"
    },
    {
      "name": "keyring",
      "declared": "3",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "windows",
        "macos",
        "linux"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "按平台分别指定 feature",
      "install": "cargo add keyring@3"
    },
    {
      "name": "md5",
      "declared": "0.8.1",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "Rust"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "",
      "install": "cargo add md5@0.8.1"
    },
    {
      "name": "notify",
      "declared": "6",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "Rust"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "",
      "install": "cargo add notify@6"
    },
    {
      "name": "pdfium-render",
      "declared": "0.9.4",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "Rust"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "",
      "install": "cargo add pdfium-render@0.9.4"
    },
    {
      "name": "rayon",
      "declared": "1.10.0",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "Rust"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "",
      "install": "cargo add rayon@1.10.0"
    },
    {
      "name": "serde",
      "declared": "1",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "Rust"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "",
      "install": "cargo add serde@1"
    },
    {
      "name": "serde_json",
      "declared": "1",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "Rust"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "",
      "install": "cargo add serde_json@1"
    },
    {
      "name": "svg2pdf",
      "declared": "0.13.0",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "Rust"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "",
      "install": "cargo add svg2pdf@0.13.0"
    },
    {
      "name": "tauri",
      "declared": "2",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "Rust"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "",
      "install": "cargo add tauri@2"
    },
    {
      "name": "tauri-plugin-http",
      "declared": "2",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "Rust"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "",
      "install": "cargo add tauri-plugin-http@2"
    },
    {
      "name": "tauri-plugin-shell",
      "declared": "2",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "Rust"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "",
      "install": "cargo add tauri-plugin-shell@2"
    },
    {
      "name": "tauri-plugin-single-instance",
      "declared": "2",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "Rust"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "",
      "install": "cargo add tauri-plugin-single-instance@2"
    },
    {
      "name": "tauri-plugin-updater",
      "declared": "2",
      "installed": null,
      "dev": false,
      "status": "ok",
      "usedBy": [
        "Rust"
      ],
      "runtimeUsedBy": [],
      "pinned": true,
      "note": "",
      "install": "cargo add tauri-plugin-updater@2"
    }
  ]
};

/** 状态 → 显示文案与语气。界面与测试共用，避免两边各写一套而漂移。 */
export const DEP_STATUS = {
  ok: { label: '已装', tone: 'ok' },
  missing: { label: '缺失', tone: 'err' },
  mismatch: { label: '版本不符', tone: 'warn' },
  unused: { label: '未被引用', tone: 'mute' },
  undeclared: { label: '未声明', tone: 'err' },
  unknown: { label: '未判定', tone: 'mute' },
};

export default DEPS_MANIFEST;
