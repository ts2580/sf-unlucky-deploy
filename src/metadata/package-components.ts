import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { PackageComponent } from '../api/package-contracts.js';
import { SfudError } from '../core/errors.js';
import { findPackageRoot, listFiles } from '../core/files.js';
import { withRequestWorkspace } from '../core/request-workspace.js';
import type { SfClient } from '../salesforce/sf-client.js';
import { childMetadataTypes } from './child-metadata-types.js';
import { readXmlStream } from './xml-stream.js';

/** Reference-only retrieval. Never writes package sources to a deployable project. */
export async function retrievePackageComponents(
  name: string, alias: string, sfClient: SfClient, cwd: string, signal?: AbortSignal,
): Promise<PackageComponent[]> {
  signal?.throwIfAborted();
  return withRequestWorkspace(cwd, async (workspace) => {
    const output = path.join(workspace, 'package-inspect');
    await mkdir(output, { mode: 0o700 });
    const raw = await sfClient.runJson(['project', 'retrieve', 'start', '--target-org', alias,
      '--package-name', name, '--target-metadata-dir', output, '--unzip', '--wait', '10'], {
      cwd: workspace, timeoutMs: 660_000, ...(signal === undefined ? {} : { signal }),
    });
    signal?.throwIfAborted();
    const result = raw as { result?: { success?: unknown; done?: unknown; status?: unknown; messages?: unknown } };
    if (result?.result?.success !== true || result.result.done === false
      || (Array.isArray(result.result.messages) ? result.result.messages.length > 0 : result.result.messages != null)) {
      throw new SfudError('SF_RESPONSE_INVALID', '패키지 구성요소를 완전히 가져오지 못했습니다. 권한과 패키지 조회 지원 여부를 확인하세요.');
    }
    const root = await findPackageRoot(output);
    const xml = await readFile(path.join(root, 'package.xml'), 'utf8');
    if (xml.length > 5_000_000 || /<!DOCTYPE/iu.test(xml) || XMLValidator.validate(xml) !== true) {
      throw new SfudError('SF_RESPONSE_INVALID', '패키지 구성요소 manifest 형식이 올바르지 않습니다.');
    }
    const parsed = new XMLParser({ parseTagValue: false, trimValues: true,
      isArray: (tag) => tag === 'types' || tag === 'members' }).parse(xml) as {
      Package?: { fullName?: string; types?: Array<{ name?: unknown; members?: unknown[] }> };
    };
    if (!parsed.Package || (parsed.Package.fullName !== undefined && parsed.Package.fullName !== name)
      || !Array.isArray(parsed.Package.types) || parsed.Package.types.length === 0) {
      throw new SfudError('SF_RESPONSE_INVALID', '조회한 패키지의 이름 또는 구성요소 목록을 확인할 수 없습니다.');
    }
    const members = new Map<string, PackageComponent>();
    for (const type of parsed.Package.types) {
      if (typeof type.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(type.name)
        || !Array.isArray(type.members) || type.members.length === 0) throw invalidMember();
      for (const fullName of type.members) {
        if (typeof fullName !== 'string' || fullName.length === 0 || fullName.length > 1000
          || /[*\u0000-\u001f]/u.test(fullName)) throw invalidMember();
        members.set(`${type.name}:${fullName}`, { type: type.name, fullName });
      }
    }
    // MDAPI embeds fields, rules and labels in parent XML. Include their exact
    // returned identities so a CustomField/CustomLabel comparison uses the same scope.
    for (const file of await listFiles(root)) {
      signal?.throwIfAborted();
      const rules = childMetadataTypes.filter((rule) => file.startsWith(`${rule.directory}/`) && file.endsWith(`.${rule.suffix}`));
      if (rules.length === 0) continue;
      const parentName = file.slice(rules[0]!.directory.length + 1, -rules[0]!.suffix.length - 1);
      if (!members.has(`${rules[0]!.parent}:${parentName}`)) continue;
      let depth = 0;
      let childType: (typeof rules)[number] | undefined;
      let identity = '';
      let reading = false;
      let identityCount = 0;
      let rootSeen = false;
      await readXmlStream(path.join(root, file), (parser) => {
        parser.onopentag = (tag) => {
          depth += 1;
          const tagName = tag.name.split(':').at(-1);
          if (depth === 1) {
            if (rootSeen || tagName !== rules[0]!.parent) throw invalidMember();
            rootSeen = true;
          }
          if (depth === 2) { childType = rules.find((rule) => rule.element === tagName); identity = ''; identityCount = 0; }
          if (depth === 3 && childType?.identity === tagName) { reading = true; identityCount += 1; }
          else if (reading || depth > 128) throw invalidMember();
        };
        parser.ontext = parser.oncdata = (value) => { if (reading) { identity += value; if (identity.length > 1000) throw invalidMember(); } };
        parser.onclosetag = () => {
          if (depth === 3) reading = false;
          if (depth === 2 && childType) {
            if (identityCount !== 1 || !/^[A-Za-z0-9_$.-]+$/u.test(identity)) throw invalidMember();
            const fullName = childType.ignoreParentName ? identity : `${parentName}.${identity}`;
            members.set(`${childType.name}:${fullName}`, { type: childType.name, fullName });
            childType = undefined;
          }
          depth -= 1;
        };
      });
      if (!rootSeen || depth !== 0) throw invalidMember();
    }
    return [...members.values()].sort((a, b) => a.type.localeCompare(b.type) || a.fullName.localeCompare(b.fullName));
  });
}

function invalidMember(): SfudError {
  return new SfudError('SF_RESPONSE_INVALID', '패키지 구성요소의 정확한 이름을 확인하지 못했습니다. 제외 없이 계속하지 않습니다.');
}
