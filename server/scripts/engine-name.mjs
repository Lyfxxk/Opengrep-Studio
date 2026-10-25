// 引擎可执行名的唯一脚本侧源头：preflight / setup-engine 等 plain-node 脚本共用。
// （脚本不能 import TS 源码，故与 server/src/config.ts 的 engineNameFor 各持一份，
//   两侧修改必须同步。）
export const engineExecutableName =
  process.platform === 'win32' ? 'opengrep.exe' : 'opengrep';
