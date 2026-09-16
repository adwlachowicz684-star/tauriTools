/**
 * 时间格式化 —— clock 节点用。
 *
 * 刻意不引 dayjs / date-fns：只要支持几个固定占位符，
 * 为一个格式函数拖进一个依赖不划算（还要处理打包与类型）。
 *
 * 支持的占位符：
 *   YYYY 四位年    MM 两位月    DD 两位日
 *   HH   24 小时   mm 分        ss 秒      SSS 毫秒
 *
 * 其它字符原样输出，所以 "YYYY-MM-DD HH:mm:ss" 直接可用。
 */

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * @param date 不传则用当前时间。传参是为了可测 ——
 *             依赖"当前时间"的逻辑若不注入就无法断言。
 */
export function formatTime(format: string, date: Date = new Date()): string {
  const map: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1, 2),
    DD: pad(date.getDate(), 2),
    HH: pad(date.getHours(), 2),
    mm: pad(date.getMinutes(), 2),
    ss: pad(date.getSeconds(), 2),
    SSS: pad(date.getMilliseconds(), 3),
  };

  let out = '';
  let i = 0;
  while (i < format.length) {
    /*
     * 从长到短匹配，否则 'SSS' 会先被 'SS'（这里没有）或单个 'S' 吃掉一半。
     * 注意顺序：SSS 必须在 ss / SS 之前判断，但 ss 与 SSS 首字母不同，
     * 真正会冲突的是同类前缀（如 YYYY 与 YY），按长度降序即可正确处理。
     */
    const rest = format.slice(i);
    let matched = false;
    for (const key of ['YYYY', 'SSS', 'MM', 'DD', 'HH', 'mm', 'ss']) {
      if (rest.startsWith(key)) {
        out += map[key];
        i += key.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += format[i];
      i += 1;
    }
  }
  return out;
}
