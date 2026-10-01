import { AsyncLocalStorage } from 'node:async_hooks';
import { SfudError } from '../core/errors.js';

export interface SalesforceConnectionPin { id: string; generation: number }
interface SalesforceContext { userId?: string; connectionIds: Map<string, SalesforceConnectionPin> }
const userContext = new AsyncLocalStorage<SalesforceContext>();

export function beginSalesforceRequestContext(continueRequest: () => void): void {
  userContext.run({ connectionIds: new Map() }, continueRequest);
}

/** Fastify 요청에서 인증 직후 설정하며, 해당 요청의 백그라운드 작업에도 전파한다. */
export function enterSalesforceUserContext(userId: string): void {
  const context = userContext.getStore();
  if (context === undefined) userContext.enterWith({ userId, connectionIds: new Map() });
  else context.userId = userId;
}

export function currentSalesforceUserId(): string | undefined {
  return userContext.getStore()?.userId;
}

export function pinSalesforceConnection(alias: string, connectionId: string, generation: number): void {
  const context = userContext.getStore();
  if (context === undefined) throw new SfudError('APPROVAL_DENIED', 'Salesforce 사용자 컨텍스트가 없습니다.');
  const previous = context.connectionIds.get(alias);
  if (previous !== undefined && (previous.id !== connectionId || previous.generation !== generation)) {
    throw new SfudError('ORG_IDENTITY_CHANGED', '실행 중 Salesforce 연결이 교체되었습니다. 작업을 다시 시작하세요.');
  }
  context.connectionIds.set(alias, { id: connectionId, generation });
}

export function currentSalesforceConnectionPin(alias: string): SalesforceConnectionPin | undefined {
  const pin = userContext.getStore()?.connectionIds.get(alias);
  return pin === undefined ? undefined : { ...pin };
}

export function runAsSalesforceUser<T>(userId: string, action: () => Promise<T>): Promise<T> {
  return userContext.run({ userId, connectionIds: new Map() }, action);
}
