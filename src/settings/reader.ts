import type { UserSettingsRepository } from './user-settings-repository.js';

export type UserSettingsReader = Pick<UserSettingsRepository, 'get'>;
