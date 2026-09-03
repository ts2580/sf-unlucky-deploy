import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compareSnapshots, MAX_DIFF_INPUT_BYTES } from '../src/metadata/comparator.js';
import type { SourceSpec } from '../src/sources/source-spec.js';
import type { MetadataSnapshot } from '../src/sources/snapshot.js';
import { removeDirectoriesAfterTest, writeFixtureFiles } from './support/files.js';

describe('metadata comparator', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => removeDirectoriesAfterTest(temporaryDirectories));

  it('추가·삭제·텍스트·XML·바이너리 변경을 컴포넌트 단위로 비교한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-comparator-'));
    temporaryDirectories.push(root);
    const leftRoot = path.join(root, 'left');
    const rightRoot = path.join(root, 'right');
    await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);

    await writeFixtureFiles(leftRoot, {
      'package.xml': '<Package/>',
      'classes/Hello.cls': "public class Hello { String value = 'left'; }\n",
      'classes/Hello.cls-meta.xml': '<?xml version="1.0"?><ApexClass><status>Active</status></ApexClass>',
      'classes/LeftOnly.cls': 'public class LeftOnly {}\n',
      'objects/Order__c.object':
        '<?xml version="1.0"?><CustomObject><fields><fullName>Status__c</fullName><label>주문 상태</label></fields></CustomObject>',
      'staticresources/logo.resource': Buffer.from([0, 1, 2]),
    });
    await writeFixtureFiles(rightRoot, {
      'package.xml': '<Package/>',
      'classes/Hello.cls': "public class Hello { String value = 'right'; }\n",
      'classes/Hello.cls-meta.xml': '<?xml version="1.0"?><ApexClass><status>Active</status></ApexClass>',
      'classes/RightOnly.cls': 'public class RightOnly {}\n',
      'objects/Order__c.object':
        '<?xml version="1.0"?><CustomObject><fields><fullName>Status__c</fullName><label>처리 상태</label></fields></CustomObject>',
      'staticresources/logo.resource': Buffer.from([0, 1, 3]),
    });

    const result = await compareSnapshots(snapshot(leftRoot, 'left'), snapshot(rightRoot, 'right'));

    expect(result.summary).toEqual({
      added: 1,
      removed: 1,
      modified: 3,
      identical: 0,
      total: 5,
      different: 5,
    });
    expect(result.components.find((component) => component.key === 'ApexClass:RightOnly')?.status).toBe('ADDED');
    expect(result.components.find((component) => component.key === 'ApexClass:LeftOnly')?.status).toBe('REMOVED');
    expect(
      result.components
        .find((component) => component.key === 'CustomObject:Order__c')
        ?.files[0]?.xmlChanges,
    ).toContainEqual({
      kind: 'MODIFIED',
      path: 'CustomObject.fields[fullName=Status__c].label',
      before: '주문 상태',
      after: '처리 상태',
    });
    expect(
      result.components.find((component) => component.key === 'StaticResource:logo')?.files[0]?.kind,
    ).toBe('binary');
  });

  it('XML 형식 차이는 기본 모드에서 무시하고 strict 모드에서 표시한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-strict-'));
    temporaryDirectories.push(root);
    const leftRoot = path.join(root, 'left');
    const rightRoot = path.join(root, 'right');
    await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
    await writeFixtureFiles(leftRoot, {
      'package.xml': '<Package/>',
      'profiles/Admin.profile': '<?xml version="1.0"?><Profile alpha="1" beta="2"><enabled>true</enabled></Profile>',
    });
    await writeFixtureFiles(rightRoot, {
      'package.xml': '<Package/>',
      'profiles/Admin.profile': '<?xml version="1.0"?>\n<Profile beta="2" alpha="1">\n  <enabled>true</enabled>\n</Profile>\n',
    });

    const defaultResult = await compareSnapshots(snapshot(leftRoot, 'left'), snapshot(rightRoot, 'right'));
    const strictResult = await compareSnapshots(snapshot(leftRoot, 'left'), snapshot(rightRoot, 'right'), {
      strict: true,
    });

    expect(defaultResult.summary.identical).toBe(1);
    expect(strictResult.summary.modified).toBe(1);
    expect(strictResult.components[0]?.files[0]?.unifiedDiff).toContain('Profile beta');
  });

  it('제한 병렬 비교에서도 컴포넌트 순서와 동일 XML 결과를 결정적으로 유지한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-concurrent-comparator-'));
    temporaryDirectories.push(root);
    const leftRoot = path.join(root, 'left');
    const rightRoot = path.join(root, 'right');
    await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);

    const files = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => {
        const name = `Class${String(19 - index).padStart(2, '0')}`;
        return [
          [`classes/${name}.cls`, `public class ${name} {}\n`],
          [
            `classes/${name}.cls-meta.xml`,
            '<?xml version="1.0"?><ApexClass><status>Active</status></ApexClass>',
          ],
        ];
      }).flat(),
    );
    await Promise.all([
      writeFixtureFiles(leftRoot, { 'package.xml': '<Package/>', ...files }),
      writeFixtureFiles(rightRoot, { 'package.xml': '<Package/>', ...files }),
    ]);

    const result = await compareSnapshots(snapshot(leftRoot, 'left'), snapshot(rightRoot, 'right'));

    expect(result.summary).toEqual({
      added: 0,
      removed: 0,
      modified: 0,
      identical: 20,
      total: 20,
      different: 0,
    });
    expect(result.components.map((component) => component.key)).toEqual(
      Array.from({ length: 20 }, (_, index) => `ApexClass:Class${String(index).padStart(2, '0')}`),
    );
    expect(
      result.components.flatMap((component) => component.files).filter((file) => file.kind === 'xml'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'IDENTICAL', xmlChanges: [] }),
      ]),
    );
  });

  it('대형 텍스트 파일은 전체 diff를 만들지 않고 checksum과 생략 경고를 남긴다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-large-diff-'));
    temporaryDirectories.push(root);
    const leftRoot = path.join(root, 'left');
    const rightRoot = path.join(root, 'right');
    await Promise.all([mkdir(leftRoot), mkdir(rightRoot)]);
    const metadata = '<?xml version="1.0"?><ApexClass><status>Active</status></ApexClass>';
    await Promise.all([
      writeFixtureFiles(leftRoot, {
        'package.xml': '<Package/>',
        'classes/Large.cls': `// left\n${'a'.repeat(MAX_DIFF_INPUT_BYTES)}`,
        'classes/Large.cls-meta.xml': metadata,
      }),
      writeFixtureFiles(rightRoot, {
        'package.xml': '<Package/>',
        'classes/Large.cls': `// right\n${'b'.repeat(MAX_DIFF_INPUT_BYTES)}`,
        'classes/Large.cls-meta.xml': metadata,
      }),
    ]);

    const result = await compareSnapshots(snapshot(leftRoot, 'left'), snapshot(rightRoot, 'right'));
    const file = result.components[0]?.files.find((entry) => entry.path.endsWith('Large.cls'));

    expect(file).toMatchObject({ status: 'MODIFIED', kind: 'text', diffTruncated: true });
    expect(file?.unifiedDiff).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.stringContaining('상세 diff 일부를 생략'));
  });
});

function snapshot(packageRoot: string, name: string): MetadataSnapshot {
  const source: SourceSpec = { kind: 'local', projectPath: packageRoot, displayName: `local:${name}` };
  return {
    source,
    packageRoot,
    manifestPath: path.join(packageRoot, 'package.xml'),
    manifestSha256: 'same-manifest',
    payloadSha256: `payload-${name}`,
    createdAt: new Date(0).toISOString(),
  };
}
