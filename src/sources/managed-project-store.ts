import type { ManagedProjectService } from './managed-project-service.js';

/** Storage capabilities for source adapters; construction belongs to the application. */
export type ManagedProjectStore = Pick<ManagedProjectService,
  'begin' | 'recordBytes' | 'pendingDirectory' | 'releasePendingBytes' | 'complete' | 'resolve' | 'pin' | 'discard' | 'list'>;
