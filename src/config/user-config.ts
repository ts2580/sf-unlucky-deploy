import { constants as fsConstants } from 'node:fs';
import { open, lstat, mkdir, realpath, unlink, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { SfudError } from '../core/errors.js';
import { runWindowsPowerShell } from './windows-powershell.js';

const CONFIG_FILE = 'config.json';
const SECRETS_FILE = 'secrets.env';
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_SECRETS_BYTES = 16 * 1024;
const SECRETS_TEMPLATE = [
  '# Optional secrets. Uncomment only the settings you use and supply real values.',
  '# SFUD_TOKEN_SECRET encrypts saved Git and Salesforce connections.',
  '# SFUD_TOKEN_SECRET=',
  '# SFUD_SF_OAUTH_CLIENT_ID=',
  '# SFUD_SF_OAUTH_CLIENT_SECRET=',
  '',
].join('\n');
const CONFIG_KEYS = new Set([
  'LOCAL', 'SFUD_UI_PORT', 'SFUD_UI_HOST', 'SFUD_DATA_DIR', 'SFUD_PUBLIC_ORIGIN',
  'SFUD_TRUSTED_PROXIES', 'SFUD_GIT_ALLOWED_IPS', 'SFUD_GIT_TOKEN_KEY_FILE',
]);
const SECRET_KEYS = new Set([
  'SFUD_TOKEN_SECRET', 'SFUD_SF_TOKEN_SECRET', 'SFUD_GIT_TOKEN_SECRET', 'SFUD_SF_OAUTH_CLIENT_ID',
  'SFUD_SF_OAUTH_CLIENT_SECRET',
]);
const FORBIDDEN_KEYS = new Set(['NODE_OPTIONS', 'PATH', 'HOME', 'SFUD_CONFIG_DIR']);

const POWERSHELL_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('SFUD_ACL_PATH')
$mode = [Environment]::GetEnvironmentVariable('SFUD_ACL_MODE')
if ([string]::IsNullOrWhiteSpace($target)) { exit 20 }
[Console]::Out.WriteLine('SFUD_ACL_STAGE=identity')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$sidObject = [Security.Principal.SecurityIdentifier]::new($sid)
[Console]::Out.WriteLine('SFUD_ACL_STAGE=item')
$attributes = [IO.File]::GetAttributes($target)
if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 21 }
$isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
[Console]::Out.WriteLine('SFUD_ACL_STAGE=read-acl')
if ($isDirectory) { $acl = [IO.Directory]::GetAccessControl($target) }
else { $acl = [IO.File]::GetAccessControl($target) }
if ($mode -eq 'set') {
  [Console]::Out.WriteLine('SFUD_ACL_STAGE=protect')
  $acl.SetAccessRuleProtection($true, $false)
  [Console]::Out.WriteLine('SFUD_ACL_STAGE=replace-rules')
  foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $inherit = [Security.AccessControl.InheritanceFlags]::None
  $propagate = [Security.AccessControl.PropagationFlags]::None
  if ($isDirectory) {
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sidObject, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $propagate, [Security.AccessControl.AccessControlType]::Allow)
  $acl.SetAccessRule($rule)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($sid))
  [Console]::Out.WriteLine('SFUD_ACL_STAGE=write-acl')
  if ($isDirectory) {
    [IO.Directory]::SetAccessControl($target, $acl)
    $acl = [IO.Directory]::GetAccessControl($target)
  } else {
    [IO.File]::SetAccessControl($target, $acl)
    $acl = [IO.File]::GetAccessControl($target)
  }
}
[Console]::Out.WriteLine('SFUD_ACL_STAGE=verify-owner')
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { exit 22 }
if ($isDirectory -and -not $acl.AreAccessRulesProtected) { exit 23 }
[Console]::Out.WriteLine('SFUD_ACL_STAGE=verify-rules')
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1) { exit 24 }
$entry = $rules[0]
if ($entry.IdentityReference.Value -ne $sid -or $entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($entry.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) { exit 25 }
exit 0
`;

export interface HomeConfigPaths {
  directory: string;
  configFile: string;
  secretsFile: string;
}

export function getHomeConfigPaths(environment: NodeJS.ProcessEnv = process.env): HomeConfigPaths {
  const configuredDirectory = environment.SFUD_CONFIG_DIR;
  if (configuredDirectory !== undefined && !path.isAbsolute(configuredDirectory)) {
    throw configurationError('SFUD_CONFIG_DIR는 절대 경로여야 합니다.');
  }
  const directory = path.resolve(configuredDirectory ?? path.join(os.homedir(), '.sfud'));
  return {
    directory,
    configFile: path.join(directory, CONFIG_FILE),
    secretsFile: path.join(directory, SECRETS_FILE),
  };
}

export async function loadHomeConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await initializeHomeConfiguration(environment, 'automatic');
  const paths = getHomeConfigPaths(environment);
  let config: Buffer | undefined;
  let directoryIdentity: { dev: number; ino: number };
  try {
    await lstat(paths.directory);
  } catch (error) {
    if (isNotFound(error)) return;
    throw configurationError('홈 설정 파일 또는 디렉터리를 안전하게 확인할 수 없습니다.');
  }
  try {
    directoryIdentity = await assertSecureDirectory(paths.directory);
    config = await readSecureFile(paths.configFile, MAX_CONFIG_BYTES, true);
  } catch (error) {
    if (error instanceof SfudError) throw error;
    throw configurationError('홈 설정 파일 또는 디렉터리를 안전하게 확인할 수 없습니다.');
  }

  let fileEnvironment: Record<string, string> = {};
  if (config !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(config)) as unknown;
    } catch {
      throw configurationError('홈 설정 JSON 형식이 올바르지 않습니다.');
    }
    fileEnvironment = validateConfig(parsed);
  }

  let secretEnvironment: Record<string, string> = {};
  try {
    await createSecretsTemplateIfMissing(paths, directoryIdentity);
    const secretContents = await readSecureFile(paths.secretsFile, MAX_SECRETS_BYTES, true);
    if (secretContents !== undefined) secretEnvironment = parseSecrets(new TextDecoder('utf-8', { fatal: true }).decode(secretContents));
  } catch (error) {
    if (error instanceof SfudError) {
      throw error;
    } else {
      throw configurationError('비밀 설정 파일을 안전하게 확인할 수 없습니다.');
    }
  }
  await verifyDirectoryIdentity(paths.directory, directoryIdentity);

  for (const [key, value] of Object.entries(fileEnvironment)) {
    if (environment[key] === undefined) environment[key] = resolveFilePath(key, value, paths.directory);
  }
  for (const [key, value] of Object.entries(secretEnvironment)) {
    if (environment[key] === undefined) environment[key] = value;
  }
}

export async function initializeHomeConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  mode: 'personal' | 'automatic' = 'personal',
): Promise<HomeConfigPaths> {
  const paths = getHomeConfigPaths(environment);
  let createdDirectory = false;
  let createdDirectoryIdentity: { dev: number; ino: number } | undefined;
  let createdFile: { path: string; dev: number; ino: number } | undefined;
  try {
    try {
      await lstat(paths.directory);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await mkdir(paths.directory, { mode: 0o700 });
        createdDirectory = true;
      }
      catch (mkdirError) {
        if (mode !== 'automatic' || !isExists(mkdirError)) throw mkdirError;
      }
      // Another first-run process may have created this directory in the meantime.
      // Only change permissions on a directory this initializer actually created.
      if (createdDirectory) {
        const createdStat = await lstat(paths.directory);
        createdDirectoryIdentity = { dev: createdStat.dev, ino: createdStat.ino };
        await verifyWindowsAcl(paths.directory, 'set');
      }
    }
    const directoryIdentity = await assertSecureDirectory(paths.directory);
    if (mode === 'automatic') {
      try {
        await lstat(paths.configFile);
        return paths;
      } catch (error) { if (!isNotFound(error)) throw error; }
    }
    const initialEnvironment = mode === 'personal' ? { LOCAL: 'true', SFUD_DATA_DIR: 'data/local' } : {};
    const document = `${JSON.stringify({ version: 1, env: initialEnvironment }, null, 2)}\n`;
    const handle = await open(paths.configFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), 0o600);
    try {
      const stat = await handle.stat();
      await assertSecureStat(stat, false);
      createdFile = { path: paths.configFile, dev: stat.dev, ino: stat.ino };
      await handle.writeFile(document, 'utf8');
      await handle.sync();
      await verifySamePath(paths.configFile, stat);
      await verifyWindowsAcl(paths.configFile, 'set');
      await verifyDirectoryIdentity(paths.directory, directoryIdentity);
    } finally {
      await handle.close();
    }
    await createSecretsTemplateIfMissing(paths, directoryIdentity);
    return paths;
  } catch (error) {
    if (createdFile !== undefined) {
      try {
        const current = await lstat(createdFile.path);
        if (current.dev === createdFile.dev && current.ino === createdFile.ino) await unlink(createdFile.path);
      } catch { /* cleanup only the file this init created */ }
    }
    if (createdDirectory && createdDirectoryIdentity !== undefined) {
      try {
        const current = await lstat(paths.directory);
        if (current.dev === createdDirectoryIdentity.dev && current.ino === createdDirectoryIdentity.ino) await rmdir(paths.directory);
      } catch { /* leave non-empty or replaced directories alone */ }
    }
    if (isExists(error)) {
      if (mode === 'automatic') return paths;
      throw configurationError('설정 파일이 이미 있습니다. 기존 파일은 변경하지 않았습니다.');
    }
    if (error instanceof SfudError) throw error;
    throw configurationError('홈 설정을 안전하게 초기화하지 못했습니다.');
  }
}

async function createSecretsTemplateIfMissing(
  paths: HomeConfigPaths,
  directoryIdentity: { dev: number; ino: number },
): Promise<void> {
  let handle;
  try {
    handle = await open(paths.secretsFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), 0o600);
  } catch (error) {
    if (isExists(error)) return;
    throw configurationError('비밀 설정 파일을 안전하게 생성하지 못했습니다.');
  }
  let createdIdentity: { dev: number; ino: number } | undefined;
  try {
    const stat = await handle.stat();
    createdIdentity = { dev: stat.dev, ino: stat.ino };
    await assertSecureStat(stat, false);
    await handle.writeFile(SECRETS_TEMPLATE, 'utf8');
    await handle.sync();
    await verifySamePath(paths.secretsFile, stat);
    await verifyWindowsAcl(paths.secretsFile, 'set');
    await verifyDirectoryIdentity(paths.directory, directoryIdentity);
  } catch (error) {
    // Close before cleanup so Windows can remove the file we created.
    await handle.close();
    if (createdIdentity !== undefined) {
      try {
        const current = await lstat(paths.secretsFile);
        if (current.dev === createdIdentity.dev && current.ino === createdIdentity.ino) await unlink(paths.secretsFile);
      } catch { /* leave pre-existing or replaced files alone */ }
    }
    if (error instanceof SfudError) throw error;
    throw configurationError('비밀 설정 파일을 안전하게 생성하지 못했습니다.');
  } finally { await handle.close(); }
}

export function shouldLoadHomeConfiguration(commandName: string): boolean {
  return ['ui', 'compare', 'deploy'].includes(commandName);
}

async function assertSecureDirectory(directory: string): Promise<{ dev: number; ino: number }> {
  let stat;
  stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw configurationError('홈 설정 디렉터리 형식이 안전하지 않습니다.');
  if (process.platform !== 'win32') {
    const resolvedParent = await realpath(path.dirname(directory));
    const resolved = await realpath(directory);
    if (resolved !== path.join(resolvedParent, path.basename(directory))) throw configurationError('홈 설정 디렉터리가 링크를 가리킵니다.');
  }
  if (process.platform === 'win32') {
    await verifyWindowsAcl(directory, 'check');
  } else {
    await assertSecureStat(stat, true);
  }
  return { dev: stat.dev, ino: stat.ino };
}

async function readSecureFile(filePath: string, maxBytes: number, optional = false): Promise<Buffer | undefined> {
  let before;
  try { before = await lstat(filePath); }
  catch (error) {
    if (optional && isNotFound(error)) return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw configurationError('설정 파일 형식이 안전하지 않습니다.');
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const opened = await handle.stat();
    await assertSecureStat(opened, false);
    await verifyWindowsAcl(filePath, 'check');
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) throw configurationError('설정 파일이 읽는 중 교체되었습니다.');
    if (opened.size > maxBytes) throw configurationError('설정 파일 크기가 허용 한도를 넘었습니다.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) throw configurationError('설정 파일 크기가 허용 한도를 넘었습니다.');
    const content = buffer.subarray(0, bytesRead);
    const afterRead = await handle.stat();
    if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino || afterRead.nlink !== 1
      || afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs || afterRead.ctimeMs !== opened.ctimeMs) {
      throw configurationError('설정 파일이 읽는 중 변경되었습니다.');
    }
    if (content.length > maxBytes) throw configurationError('설정 파일 크기가 허용 한도를 넘었습니다.');
    await verifySamePath(filePath, opened);
    return content;
  } finally {
    await handle.close();
  }
}

async function assertSecureStat(stat: { uid?: number; mode: number }, directory: boolean): Promise<void> {
  if (process.platform === 'win32') return;
  if (stat.uid !== process.getuid?.()) throw configurationError('홈 설정의 소유자가 현재 사용자와 다릅니다.');
  const forbiddenBits = directory ? 0o077 : 0o077;
  if ((stat.mode & forbiddenBits) !== 0) throw configurationError('홈 설정 권한이 안전하지 않습니다. 권한을 직접 700/600으로 설정하세요.');
}

async function verifyDirectoryIdentity(directory: string, expected: { dev: number; ino: number }): Promise<void> {
  const current = await lstat(directory);
  if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw configurationError('홈 설정 디렉터리가 작업 중 교체되었습니다.');
  }
}

async function verifySamePath(filePath: string, opened: { dev: number; ino: number }): Promise<void> {
  const current = await lstat(filePath);
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || current.dev !== opened.dev || current.ino !== opened.ino) {
    throw configurationError('설정 파일이 읽는 중 교체되었습니다.');
  }
}

function validateConfig(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw configurationError('홈 설정 구조가 올바르지 않습니다.');
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some((key) => key !== 'version' && key !== 'env') || root.version !== 1
    || typeof root.env !== 'object' || root.env === null || Array.isArray(root.env)) {
    throw configurationError('홈 설정 버전 또는 구조가 올바르지 않습니다.');
  }
  const values = root.env as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, valueAtKey] of Object.entries(values)) {
    if (FORBIDDEN_KEYS.has(key) || SECRET_KEYS.has(key) || !CONFIG_KEYS.has(key)) {
      throw configurationError('허용되지 않은 설정 키가 있습니다.');
    }
    if (typeof valueAtKey !== 'string' || /[\u0000-\u001f\u007f]/u.test(valueAtKey)) throw configurationError('설정 값 형식이 올바르지 않습니다.');
    if (key === 'LOCAL' && valueAtKey !== 'true' && valueAtKey !== 'false') throw configurationError('LOCAL은 true 또는 false여야 합니다.');
    if (key === 'SFUD_UI_PORT' && (!/^\d{1,5}$/u.test(valueAtKey) || Number(valueAtKey) < 1 || Number(valueAtKey) > 65_535)) {
      throw configurationError('SFUD_UI_PORT 값이 올바르지 않습니다.');
    }
    if (['SFUD_DATA_DIR', 'SFUD_GIT_TOKEN_KEY_FILE'].includes(key) && valueAtKey.length === 0) throw configurationError(`${key} 경로가 비어 있습니다.`);
    result[key] = valueAtKey;
  }
  return result;
}

function parseSecrets(contents: string): Record<string, string> {
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=.*$/u.exec(trimmed);
    if (match === null) throw configurationError('비밀 설정 파일에 잘못된 줄이 있습니다.');
    const rawValue = trimmed.slice(trimmed.indexOf('=') + 1).trim();
    const openingQuote = rawValue[0];
    if ((openingQuote === '"' || openingQuote === "'" || openingQuote === '`')
      && (rawValue.length < 2 || rawValue.at(-1) !== openingQuote)) {
      throw configurationError('비밀 설정 파일에 닫히지 않은 따옴표가 있습니다.');
    }
    const key = match[1]!;
    if (FORBIDDEN_KEYS.has(key) || !SECRET_KEYS.has(key)) throw configurationError('허용되지 않은 비밀 설정 키가 있습니다.');
  }
  let parsed: Record<string, string>;
  try {
    const nodeParsed = parseEnv(contents);
    parsed = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(nodeParsed)) {
      if (value === undefined) throw configurationError('비밀 설정 파일 형식이 올바르지 않습니다.');
      parsed[key] = value;
    }
  }
  catch { throw configurationError('비밀 설정 파일 형식이 올바르지 않습니다.'); }
  for (const value of Object.values(parsed)) {
    if (/[\u0000-\u001f\u007f]/u.test(value)) throw configurationError('비밀 설정 값 형식이 올바르지 않습니다.');
  }
  return parsed;
}

function resolveFilePath(key: string, value: string, directory: string): string {
  if (key !== 'SFUD_DATA_DIR' && key !== 'SFUD_GIT_TOKEN_KEY_FILE') return value;
  return path.isAbsolute(value) ? value : path.resolve(directory, value);
}

async function verifyWindowsAcl(target: string, mode: 'check' | 'set'): Promise<void> {
  if (process.platform !== 'win32') return;
  await runWindowsPowerShell(POWERSHELL_ACL_SCRIPT, { SFUD_ACL_PATH: target, SFUD_ACL_MODE: mode });
}

function noFollowFlag(): number {
  return fsConstants.O_NOFOLLOW ?? 0;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function configurationError(message: string): SfudError {
  return new SfudError('CONFIGURATION_ERROR', message);
}
