import path from 'node:path';
import { parse } from '@babel/parser';

const allowed = {
  app: ['auth', 'compare', 'config', 'contracts', 'core', 'deploy', 'git', 'jobs', 'metadata', 'reports', 'salesforce', 'settings', 'sources', 'source-contracts', 'storage'],
  auth: ['storage'],
  compare: ['core', 'jobs', 'metadata', 'reports', 'salesforce', 'settings', 'source-contracts', 'sources', 'storage', 'contracts'],
  config: ['core', 'salesforce'],
  contracts: [],
  core: [],
  deploy: ['auth', 'contracts', 'core', 'jobs', 'metadata', 'reports', 'salesforce', 'settings', 'source-contracts', 'sources', 'storage'],
  git: ['contracts', 'core', 'source-contracts', 'sources', 'storage'],
  jobs: ['auth', 'core', 'storage'],
  metadata: ['contracts', 'core', 'salesforce', 'source-contracts'],
  reports: ['contracts', 'core', 'metadata'],
  salesforce: ['core', 'storage'],
  settings: ['storage'],
  'source-contracts': ['contracts', 'salesforce'],
  sources: ['contracts', 'core', 'metadata', 'salesforce', 'source-contracts', 'storage'],
  storage: ['core'],
  'ui-app': ['ui-auth', 'ui-admin', 'ui-comparison', 'ui-deployment', 'ui-git', 'ui-shared', 'contracts'],
  'ui-auth': ['ui-shared', 'contracts'],
  'ui-admin': ['ui-auth', 'ui-shared', 'contracts'],
  'ui-comparison': ['ui-shared', 'contracts'],
  'ui-deployment': ['ui-auth', 'ui-comparison', 'ui-shared', 'contracts'],
  'ui-git': ['ui-auth', 'ui-shared', 'contracts'],
  'ui-shared': ['contracts'],
};

export function moduleOf(file) {
  if (['src/sources/model.ts', 'src/sources/ports.ts'].includes(file)) return 'source-contracts';
  if (file.startsWith('src/web/') || ['src/cli.ts', 'src/program.ts'].includes(file)) return 'app';
  if (file.startsWith('ui/src/')) {
    const directory = file.split('/')[2];
    if (['App.tsx', 'main.tsx', 'workflows'].includes(directory)) return 'ui-app';
    if (['auth', 'admin', 'comparison', 'deployment', 'git'].includes(directory)) return `ui-${directory}`;
    return 'ui-shared';
  }
  return file.startsWith('src/') ? file.split('/')[1] : undefined;
}

function imports(source, file) {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', ...(file.endsWith('.tsx') ? ['jsx'] : [])] });
  const references = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) references.push(node.source.value);
    if (node.type === 'TSImportType') references.push(node.argument.value);
    if (node.type === 'ImportExpression') references.push(node.source.type === 'StringLiteral' ? node.source.value : undefined);
    if (node.type === 'CallExpression' && (node.callee.type === 'Import' || (node.callee.type === 'Identifier' && node.callee.name === 'require'))) {
      references.push(node.arguments[0]?.type === 'StringLiteral' ? node.arguments[0].value : undefined);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item?.type) visit(item);
      } else if (value?.type) visit(value);
    }
  }
  visit(ast);
  return references;
}

function resolve(file, specifier, files) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  const candidates = base.endsWith('.js') ? [base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx']
    : [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  return candidates.find((candidate) => files.has(candidate));
}

function isPublicEntry(target, owner, consumer) {
  if (['contracts', 'core', 'storage', 'source-contracts', 'ui-shared'].includes(owner)) return true;
  if (target.endsWith('/public.ts')) return true;
  if (owner.startsWith('ui-') && target.endsWith('/api.ts')) return true;
  return consumer === 'app' && target.endsWith('/composition.ts');
}

export function checkBoundaries(files) {
  const diagnostics = [];
  const edges = new Map();
  for (const [file, source] of files) {
    if (/\.test\.tsx?$/u.test(file)) continue;
    const from = moduleOf(file);
    if (!Object.hasOwn(allowed, from)) { diagnostics.push(`${file}: unclassified module`); continue; }
    for (const specifier of imports(source, file)) {
      if (specifier === undefined) { diagnostics.push(`${file}: nonliteral module import`); continue; }
      if (!specifier.startsWith('.')) {
        if ((from === 'contracts' || from.startsWith('ui-')) && specifier.startsWith('node:')) diagnostics.push(`${file}: server dependency ${specifier}`);
        continue;
      }
      if (/\.(?:css|json|svg|png)$/u.test(specifier)) continue;
      const target = resolve(file, specifier, files);
      if (target === undefined) { diagnostics.push(`${file}: unresolved import ${specifier}`); continue; }
      const to = moduleOf(target);
      if (from === to) continue;
      if (!allowed[from].includes(to)) diagnostics.push(`${file}: forbidden dependency ${from} -> ${to} (${target})`);
      if (!isPublicEntry(target, to, from)) diagnostics.push(`${file}: internal module import ${target}`);
      if (!edges.has(from)) edges.set(from, new Set());
      edges.get(from).add(to);
    }
  }
  const completed = new Set();
  const active = [];
  function visit(module) {
    if (active.includes(module)) { diagnostics.push(`module cycle: ${[...active.slice(active.indexOf(module)), module].join(' -> ')}`); return; }
    if (completed.has(module)) return;
    active.push(module);
    for (const target of edges.get(module) ?? []) visit(target);
    active.pop();
    completed.add(module);
  }
  for (const module of edges.keys()) visit(module);
  return diagnostics;
}
