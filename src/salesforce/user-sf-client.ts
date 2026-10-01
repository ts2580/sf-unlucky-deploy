import { chmod, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SfudError } from '../core/errors.js';
import { isOrgIdentifier, normalizeSalesforceOrgId } from './org-identifier.js';
import { isDefiniteSalesforceAuthFailure, ProcessSfClient, type SfClient, type SfRunOptions } from './sf-client.js';
import { currentSalesforceUserId, pinSalesforceConnection } from './user-context.js';
import { SalesforceConnectionRepository, type SalesforceConnection } from '../storage/salesforce-connection-repository.js';

/** 사용자별 암호화 URL만 임시 CLI 상태로 복원하고 명령 종료 후 지운다. */
export class UserSfClient implements SfClient {
  public constructor(
    private readonly connections: SalesforceConnectionRepository,
    private readonly processClient: SfClient = new ProcessSfClient(),
  ) {}

  public async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    const ownerUserId = currentSalesforceUserId();
    if (ownerUserId === undefined) throw new SfudError('APPROVAL_DENIED', 'Salesforce 작업 사용자 컨텍스트가 없습니다.');
    const listAll = args[0] === 'org' && args[1] === 'list' && args.length <= 3;
    const alias = optionValue(args, '--target-org') ?? optionValue(args, '--from-org');
    const allConnections = listAll ? await this.connections.list(ownerUserId) : [];
    const selected = alias === undefined ? [] : [await this.connections.getByAlias(ownerUserId, alias)];
    if (alias !== undefined && selected[0] === undefined) {
      throw new SfudError('APPROVAL_DENIED', '본인 소유 Salesforce 연결을 찾을 수 없습니다.');
    }
    const required = listAll ? allConnections.filter((connection) => connection.status === 'CONNECTED')
      : selected as SalesforceConnection[];
    if (listAll && required.length === 0) return { status: 0, result: { nonScratchOrgs: [], scratchOrgs: [], devHubs: [] } };
    if (required.length > 0 && !this.connections.ready) {
      throw new SfudError('STORAGE_ERROR', 'Salesforce 인증 암호화 키가 없습니다.');
    }
    for (const connection of required) pinSalesforceConnection(connection.alias, connection.id, connection.generation);
    return withIsolatedSalesforceHome(async (environment) => {
      const imported: SalesforceConnection[] = [];
      for (const connection of required) {
        try {
          await importConnection(this.processClient, this.connections, ownerUserId, connection, environment, options.cwd);
          imported.push(connection);
        } catch (error) {
          if (error instanceof SfudError && (error.code === 'STORAGE_ERROR' || error.code === 'ORG_IDENTITY_CHANGED')) throw error;
          const current = await this.connections.getByAlias(ownerUserId, connection.alias);
          if (current === undefined || current.id !== connection.id || current.generation !== connection.generation) {
            throw new SfudError('ORG_IDENTITY_CHANGED', '실행 중 Salesforce 연결이 교체되었습니다. 작업을 다시 시작하세요.');
          }
          if (isDefiniteSalesforceAuthFailure(error)) {
            await this.connections.markReauthRequired(ownerUserId, connection.id, connection.generation);
          }
          if (!listAll) throw error;
        }
      }
      if (listAll && imported.length === 0) return { status: 0, result: { nonScratchOrgs: [], scratchOrgs: [], devHubs: [] } };
      // Catch replacement after auth restoration and immediately before the CLI
      // command starts; runJson then uses only this isolated HOME's auth state.
      for (const connection of required) {
        const current = await this.connections.getByAlias(ownerUserId, connection.alias);
        if (current === undefined || current.id !== connection.id || current.generation !== connection.generation) {
          throw new SfudError('ORG_IDENTITY_CHANGED', '실행 중 Salesforce 연결이 교체되었습니다. 작업을 다시 시작하세요.');
        }
      }
      let result: unknown;
      try { result = await this.processClient.runJson(args, { ...options, environment }); }
      catch (error) {
        if (!listAll && selected[0] !== undefined && isDefiniteSalesforceAuthFailure(error)) {
          await this.connections.markReauthRequired(ownerUserId, selected[0].id, selected[0].generation);
        }
        throw error;
      }
      for (const connection of imported) {
        try {
          const exported = await this.processClient.runJson([
            'org', 'auth', 'show-sfdx-auth-url', '--target-org', connection.alias,
          ], { cwd: options.cwd, environment, timeoutMs: 30_000 });
          const authUrl = extractAuthUrl(exported);
          if (authUrl !== undefined) await this.connections.rotateAuthUrl(ownerUserId, connection.id, connection.generation, authUrl);
        } catch {
          // 정상 명령 결과는 보존한다. 다음 인증 실패 시 이 연결만 재인증 상태로 전환한다.
        }
      }
      return result;
    });
  }

  public async validateAuthUrl(alias: string, authUrl: string, cwd: string): Promise<{
    orgId: string; username: string; instanceUrl: string; authUrl: string;
  }> {
    if (!isOrgIdentifier(alias) || alias.length > 120) throw new SfudError('INVALID_ARGUMENT', 'Salesforce 연결 별칭이 올바르지 않습니다.');
    assertSfdxAuthUrl(authUrl);
    return withIsolatedSalesforceHome(async (environment) => {
      await this.processClient.runJson(['org', 'login', 'sfdx-url', '--sfdx-url-stdin', '--alias', alias],
        { cwd, environment, stdin: `${authUrl}\n`, timeoutMs: 60_000 });
      const response = await this.processClient.runJson(['org', 'display', '--target-org', alias],
        { cwd, environment, timeoutMs: 60_000 });
      const result = record(record(response).result);
      const rawOrgId = string(result.id) ?? string(result.orgId);
      const username = string(result.username);
      const instanceUrl = string(result.instanceUrl);
      if (rawOrgId === undefined || username === undefined || instanceUrl === undefined) {
        throw new SfudError('SF_RESPONSE_INVALID', 'Salesforce 연결의 Org ID, 사용자명 또는 인스턴스 URL을 확인할 수 없습니다.');
      }
      assertSalesforceInstanceUrl(instanceUrl);
      const exported = await this.processClient.runJson(['org', 'auth', 'show-sfdx-auth-url', '--target-org', alias],
        { cwd, environment, timeoutMs: 30_000 });
      const refreshedUrl = extractAuthUrl(exported);
      if (refreshedUrl === undefined) throw new SfudError('SF_RESPONSE_INVALID', 'Salesforce 인증 URL을 갱신할 수 없습니다.');
      return { orgId: normalizeSalesforceOrgId(rawOrgId), username, instanceUrl, authUrl: refreshedUrl };
    });
  }
}

async function importConnection(
  client: SfClient,
  repository: SalesforceConnectionRepository,
  ownerUserId: string,
  connection: SalesforceConnection,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  const authUrl = await repository.authUrl(ownerUserId, connection.id, connection.generation);
  await client.runJson(['org', 'login', 'sfdx-url', '--sfdx-url-stdin', '--alias', connection.alias],
    { cwd, environment, stdin: `${authUrl}\n`, timeoutMs: 60_000 });
}

function assertSfdxAuthUrl(value: string): void {
  if (value.length < 40 || value.length > 16_384 || /[\s\u0000-\u001f]/u.test(value) || !value.startsWith('force://')) {
    throw new SfudError('INVALID_ARGUMENT', 'SFDX 인증 URL 형식이 올바르지 않습니다.');
  }
  const separator = value.lastIndexOf('@');
  const parts = separator < 0 ? [] : value.slice(8, separator).split(':');
  // Salesforce CLI's default PlatformCLI Connected App exports an empty client secret.
  if (parts.length !== 3 || parts[0]?.length === 0 || parts[2]?.length === 0) {
    throw new SfudError('INVALID_ARGUMENT', 'SFDX 인증 URL 형식이 올바르지 않습니다.');
  }
  assertSalesforceHostname(value.slice(separator + 1));
}

function assertSalesforceInstanceUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new SfudError('INVALID_ARGUMENT', 'Salesforce 인스턴스 URL이 올바르지 않습니다.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new SfudError('INVALID_ARGUMENT', 'Salesforce 인스턴스 URL이 올바르지 않습니다.');
  }
  assertSalesforceHostname(url.hostname);
}

function assertSalesforceHostname(host: string): void {
  if (!/^(?:[a-z0-9-]+\.)+(?:salesforce\.com|force\.com)$/iu.test(host)) {
    throw new SfudError('INVALID_ARGUMENT', 'Salesforce 공식 도메인의 인증 URL만 등록할 수 있습니다.');
  }
}

async function withIsolatedSalesforceHome<T>(action: (environment: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sfud-salesforce-'));
  try {
    await chmod(home, 0o700);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:SF_|SFDX_|SFUD_|HOME$|USERPROFILE$|HOMEPATH$|HOMEDRIVE$|XDG_|APPDATA$|LOCALAPPDATA$|TMP$|TEMP$)/iu.test(key)));
    return await action({ ...environment, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
      APPDATA: home, LOCALAPPDATA: home, TMP: home, TEMP: home });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function extractAuthUrl(response: unknown): string | undefined {
  const result = record(record(response).result);
  const value = string(result.sfdxAuthUrl);
  if (value === undefined) return undefined;
  assertSfdxAuthUrl(value);
  return value;
}
