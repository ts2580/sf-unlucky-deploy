import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveMetadataComponents } from '../src/metadata/component-resolver.js';
import { removeDirectoriesAfterTest, writeFixtureFiles } from './support/files.js';

describe('metadata component resolver', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => removeDirectoriesAfterTest(temporaryDirectories));

  it('LWC 파일과 source/meta 쌍을 논리 컴포넌트로 묶는다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-components-'));
    temporaryDirectories.push(root);
    await writeFixtureFiles(root, {
      'package.xml': '<Package/>',
      'lwc/orderTable/orderTable.js': 'export default class {}',
      'lwc/orderTable/orderTable.html': '<template></template>',
      'lwc/orderTable/orderTable.js-meta.xml': '<?xml version="1.0"?><LightningComponentBundle/>',
      'classes/OrderService.cls': 'public class OrderService {}',
      'classes/OrderService.cls-meta.xml': '<?xml version="1.0"?><ApexClass/>',
    });

    const components = await resolveMetadataComponents(root);

    expect(components).toHaveLength(2);
    expect(components.get('LightningComponentBundle:orderTable')?.files).toEqual([
      'lwc/orderTable/orderTable.html',
      'lwc/orderTable/orderTable.js',
      'lwc/orderTable/orderTable.js-meta.xml',
    ]);
    expect(components.get('ApexClass:OrderService')?.files).toEqual([
      'classes/OrderService.cls',
      'classes/OrderService.cls-meta.xml',
    ]);
  });

  it('sf metadata type 설명으로 기존에 알 수 없던 source/meta 쌍을 묶는다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-dynamic-components-'));
    temporaryDirectories.push(root);
    await writeFixtureFiles(root, {
      'package.xml': '<Package/>',
      'contentassets/product.asset': 'binary-content',
      'contentassets/product.asset-meta.xml': '<ContentAsset/>',
      'territory2Models/West.territory2': '<Territory2/>',
      'territory2Models/West.Rule.territory2Rule': '<Territory2Rule/>',
    });

    const components = await resolveMetadataComponents(root, [
      { directoryName: 'contentassets', suffix: 'asset', xmlName: 'ContentAsset' },
      { directoryName: 'territory2Models', suffix: 'territory2', xmlName: 'Territory2' },
      { directoryName: 'territory2Models', suffix: 'territory2Rule', xmlName: 'Territory2Rule' },
    ]);

    expect(components.get('ContentAsset:product')?.files).toEqual([
      'contentassets/product.asset',
      'contentassets/product.asset-meta.xml',
    ]);
    expect(components.has('Territory2:West')).toBe(true);
    expect(components.has('Territory2Rule:West.Rule')).toBe(true);
  });
});
