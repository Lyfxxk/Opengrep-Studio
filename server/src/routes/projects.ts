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
  listScans,
  updateProject,
  upsertReview,
  type Project,
  type Review,
} from '../db.js';
import { cloneRepo } from '../git-clone.js';
import { asyncHandler, decodeUploadFileName, newId, requireProject, requireValidBaseline } from './shared.js';

export const projectRoutes = Router();

const MAX_PROJECT_DESCRIPTION_LENGTH = 200;

function normalizeProjectDescription(value: unknown): string {
  const text = String(value ?? '').trim();
  if (text.length > MAX_PROJECT_DESCRIPTION_LENGTH) {
    throw new HttpError(400, `项目描述不能超过 ${MAX_PROJECT_DESCRIPTION_LENGTH} 个字符`, {
      code: 'srv.projectDescriptionTooLong',
      params: { limit: MAX_PROJECT_DESCRIPTION_LENGTH },
    });
  }
  return text;
}

projectRoutes.get('/api/projects', (_req, res) => {
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
    description: normalizeProjectDescription(req.body?.description) || undefined,
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
    if (name.length > 50) {
      throw new HttpError(400, '项目名称不能超过 50 个字符', { code: 'srv.projectNameTooLong' });
    }
    patch.name = name;
  }
  if (req.body?.description !== undefined) {
    patch.description = normalizeProjectDescription(req.body.description) || null;
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
  if (isProjectImporting(project.id)) {
    throw new HttpError(409, '该项目正在导入源码（上传/克隆）中，请等待完成后再删除', {
      code: 'srv.projectImportBusy',
    });
  }
  if (listScans(project.id).some((scan) => scan.status === 'scanning')) {
    throw new HttpError(409, '项目有进行中的扫描，请等扫描完成后再删除', {
      code: 'srv.projectScanBusy',
    });
  }
  deleteProject(project.id);
  try {
    fs.rmSync(projectWorkspace(project.id), { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `[projects] 项目 ${project.id} 工作区清理失败，可手动删除 ${projectWorkspace(project.id)}：` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  res.status(204).end();
}));

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

function stageLooseFiles(
  stagingDir: string,
  looseFiles: Express.Multer.File[],
  relPaths: string[],
): number {
  if (relPaths.length !== looseFiles.length) {
    throw new HttpError(400, '文件列表与路径参数数量不匹配', { code: 'srv.filesMismatch' });
  }
  if (looseFiles.length > config.maxImportEntries) {
    throw new HttpError(400, `文件数超过 ${config.maxImportEntries} 上限`, {
      code: 'srv.tooManyFiles',
      params: { limit: config.maxImportEntries },
    });
  }
  const totalBytes = looseFiles.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > config.maxExtractedBytes) {
    throw new HttpError(
      400,
      `总体积超过 ${config.maxExtractedBytes / 1024 ** 3}GB 上限`,
      { code: 'srv.totalTooLarge', params: { gb: config.maxExtractedBytes / 1024 ** 3 } },
    );
  }
  looseFiles.forEach((file, index) => {
    const rel = safeRelativePath(relPaths[index] || decodeUploadFileName(file.originalname));
    if (!rel) throw new HttpError(400, '文件路径不能为空', { code: 'srv.pathRequired' });
    const target = path.join(stagingDir, rel);
    if (!isPathWithin(stagingDir, target)) {
      throw new HttpError(400, `文件路径不安全：${relPaths[index]}`, {
        code: 'srv.unsafeFilePath',
        params: { path: relPaths[index] },
      });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.buffer);
  });
  return totalBytes;
}

const importingProjects = new Set<string>();

export function isProjectImporting(projectId: string): boolean {
  return importingProjects.has(projectId);
}

export function markProjectImporting(projectId: string): void {
  importingProjects.add(projectId);
}

export function unmarkProjectImporting(projectId: string): void {
  importingProjects.delete(projectId);
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
    const destDir = pendingSourceDir(project.id);
    const stagingDir = `${destDir}.uploading`;
    try {
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.mkdirSync(stagingDir, { recursive: true });
      const filesMap = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
      const archive = filesMap.file?.[0];
      const looseFiles = filesMap.files ?? [];
      const respectGitignore = req.body?.respectGitignore !== 'false';

      const commitStaging = () => {
        fs.rmSync(destDir, { recursive: true, force: true });
        fs.renameSync(stagingDir, destDir);
      };

      if (archive) {
        const archiveName = decodeUploadFileName(archive.originalname);
        if (!isArchiveFileName(archiveName)) {
          throw new HttpError(
            400,
            '仅支持 ZIP / 7Z / RAR / TAR / TAR.GZ 压缩包，或直接拖入文件夹上传',
            { code: 'srv.archiveTypeUnsupported' },
          );
        }
        const extracted = await extractArchive(archive.buffer, stagingDir, archiveName);
        const { fileCount, ignoredCount } = await applyIgnoreFilter(stagingDir, extracted, respectGitignore);
        const languageStats = await collectLanguageStats(stagingDir);
        commitStaging();
        updateProject(project.id, { languageStats });
        res.json({
          fileName: archiveName,
          fileSize: archive.size,
          fileCount,
          ignoredCount,
          languageStats,
        });
        return;
      }

      if (looseFiles.length > 0) {
        const pathsRaw = req.body?.paths;
        const relPaths = Array.isArray(pathsRaw)
          ? pathsRaw.map(String)
          : pathsRaw !== undefined
            ? [String(pathsRaw)]
            : [];
        const looseTotalBytes = stageLooseFiles(stagingDir, looseFiles, relPaths);
        const firstSegments = relPaths.map((p) => p.replace(/\\/g, '/').split('/')[0]);
        const commonRoot =
          firstSegments.every((seg) => seg && seg === firstSegments[0]) && looseFiles.length > 1
            ? firstSegments[0]
            : undefined;
        const label =
          commonRoot ?? (looseFiles.length === 1 ? firstSegments[0] : `${looseFiles.length} 个文件`);
        const { fileCount, ignoredCount } = await applyIgnoreFilter(stagingDir, looseFiles.length, respectGitignore);
        const languageStats = await collectLanguageStats(stagingDir);
        commitStaging();
        updateProject(project.id, { languageStats });
        res.json({
          fileName: label,
          fileSize: looseTotalBytes,
          fileCount,
          ignoredCount,
          languageStats,
        });
        return;
      }

      throw new HttpError(400, '请通过 multipart 表单上传 file 或 files 字段', {
        code: 'srv.fileRequired',
      });
    } catch (error) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw error;
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
    });
  } finally {
    importingProjects.delete(project.id);
  }
}));


const REVIEW_STATUSES = ['confirmed', 'false_positive', 'accepted'] as const;

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
