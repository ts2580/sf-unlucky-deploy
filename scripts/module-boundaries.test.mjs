import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBoundaries } from './module-boundaries.mjs';

const check = (entries) => checkBoundaries(new Map(Object.entries(entries)));

test('public APIs and application-only construction entries are accepted', () => {
  assert.deepEqual(check({
    'src/app/runtime.ts': "import { AuthService } from '../auth/composition.js';",
    'src/auth/composition.ts': "export { AuthService } from './auth-service.js';",
    'src/auth/auth-service.ts': 'export class AuthService {}',
    'src/deploy/service.ts': "import type { WorkspacePort } from '../sources/ports.js';",
    'src/sources/ports.ts': 'export interface WorkspacePort {}',
  }), []);
});

test('direct internal and composition imports from business modules are rejected', () => {
  const result = check({
    'src/deploy/service.ts': "import { secret } from '../auth/password.js'; import type { AuthService } from '../auth/composition.js';",
    'src/auth/password.ts': 'export const secret = 1;',
    'src/auth/composition.ts': 'export interface AuthService {}',
  });
  assert.equal(result.filter((line) => line.includes('internal module import')).length, 2);
});

test('type queries, dynamic imports, and re-exports cannot bypass boundaries', () => {
  for (const source of [
    "type T = import('../git/private.js').T;",
    "const value = import('../git/private.js');",
    "export * from '../git/private.js';",
    "const value = require('../git/private.js');",
  ]) {
    assert.ok(check({ 'src/deploy/service.ts': source, 'src/git/private.ts': 'export type T = string;' })
      .some((line) => line.includes('forbidden dependency')));
  }
});

test('module cycles, including type-only edges, are reported', () => {
  assert.ok(check({
    'src/git/public.ts': "import type { T } from '../sources/public.js'; export type U = string;",
    'src/sources/public.ts': "import type { U } from '../git/public.js'; export type T = string;",
  }).some((line) => line.includes('module cycle:')));
});

test('unclassified modules, unresolved paths and nonliteral imports fail closed', () => {
  assert.ok(check({ 'src/mystery/file.ts': '' }).some((line) => line.includes('unclassified')));
  assert.ok(check({ 'src/deploy/file.ts': "import './missing.js';" }).some((line) => line.includes('unresolved')));
  assert.ok(check({ 'src/deploy/file.ts': 'const file = import(variable);' }).some((line) => line.includes('nonliteral')));
});

test('browser modules can use shared contracts but cannot import server implementations', () => {
  assert.deepEqual(check({
    'ui/src/git/api.ts': "import type { Input } from '../../../src/contracts/git.ts';",
    'src/contracts/git.ts': 'export type Input = string;',
  }), []);
  assert.ok(check({
    'ui/src/git/api.ts': "import { service } from '../../../src/git/public.ts';",
    'src/git/public.ts': 'export const service = 1;',
  }).some((line) => line.includes('forbidden dependency')));
  assert.ok(check({ 'src/contracts/git.ts': "import fs from 'node:fs';" }).some((line) => line.includes('server dependency')));
});
