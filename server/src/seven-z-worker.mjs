// 7z 解压 worker（纯 JS：Node 直接按 ESM 加载，不需要 tsx 参与编译）。
// 7z-wasm 的 callMain 是同步阻塞调用，只有放在独立线程里，主线程才能对它限时与限盘（terminate）。
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import * as sevenzzNs from '7z-wasm';

// UMD 包经不同模块系统加载后的互操作形态不同：真正的工厂函数可能是命名空间本身或其 default
const init7z = typeof sevenzzNs === 'function' ? sevenzzNs : sevenzzNs.default;

parentPort.on('message', ({ buffer, ext, destDir }) => {
  void (async () => {
    let stderr = '';
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
      fs.mkdirSync(destDir, { recursive: true });
      const seven = await init7z({
        printErr: (line) => {
          stderr += `${line}\n`;
        },
      });
      seven.FS.writeFile(`input${ext}`, Buffer.from(buffer));
      seven.FS.mkdir('/out');
      // 保留 NODEFS 直写磁盘：内存 FS 会让 wasm 堆随解压产物一起膨胀，反而更容易 OOM
      seven.FS.mount(seven.NODEFS, { root: destDir }, '/out');
      const code = seven.callMain(['x', '-y', `input${ext}`, '-o/out']);
      if (code !== 0) {
        const detail = stderr.trim().split('\n').pop() ?? '';
        throw new Error(detail || `7z exit ${code}`);
      }
      parentPort.postMessage({ ok: true });
    } catch (error) {
      parentPort.postMessage({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});
