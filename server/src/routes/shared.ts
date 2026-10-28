import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { getProject, getScan, type Project, type ScanRecord } from '../db.js';
import { HttpError } from '../errors.js';

/** 规则包 YAML 上传与实验室运行的体积上限（同一策略，报错文案从这里取数） */
export const MAX_RULE_YAML_BYTES = 1024 * 1024;
/** 单个测试样本的体积上限（规则包创建与实验室运行共用，报错文案从这里取数） */
export const MAX_SAMPLE_BYTES = 200 * 1024;

export const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function requireProject(id: string): Project {
  const project = getProject(id);
  if (!project) throw new HttpError(404, '项目不存在或已被删除', { code: 'srv.projectNotFound' });
  return project;
}

/** 基线校验：必须是本项目下已完成的扫描（POST /scans、PATCH /projects、SARIF 导入共用） */
export function requireValidBaseline(projectId: string, baselineParam: unknown): string {
  const scan = getScan(String(baselineParam));
  if (!scan || scan.projectId !== projectId || scan.status !== 'completed') {
    throw new HttpError(400, '基线必须是本项目下已完成的扫描', { code: 'srv.baselineInvalid' });
  }
  return scan.id;
}

// 把 multer 的 LIMIT_FILE_SIZE 转成带该通道准确上限的 400（各通道上限不同，全局中间件无法区分）
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
