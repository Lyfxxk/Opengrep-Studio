import { Router } from 'express';
import { HttpError } from '../errors.js';
import { checkEngineUpdate, engineUpgradeState, startEngineUpgrade } from '../engine-update.js';
import { hasRunningScan } from '../scan-runner.js';
import { isEngineJobBusy } from '../engine-job.js';
import { asyncHandler } from './shared.js';

export const engineRoutes = Router();

// ---------- 引擎版本检查与一键升级 ----------

engineRoutes.get('/api/engine/update', asyncHandler(async (req, res) => {
  res.json(await checkEngineUpdate(req.query.refresh === '1'));
}));

// 升级在后台跑，前端轮询这个接口拿进度（50MB 下载不能让请求一直挂着）
engineRoutes.get('/api/engine/upgrade', (_req, res) => {
  res.json(engineUpgradeState());
});

engineRoutes.post('/api/engine/upgrade', asyncHandler(async (_req, res) => {
  if (hasRunningScan()) {
    throw new HttpError(409, '有扫描任务正在运行，请等扫描结束后再升级引擎', {
      code: 'srv.upgradeScanBusy',
    });
  }
  if (isEngineJobBusy()) {
    throw new HttpError(409, '规则实验室或规则包质量检查正在运行，请稍后再升级引擎', {
      code: 'srv.upgradeJobBusy',
    });
  }
  res.status(202).json(await startEngineUpgrade());
}));
