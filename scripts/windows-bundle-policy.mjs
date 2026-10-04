export const WINDOWS_BUNDLE = Object.freeze({
  name: '@trstyq/sf-unlucky-deploy',
  version: '0.4.0-rc.4.win32-x64.1',
  baseVersion: '0.4.0-rc.4',
  sourceCommit: '602b58e87bdf43156d498012008640864d6a0713',
  sourceSha256: '275a1cd6e58bc26100df0673cdabe89f16328fc1a28148738add821d2dbdc370',
  sqliteVersion: '6.0.1',
  sqliteUrl: 'https://github.com/TryGhost/node-sqlite3/releases/download/v6.0.1/sqlite3-v6.0.1-napi-v6-win32-x64.tar.gz',
  sqliteSha256: 'e0bbbb6e43b45378e6d6e2c5cc096e61e4c8932dbc2d2c9c08b8e3aaa80c9adf',
});

export function assertWindowsBundleArchive(entries) {
  for (const entry of entries) {
    const parts = entry.split('/');
    if (parts[0] !== 'package' || entry.includes('\\') || parts.some((p) => p === '..' || p === '.' || /^[A-Za-z]:/u.test(p))) {
      throw new Error(`Windows 패키지 경로 오류: ${entry}`);
    }
    if (parts.some((p) => /^(?:\.git|\.npmrc|\.env|\.sf|\.sfdx|\.sfud|\.sfud-local|secrets\.env)$/iu.test(p))) {
      throw new Error(`Windows 패키지의 비공개 파일: ${entry}`);
    }
    if (entry.endsWith('.node') && entry !== 'package/node_modules/sqlite3/build/Release/node_sqlite3.node') {
      throw new Error(`예상하지 않은 native binary: ${entry}`);
    }
  }
  if (!entries.includes('package/node_modules/sqlite3/build/Release/node_sqlite3.node')) {
    throw new Error('Windows SQLite native binding 누락');
  }
  if (!entries.includes('package/node_modules/sqlite3/LICENSE')) throw new Error('SQLite 라이선스 고지 누락');
}

export function assertWindowsX64Binary(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Windows PE binary가 아닙니다.');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset + 6 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0'
    || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('Windows x64 PE binary가 아닙니다.');
}
