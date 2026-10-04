import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { SfudError } from '../core/errors.js';
import { inspectDataDirectory } from './data-inspection.js';
import { configurationUrl, LOOPBACK_HOSTS, resolveRuntimeSettings } from './runtime-settings.js';
import { terminalSetupPrompt, type SetupPrompt } from './setup-prompt.js';
import { readHomeConfigurationSnapshot, saveHomeConfiguration } from './user-config.js';

export async function runSetup(environment: NodeJS.ProcessEnv = process.env, prompt: SetupPrompt = terminalSetupPrompt()): Promise<number> {
  if (!prompt.interactive) {
    prompt.write('sfud setup은 대화형 서버 터미널에서 실행하세요. 입력을 기다리거나 파일을 생성하지 않습니다.\n설정 위치: sfud config path\n필요 설정: LOCAL=true, SFUD_UI_HOST, SFUD_UI_PORT, 별도 SFUD_DATA_DIR.\n원격 개인용은 SFUD_ACCESS_PASSWORD(12–128자)가 필수입니다. 비밀값은 secrets.env에만 저장하세요.\n점검: sfud doctor --json\n');
    return 2;
  }
  try {
    const snapshot = await readHomeConfigurationSnapshot(environment);
    if (snapshot.environment.LOCAL !== undefined && snapshot.environment.LOCAL !== 'true') {
      prompt.write('기존 사용자별 서버 설정을 보존했습니다. 개인용으로 전환하지 않습니다.\n운영 안내: https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/configuration.md\n');
      return 2;
    }
    const choice = (await prompt.ask('사용 방식: 1) 내 PC에서만  2) 원격 서버에서 혼자 [1]: ')).trim() || '1';
    if (choice !== '1' && choice !== '2') throw invalid('사용 방식은 1 또는 2를 선택하세요.');
    const remote = choice === '2';
    const config: Record<string, string> = { ...snapshot.configuration, LOCAL: 'true' };
    const secrets = { ...snapshot.secrets };
    config.SFUD_UI_HOST = (await prompt.ask(`수신 주소 [${remote ? '0.0.0.0' : '127.0.0.1'}]: `)).trim() || (remote ? '0.0.0.0' : '127.0.0.1');
    if (!remote && !LOOPBACK_HOSTS.has(config.SFUD_UI_HOST)) throw invalid('내 PC 사용은 루프백 주소를 선택하세요.');
    config.SFUD_UI_PORT = (await prompt.ask('수신 포트 [27546]: ')).trim() || '27546';
    const defaultData = snapshot.configuration.SFUD_DATA_DIR ?? 'data/local';
    // Do not echo arbitrary environment values in defaults.
    const selectedData = (await prompt.ask('개인용 데이터 경로 [기존 홈 설정 경로 또는 data/local]: ')).trim() || defaultData;
    config.SFUD_DATA_DIR = selectedData;
    delete config.SFUD_PUBLIC_ORIGIN;
    delete config.SFUD_TRUSTED_PROXIES;
    if (remote && (await prompt.ask('리버스 프록시를 사용하나요? [y/N]: ')).trim().toLowerCase() === 'y') {
      config.SFUD_PUBLIC_ORIGIN = (await prompt.ask('공개 http(s) Origin: ')).trim();
      config.SFUD_TRUSTED_PROXIES = (await prompt.ask('신뢰 프록시 IP/CIDR (쉼표로 구분): ')).trim();
      if (config.SFUD_TRUSTED_PROXIES.length === 0) throw invalid('프록시의 실제 IP/CIDR을 입력하세요.');
    }
    const existingPassword = snapshot.environment.SFUD_ACCESS_PASSWORD;
    const needsPassword = remote || config.SFUD_PUBLIC_ORIGIN !== undefined;
    if (existingPassword === undefined && (needsPassword || (await prompt.ask('접속 비밀번호를 설정하나요? [y/N]: ')).trim().toLowerCase() === 'y')) {
      const password = await prompt.ask('접속 비밀번호 (12–128자, 숨김 입력): ', true);
      const confirmation = await prompt.ask('접속 비밀번호 재입력: ', true);
      if (password !== confirmation) throw invalid('비밀번호가 일치하지 않습니다.');
      secrets.SFUD_ACCESS_PASSWORD = password;
    }
    const plannedEnvironment = { ...snapshot.environment };
    // The shell environment, including empty values, always wins over files.
    for (const [key, value] of Object.entries(config)) {
      if (environment[key] === undefined) plannedEnvironment[key] = key === 'SFUD_DATA_DIR' || key === 'SFUD_GIT_TOKEN_KEY_FILE'
        ? path.resolve(snapshot.paths.directory, value) : value;
    }
    for (const key of ['SFUD_PUBLIC_ORIGIN', 'SFUD_TRUSTED_PROXIES']) if (environment[key] === undefined && config[key] === undefined) delete plannedEnvironment[key];
    for (const [key, value] of Object.entries(secrets)) if (environment[key] === undefined) plannedEnvironment[key] = value;
    const settings = resolveRuntimeSettings(plannedEnvironment);
    if (!remote && (!LOOPBACK_HOSTS.has(settings.host) || settings.publicOrigin !== undefined || settings.trustedProxies.length > 0)) throw invalid('환경변수가 내 PC 설정을 원격 설정으로 덮어씁니다. 환경변수 또는 시작 스크립트를 수정하세요.');
    const data = await inspectDataDirectory(settings.dataDirectory);
    if (!data.accessible) throw invalid('데이터 디렉터리에 접근할 수 없습니다. 권한과 경로를 확인하세요.');
    if (data.mode === 'multiuser' || data.uncertain || (data.databaseExists && data.mode !== 'local')) throw invalid('기존 DB 모드를 안전하게 확인할 수 없거나 사용자별 DB입니다. 실행 중인 서버를 종료해 재점검하거나 별도 빈 데이터 경로를 선택하세요.');
    const keyNames = ['SFUD_TOKEN_SECRET', 'SFUD_GIT_TOKEN_SECRET', 'SFUD_SF_TOKEN_SECRET', 'SFUD_GIT_TOKEN_KEY_FILE'];
    const hasKey = keyNames.some((key) => plannedEnvironment[key] !== undefined);
    if (!hasKey) {
      if (!data.empty || data.databaseExists) prompt.write('기존 데이터가 있으므로 암호화 키를 생성하지 않습니다. 기존 키 복구 후 연결 저장을 사용하세요.\n');
      else if ((await prompt.ask('새 암호화 키를 생성·저장하나요? [y/N]: ')).trim().toLowerCase() === 'y') secrets.SFUD_TOKEN_SECRET = randomBytes(32).toString('base64url');
    } else prompt.write('기존 암호화 키 설정을 보존합니다. 키를 자동 교체하지 않습니다.\n');
    const overridden = Object.keys({ ...config, ...secrets }).filter((key) => environment[key] !== undefined);
    prompt.write(safeOutput(`저장 계획\n일반 설정: ${safeOutput(snapshot.paths.configFile, plannedEnvironment)}\n비밀 설정: ${safeOutput(snapshot.paths.secretsFile, plannedEnvironment)}\n모드: 개인용\n수신: ${settings.host}:${settings.port}\n데이터: ${safeOutput(settings.dataDirectory, plannedEnvironment)}\n접속 URL: ${configurationUrl(settings) ?? '수신 주소가 전체 인터페이스입니다. 실제 서버 주소를 사용하세요.'}\n`, plannedEnvironment));
    prompt.write(`적용 우선순위: UI CLI 옵션 > 환경변수(빈 값 포함) > 홈 설정 > 기본값. 시작 스크립트의 CLI 옵션은 여기서 확인할 수 없습니다.\n환경변수 우선 항목: ${overridden.length === 0 ? '없음' : overridden.join(', ')}\n`);
    if ((await prompt.ask('이 계획을 저장하나요? [y/N]: ')).trim().toLowerCase() !== 'y') { prompt.write('설정을 취소했습니다. 파일을 저장하지 않았습니다.\n'); return 0; }
    // Recheck fresh data before key generation is committed.
    const latestData = await inspectDataDirectory(settings.dataDirectory);
    if (!latestData.accessible || latestData.uncertain || latestData.mode === 'multiuser' || (latestData.databaseExists && latestData.mode !== 'local')) throw invalid('설정 중 데이터 모드나 접근 상태가 변경되었습니다. 저장하지 않았습니다. 다시 확인하세요.');
    if (secrets.SFUD_TOKEN_SECRET !== snapshot.secrets.SFUD_TOKEN_SECRET && (!latestData.empty || latestData.databaseExists)) throw invalid('설정 중 데이터가 생성되었습니다. 새 키를 저장하지 않았습니다. 다시 확인하세요.');
    await saveHomeConfiguration(snapshot, config, secrets);
    prompt.write(`설정을 저장했습니다.\n실행: sfud ui${remote ? ' --allow-remote' : ''} --no-open\n점검: sfud doctor\n`);
    return 0;
  } catch (error) {
    if (error instanceof SfudError) throw error;
    throw invalid('설정을 완료하지 못했습니다. 기존 설정과 파일 권한을 확인하세요.');
  }
}
function invalid(message: string): SfudError { return new SfudError('CONFIGURATION_ERROR', message); }

export function safeOutput(value: string, environment: NodeJS.ProcessEnv): string {
  let result = value.replace(/[\u0000-\u001f\u007f]/gu, '?');
  for (const [key, secret] of Object.entries(environment)) {
    if (/SECRET|PASSWORD|TOKEN/iu.test(key) && key !== 'SFUD_GIT_TOKEN_KEY_FILE' && secret !== undefined && secret.length > 0) result = result.split(secret).join('[REDACTED]');
  }
  return result;
}
