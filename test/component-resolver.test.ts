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
});
