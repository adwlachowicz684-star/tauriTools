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

/** 目录选择器只用于"填设置"，不代表要导出 */
const BROWSE_ONLY = '__browse__';

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
  /** 待导出的格式：等用户选完目录再真正写 */
  const [pendingExport, setPendingExport] = useState<string | null>(null);

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
  const writeExport = useCallback(
    async (fmt: string, dir: string | null) => {
      const meta = EXPORT_FORMATS.find((f) => f.id === fmt);
      if (!meta) return;
      const graph = { nodes, edges };
      const r = exportFlow(graph, meta.id as never);
      const target = resolveExportTarget(exportDir, dir, canvasName || 'canvas', meta.ext);

      /*
       * 没有目录可用（浏览器模式，或未设目录也没选）→ 退回下载。
       * 这时**必须**明说路径不受控，不能让用户以为写到了某处。
       */
      if (target.source === 'download') {
        try {
          const blob = new Blob([r.text], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = target.path;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          onLog(`✅ 已导出${meta.label}（${r.count} 个节点）→ ${target.path}（浏览器下载目录，非软件目录）`);
        } catch (e) {
          /* 这里**不能**再静默 —— 失败就要说失败 */
          onLog(`✗ 导出失败：${String((e as Error)?.message ?? e)}`);
        }
        reportSkipped(r, meta.label, onLog);
        return;
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
        const dir = parentOf(target.path);
        let roots = await listFsRoots().catch(() => [] as string[]);
        if (!withinRoots(dir, roots)) {
          onLog(`· 目录还没授权，正在申请：${dir}`);
          try {
            await fsAllowRoot(dir);
          } catch (e) {
            /*
             * 授权失败**必须**说清原因 ——
             * 最常见的是"目录不存在"或"不允许把这么大的范围加进来"，
             * 笼统报"路径越权"会让人以为是路径写错了。
             */
            onLog(`✗ 授权目录失败：${String((e as Error)?.message ?? e)}`);
            return;
          }
          /* 回读一次：确认真的加进去了，别把"调用了但没生效"当成成功 */
          roots = await listFsRoots().catch(() => [] as string[]);
          if (!withinRoots(dir, roots)) {
            onLog(`✗ 授权已提交但目录仍不在授权列表里：${dir} —— 请换一个目录，或到设置里检查授权列表`);
            return;
          }
        }

        const out = await writeTextFile(target.path, r.text);
        if (!out.ok) {
          onLog(`✗ 导出失败：${out.text || '目标目录不可写'}`);
          return;
        }
        const how = target.source === 'picked' ? '（本次选的目录）' : '（默认导出目录）';
        onLog(`✅ 已导出${meta.label}（${r.count} 个节点）→ ${target.path} ${how}`);
      } catch (e) {
        onLog(`✗ 导出失败：${String((e as Error)?.message ?? e)}`);
        return;
      }
      reportSkipped(r, meta.label, onLog);
    },
    [nodes, edges, canvasName, exportDir, onLog],
  );

  /** 导出入口：没设默认目录就先让用户选一个 */
  const exportFlowAs = useCallback((fmt: string) => {
    /* 浏览器模式写不了文件，直接走下载，弹选择器也没意义 */
    if (!canExportToFile()) {
      void writeExport(fmt, null);
      return;
    }
    if (exportDir) {
      void writeExport(fmt, null);
      return;
    }
    setPendingExport(fmt);
  }, [exportDir, writeExport]);

  /** 目录选择器选完之后 */
  const onPickExportDir = useCallback((dir: string, asDefault: boolean) => {
    const fmt = pendingExport;
    setPendingExport(null);
    /*
     * '__browse__' 表示"只是从设置里点浏览来填目录"，不是要导出 ——
     * 这时只把目录填进设置框，不写文件。
     * 不区分的话，用户在设置里选个目录会莫名导出一份文件。
     */
    const browsing = fmt === BROWSE_ONLY;
    if (asDefault || browsing) setExportDir(dir);
    if (fmt && !browsing) void writeExport(fmt, dir);
  }, [pendingExport, writeExport, setExportDir]);




  /*
   * 选择器取消、以及"从设置里点浏览"这两个入口都只跟 pendingExport 有关，
   * 而 BROWSE_ONLY 这个哨兵值是本 hook 的实现细节 ——
   * 不把它暴露出去，App 那边就不用知道有这个值存在。
   */
  const cancelPendingExport = useCallback(() => setPendingExport(null), []);
  const browseExportDir = useCallback(() => setPendingExport(BROWSE_ONLY), []);

  return {
    exportDir, setExportDir, pendingExport,
    exportFlowAs, onPickExportDir, cancelPendingExport, browseExportDir,
  };
}
