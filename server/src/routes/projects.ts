import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { config, pendingSourceDir, projectWorkspace } from '../config.js';
import {
  collectLanguageStats,
  extractArchive,
  isArchiveFileName,
  isPathWithin,
  safeRelativePath,
} from '../archive.js';
import { pruneIgnoredFiles } from '../ignore-filter.js';
import { HttpError } from '../errors.js';
import {
  deleteProject,
  deleteReview,
  getConfig,
  getProject,
  insertProject,
  listProjects,
  listReviews,
  listScans,
  updateProject,
  upsertReview,
  type Project,
  type Review,
} from '../db.js';
import { cloneRepo } from '../git-clone.js';
import { asyncHandler, newId, requireProject, requireValidBaseline } from './shared.js';

export const projectRoutes = Router();

projectRoutes.get('/api/projects', (_req, res) => {
  // hasSource 让前端在刷新/从其他页返回时恢复「源码已导入」的扫描按钮可用态
  res.json(
    listProjects().map((project) => ({
      ...project,
      hasSource: fs.existsSync(pendingSourceDir(project.id)),
    })),
  );
});

projectRoutes.post('/api/projects', asyncHandler(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw new HttpError(400, '项目名称不能为空', { code: 'srv.projectNameRequired' });
  if (name.length > 50) {
    throw new HttpError(400, '项目名称不能超过 50 个字符', { code: 'srv.projectNameTooLong' });
  }
  const project: Project = {
    id: newId('p'),
    name,
    description: String(req.body?.description ?? '').trim() || undefined,
    language: String(req.body?.language ?? '').trim(),
    createdAt: new Date().toISOString(),
  };
  insertProject(project);
  res.status(201).json(project);
}));

projectRoutes.patch('/api/projects/:id', asyncHandler(async (req, res) => {
  const project = requireProject(req.params.id);
  const patch: Parameters<typeof updateProject>[1] = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) throw new HttpError(400, '项目名称不能为空', { code: 'srv.projectNameRequired' });
    patch.name = name;
  }
  if (req.body?.description !== undefined) {
    patch.description = String(req.body.description).trim() || null;
  }
  if (req.body?.language !== undefined) patch.language = String(req.body.language);
  if (req.body?.baselineScanId !== undefined) {
    const scanId = req.body.baselineScanId;
    if (scanId === null || scanId === '') {
      patch.baselineScanId = null;
    } else {
      patch.baselineScanId = requireValidBaseline(project.id, scanId);
    }
  }
  if (req.body?.configId !== undefined) {
    const configId = req.body.configId;
    if (configId === null || configId === '') {
      patch.configId = null;
    } else {
      // 引用字段校验与 baselineScanId 同口径：配置不存在时报 400，
      // 而不是静默解绑（否则下次一键扫描会把用户选的配置改绑成默认配置）
      const scanConfig = getConfig(String(configId));
      if (!scanConfig) {
        throw new HttpError(400, '扫描配置不存在或已被删除', { code: 'srv.configNotFound' });
      }
      patch.configId = scanConfig.id;
    }
  }
  updateProject(project.id, patch);
  res.json(getProject(project.id));
}));

projectRoutes.delete('/api/projects/:id', asyncHandler(async (req, res) => {
  const project = requireProject(req.params.id);
  // 进行中/排队中的扫描还在用项目工作区与 DB 行：放行删除会让引擎把 issue 写回已删的扫描，
  // Windows 上还会撞上被占用的目录（rmSync 抛 EPERM 但 DB 已删，留下自相矛盾的状态）
  if (listScans(project.id).some((scan) => scan.status === 'scanning')) {
    throw new HttpError(409, '项目有进行中的扫描，请等扫描完成后再删除', {
      code: 'srv.projectScanBusy',
    });
  }
  // 级联删除（扫描/问题/复核）在 db 层 deleteProject 内完成，路由不再重复调用
  deleteProject(project.id);
  fs.rmSync(projectWorkspace(project.id), { recursive: true, force: true });
  res.status(204).end();
}));

/**
 * 上传快照的忽略规则剪枝：默认开启（respectGitignore !== 'false'），
 * 按 .gitignore / .opengrepignore 过滤，使上传源码与 Git 仓库直扫的扫描口径一致；
 * 关闭后保留全部上传内容（用于排查 .env 等被忽略文件中的硬编码密钥）。
 */
async function applyIgnoreFilter(
  destDir: string,
  preCount: number,
  respectGitignore: boolean,
): Promise<{ fileCount: number; ignoredCount: number }> {
  if (!respectGitignore) return { fileCount: preCount, ignoredCount: 0 };
  const { keptFiles, ignoredFiles } = await pruneIgnoredFiles(destDir);
  if (keptFiles === 0) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw new HttpError(
      400,
      '按 .gitignore 忽略规则过滤后没有剩余可扫描的文件，请检查忽略规则，或关闭“按 .gitignore 忽略文件”后重新上传',
      { code: 'srv.allFilesIgnored' },
    );
  }
  return { fileCount: keptFiles, ignoredCount: ignoredFiles };
}

/** 同一项目同一时刻只允许一个源码导入任务（上传/克隆），防止并发写同一个 pending 目录 */
const importingProjects = new Set<string>();

/**
 * 导入互斥对扫描入口的暴露：上传解压/剪枝/统计已异步化，期间其余请求照常调度，
 * 而导入中的 pending/src 是半成品，扫描创建放行会快照到不完整源码。
 */
export function isProjectImporting(projectId: string): boolean {
  return importingProjects.has(projectId);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

projectRoutes.post(
  '/api/projects/:id/source',
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'files', maxCount: config.maxImportEntries },
  ]),
  asyncHandler(async (req, res) => {
    const project = requireProject(req.params.id);
    if (importingProjects.has(project.id)) {
      throw new HttpError(409, '该项目正在导入源码（上传/克隆）中，请等待完成后再试', {
        code: 'srv.projectImportBusy',
      });
    }
    importingProjects.add(project.id);
    try {
      const destDir = pendingSourceDir(project.id);
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      const filesMap = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
      const archive = filesMap.file?.[0];
      const looseFiles = filesMap.files ?? [];
      const respectGitignore = req.body?.respectGitignore !== 'false';

      // 形态一：单个压缩包（ZIP / 7Z / RAR / TAR / TAR.GZ），按扩展名分发解压
      if (archive) {
        if (!isArchiveFileName(archive.originalname)) {
          throw new HttpError(
            400,
            '仅支持 ZIP / 7Z / RAR / TAR / TAR.GZ 压缩包，或直接拖入文件夹上传',
            { code: 'srv.archiveTypeUnsupported' },
          );
        }
        const extracted = await extractArchive(archive.buffer, destDir, archive.originalname);
        const { fileCount, ignoredCount } = await applyIgnoreFilter(destDir, extracted, respectGitignore);
        const languageStats = await collectLanguageStats(destDir);
        updateProject(project.id, { languageStats });
        const ignoreNote = ignoredCount > 0 ? `，已按 .gitignore 忽略 ${ignoredCount} 个文件` : '';
        res.json({
          fileName: archive.originalname,
          fileSize: archive.size,
          fileCount,
          ignoredCount,
          languageStats,
          message: `上传成功，已解压 ${fileCount} 个文件${ignoreNote}`,
        });
        return;
      }

      // 形态二：散装多文件（文件夹拖拽 / 目录选择），按相对路径落盘
      if (looseFiles.length > 0) {
        const pathsRaw = req.body?.paths;
        const relPaths = Array.isArray(pathsRaw)
          ? pathsRaw.map(String)
          : pathsRaw !== undefined
            ? [String(pathsRaw)]
            : [];
        if (relPaths.length !== looseFiles.length) {
          throw new HttpError(400, '文件列表与路径参数数量不匹配', { code: 'srv.filesMismatch' });
        }
        if (looseFiles.length > config.maxImportEntries) {
          throw new HttpError(400, `文件数超过 ${config.maxImportEntries} 上限`, {
            code: 'srv.tooManyFiles',
            params: { limit: config.maxImportEntries },
          });
        }
        let totalBytes = 0;
        fs.rmSync(destDir, { recursive: true, force: true });
        fs.mkdirSync(destDir, { recursive: true });
        try {
          looseFiles.forEach((file, index) => {
            const rel = safeRelativePath(relPaths[index] || file.originalname);
            if (!rel) throw new HttpError(400, '文件路径不能为空', { code: 'srv.pathRequired' });
            const target = path.join(destDir, rel);
            if (!isPathWithin(destDir, target)) {
              throw new HttpError(400, `文件路径不安全：${relPaths[index]}`, {
                code: 'srv.unsafeFilePath',
                params: { path: relPaths[index] },
              });
            }
            totalBytes += file.size;
            if (totalBytes > config.maxExtractedBytes) {
              throw new HttpError(
                400,
                `总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限`,
                { code: 'srv.totalTooLarge', params: { gb: config.maxExtractedBytes / 1024 ** 3 } },
              );
            }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, file.buffer);
          });
        } catch (error) {
          // 中途失败不留半成品 pending 目录（否则后续扫描会拿到不完整源码）
          fs.rmSync(destDir, { recursive: true, force: true });
          throw error;
        }
        const firstSegments = relPaths.map((p) => p.replace(/\\/g, '/').split('/')[0]);
        const commonRoot =
          firstSegments.every((seg) => seg && seg === firstSegments[0]) && looseFiles.length > 1
            ? firstSegments[0]
            : undefined;
        const label =
          commonRoot ?? (looseFiles.length === 1 ? firstSegments[0] : `${looseFiles.length} 个文件`);
        const { fileCount, ignoredCount } = await applyIgnoreFilter(destDir, looseFiles.length, respectGitignore);
        const languageStats = await collectLanguageStats(destDir);
        updateProject(project.id, { languageStats });
        const ignoreNote = ignoredCount > 0 ? `，已按 .gitignore 忽略 ${ignoredCount} 个文件` : '';
        res.json({
          fileName: label,
          fileSize: totalBytes,
          fileCount,
          ignoredCount,
          languageStats,
          message: `上传成功，共 ${fileCount} 个文件${ignoreNote}`,
        });
        return;
      }

      throw new HttpError(400, '请通过 multipart 表单上传 file 或 files 字段', {
        code: 'srv.fileRequired',
      });
    } finally {
      importingProjects.delete(project.id);
    }
  }),
);

projectRoutes.post('/api/projects/:id/clone', asyncHandler(async (req, res) => {
  const project = requireProject(req.params.id);
  const url = String(req.body?.url ?? '').trim();
  if (!url) throw new HttpError(400, '请提供 Git 仓库地址', { code: 'srv.gitUrlRequired' });
  const ref = String(req.body?.ref ?? '').trim();
  if (importingProjects.has(project.id)) {
    throw new HttpError(409, '该项目正在导入源码（上传/克隆）中，请等待完成后再试', {
      code: 'srv.projectImportBusy',
    });
  }
  importingProjects.add(project.id);
  try {
    const destDir = pendingSourceDir(project.id);
    const { fileCount } = await cloneRepo(url, ref, destDir);
    const languageStats = await collectLanguageStats(destDir);
    updateProject(project.id, { languageStats });
    res.json({
      url,
      ref: ref || 'HEAD',
      fileCount,
      languageStats,
      message: `克隆成功，共 ${fileCount} 个文件`,
    });
  } finally {
    importingProjects.delete(project.id);
  }
}));

// ---------- 人工复核与证据链（P1-2） ----------

const REVIEW_STATUSES = ['confirmed', 'false_positive', 'accepted'] as const;

projectRoutes.get('/api/projects/:id/reviews', asyncHandler(async (req, res) => {
  requireProject(req.params.id);
  res.json(listReviews(req.params.id));
}));

projectRoutes.put('/api/projects/:id/reviews', asyncHandler(async (req, res) => {
  const project = requireProject(req.params.id);
  const fingerprint = String(req.body?.fingerprint ?? '').trim();
  if (!fingerprint || fingerprint.length > 512) {
    throw new HttpError(400, '需要 fingerprint（问题指纹，512 字符以内）', {
      code: 'srv.fingerprintInvalid',
    });
  }
  const status = String(req.body?.status ?? '');
  if (!REVIEW_STATUSES.includes(status as (typeof REVIEW_STATUSES)[number])) {
    throw new HttpError(
      400,
      `status 仅支持：${REVIEW_STATUSES.join(' / ')}（重置请用 DELETE）`,
      { code: 'srv.reviewStatusInvalid', params: { statuses: REVIEW_STATUSES.join(' / ') } },
    );
  }
  const reason = String(req.body?.reason ?? '').trim();
  if (reason.length > 500) {
    throw new HttpError(400, '复核理由不能超过 500 字符', { code: 'srv.reasonTooLong' });
  }
  const reviewer = String(req.body?.reviewer ?? '').trim() || 'admin';
  if (reviewer.length > 100) {
    throw new HttpError(400, '复核人不能超过 100 字符', { code: 'srv.reviewerTooLong' });
  }
  const review: Review = {
    projectId: project.id,
    fingerprint,
    status: status as Review['status'],
    ...(reason ? { reason } : {}),
    reviewer,
    updatedAt: new Date().toISOString(),
  };
  upsertReview(review);
  res.json(review);
}));

projectRoutes.delete('/api/projects/:id/reviews/:fingerprint', asyncHandler(async (req, res) => {
  requireProject(req.params.id);
  deleteReview(req.params.id, req.params.fingerprint);
  res.status(204).end();
}));
