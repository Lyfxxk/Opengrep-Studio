import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { engineInstallHint, engineSourceLabel, terminateTrackedChildren } from './engine.js';
import { engineTargetVersion } from './engine-manifest.js';
import { markStaleScansFailed } from './scan-runner.js';
import { cleanupRuleLabScratch } from './rule-lab.js';
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
// 默认 100kb 会先于路由层校验拒绝大 JSON：规则包在线创建/编辑允许 1MB YAML、实验室
// 允许 1MB YAML + 各 200KB 正反例，JSON 转义后还要膨胀。这里统一放宽到 5MB，
// 各路由仍按自己的业务上限做 400 校验；文件上传走 multipart，不受此限制。
app.use(express.json({ limit: '5mb' }));

/** 主机名是否指向本机：localhost 或 IP 字面量（IPv6 的 URL 形态带方括号，先剥掉） */
function isLocalHost(hostname: string): boolean {
  const name = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || net.isIP(name) !== 0;
}

// 防 DNS 重绑定与跨站盲写：攻击页把自己的域名解析到 127.0.0.1 后，浏览器会带着攻击域名的
// Host 头访问本服务并视为同源（可读取扫描结果与源码片段）。因此 Host 必须是 localhost 或
// IP 字面量；带 Origin 的变更请求必须来自本机。经 IP 直连的局域网访问不受影响。
app.use((req, res, next) => {
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

// 各资源域路由：misc（健康检查/规则说明/扫描配置/知识库/实验室）→ 引擎 → 规则包 → 项目 → 扫描。
// 挂载顺序只影响注册先后，各域路径互不重叠；/api 404 兜底必须排在其后。
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
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    // code/params 是可选契约：带 code 的错误前端按语言翻译，message 仍是各语言兜底
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
  // Express 内部抛出的客户端错误自带状态码：路由参数带畸形百分号编码（%FF、截断的多字节
  // 序列等）时 decode_param 抛的 URIError 已被 express 标为 status=400（layer.js），JSON
  // body 解析失败同理。这些是客户端输入问题，按其状态码回 4xx，既不误导排障也不刷异常日志
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
  markStaleScansFailed();
  console.log(`[server] Opengrep Studio 后端已启动: http://${config.host}:${config.port}`);
  console.log(`[server] 引擎路径: ${path.resolve(config.opengrepBin)}（${engineSourceLabel()}）`);
  console.log(
    `[server] 运行平台: ${process.platform}/${process.arch}  清单目标引擎版本: ${engineTargetVersion() ?? '未知'}`,
  );
  console.log(`[server] 数据目录: ${config.dataDir}`);
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

// 退出时先杀引擎子进程再关 HTTP：Docker stop / taskkill 只把信号发给 node 本身，
// 不处理的话孤儿 opengrep 会继续跑完并占着引擎文件（Windows 上会锁死下一次升级）
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] 收到 ${signal}，终止引擎子进程并退出`);
  terminateTrackedChildren();
  server.close(() => process.exit(0));
  // 兜底：个别连接挂着不关也要保证退出
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
