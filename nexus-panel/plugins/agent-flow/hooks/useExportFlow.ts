import { useCallback, useState } from 'react';
import { exportFlow, EXPORT_FORMATS } from '../engine/scriptExport';
import {
  loadExportDir as loadExportDirSetting, saveExportDir as persistExportDir,
  resolveExportTarget, parentOf, withinRoots,
} from '../engine/exportDir';
import {
  writeTextFile, fsAllowRoot, listFsRoots, canExportToFile,
} from '../lib/tauri';
import type { FlowEdge, FlowNode } from '../flowTypes';

/**
 * 待导出的一份内容。
 *
 * 以前这里只存格式 id（'script' / 'md' …），于是"导出流程 JSON"没法复用
 * 这条"没目录 → 弹选择器 → 写"的链路 —— 它只能自己走浏览器下载，
 * 而 Tauri 的 webview 不接管下载，点了就什么都没发生。
 *
 * 现在存的是**已经生成好的内容**，谁都能用。
 */
type PendingExport = {
  kind: 'browse';
} | {
  kind: 'write';
  ext: string;
  label: string;
  text: string;
  /** 字数/节点数一类的补充，拼进日志里 */
  note?: string;
};

/**
 * 未翻译的节点**必须**告出来 ——
 * 用户拿到一份"少了点什么"的脚本而毫无线索，是最坏的结果。
 */
function reportSkipped(
  r: { skipped: Array<{ id: string; kind?: string }> },
  label: string,
  onLog: (m: string) => void,
): void {
  if (r.skipped.length === 0) return;
  const names = r.skipped.map((x) => `${x.id}(${x.kind || '?'})`).join('、');
  onLog(`⚠ ${label}已导出，但 ${r.skipped.length} 个节点没能翻译：${names} —— 它们在结果里以 TODO 标出`);
}

/**
 * 默认导出目录 + 把画布导出成脚本 / 说明。
 *
 * ================= 为什么抽出来 ====================
 *
 * App.tsx 往下拆的第六块。它只依赖"节点 / 边 / 当前画布名"和一个写日志的回调，
 * 与凭据、MCP、嵌合、执行流程都不相干。
 *
 * ================= 边界 ====================
 *
 * 脚本生成在 engine/scriptExport，路径解算与授权判定在 engine/exportDir，
 * 真正写盘在 lib/tauri。这里只管"有没有目录 → 选目录 → 写 → 报结果"。
 */
export function useExportFlow({
  nodes, edges, canvasName, onLog,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  canvasName: string | null;
  onLog: (msg: string) => void;
}) {
  /* ---------------- 导出目录 ---------------- */

  /*
   * 默认导出目录 —— **全局偏好**，不是画布级配置。
   * 导出到哪跟"这是哪张画布"无关，是用户习惯。
   */
  const [exportDir, setExportDirState] = useState<string>(() => loadExportDirSetting());
  /** 待导出的内容：等用户选完目录再真正写 */
  const [pendingExport, setPendingExport] = useState<PendingExport | null>(null);

  const setExportDir = useCallback((d: string) => {
    setExportDirState(d);
    persistExportDir(d);
  }, []);


  /**
   * 把整张画布导出成脚本 / 说明。
   *
   * ================= 为什么不走浏览器下载了 =================
   *
   * 以前用 <a download>：文件落到系统默认下载目录，
   * **插件自己也不知道在哪**，日志里只有文件名没有目录 ——
   * 用户找不到文件，也不知道该去哪找。
   *
   * 更糟的是 try/catch 的 catch 是空的（注释说"退回剪贴板"但没实现），
   * 下载被拦时日志照样打印"✅ 已导出"，**失败伪装成成功**。
   *
   * 现在改走 fs_op 写文件：路径由我们决定，结果能确认，
   * 失败就明确报失败。
   */
  const writeOut = useCallback(
    async (
      text: string,
      ext: string,
      label: string,
      dir: string | null,
      note = '',
    ) => {
      const target = resolveExportTarget(exportDir, dir, canvasName || 'canvas', ext);

      /*
       * 没有目录可用（浏览器模式，或未设目录也没选）→ 退回下载。
       * 这时**必须**明说路径不受控，不能让用户以为写到了某处。
       */
      if (target.source === 'download') {
        try {
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = target.path;
          /*
           * 两个细节，少一个都是"点了没反应"：
           *   · a 必须挂进文档 —— 有些内核（Firefox / 部分 WebKit）
           *     对游离元素的 click() 不触发下载
           *   · revoke 必须延后 —— click() 只是派发事件，真正取流是异步的，
           *     同步 revoke 会把 URL 提前作废，下载直接消失
           */
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          onLog(`✅ 已导出${label}${note} → ${target.path}（浏览器下载目录，非软件目录）`);
        } catch (e) {
          /* 这里**不能**再静默 —— 失败就要说失败 */
          onLog(`✗ 导出失败：${String((e as Error)?.message ?? e)}`);
        }
        return true;
      }

      try {
        /*
         * fs_op 只写**授权根目录内**的路径 —— 这是"读任意文件 + 外传"
         * 这条风险链的收敛点，不能绕。
         *
         * 所以写之前先看目录在不在授权列表里，不在就申请。
         *
         * 为什么不能像第一版那样"失败了偷偷授权再试一次"：
         *   · 用户完全不知道发生过授权
         *   · 授权失败时看到的是笼统的"路径越权"，
         *     而不是真正的原因（目录不存在 / 不允许授权 / 加进去没生效），
         *     排查只能靠猜
         */
        const dirPath = parentOf(target.path);
        let roots = await listFsRoots().catch(() => [] as string[]);
        if (!withinRoots(dirPath, roots)) {
          onLog(`· 目录还没授权，正在申请：${dirPath}`);
          try {
            await fsAllowRoot(dirPath);
          } catch (e) {
            /*
             * 授权失败**必须**说清原因 ——
             * 最常见的是"目录不存在"或"不允许把这么大的范围加进来"，
             * 笼统报"路径越权"会让人以为是路径写错了。
             */
            onLog(`✗ 授权目录失败：${String((e as Error)?.message ?? e)}`);
            return false;
          }
          /* 回读一次：确认真的加进去了，别把"调用了但没生效"当成成功 */
          roots = await listFsRoots().catch(() => [] as string[]);
          if (!withinRoots(dirPath, roots)) {
            onLog(`✗ 授权已提交但目录仍不在授权列表里：${dirPath} —— 请换一个目录，或到设置里检查授权列表`);
            return false;
          }
        }

        const out = await writeTextFile(target.path, text);
        if (!out.ok) {
          onLog(`✗ 导出失败：${out.text || '目标目录不可写'}`);
          return false;
        }
        const how = target.source === 'picked' ? '（本次选的目录）' : '（默认导出目录）';
        onLog(`✅ 已导出${label}${note} → ${target.path} ${how}`);
        return true;
    } catch (e) {
      onLog(`✗ 导出失败：${String((e as Error)?.message ?? e)}`);
      return false;
    }
  },
  [canvasName, exportDir, onLog],
  );

  /*
   * 统一的导出入口：没设默认目录就先让用户选一个。
   *
   * 两份内容（脚本/说明 与 流程 JSON）都走它 ——
   * 各写一份"没目录怎么办"就会出现"脚本能导出、JSON 点了没反应"，
   * 而用户只会说"导出坏了"，分不清是哪一份。
   */
  const startWrite = useCallback((p: Extract<PendingExport, { kind: 'write' }>) => {
    /* 浏览器模式写不了文件，直接走下载，弹选择器也没意义 */
    if (!canExportToFile() || exportDir) {
      void writeOut(p.text, p.ext, p.label, null, p.note ?? '');
      return;
    }
    setPendingExport(p);
  }, [exportDir, writeOut]);

  /** 导出入口：脚本 / 说明 */
  const exportFlowAs = useCallback((fmt: string) => {
    const meta = EXPORT_FORMATS.find((f) => f.id === fmt);
    if (!meta) return;
    const r = exportFlow({ nodes, edges }, meta.id as never);
    /*
     * 内容在这里就生成好，而不是等选完目录再生成：
     * pending 里存文本后，"生成"与"写"两件事彻底分开，
     * 写失败时不会因为画布状态已经变了而导出出一份不一样的东西。
     */
    startWrite({
      kind: 'write', ext: meta.ext, label: meta.label,
      text: r.text, note: `（${r.count} 个节点）`,
    });
    if (r.skipped.length) {
      /* 漏翻的节点在选目录之前就该说，否则用户以为只导出了一部分还成功了 */
      reportSkipped(r, meta.label, onLog);
    }
  }, [nodes, edges, startWrite, onLog]);

  /** 导出入口：流程 JSON（工具栏「导出」） */
  const exportText = useCallback((text: string, ext: string, label: string, note?: string) => {
    startWrite({ kind: 'write', ext, label, text, note });
  }, [startWrite]);

  /** 目录选择器选完之后 */
  const onPickExportDir = useCallback((dir: string, asDefault: boolean) => {
    const p = pendingExport;
    setPendingExport(null);
    /*
     * kind='browse' 表示"只是从设置里点浏览来填目录"，不是要导出 ——
     * 这时只把目录填进设置框，不写文件。
     * 不区分的话，用户在设置里选个目录会莫名导出一份文件。
     */
    const browsing = p?.kind === 'browse';
    if (asDefault || browsing) setExportDir(dir);
    if (p?.kind === 'write') void writeOut(p.text, p.ext, p.label, dir, p.note ?? '');
  }, [pendingExport, writeOut, setExportDir]);




  /*
   * 选择器取消、以及"从设置里点浏览"这两个入口都只跟 pendingExport 有关，
   * 而 'browse' 这个分支是本 hook 的实现细节 ——
   * 不把它暴露出去，App 那边就不用知道有这个值存在。
   */
  const cancelPendingExport = useCallback(() => setPendingExport(null), []);
  const browseExportDir = useCallback(() => setPendingExport({ kind: 'browse' }), []);

  return {
    exportDir, setExportDir, pendingExport,
    exportFlowAs, exportText, onPickExportDir, cancelPendingExport, browseExportDir,
  };
}
