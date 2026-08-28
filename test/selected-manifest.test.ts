import { describe, expect, it } from 'vitest';

import { normalizeSelectedComponents, renderSelectedManifest } from '../src/deploy/selected-manifest.js';

describe('배포 장바구니 manifest', () => {
  it('type별로 중복을 제거하고 결정적인 package.xml을 만든다', () => {
    const components = normalizeSelectedComponents([
      { type: 'CustomField', fullName: 'Account.Label__c' },
      { type: 'ApexClass', fullName: 'Hello' },
      { type: 'ApexClass', fullName: 'Hello' },
      { type: 'CustomField', fullName: 'Account.A&B__c' },
    ]);

    expect(components).toEqual([
      { type: 'ApexClass', fullName: 'Hello' },
      { type: 'CustomField', fullName: 'Account.A&B__c' },
      { type: 'CustomField', fullName: 'Account.Label__c' },
    ]);
    expect(renderSelectedManifest(components, '67.0')).toBe([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <types>',
      '        <members>Hello</members>',
      '        <name>ApexClass</name>',
      '    </types>',
      '    <types>',
      '        <members>Account.A&amp;B__c</members>',
      '        <members>Account.Label__c</members>',
      '        <name>CustomField</name>',
      '    </types>',
      '    <version>67.0</version>',
      '</Package>',
      '',
    ].join('\n'));
  });

  it('비어 있거나 잘못된 type을 거부한다', () => {
    expect(() => normalizeSelectedComponents([])).toThrow(/1개부터/u);
    expect(() => normalizeSelectedComponents([{ type: 'Apex Class', fullName: 'Hello' }]))
      .toThrow(/type이 올바르지/u);
  });
});
