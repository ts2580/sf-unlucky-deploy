import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sfProcessCommand } from '../salesforce/sf-client.js';
import { inspectDataDirectory } from './data-inspection.js';
import { configurationUrl, LOOPBACK_HOSTS, resolveRuntimeSettings } from './runtime-settings.js';
import { safeOutput } from './setup.js';
import { readHomeConfigurationSnapshot } from './user-config.js';

interface DoctorCheck { id: string; status: 'pass' | 'warn' | 'fail'; message: string }
export interface DoctorReport {
  version: 1;
  checks: DoctorCheck[];
  configuration?: { file: string; secretsFile: string; mode: string; host: string; port: number; dataDirectory: string; trustedProxies: string[]; publicOrigin?: string; environmentOverrides: string[] };
  connection?: { calculatedUrl?: string; reachability: 'not_checked' | 'reachable_from_server' | 'unreachable_from_server' | 'no_concrete_url'; message: string };
  oauth?: { callback: string; port: number; message: string };
  exitCode: number;
}
export interface DoctorDependencies {
  version?: (command: 'git' | 'sf', environment: NodeJS.ProcessEnv) => Promise<string | undefined>;
  reach?: (url: string) => Promise<boolean>;
  oauthPort?: (cwd: string) => Promise<number>;
}

export async function runDoctor(options: { checkUrl?: boolean } = {}, environment: NodeJS.ProcessEnv = process.env, dependencies: DoctorDependencies = {}, cwd = process.cwd()): Promise<DoctorReport> {
  const report: DoctorReport = { version: 1, checks: [], exitCode: 0 };
  const add = (id: string, status: DoctorCheck['status'], message: string) => { report.checks.push({ id, status, message }); };
  const node = process.versions.node.split('.').map(Number);
  add('node', node[0]! > 22 || (node[0] === 22 && (node[1]! > 19 || (node[1] === 19 && node[2]! >= 0))) ? 'pass' : 'fail', `Node ${process.versions.node}; 지원: 22.19.0 이상`);
  const version = dependencies.version ?? toolVersion;
  const versions = await Promise.allSettled(['git', 'sf'].map((command) => version(command as 'git' | 'sf', environment)));
  for (const [index, item] of versions.entries()) {
    const tool = index === 0 ? 'git' : 'sf';
    const output = item.status === 'fulfilled' ? item.value : undefined;
    const match = tool === 'git' ? /^git version (\d+\.\d+(?:\.\d+)?)/u.exec(output ?? '') : /(?:@salesforce\/cli|sf)\/(\d+\.\d+(?:\.\d+)?)/u.exec(output ?? '');
    add(tool, match === null || (tool === 'sf' && Number(match[1]!.split('.')[0]) !== 2) ? 'fail' : 'pass', match === null ? `${tool} 설치 또는 버전을 확인하지 못했습니다.` : `${tool} ${match[1]}${tool === 'sf' ? '; 지원: CLI v2' : '; 최소 버전은 별도 지정하지 않습니다.'}`);
  }
  let effective = { ...environment };
  try {
    const snapshot = await readHomeConfigurationSnapshot(environment);
    effective = snapshot.environment;
    add('home-files', snapshot.originals.config === undefined ? 'warn' : 'pass', snapshot.originals.config === undefined ? '홈 설정 파일이 없습니다. 현재 환경과 기본값만 점검했습니다.' : '홈 설정 형식·소유자·파일 권한 검사를 통과했습니다.');
    add('secret-file', snapshot.originals.secrets === undefined ? 'warn' : 'pass', snapshot.originals.secrets === undefined ? '비밀 설정 파일이 없습니다.' : '비밀 설정 형식·권한 검사를 통과했습니다.');
    const settings = resolveRuntimeSettings(effective, cwd);
    const environmentOverrides = Object.keys({ ...snapshot.configuration, ...snapshot.secrets }).filter((key) => environment[key] !== undefined);
    report.configuration = { file: snapshot.paths.configFile, secretsFile: snapshot.paths.secretsFile,
      mode: settings.localMode ? 'personal' : 'multiuser', host: settings.host, port: settings.port,
      dataDirectory: settings.dataDirectory, trustedProxies: settings.trustedProxies,
      ...(settings.publicOrigin === undefined ? {} : { publicOrigin: settings.publicOrigin }), environmentOverrides };
    add('runtime', 'pass', '실행 모드·수신 주소·프록시·접속 비밀번호의 정합성을 확인했습니다. CLI 옵션은 환경과 홈 설정을 덮어씁니다.');
    for (const key of ['SFUD_TOKEN_SECRET', 'SFUD_GIT_TOKEN_SECRET', 'SFUD_SF_TOKEN_SECRET']) {
      const secret = effective[key];
      if (secret !== undefined) add(key, validTokenSecret(secret) ? 'pass' : 'fail', `${key}: ${validTokenSecret(secret) ? '존재·형식 확인' : '형식 오류 (32–1024자, 앞뒤 공백·제어문자 금지)'}`);
    }
    const keyFile = effective.SFUD_GIT_TOKEN_KEY_FILE;
    let keyFileValid = false;
    if (keyFile !== undefined) {
      try {
        const stat = await lstat(keyFile);
        const valid = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === 32 && (process.platform === 'win32' || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.()));
        // Use the home-config secure reader to apply the same real Windows ACL policy.
        const { inspectSecureConfigurationFile } = await import('./user-config.js');
        if (valid) { await inspectSecureConfigurationFile(keyFile, 32); keyFileValid = true; }
        add('git-key-file', valid ? 'pass' : 'fail', valid ? 'Git 키 파일 형식·권한 확인' : 'Git 키 파일 형식·권한 오류');
      } catch { add('git-key-file', 'fail', 'Git 키 파일을 안전하게 읽을 수 없습니다.'); }
    }
    const gitSecret = effective.SFUD_TOKEN_SECRET ?? effective.SFUD_GIT_TOKEN_SECRET;
    const sfSecret = effective.SFUD_TOKEN_SECRET ?? effective.SFUD_SF_TOKEN_SECRET;
    const gitReady = gitSecret !== undefined ? validTokenSecret(gitSecret) : keyFileValid;
    add('git-encryption', gitReady ? 'pass' : 'warn', gitReady ? 'Git 연결 저장용 암호화 키 준비됨' : 'Git 연결 저장용 암호화 키 없음 또는 형식 오류; 연결 저장 전에 설정하세요.');
    add('salesforce-encryption', settings.localMode || (sfSecret !== undefined && validTokenSecret(sfSecret)) ? 'pass' : 'warn', settings.localMode ? '개인용 Salesforce는 OS CLI 인증을 사용합니다. 별도 암호화 키가 필요하지 않습니다.' : sfSecret !== undefined && validTokenSecret(sfSecret) ? '사용자별 Salesforce 연결 저장용 암호화 키 준비됨' : '사용자별 Salesforce 연결 저장용 암호화 키 설정이 필요합니다.');
    for (const key of ['SFUD_SF_OAUTH_CLIENT_ID', 'SFUD_SF_OAUTH_CLIENT_SECRET']) {
      const value = effective[key];
      if (value === undefined) { if (!settings.localMode) add(key, 'warn', `${key}: 사용자별 브라우저 OAuth를 사용하려면 설정하세요.`); }
      else {
        const valid = value.length > 0 && value.length <= 4096 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
        add(key, valid ? 'pass' : 'fail', `${key}: ${valid ? '존재·형식 확인' : '형식 오류'}`);
      }
    }
    const data = await inspectDataDirectory(settings.dataDirectory);
    add('data-access', data.accessible ? 'pass' : 'fail', data.accessible ? `${data.exists ? '데이터 디렉터리' : '가장 가까운 기존 상위 디렉터리'} 접근 권한 확인; 실제 쓰기는 수행하지 않았습니다.` : '데이터 경로 접근 실패');
    if (data.uncertain) add('database-mode', 'warn', 'DB 또는 미체크포인트 WAL 때문에 기존 DB 모드를 확정할 수 없습니다. 서버 종료 후 다시 점검하세요.');
    else if (data.mode !== undefined) add('database-mode', data.mode === (settings.localMode ? 'local' : 'multiuser') ? 'pass' : 'fail', data.mode === (settings.localMode ? 'local' : 'multiuser') ? '기존 DB 모드와 시작 설정 일치' : '기존 DB 모드와 시작 설정 불일치. 별도 데이터 경로를 사용하세요.');
    else add('database-mode', 'warn', '기존 DB 없음; DB를 생성하거나 마이그레이션하지 않았습니다.');
    const gitKey = effective.SFUD_TOKEN_SECRET ?? effective.SFUD_GIT_TOKEN_SECRET;
    const sfKey = effective.SFUD_TOKEN_SECRET ?? effective.SFUD_SF_TOKEN_SECRET;
    if (data.databaseExists && (gitKey === undefined && keyFile === undefined || sfKey === undefined)) add('key-recovery', 'warn', '기존 DB의 암호화 키 설정이 부족합니다. 기존 키를 복구하세요. 새 키는 생성하지 않습니다.');
    const url = configurationUrl(settings);
    report.connection = { ...(url === undefined ? {} : { calculatedUrl: url }), reachability: url === undefined ? 'no_concrete_url' : 'not_checked', message: '계산한 URL은 실제 브라우저 접근 성공을 의미하지 않습니다. --check-url로 서버에서 읽기 점검할 수 있습니다.' };
    if (options.checkUrl && url !== undefined) {
      let reached = false;
      try { reached = await (dependencies.reach ?? reachUrl)(url); } catch { /* sanitized below */ }
      report.connection.reachability = reached ? 'reachable_from_server' : 'unreachable_from_server';
      report.connection.message = reached ? '서버에서 HTTP 응답 확인. 외부 브라우저·프록시 접근 성공은 확인하지 않았습니다.' : '서버에서 URL 응답을 확인하지 못했습니다. 서버 실행·주소·네트워크를 확인하세요.';
      add('url-reachability', reached ? 'pass' : 'fail', report.connection.message);
    }
    if (settings.localMode) {
      const port = await (dependencies.oauthPort ?? localOauthPort)(cwd);
      report.oauth = { callback: `http://localhost:${port}/OauthRedirect`, port, message: LOOPBACK_HOSTS.has(settings.host) && settings.publicOrigin === undefined ? 'Salesforce 브라우저 로그인은 서버의 로컬 OAuth 콜백 포트를 사용합니다.' : 'Salesforce 브라우저 로그인은 공개 UI URL 대신 서버의 로컬 콜백을 사용합니다. 브라우저 PC에서 서버로 이 포트의 SSH 터널이 필요합니다.' };
    } else if (settings.publicOrigin?.startsWith('https://')) report.oauth = { callback: `${settings.publicOrigin}/api/v1/salesforce/oauth/callback`, port: Number(new URL(settings.publicOrigin).port || '443'), message: '사용자별 브라우저 OAuth에는 HTTPS 공개 Origin·클라이언트 설정·암호화 키가 필요합니다.' };
    else add('oauth-callback', 'warn', '사용자별 브라우저 OAuth에는 HTTPS 공개 Origin이 필요합니다.');
  } catch {
    add('configuration', 'fail', '설정·비밀 파일의 형식·권한 또는 실행 설정 정합성 오류입니다. sfud config path와 운영 문서를 확인하세요. 원문 값은 출력하지 않습니다.');
  }
  report.exitCode = report.checks.some((check) => check.status === 'fail') ? 1 : 0;
  return JSON.parse(JSON.stringify(report, (_key, value: unknown) => typeof value === 'string' ? safeOutput(value, effective) : value)) as DoctorReport;
}

function validTokenSecret(secret: string): boolean { return secret.length >= 32 && secret.length <= 1024 && secret === secret.trim() && !/[\u0000-\u001f\u007f]/u.test(secret); }
async function toolVersion(command: 'git' | 'sf', environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !/^(?:NODE_OPTIONS|SFUD_)/iu.test(key)));
  let executable = command as string;
  let args: readonly string[] = ['--version'];
  try { if (command === 'sf') ({ executable, args } = sfProcessCommand('sf', args, process.platform, env)); }
  catch { return undefined; }
  return new Promise((resolve) => {
    const child = spawn(executable, args, { env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(undefined); }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 4096) { child.kill('SIGKILL'); resolve(undefined); } });
    child.once('error', () => { clearTimeout(timer); resolve(undefined); });
    child.once('close', (code) => { clearTimeout(timer); resolve(code === 0 && output.length <= 4096 ? output.trim() : undefined); });
  });
}
async function reachUrl(url: string): Promise<boolean> {
  const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
  return response.status >= 100 && response.status < 600;
}
async function localOauthPort(cwd: string): Promise<number> {
  let directory = cwd;
  while (true) {
    try {
      const file = path.join(directory, 'sfdx-project.json');
      const stat = await lstat(file);
      if (stat.isFile() && stat.size < 32 * 1024) {
        const contents = JSON.parse(await readFile(file, 'utf8')) as { oauthLocalPort?: unknown };
        if (Number.isInteger(contents.oauthLocalPort) && Number(contents.oauthLocalPort) >= 1 && Number(contents.oauthLocalPort) <= 65535) return Number(contents.oauthLocalPort);
      }
      return 1717;
    } catch { /* locate the same nearest project as Salesforce */ }
    const parent = path.dirname(directory);
    if (parent === directory) return 1717;
    directory = parent;
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((check) => `${check.status.toUpperCase()} ${check.id}: ${check.message}`);
  if (report.configuration !== undefined) {
    const config = report.configuration;
    lines.push(`설정: ${config.file}`, `비밀 설정: ${config.secretsFile}`, `모드: ${config.mode}; 수신: ${config.host}:${config.port}`, `데이터: ${config.dataDirectory}`,
      `프록시: ${config.trustedProxies.join(', ') || '없음'}; 공개 Origin: ${config.publicOrigin ?? '없음'}`,
      `환경변수 우선 항목: ${config.environmentOverrides.join(', ') || '없음'}`);
  }
  if (report.connection !== undefined) lines.push(`계산 URL: ${report.connection.calculatedUrl ?? '전체 인터페이스 수신; 실제 서버 주소 필요'}`, `도달 상태: ${report.connection.reachability}; ${report.connection.message}`);
  if (report.oauth !== undefined) lines.push(`OAuth 콜백: ${report.oauth.callback}; ${report.oauth.message}`);
  return `${lines.join('\n')}\n`;
}
