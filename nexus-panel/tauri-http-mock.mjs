/**
 * 测试用的模块 mock：拦截 @tauri-apps/api/core，注入可控的 invoke 实现。
 *
 * tauri.ts 是静态 import，没法在 import 前替换依赖。
 * Node 20 的 module.register 钩子可以在解析阶段把它换成这里的假实现，
 * 于是能真正跑一遍 tauriHttpRequest 的完整流程，
 * 而不是把逻辑复制一份来测（复制的版本会和真实代码悄悄漂移）。
 */
export const state = {
  /** (cmd, args) => any；抛错即模拟通道不可用 */
  invoke: async () => { throw new Error('未设置 mock'); },
  isTauri: true,
  /** 记录所有调用，便于断言 */
  calls: [],
};

globalThis.__MOCK_STATE__ = state;

export function setMock({ invoke, isTauri = true }) {
  state.invoke = invoke;
  state.isTauri = isTauri;
  state.calls = [];
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@tauri-apps/api/core') {
    return { url: 'mock:tauri-core', shortCircuit: true };
  }
  // 源码里相对 import 不带扩展名（打包器习惯），Node ESM 要求完整路径 —— 逐个试
  if (specifier.startsWith('.') && !/\.[a-z0-9]+$/i.test(specifier)) {
    for (const ext of ['.ts', '.tsx', '.js', '/index.ts']) {
      try { return await nextResolve(specifier + ext, context); } catch { /* 试下一个 */ }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // Node 不认 .ts，先用 esbuild 转成 ESM 再交给后续流程
  if (url.startsWith('file:') && url.endsWith('.ts')) {
    const { transform } = await import('esbuild');
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const raw = await readFile(fileURLToPath(url), 'utf8');
    const { code } = await transform(raw, {
      loader: 'ts', format: 'esm', target: 'es2021', sourcefile: url,
    });
    return { format: 'module', shortCircuit: true, source: code };
  }
  if (url === 'mock:tauri-core') {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        const st = globalThis.__MOCK_STATE__;
        export const invoke = async (cmd, args) => {
          st.calls.push({ cmd, args });
          return st.invoke(cmd, args);
        };
        export const isTauri = () => st.isTauri;
      `,
    };
  }
  return nextLoad(url, context);
}
