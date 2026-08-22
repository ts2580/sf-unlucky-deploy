import { describe, expect, it } from 'vitest';

import { compareXml } from '../src/metadata/xml-diff.js';

describe('XML metadata diff', () => {
  it('들여쓰기와 attribute 순서만 다르면 동일하다', () => {
    const left = '<?xml version="1.0"?><Root beta="2" alpha="1"><enabled>true</enabled></Root>';
    const right = `<?xml version="1.0"?>
      <Root alpha="1" beta="2">
        <enabled>true</enabled>
      </Root>`;

    expect(compareXml(left, right)).toEqual([]);
  });

  it('반복 메타데이터를 fullName 기준으로 비교해 값 차이를 표시한다', () => {
    const left = `<?xml version="1.0"?>
      <CustomObject>
        <fields><fullName>Status__c</fullName><label>주문 상태</label></fields>
        <fields><fullName>Channel__c</fullName><label>채널</label></fields>
      </CustomObject>`;
    const right = `<?xml version="1.0"?>
      <CustomObject>
        <fields><fullName>Status__c</fullName><label>처리 상태</label></fields>
        <fields><fullName>Owner__c</fullName><label>담당자</label></fields>
      </CustomObject>`;

    const changes = compareXml(left, right);
    expect(changes).toContainEqual({
      kind: 'MODIFIED',
      path: 'CustomObject.fields[fullName=Status__c].label',
      before: '주문 상태',
      after: '처리 상태',
    });
    expect(changes.some((change) => change.kind === 'REMOVED' && change.path.includes('Channel__c'))).toBe(true);
    expect(changes.some((change) => change.kind === 'ADDED' && change.path.includes('Owner__c'))).toBe(true);
  });

  it('반복 항목의 순서 변경을 별도로 표시한다', () => {
    const left = '<Layout><items><field>A__c</field></items><items><field>B__c</field></items></Layout>';
    const right = '<Layout><items><field>B__c</field></items><items><field>A__c</field></items></Layout>';

    expect(compareXml(left, right)).toContainEqual({
      kind: 'REORDERED',
      path: 'Layout.items.$order',
      before: 'field=A__c, field=B__c',
      after: 'field=B__c, field=A__c',
    });
  });

  it('XML 값 내부의 앞뒤 공백 차이는 보존한다', () => {
    const left = '<Flow><formula>A + B</formula></Flow>';
    const right = '<Flow><formula> A + B </formula></Flow>';

    expect(compareXml(left, right)).toContainEqual({
      kind: 'MODIFIED',
      path: 'Flow.formula',
      before: 'A + B',
      after: ' A + B ',
    });
  });
});
