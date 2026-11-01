import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import * as sevenzzNs from '7z-wasm';

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
