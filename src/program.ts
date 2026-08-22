import { Command } from 'commander';

export const CLI_VERSION = '0.1.0';

export function createProgram(): Command {
  return new Command()
    .name('sfud')
    .description('Salesforce 메타데이터 비교·검증·배포 CLI')
    .version(CLI_VERSION);
}
