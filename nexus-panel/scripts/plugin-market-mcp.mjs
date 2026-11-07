#!/usr/bin/env node
/**
 * 插件市场 MCP server（HTTP JSON-RPC，零第三方依赖）
 * ============================================================================
 * 为什么要有它
 * ----------------------------------------------------------------------------
 * 「下载 → 安装 → 卸载」此前只能在应用 webview 里点按钮验证，每暴露一层
 * 问题都要用户手动截一次图（req 形状 / 授权根 / CORS 逐个来）。这里把
 * **生产编排层**（js/plugin-market.js + js/plugin-store-client.js）原样包成
 * MCP 工具，让外部 Agent 能通过标准 tools/call 自己跑完整条链路。
 *
 * 🔴 不重写任何判据：安装、digest 校验、解包、台账、卸载全部委托
 * createPluginMarket / downloadAsset / verifyAssetDigest，与 webview 同一份代码。
 * 只注入 Node 侧的 fs 与 fetch —— 所以这里验证的是编排层本身，不是 UI。
 *
 * 落点与凭据
 * ----------------------------------------------------------------------------
 * · 数据目录默认在临时沙盒（PM_DATA_DIR 可覆盖），**不碰真实 appData**。
 * · PAT 从 PM_TOKEN_FILE 或 ~/.workbuddy/github-token.txt 读，只进内存 header，
 *   不写日志、不回显、不进 tools/list。
 * · 仅监听 127.0.0.1；设置 PM_MCP_KEY 时需带 x-mcp-key 头。
 *
 * 用法
 *   node scripts/plugin-market-mcp.mjs            # 默认 127.0.0.1:9912
 *   PM_PORT=9913 PM_DATA_DIR=/path node scripts/plugin-market-mcp.mjs
 *
 * 挂到主仓 MCP 网关（9910，应用内调用）：
 *   mcp_gw_register({ server:'plugin-market', url:'http://127.0.0.1:9912/', token:'' })
 *   之后工具名形如 plugin-market__pm_install。
 * ============================================================================
 */
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, '..');
const imp = (rel) => import(pathToFileURL(join(PANEL, rel)).href);

const [
  marketMod, fsMod, dataStoreMod, ledgerMod, manifestMod, clientMod,
] = await Promise.all([
  imp('js/plugin-market.js'),
  imp('scripts/node-fs-adapter.mjs'),
  imp('js/plugin-data-store.js'),
  imp('js/plugin-ledger.js'),
  imp('js/plugin-manifest.js'),
  imp('js/plugin-store-client.js'),
]);

const { createPluginMarket } = marketMod;
const { createNodeFs } = fsMod;
const { createPluginDataStore } = dataStoreMod;
const { LEDGER_FILE } = ledgerMod;
const { INSTALLED_PLUGINS_DIR } = manifestMod;
const { fetchRelease, downloadAsset, verifyAssetDigest, parseRepoInput, isUploadedAsset, ASSET_PREFIX, ASSET_SUFFIX } = clientMod;

const PORT = Number(process.env.PM_PORT || 9912);
const HOST = '127.0.0.1';
const DATA_DIR = process.env.PM_DATA_DIR || join(tmpdir(), 'nexus-panel-mcp-sandbox');
const TOKEN_FILE = process.env.PM_TOKEN_FILE || join(homedir(), '.workbuddy', 'github-token.txt');
const MCP_KEY = process.env.PM_MCP_KEY || '';
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
if (!TOKEN) throw new Error('PAT 为空：请设置 PM_TOKEN_FILE 或写入 ~/.workbuddy/github-token.txt');

mkdirSync(DATA_DIR, { recursive: true });
const fs = createNodeFs();
const dataStore = createPluginDataStore({ fs, dataRoot: DATA_DIR, legacyStorage: null });
const headers = { Authorization: `Bearer ${TOKEN}` };
const webFetch = (url, opts = {}) => fetch(url, opts);

/** 每次都新建：读取的是磁盘台账，不缓存内存态，避免跨调用残留。 */
function makeMarket() {
  return createPluginMarket({
    installedDir: join(DATA_DIR, INSTALLED_PLUGINS_DIR),
    ledgerFile: join(DATA_DIR, LEDGER_FILE),
    dataRoot: DATA_DIR,
    dataStore,
    fs,
    headers,
    fetch: webFetch,
    staticPlugins: [],
    reservedIds: [],
  });
}

const TOOLS = [
  {
    name: 'pm_download',
    description: '只下载 release asset 并校验 sha256 digest，不落盘、不安装。用于单独验证下载链路。',
    inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'owner/repo' } }, required: ['repo'] },
  },
  {
    name: 'pm_install',
    description: '从 GitHub release 安装插件（含下载、digest 校验、解包、落盘、写台账）。',
    inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'owner/repo' }, ref: { type: 'string', description: '可选 tag，如 v0.3.0' } }, required: ['repo'] },
  },
  {
    name: 'pm_uninstall',
    description: '按插件 id 卸载（含目录清理与台账移除）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '插件 id，如 github-manager' } }, required: ['id'] },
  },
  {
    name: 'pm_list',
    description: '列出当前沙盒里已安装的插件（扫描目录 + 台账）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pm_check_updates',
    description: '对照远端 latest release 检查已安装插件是否有更新。',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** 只下载 + 校验：把 install 的 download/digest 两段单独暴露出来。 */
async function pmDownload(repo) {
  /* 与 install 同一份判据：先 parseRepoInput，再 fetchRelease({owner,repo})，
   * 产物筛选也用 isUploadedAsset + ASSET_PREFIX/SUFFIX，不另写一套正则。 */
  const parsed = parseRepoInput(String(repo || ''));
  if (!parsed) return { ok: false, stage: 'parse', error: '仓库地址无法解析' };
  const rel = await fetchRelease(
    { owner: parsed.owner, repo: parsed.repo },
    { headers, fetch: webFetch, ref: parsed.ref || null },
  );
  if (!rel.ok) return { ok: false, stage: 'release', error: rel.error };
  const assets = (rel.release?.assets || []).filter((a) => a && typeof a.name === 'string'
    && isUploadedAsset(a) && a.name.startsWith(ASSET_PREFIX) && a.name.endsWith(ASSET_SUFFIX));
  const asset = assets[0];
  if (!asset) return { ok: false, stage: 'asset', error: 'release 里没有 state=uploaded 的规范 tarball' };
  const dl = await downloadAsset(asset, { headers, fetch: webFetch });
  if (!dl.ok) return { ok: false, stage: 'download', error: dl.error };
  /* verifyAssetDigest 是 async（内部用 WebCrypto subtle.digest）——漏 await
   * 会拿到 Promise，dv.ok 恒 undefined，表现成「下载成功但 digest 失败」。 */
  const dv = await verifyAssetDigest(dl.buffer, asset);
  const sha256 = createHash('sha256').update(Buffer.from(dl.buffer)).digest('hex');
  return {
    ok: dv.ok,
    stage: dv.ok ? 'download' : 'digest',
    error: dv.ok ? null : dv.reason,
    repo,
    asset: { name: asset.name, digest: asset.digest, size: asset.size },
    bytes: dl.bytes,
    sha256,
    digestChecked: dv.ok,
  };
}

async function dispatch(name, args = {}) {
  switch (name) {
    case 'pm_download': return pmDownload(args.repo);
    case 'pm_install': {
      const input = args.ref ? `${args.repo}#${args.ref}` : args.repo;
      return await makeMarket().install(input);
    }
    case 'pm_uninstall': return await makeMarket().uninstall(args.id);
    case 'pm_list': return { ok: true, ...(await makeMarket().list()) };
    case 'pm_check_updates': return { ok: true, ...(await makeMarket().checkUpdates()) };
    default: return { ok: false, error: `未知工具「${name}」，可调 tools/list 查看清单` };
  }
}

const textResult = (v, isError = false) => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }],
  ...(isError ? { isError: true } : {}),
});

const server = http.createServer(async (req, res) => {
  const send = (obj, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.method !== 'POST') return send({ error: '仅支持 POST JSON-RPC' }, 405);
  if (MCP_KEY && req.headers['x-mcp-key'] !== MCP_KEY) return send({ error: 'unauthorized' }, 401);

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let msg;
  try { msg = JSON.parse(raw); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '非法 JSON' } }); }
  const { id, method, params } = msg || {};
  /* 通知类消息没有 id，按 MCP 规范不回包体。 */
  if (id === undefined && method !== 'tools/call' && method !== 'tools/list' && method !== 'initialize') {
    res.writeHead(202); return res.end();
  }

  let result;
  switch (method) {
    case 'initialize':
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'nexus-panel-plugin-market', version: '1.0.0' },
      };
      break;
    case 'ping': result = {}; break;
    case 'tools/list': result = { tools: TOOLS }; break;
    case 'tools/call': {
      const name = params?.name;
      try {
        const r = await dispatch(name, params?.arguments || {});
        result = textResult(r, !!(r && r.ok === false));
      } catch (e) {
        result = textResult({ ok: false, error: String(e && e.message) }, true);
      }
      break;
    }
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${method}` } });
  }
  return send({ jsonrpc: '2.0', id, result });
});

server.listen(PORT, HOST, () => {
  console.log(`[plugin-market-mcp] http://${HOST}:${PORT}/ · data=${DATA_DIR} · tools=${TOOLS.length}`);
});
