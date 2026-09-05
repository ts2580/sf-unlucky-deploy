import { createWriteStream } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FastifyInstance } from 'fastify';

import { redactSensitiveText } from '../../salesforce/sf-client.js';
import { requireAuthenticatedSession } from './auth-routes.js';
import { UploadQuotaError } from './workspace-service.js';

const MAX_FILE_COUNT = 2_000;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_SIZE_BYTES = 100 * 1024 * 1024;
const FORBIDDEN_DIRECTORIES = new Set(['.git', '.sf', '.sfdx', 'node_modules']);
const FORBIDDEN_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx']);

export async function registerProjectUploadRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/uploads/projects', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, {
      csrf: true,
      roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'],
    });
    if (session === undefined) return;
    if (!request.isMultipart()) {
      return reply.code(415).send({ error: {
        code: 'MULTIPART_REQUIRED',
        message: '프로젝트 폴더는 multipart/form-data로 업로드해야 합니다.',
      } });
    }

    const upload = await app.sfudRuntime.workspace.beginProjectUpload(session.user.id);
    let fileCount = 0;
    let totalBytes = 0;
    let label: string | undefined;
    try {
      for await (const part of request.parts({
        preservePath: true,
        limits: {
          fields: 1,
          files: MAX_FILE_COUNT,
          parts: MAX_FILE_COUNT + 1,
          fileSize: MAX_FILE_SIZE_BYTES,
        },
      })) {
        if (part.type === 'field') {
          if (part.fieldname !== 'label' || typeof part.value !== 'string' || part.valueTruncated) {
            throw new Error('업로드 프로젝트 이름이 올바르지 않습니다.');
          }
          label = part.value;
          continue;
        }
        if (part.fieldname !== 'files') {
          part.file.resume();
          throw new Error('지원하지 않는 업로드 파일 필드입니다.');
        }
        fileCount += 1;
        const relativePath = safeUploadPath(part.filename);
        const targetPath = await resolveUploadTarget(upload.directory, relativePath);
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            totalBytes += chunk.length;
            if (totalBytes > MAX_TOTAL_SIZE_BYTES) {
              callback(new UploadLimitError('업로드 프로젝트 전체 크기는 100MB 이하여야 합니다.'));
              return;
            }
            try {
              app.sfudRuntime.workspace.recordProjectUploadBytes(upload.id, chunk.length);
            } catch (error) {
              callback(error as Error);
              return;
            }
            callback(null, chunk);
          },
        });
        await pipeline(part.file, counter, createWriteStream(targetPath, { flags: 'wx', mode: 0o600 }));
        if (part.file.truncated) {
          throw new UploadLimitError('업로드 파일 하나의 크기는 10MB 이하여야 합니다.');
        }
      }
      if (fileCount === 0) throw new Error('업로드할 프로젝트 파일이 없습니다.');
      const project = await app.sfudRuntime.workspace.completeProjectUpload(
        upload.id,
        session.user.id,
        label,
      );
      return reply.code(201).send({ source: {
        id: `upload:${project.id}`,
        kind: 'local',
        location: 'upload',
        label: project.displayName,
        detail: '내 단말기에서 임시 업로드 · 마지막 사용 후 4시간',
        expiresAt: new Date(project.expiresAt).toISOString(),
      } });
    } catch (error) {
      await app.sfudRuntime.workspace.discardProjectUpload(upload.id);
      const tooLarge = error instanceof UploadLimitError
        || error instanceof UploadQuotaError
        || error instanceof app.multipartErrors.RequestFileTooLargeError
        || error instanceof app.multipartErrors.FilesLimitError
        || error instanceof app.multipartErrors.PartsLimitError;
      return reply.code(tooLarge ? 413 : 400).send({ error: {
        code: error instanceof UploadQuotaError
          ? 'PROJECT_UPLOAD_QUOTA_EXCEEDED'
          : tooLarge ? 'PROJECT_UPLOAD_TOO_LARGE' : 'INVALID_PROJECT_UPLOAD',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error))
          .replaceAll(upload.directory, '[임시 업로드]'),
      } });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/v1/uploads/projects/:id', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, {
      csrf: true,
      roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'],
    });
    if (session === undefined) return;
    try {
      await app.sfudRuntime.workspace.discardProjectUpload(request.params.id, session.user.id);
      return reply.code(204).send();
    } catch (error) {
      return reply.code(404).send({ error: {
        code: 'PROJECT_UPLOAD_NOT_FOUND',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      } });
    }
  });
}

function safeUploadPath(filename: string): string {
  if (filename.length === 0 || filename.length > 500 || filename.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(filename) || path.posix.isAbsolute(filename)) {
    throw new Error('업로드 파일 경로가 올바르지 않습니다.');
  }
  const normalized = path.posix.normalize(filename);
  if (normalized !== filename || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('업로드 파일 경로가 올바르지 않습니다.');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..'
    || FORBIDDEN_DIRECTORIES.has(segment.toLowerCase()))) {
    throw new Error('업로드할 수 없는 디렉토리가 포함되어 있습니다.');
  }
  if (segments.some((segment) => segment.includes(':') || /[. ]$/u.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
    throw new Error('Windows에서 안전하지 않은 파일 경로는 업로드할 수 없습니다.');
  }
  const basename = segments.at(-1)!.toLowerCase();
  if (basename === '.env' || basename.startsWith('.env.') || FORBIDDEN_EXTENSIONS.has(path.extname(basename))) {
    throw new Error('비밀 정보일 수 있는 파일은 업로드할 수 없습니다.');
  }
  return normalized;
}

async function resolveUploadTarget(uploadDirectory: string, relativePath: string): Promise<string> {
  const root = await realpath(uploadDirectory);
  const requestedPath = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(requestedPath), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(requestedPath));
  if (!isInsideOrEqual(root, parent)) throw new Error('업로드 파일 경로가 임시 저장소 밖을 가리킵니다.');
  const targetPath = path.join(parent, path.basename(requestedPath));
  if (!isInsideOrEqual(root, targetPath) || targetPath === root) {
    throw new Error('업로드 파일 경로가 임시 저장소 밖을 가리킵니다.');
  }
  return targetPath;
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

class UploadLimitError extends Error {}
