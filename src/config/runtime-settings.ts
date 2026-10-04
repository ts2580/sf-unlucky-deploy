import { isIP } from 'node:net';
import path from 'node:path';
import { SfudError } from '../core/errors.js';

export interface RuntimeSettings {
  localMode: boolean;
  host: string;
  port: number;
  dataDirectory: string;
  trustedProxies: string[];
  publicOrigin?: string;
  accessPassword?: string;
}
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function resolveRuntimeSettings(environment: NodeJS.ProcessEnv, cwd = process.cwd()): RuntimeSettings {
  const local = environment.LOCAL ?? 'false';
  if (local !== 'true' && local !== 'false') throw invalid('LOCAL은 true 또는 false여야 합니다.');
  const host = environment.SFUD_UI_HOST ?? '127.0.0.1';
  if (host.length > 253 || (!isIP(host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/u.test(host))) throw invalid('수신 주소는 IP 또는 호스트 이름이어야 합니다.');
  const portValue = environment.SFUD_UI_PORT ?? '27546';
  if (!/^\d{1,5}$/u.test(portValue) || Number(portValue) < 1 || Number(portValue) > 65535) throw invalid('수신 포트는 1부터 65535 사이여야 합니다.');
  const trustedProxies = (environment.SFUD_TRUSTED_PROXIES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  for (const proxy of trustedProxies) {
    const [address, prefix, extra] = proxy.split('/');
    const family = isIP(address ?? '');
    if (family === 0 || extra !== undefined || (prefix !== undefined && (!/^\d{1,3}$/u.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))) throw invalid('신뢰 프록시는 IP 또는 CIDR이어야 합니다.');
  }
  let publicOrigin: string | undefined;
  if (environment.SFUD_PUBLIC_ORIGIN !== undefined) {
    try {
      const url = new URL(environment.SFUD_PUBLIC_ORIGIN);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      publicOrigin = url.origin;
    } catch { throw invalid('공개 URL은 경로와 인증정보가 없는 http(s) origin이어야 합니다.'); }
  }
  if (trustedProxies.length > 0 && publicOrigin === undefined) throw invalid('신뢰 프록시를 사용하면 공개 Origin도 설정하세요.');
  const accessPassword = environment.SFUD_ACCESS_PASSWORD;
  if (accessPassword !== undefined && (local !== 'true' || accessPassword.trim().length < 12 || accessPassword.length > 128 || /[\u0000-\u001f\u007f]/u.test(accessPassword))) throw invalid('접속 비밀번호는 LOCAL=true에서 12자 이상 128자 이하로 설정하세요.');
  if (local === 'true' && accessPassword === undefined && (!LOOPBACK_HOSTS.has(host) || trustedProxies.length > 0 || publicOrigin !== undefined)) throw invalid('원격 개인용·프록시·공개 Origin에는 접속 비밀번호가 필요합니다.');
  if (environment.SFUD_DATA_DIR !== undefined && environment.SFUD_DATA_DIR.length === 0) throw invalid('데이터 경로가 비어 있습니다.');
  return { localMode: local === 'true', host, port: Number(portValue),
    dataDirectory: path.resolve(cwd, environment.SFUD_DATA_DIR ?? (local === 'true' ? '.sfud-local' : '.sfud')),
    trustedProxies, ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(accessPassword === undefined ? {} : { accessPassword }) };
}

export function configurationUrl(settings: RuntimeSettings): string | undefined {
  if (settings.publicOrigin !== undefined) return settings.publicOrigin;
  if (settings.host === '0.0.0.0' || settings.host === '::') return undefined;
  return `http://${isIP(settings.host) === 6 ? `[${settings.host}]` : settings.host}:${settings.port}`;
}

function invalid(message: string): SfudError { return new SfudError('CONFIGURATION_ERROR', message); }
