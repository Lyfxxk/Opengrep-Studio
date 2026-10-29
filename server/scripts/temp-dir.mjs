// 单测临时目录的退出回收（node --test 运行，`npm test` 统一驱动）
// 历史问题：每个单测文件把 DATA_DIR 指到 mkdtemp 的临时目录（或造一份假的引擎二进制目录）却从不删，
// Windows 上 SQLite 句柄不关又删不掉（rmSync 抛 EPERM），跑几十次就在 %TEMP% 攒下几百个残目录。
import fs from 'node:fs';

/**
 * 登记一个临时目录，进程退出时回收；回收数据库句柄时先传 closeDatabase。
 * 用 exit 钩子而不是 test.after——node:test 的 after 只包住单个顶层 test 的上下文，
 * 文件里的多条 test 会各触发一次，第二次删已不存在的目录反而制造报错。
 */
export function trackTempDir(dir, closeDatabase) {
  process.on('exit', () => {
    try {
      closeDatabase?.();
    } catch {
      // 句柄已关或关不掉都不该让测试以退出异常收场
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 文件被占用时宁可留一个残目录，也不在退出阶段抛错
    }
  });
}
