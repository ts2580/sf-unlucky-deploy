import path from 'node:path';

const forbiddenDirectory = /^(?:\.git|\.sfud(?:-local)?|\.sf|\.sfdx|node_modules|coverage|test|tests|fixtures?|working)$/iu;
const forbiddenFile = /^(?:\.env(?:\..*)?|secrets\.env|config\.json|.*\.(?:db|sqlite|sqlite3|key|pem|zip)|.*\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal))$/iu;

export function assertSafeArchive(entries) {
  const unsafe = entries.filter((entry) => {
    if (entry.includes('\\') || path.posix.isAbsolute(entry) || /^[A-Za-z]:/u.test(entry)) return true;
    const parts = entry.split('/');
    if (parts[0] !== 'package' || parts.some((part) => part === '..' || part === '.')) return true;
    return parts.slice(1).some((part, index, rest) => {
      const isDirectory = index < rest.length - 1 || entry.endsWith('/');
      return isDirectory ? forbiddenDirectory.test(part) : forbiddenFile.test(part);
    });
  });
  if (unsafe.length > 0) throw new Error(`tarball에 허용되지 않는 경로가 있습니다: ${unsafe.slice(0, 10).join(', ')}`);
}

export function verifyUiAssetPaths(html, entries) {
  const assets = [...html.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/gu)].map((match) => match[1]);
  if (assets.length < 2) throw new Error('배포된 UI HTML에서 JS/CSS 자산 링크를 찾지 못했습니다.');
  for (const asset of assets) {
    const assetPath = path.posix.normalize(path.posix.join('package/dist/ui', asset.replace(/^\//u, '').replace(/^\.\//u, '')));
    if (!assetPath.startsWith('package/dist/ui/') || !entries.includes(assetPath)) {
      throw new Error(`UI 자산 참조가 tarball에 없습니다: ${assetPath}`);
    }
  }
  return assets;
}

export function assertPackedMetadataMatches(packed, source) {
  for (const field of ['name', 'version', 'private', 'license', 'publishConfig', 'engines', 'repository']) {
    if (JSON.stringify(packed[field]) !== JSON.stringify(source[field])) {
      throw new Error(`tarball package.json의 ${field}가 현재 package.json과 다릅니다.`);
    }
  }
}
