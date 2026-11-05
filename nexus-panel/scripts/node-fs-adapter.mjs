/**
 * Node 侧 fs 适配器（只给测试与联网探针用）
 * ============================================================
 * 第 46 轮把 installed-plugin-scan.js 从「直接 import node:fs」改成
 * **注入式异步 fs**，于是所有调用方都得提供一份 fs。生产里是
 * js/plugin-fs-bridge.js 的 createFs(invoke)，测试里就是本文件。
 *
 * 为什么不各写一份
 * ------------------------------------------------------------
 * 四个测试/探针原本各有一份内联适配器，缺 readdir / isFile 时
 * 就会各自补一套；某一套把「读目录失败」吞成「空目录」时，
 * 只有那一个测试会表现异常，其余全绿 —— 正是本项目反复栽的
 * 「同一判据多份实现，坏一份不喊」。所以抽成唯一一份。
 *
 * ⛔ 本文件 import node:fs，属于 Node 侧：**生产代码不得 import 它**。
 *    它放在 scripts/ 下、不进 js/ 目录，market-runtime-gap 的闭包
 *    从 js/plugin-market.js 出发，永远走不到这里。
 *
 * 两条与 createFs(invoke) 对齐的语义
 * ------------------------------------------------------------
 * · readdir 只返回名字，不区分文件/目录（后端 list 回执同样不区分），
 *   需要区分请调 isFile；
 * · 失败一律 throw，绝不返回 {ok:false} 或空数组。返回空目录会把
 *   「目录读不了」伪装成「没装插件」，界面上一个都不出现却不报错。
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  readdirSync, statSync, rmSync, renameSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * 造一份与 createFs(invoke) 同形状的异步 fs。
 * 所有方法都 async —— 让测试真的走 Promise 链，而不是同步侥幸通过。
 */
export function createNodeFs() {
  return {
    async exists(p) {
      return existsSync(p);
    },

    async readdir(p) {
      /* 不 catch：读失败必须抛给调用方，由扫描器降级成「读目录失败」 */
      return readdirSync(p).map((n) => String(n).trim()).filter(Boolean);
    },

    async readText(p) {
      return readFileSync(p, 'utf8');
    },

    /** 与 createFs 的 isFile 同一语义：是文件 true、是目录 false，其它抛错 */
    async isFile(p) {
      return statSync(p).isFile();
    },

    async writeText(p, content) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf8');
    },

    async mkdir(p) {
      mkdirSync(p, { recursive: true });
    },

    async move(a, b) {
      mkdirSync(dirname(b), { recursive: true });
      renameSync(a, b);
    },

    async remove(p) {
      rmSync(p, { recursive: true, force: true });
    },
  };
}
