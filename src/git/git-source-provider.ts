import type { ManagedProjectStore } from '../sources/public.js';
import type { SourceProvider } from '../sources/ports.js';
import { gitMetadataTypes } from '../contracts/git-metadata-types.js';
import { requireGitMetadataType } from './git-metadata-selection.js';
import type { GitImportService } from './git-import-service.js';
import type { GitRegistrationService } from './git-registration-service.js';

export function createGitSourceProvider(
  imports: () => Pick<GitImportService, 'remove' | 'resolve' | 'sourceForPath'>,
  registrations: () => Pick<GitRegistrationService, 'prepare' | 'get'>,
  projects: Pick<ManagedProjectStore, 'pin'>,
): SourceProvider {
  return {
    accepts: (id) => id.startsWith('git:') || id.startsWith('git-registered:'),
    requiresPreparation: (id) => id.startsWith('git-registered:'),
    async prepare(id, input) {
      if (!id.startsWith('git-registered:')) return { id, release() {}, async discard() {} };
      if (!['all', 'selected'].includes(input.scope) || input.metadataType === undefined) {
        throw new Error('등록 브랜치는 메타데이터 타입을 선택해 비교하세요.');
      }
      const record = await registrations().prepare(id.slice('git-registered:'.length), input.ownerUserId,
        input.metadataType, { sessionId: input.sessionId, jobId: input.jobId, side: input.side });
      let release: () => void;
      try { release = projects.pin([record.id], input.ownerUserId); }
      catch (error) {
        await imports().remove(record.id, input.ownerUserId).catch(() => undefined);
        throw error;
      }
      return {
        id: `git:${record.id}`, release,
        async discard() { release(); await imports().remove(record.id, input.ownerUserId); },
      };
    },
    resolveProject: async (id, owner) => imports().resolve(id.slice('git:'.length), owner),
    managedProjectIds: (id) => id.startsWith('git:') ? [id.slice('git:'.length)] : [],
    sourceForPath: (realPath) => imports().sourceForPath(realPath),
    async metadataTypes(id, owner) {
      if (id.startsWith('git-registered:')) {
        if (owner === undefined) throw new Error('등록 브랜치를 사용할 수 없습니다.');
        await registrations().get(id.slice('git-registered:'.length), owner);
        return gitMetadataTypes.map(({ name, directoryName }) => ({ name, directoryName }));
      }
      const project = await imports().resolve(id.slice('git:'.length), owner);
      const name = imports().sourceForPath(project.realPath)?.provenance?.metadataType;
      if (name === undefined) return [];
      const type = requireGitMetadataType(name);
      return [{ name, directoryName: type.directoryName }];
    },
  };
}
