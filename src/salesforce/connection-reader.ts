import type { SalesforceConnectionRepository } from './connection-repository.js';

/** Read-only connection identity lookup; mutation and credential access remain internal. */
export type SalesforceConnectionReader = Pick<SalesforceConnectionRepository, 'list' | 'getByAlias'>;
