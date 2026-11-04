import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { getProject, getScan, type Project } from '../db.js';
import { HttpError } from '../errors.js';
import { engineUpgradeRunning } from '../engine.js';
import type { ReportLang } from '../report.js';

export const MAX_RULE_YAML_BYTES = 1024 * 1024;
export const MAX_SAMPLE_BYTES = 200 * 1024;

let engineJobBusy = false;

export function isEngineJobBusy(): boolean {
  return engineJobBusy;
}

function setEngineJobBusy(busy: boolean): void {
  engineJobBusy = busy;
}

export function withEngineJobBusy<T>(
  upgradeBusy: { message: string; code: string },
  run: () => Promise<T>,
): Promise<T> {
  if (engineUpgradeRunning()) {
    throw new HttpError(409, upgradeBusy.message, { code: upgradeBusy.code });
  }
  if (isEngineJobBusy()) {
    throw new HttpError(409, '上一次引擎任务（实验室/质量检查）还在运行，请稍候再试', {
      code: 'srv.engineJobBusy',
    });
  }
  setEngineJobBusy(true);
  return run().finally(() => setEngineJobBusy(false));
}

export function parseProductLang(value: unknown): ReportLang {
  return value === 'zh-Hant'
    ? 'zh-Hant'
    : value === 'en'
      ? 'en'
      : value === 'ja'
        ? 'ja'
        : value === 'ko'
          ? 'ko'
          : 'zh';
}

export const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function decodeUploadFileName(name: string): string {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

export function requireProject(id: string): Project {
  const project = getProject(id);
  if (!project) throw new HttpError(404, '项目不存在或已被删除', { code: 'srv.projectNotFound' });
  return project;
}

export function requireValidBaseline(projectId: string, baselineParam: unknown): string {
  const scan = getScan(String(baselineParam));
  if (!scan || scan.projectId !== projectId || scan.status !== 'completed') {
    throw new HttpError(400, '基线必须是本项目下已完成的扫描', { code: 'srv.baselineInvalid' });
  }
  return scan.id;
}

export function limit400(
  limited: import('express').RequestHandler,
  limitBytes: number,
): import('express').RequestHandler {
  return (req, res, next) => {
    limited(req, res, (error) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        next(
          new HttpError(400, `文件超过 ${Math.round(limitBytes / 1024 / 1024)}MB 上传上限`, {
            code: 'srv.uploadTooLarge',
            params: { mb: Math.round(limitBytes / 1024 / 1024) },
          }),
        );
        return;
      }
      next(error);
    });
  };
}

export function memoryFileUpload(
  maxBytes: number,
  accept: { pattern: RegExp; message: string; code: string },
) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes },
    fileFilter: (_req, file, cb) => {
      if (!accept.pattern.test(file.originalname)) {
        cb(new HttpError(400, accept.message, { code: accept.code }));
        return;
      }
      cb(null, true);
    },
  });
}
