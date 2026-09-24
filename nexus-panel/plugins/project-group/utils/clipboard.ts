/**
 * 复制文本到剪贴板（三档兜底）。
 *
 * 从 App.tsx 抽出来：App 已经顶到结构护栏的硬上限（1300 行），
 * 再往里塞任何东西都会撞线。这段是**自成一体的**：不读卡片状态、
 * 不碰布局、只依赖传进来的三个回调，搬出来没有副作用。
 *
 * 三档顺序不是随便排的：
 *   1. **后端**（`api.copyText`）—— iframe 沙箱里没有 clipboard-write
 *      权限，`navigator.clipboard` 会**静默失败**（点了完全没反应），
 *      所以后端必须排第一；
 *   2. `navigator.clipboard` —— 后端命令不存在时（旧版 Rust 没编进来）走这档；
 *   3. `execCommand('copy')` —— 最后兜底，老浏览器与非安全上下文用它。
 *
 * **三档全失败才提示失败**，中途不能报：第 1 档失败就弹错误的话，
 * 明明第 2 档能成功，用户却先看到一个红 toast —— 他会以为复制没成，
 * 于是再点一次，结果真的发起了两次写。
 */

/** 只用到这一个方法，用结构类型而不是整个 FpxApi，免得 utils 反向依赖 api。 */
export interface ClipboardApi {
  copyText: (text: string) => Promise<boolean>;
}

export interface ClipboardDeps {
  api: ClipboardApi;
  toast: (msg: string, kind: 'ok' | 'err' | 'info') => void;
  log: (msg: string, isError?: boolean) => void;
}

export async function copyText(deps: ClipboardDeps, text: string): Promise<boolean> {
  const { api, toast, log } = deps;

  try {
    if (await api.copyText(text)) {
      toast('已复制', 'ok');
      return true;
    }
    log('复制失败：后端未能写入剪贴板', true);
  } catch {
    /* 后端命令可能不存在（旧版本 Rust 未编译进来），静默降级到浏览器 API */
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast('已复制', 'ok');
      return true;
    }
  } catch { /* 继续兜底 */ }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'err');
    return ok;
  } catch {
    toast('复制失败', 'err');
    return false;
  }
}
