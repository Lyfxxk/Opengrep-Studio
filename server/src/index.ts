import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { engineInstallHint, engineSourceLabel, terminateTrackedChildren } from './engine.js';
import { engineTargetVersion } from './engine-manifest.js';
import { ensureFallbackScanConfig } from './fallback-config.js';
import { markStaleScansFailed } from './scan-runner.js';
import { cleanupRuleLabScratch } from './rule-lab.js';
import { reportCustomPackDrift } from './rulepacks.js';
import { miscRoutes } from './routes/misc.js';
import { engineRoutes } from './routes/engine.js';
import {
  ensureBuiltinRulePacks,
  pruneStaleBuiltinPacks,
  rulepackRoutes,
} from './routes/rulepacks.js';
import { projectRoutes } from './routes/projects.js';
import { scanRoutes } from './routes/scans.js';

const app = express();
app.use(express.json({ limit: '5mb' }));

function isLocalHost(hostname: string): boolean {
  const name = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || net.isIP(name) !== 0;
}

app.use((req, _res, next) => {
  let hostOk = false;
  if (typeof req.headers.host === 'string') {
    try {
      hostOk = isLocalHost(new URL(`http://${req.headers.host.trim()}`).hostname);
    } catch {
      hostOk = false;
    }
  }
  if (!hostOk) {
    next(new HttpError(403, '拒绝访问：Host 头不是本机地址（防 DNS 重绑定）', { code: 'srv.hostNotAllowed' }));
    return;
  }
  const origin = req.headers.origin;
  if (req.method !== 'GET' && req.method !== 'HEAD' && typeof origin === 'string') {
    let originOk = false;
    if (origin !== 'null') {
      try {
        originOk = isLocalHost(new URL(origin).hostname);
      } catch {
        originOk = false;
      }
    }
    if (!originOk) {
      next(new HttpError(403, '拒绝跨站请求：Origin 不是本机地址', { code: 'srv.originNotAllowed' }));
      return;
    }
  }
  next();
});

app.use(miscRoutes);
app.use(engineRoutes);
app.use(rulepackRoutes);
app.use(projectRoutes);
app.use(scanRoutes);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: { message: '接口不存在', code: 'srv.routeNotFound' } });
});

const distDir = path.join(import.meta.dirname, '..', '..', 'code', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET') { next(); return; }
    if (!req.accepts('html') || path.extname(req.path)) { next(); return; }
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    const meta = error.meta?.code
      ? { code: error.meta.code, params: error.meta.params }
      : {};
    res.status(error.status).json({ error: { message: error.message, ...meta } });
    return;
  }
  if (error instanceof multer.MulterError) {
    const mb = Math.round(config.maxUploadBytes / 1024 / 1024);
    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        error: { message: `文件超过 ${mb}MB 上传上限`, code: 'srv.uploadTooLarge', params: { mb } },
      });
      return;
    }
    res.status(400).json({
      error: {
        message: `上传失败：${error.message}`,
        code: 'srv.uploadFailed',
        params: { reason: error.message },
      },
    });
    return;
  }
  const framed = error as { status?: unknown; statusCode?: unknown; message?: unknown };
  const status = typeof framed.status === 'number'
    ? framed.status
    : typeof framed.statusCode === 'number'
      ? framed.statusCode
      : undefined;
  if (status !== undefined && status >= 400 && status < 500) {
    const message = typeof framed.message === 'string' && framed.message
      ? framed.message
      : '请求无法解析';
    res.status(status).json({ error: { message, code: 'srv.badRequest' } });
    return;
  }
  console.error('[server] 未处理异常:', error);
  res.status(500).json({ error: { message: '服务器内部错误', code: 'srv.internalError' } });
});

const server = app.listen(config.port, config.host, () => {
  ensureBuiltinRulePacks();
  pruneStaleBuiltinPacks();
  ensureFallbackScanConfig();
  markStaleScansFailed();
  console.log(`[server] Opengrep Studio 后端已启动: http://${config.host}:${config.port}`);
  console.log(`[server] 引擎路径: ${path.resolve(config.opengrepBin)}（${engineSourceLabel()}）`);
  console.log(
    `[server] 运行平台: ${process.platform}/${process.arch}  清单目标引擎版本: ${engineTargetVersion() ?? '未知'}`,
  );
  console.log(`[server] 数据目录: ${config.dataDir}`);
  console.log(`[server] 自定义规则包目录: ${config.customRulesDir}`);
  reportCustomPackDrift();
  if (!fs.existsSync(config.opengrepBin)) {
    console.error(`[server] 警告：${engineInstallHint().replace(/\n/g, '\n[server] ')}`);
  }
});

server.on('listening', () => {
  cleanupRuleLabScratch();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[server] 端口 ${config.port} 已被占用——很可能是另一个正在使用的实例，不要杀它（可能有人在用）。` +
        `换个端口：PORT=${config.port + 1} npm start；确认是残留进程时才执行: node server/scripts/kill-port.mjs ${config.port}`,
    );
    process.exit(1);
  }
  throw err;
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] 收到 ${signal}，终止引擎子进程并退出`);
  terminateTrackedChildren();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
