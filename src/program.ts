import { Command } from 'commander';

import { runCompareCommand, type CommandDependencies } from './commands/compare.js';
import {
  runDeployCommand,
  type DeployCommandDependencies,
} from './commands/deploy.js';
import { SfudError } from './core/errors.js';
import type { RequestedTestLevel } from './deploy/test-plan.js';
import {
  DEFAULT_UI_HOST,
  DEFAULT_UI_PORT,
  startWebUi,
} from './web/server/start.js';

export const CLI_VERSION = '0.2.0';

export interface ProgramDependencies extends CommandDependencies, DeployCommandDependencies {}

const TEST_LEVELS: RequestedTestLevel[] = [
  'auto',
  'NoTestRun',
  'RunSpecifiedTests',
  'RunLocalTests',
  'RunAllTestsInOrg',
  'RunRelevantTests',
];

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const program = new Command()
    .name('sfud')
    .description('Salesforce 메타데이터 비교·검증·배포 CLI')
    .version(CLI_VERSION)
    .showHelpAfterError();

  program
    .command('compare')
    .description('org 또는 로컬 DX 프로젝트의 메타데이터를 비교합니다.')
    .requiredOption('--left <source>', '왼쪽 소스: org:<alias> 또는 local:<path>')
    .requiredOption('--right <source>', '오른쪽 소스: org:<alias> 또는 local:<path>')
    .option('--manifest <path>', '공통 package.xml 경로', 'manifest/package.xml')
    .option('--all-metadata', 'sf CLI로 양쪽 소스의 전체 배포 가능 메타데이터 manifest 생성')
    .option('--metadata-type <type>', 'sf CLI로 지정한 Salesforce metadata type만 비교')
    .option('--wait <minutes>', 'Salesforce retrieve 대기 시간', parsePositiveInteger, 60)
    .option('--report-dir <path>', '실행 결과 저장 디렉터리')
    .option('--detail', '변경 상세를 터미널에 출력')
    .option('--show-identical', '동일한 컴포넌트도 터미널에 출력')
    .option('--strict', 'XML 형식 차이까지 비교')
    .option('--fail-on-diff', '차이가 있으면 종료 코드 1 반환')
    .option('--json', 'JSON 결과를 표준 출력')
    .option('--no-color', '터미널 색상 비활성화')
    .action(async (options) => {
      const result = await runCompareCommand(options as Parameters<typeof runCompareCommand>[0], dependencies);
      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
      }
    });

  program
    .command('deploy')
    .description('org 또는 로컬 DX 프로젝트의 메타데이터를 org에 검증·배포합니다.')
    .requiredOption('--from <source>', '배포 소스: org:<alias> 또는 local:<path>')
    .requiredOption('--to <alias>', '대상 org 별칭')
    .option('--manifest <path>', '배포 범위 package.xml 경로', 'manifest/package.xml')
    .option('--all-metadata', 'sf CLI로 source와 target의 전체 배포 가능 메타데이터 manifest 생성')
    .option('--metadata-type <type>', 'sf CLI로 지정한 Salesforce metadata type만 검증·배포')
    .option('--report-dir <path>', '실행 결과 저장 디렉터리')
    .option('--dry-run', '실제 반영 없이 검증만 실행 (기본값)')
    .option('--execute', 'dry-run 성공 후 실제 배포 실행')
    .option('--test-level <level>', `Apex 테스트 수준: ${TEST_LEVELS.join(', ')}`, 'auto')
    .option('--tests <names...>', '실행할 Apex 테스트 클래스. 미지정 시 *_Test.cls 자동 선택')
    .option('--wait <minutes>', 'Salesforce CLI 대기 시간', parsePositiveInteger, 60)
    .option('--strict', 'XML 형식 차이까지 비교')
    .option('--json', 'JSON 결과를 표준 출력')
    .option('--no-color', '터미널 색상 비활성화')
    .action(async (options) => {
      const testLevel = options.testLevel as string;
      if (!TEST_LEVELS.includes(testLevel as RequestedTestLevel)) {
        throw new SfudError('INVALID_ARGUMENT', `지원하지 않는 test level입니다: ${testLevel}`);
      }
      await runDeployCommand(options as Parameters<typeof runDeployCommand>[0], dependencies);
    });

  program
    .command('ui')
    .description('로컬 웹 UI를 시작합니다.')
    .option('--host <host>', 'bind 주소', DEFAULT_UI_HOST)
    .option(
      '--port <port>',
      'bind 포트',
      parsePort,
    )
    .option('--project <path>', '서버에서 허용할 Salesforce DX 프로젝트 경로 (반복 가능, 기본 없음)', collectOption, [])
    .option('--data-dir <path>', 'SQLite와 실행 상태를 저장할 디렉터리')
    .option('--no-open', '시작 후 브라우저를 열지 않음')
    .option('--allow-remote', 'loopback 외 주소 bind 허용')
    .action(async (options) => {
      const dataDirectory = options.dataDir as string | undefined;
      const projectPaths = options.project as string[];
      const port = options.port as number | undefined;
      await startWebUi({
        host: options.host as string,
        port: port ?? parsePort(process.env.SFUD_UI_PORT ?? String(DEFAULT_UI_PORT)),
        allowRemote: options.allowRemote === true,
        open: options.open !== false,
        logger: false,
        ...(dataDirectory === undefined ? {} : { dataDirectory }),
        ...(projectPaths.length === 0 ? {} : { projectPaths }),
      });
    });

  return program;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('포트는 1부터 65535 사이의 정수여야 합니다.');
  }
  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('1 이상의 정수를 입력해야 합니다.');
  }
  return parsed;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}
