import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitMaterializer } from '../../src/git/git-materializer.js';
import { ProcessSfClient } from '../../src/salesforce/sf-client.js';
import { generateDeployableManifest } from '../../src/metadata/deployable-manifest.js';
import { createSnapshot } from '../../src/sources/snapshot.js';
import { compareSnapshots } from '../../src/metadata/comparator.js';
import type { GitTreeEntry } from '../../src/git/git-object-store.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-foldered-apex-proof-'));
const content = new Map<string, Buffer>();
const files: Record<string, string> = {
  'sfdx-project.json': JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '64.0' }),
  '.forceignore': '**/ignored/**\n',
};
for (const [folder, name, body] of [
  ['interface', 'Contract', 'public interface Contract {}'],
  ['campaign', 'CampaignHandler', 'public class CampaignHandler {}'],
  ['logger/internal', 'Logger', 'public class Logger {}'],
  ['ignored', 'Hidden', 'public class Hidden {}'],
]) {
  files[`force-app/main/default/classes/${folder}/${name}.cls`] = `${body}\r\n`;
  files[`force-app/main/default/classes/${folder}/${name}.cls-meta.xml`] = '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>64.0</apiVersion><status>Active</status></ApexClass>\n';
}
const entries: GitTreeEntry[] = Object.entries(files).map(([file, value]) => {
  const body = Buffer.from(value);
  const objectId = createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
  content.set(objectId, body);
  return { path: file, objectId, mode: '100644', type: 'blob', size: body.length };
});
const objects = { listTree: async () => entries, readBlob: async (id: string) => content.get(id)! };
const project = path.join(root, 'project');
const imported = await new GitMaterializer(objects).materialize('a'.repeat(40), '.', project);
const source = { kind: 'local' as const, projectPath: project, displayName: 'foldered fixture' };
const sfClient = new ProcessSfClient();
const manifest = await generateDeployableManifest({ sources: [source], metadataTypes: ['ApexClass'],
  outputDirectory: path.join(root, 'manifest'), commandProjectPath: project, sfClient });
const xml = await readFile(manifest.manifestPath, 'utf8');
for (const name of ['Contract', 'CampaignHandler', 'Logger']) assert(xml.includes(`<members>${name}</members>`));
assert(!xml.includes('Hidden'));
assert(!xml.includes('interface/'));
const snapshot = await createSnapshot({ source, manifestPath: manifest.manifestPath,
  outputDir: path.join(root, 'snapshot'), commandProjectPath: project, sfClient });
assert.deepEqual((await readdir(path.join(snapshot.packageRoot, 'classes'))).sort(),
  ['CampaignHandler.cls', 'CampaignHandler.cls-meta.xml', 'Contract.cls', 'Contract.cls-meta.xml', 'Logger.cls', 'Logger.cls-meta.xml']);
const flatEntries = entries.map((entry) => ({ ...entry,
  path: entry.path.replace(/classes\/(?:interface|campaign|logger\/internal)\//u, 'classes/'),
}));
const flatProject = path.join(root, 'flat-project');
const flatImport = await new GitMaterializer({ ...objects, listTree: async () => flatEntries }).materialize('b'.repeat(40), '.', flatProject);
assert.equal(flatImport.checksum, imported.checksum);
const flatSnapshot = await createSnapshot({ source: { ...source, projectPath: flatProject, displayName: 'flat fixture' },
  manifestPath: manifest.manifestPath, outputDir: path.join(root, 'flat-snapshot'), commandProjectPath: flatProject, sfClient });
const comparison = await compareSnapshots(flatSnapshot, snapshot);
assert.equal(comparison.summary.identical, 3);
assert(comparison.components.every((component) => !component.fullName.includes('/')));
console.log(JSON.stringify({ status: 'PASS', root, importedFiles: imported.fileCount, identical: comparison.summary.identical,
  manifest: manifest.manifestPath, deploymentPayload: snapshot.packageRoot, remoteAccess: false, deployed: false }));
