import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compareSnapshots } from '../src/metadata/comparator.js';
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
