import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateDeployableManifest } from '../src/metadata/deployable-manifest.js';
import { resolveMetadataComponents } from '../src/metadata/component-resolver.js';
import type { SfClient, SfRunOptions } from '../src/salesforce/sf-client.js';
import { parseSourceSpec } from '../src/sources/source-spec.js';

const temporaryDirectories: string[] = [];

describe('전체 배포 가능 메타데이터 manifest', () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  it('sf CLI로 양쪽 소스를 조회하고 컴포넌트 합집합을 생성한다', async () => {
    const root = await createProject();
    const localProject = path.join(root, 'local-project');
    await mkdir(path.join(localProject, 'force-app'), { recursive: true });
    await writeFile(path.join(localProject, 'sfdx-project.json'), JSON.stringify({
      packageDirectories: [{ path: 'force-app' }],
      sourceApiVersion: '66.0',
    }));
    const sfClient = new ManifestSfClient();

    const generated = await generateDeployableManifest({
      sources: [
        parseSourceSpec('org:stdOrg', root),
        parseSourceSpec(`local:${localProject}`, root),
      ],
      outputDirectory: path.join(root, 'generated'),
      commandProjectPath: root,
      sfClient,
    });

    expect(sfClient.calls).toContainEqual(
      expect.arrayContaining(['--from-org', 'stdOrg', '--api-version', '67.0']),
    );
    expect(sfClient.calls).toContainEqual(
      expect.arrayContaining(['--source-dir', path.join(localProject, 'force-app'), '--api-version', '67.0']),
    );
    expect(sfClient.calls).toContainEqual(
      expect.arrayContaining([
        'org', 'list', 'metadata-types', '--target-org', 'stdOrg', '--api-version', '67.0',
      ]),
    );
    expect(generated.metadataTypes).toEqual([
      { directoryName: 'labels', suffix: 'labels', xmlName: 'CustomLabels' },
    ]);
    expect(await readFile(generated.manifestPath, 'utf8')).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>LocalOnly</members>
        <members>OrgOnly</members>
        <members>Shared</members>
        <name>CustomLabels</name>
    </types>
    <types>
        <members>Account</members>
        <name>CustomObject</name>
    </types>
    <version>67.0</version>
</Package>
`);
  });

  it('local-only 비교에서도 meta XML에서 동적 타입 descriptor를 생성한다', async () => {
    const root = await createProject();
    const left = path.join(root, 'left');
    const right = path.join(root, 'right');
    for (const project of [left, right]) {
      await mkdir(path.join(project, 'force-app', 'main', 'default', 'contentassets'), { recursive: true });
      await writeFile(path.join(project, 'sfdx-project.json'), JSON.stringify({
        packageDirectories: [{ path: 'force-app' }], sourceApiVersion: '67.0',
      }));
      await writeFile(path.join(
        project, 'force-app', 'main', 'default', 'contentassets', 'product.asset',
      ), 'asset');
      await writeFile(
        path.join(project, 'force-app', 'main', 'default', 'contentassets', 'product.asset-meta.xml'),
        '<?xml version="1.0"?><ContentAsset xmlns="http://soap.sforce.com/2006/04/metadata"/>',
      );
    }

    const generated = await generateDeployableManifest({
      sources: [parseSourceSpec(`local:${left}`, root), parseSourceSpec(`local:${right}`, root)],
      outputDirectory: path.join(root, 'local-only-generated'),
      commandProjectPath: root,
      sfClient: new ManifestSfClient(),
    });

    expect(generated.metadataTypes).toContainEqual({
      directoryName: 'contentassets', suffix: 'asset', xmlName: 'ContentAsset',
    });
    const components = await resolveMetadataComponents(
      path.join(left, 'force-app', 'main', 'default'),
      generated.metadataTypes,
    );
    expect(components).toHaveLength(1);
    expect(components.get('ContentAsset:product')?.files).toEqual([
      'contentassets/product.asset',
      'contentassets/product.asset-meta.xml',
    ]);
  });

  it('선택한 Salesforce metadata type만 합집합 manifest에 남긴다', async () => {
    const root = await createProject();
    const sfClient = new ManifestSfClient();

    const generated = await generateDeployableManifest({
      sources: [parseSourceSpec('org:left', root), parseSourceSpec('org:right', root)],
      metadataTypes: ['CustomLabels'],
      outputDirectory: path.join(root, 'filtered'),
      commandProjectPath: root,
      sfClient,
    });

    const content = await readFile(generated.manifestPath, 'utf8');
    expect(content).toContain('<name>CustomLabels</name>');
    expect(content).not.toContain('<name>CustomObject</name>');
    for (const sourceManifest of generated.sourceManifests) {
      const sourceContent = await readFile(sourceManifest.manifestPath, 'utf8');
      expect(sourceContent).toContain('<name>CustomLabels</name>');
      expect(sourceContent).not.toContain('<name>CustomObject</name>');
    }
    const orgManifestCalls = sfClient.calls.filter((args) => args.includes('--from-org'));
    expect(orgManifestCalls).toHaveLength(2);
    for (const args of orgManifestCalls) {
      expect(args).toEqual(expect.arrayContaining(['--metadata', 'CustomLabels']));
    }
  });

  it('양쪽에 선택 타입 멤버가 없으면 빈 동적 manifest로 표시한다', async () => {
    const root = await createProject();
    const generated = await generateDeployableManifest({
      sources: [parseSourceSpec('org:left', root), parseSourceSpec('org:right', root)],
      metadataTypes: ['ApexClass'],
      outputDirectory: path.join(root, 'empty'),
      commandProjectPath: root,
      sfClient: new EmptyManifestSfClient(),
    });

    expect(generated.empty).toBe(true);
    expect(generated.sourceManifests).toEqual([
      expect.objectContaining({ empty: true }),
      expect.objectContaining({ empty: true }),
    ]);
    expect(await readFile(generated.manifestPath, 'utf8')).not.toContain('<types>');
  });
});

class EmptyManifestSfClient implements SfClient {
  public async runJson(args: readonly string[], _options: SfRunOptions): Promise<unknown> {
    if (args[0] === 'org' && args[1] === 'list' && args[2] === 'metadata-types') {
      return { result: { metadataObjects: [
        { directoryName: 'classes', suffix: 'cls', xmlName: 'ApexClass' },
      ] } };
    }
    const outputDirectory = flagValue(args, '--output-dir');
    const name = flagValue(args, '--name');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, name), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
      '  <version>67.0</version>',
      '</Package>',
    ].join('\n'));
    return { status: 0 };
  }
}

class ManifestSfClient implements SfClient {
  public readonly calls: string[][] = [];

  public async runJson(args: readonly string[], _options: SfRunOptions): Promise<unknown> {
    this.calls.push([...args]);
    if (args[0] === 'org' && args[1] === 'list' && args[2] === 'metadata-types') {
      return { result: { metadataObjects: [
        { directoryName: 'labels', suffix: 'labels', xmlName: 'CustomLabels' },
      ] } };
    }
    const outputDirectory = flagValue(args, '--output-dir');
    const name = flagValue(args, '--name');
    await mkdir(outputDirectory, { recursive: true });
    const isOrg = args.includes('--from-org');
    await writeFile(path.join(outputDirectory, name), `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    <members>Shared</members>
    <members>${isOrg ? 'OrgOnly' : 'LocalOnly'}</members>
    <name>CustomLabels</name>
  </types>
  ${isOrg ? '<types><members>Account</members><name>CustomObject</name></types>' : ''}
  <version>${isOrg ? '67.0' : '66.0'}</version>
</Package>
`);
    return { status: 0 };
  }
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-deployable-manifest-'));
  temporaryDirectories.push(root);
  await writeFile(path.join(root, 'sfdx-project.json'), JSON.stringify({
    packageDirectories: [{ path: 'force-app' }],
    sourceApiVersion: '67.0',
  }));
  return root;
}

function flagValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index < 0 || value === undefined) throw new Error(`${flag} argument missing`);
  return value;
}
