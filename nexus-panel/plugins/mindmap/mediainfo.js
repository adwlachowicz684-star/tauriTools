/**
 * 视频元信息 —— 已提取到共享层。
 *
 * ⛔ 本文件只剩一行 re-export，**不要**在这里重新实现任何解析。
 *
 * 提取的原因：agent-flow 的附属文件面板要显示同样的
 * 分辨率 / 帧率 / 编码，而两套实现迟早会分叉 ——
 * 同一个文件在两个面板里显示不同的数字，两边都没错，却查不出哪边坏了。
 *
 * 保留这个文件是为了让 `import * as mi from './mediainfo.js'`
 * 那一处不用改，避免为一处引用去动 panels.js 里几百行。
 */

export {
  parseMp4, parseWebm, parseContainer, probeByElement, probeVideo,
  formatDuration, formatBitrate, formatFps, formatDateTime,
  formatChannels, shortType,
} from '../../js/media-info.js';
