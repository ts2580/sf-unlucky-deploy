/** Shared by workspace discovery and execution access; usernames need @ and +. */
const ORG_IDENTIFIER_PATTERN = '^[A-Za-z0-9._@+\\-]+$';

export function isOrgIdentifier(value: string): boolean {
  return new RegExp(ORG_IDENTIFIER_PATTERN, 'u').test(value);
}

/** Salesforce의 15자리 ID를 대소문자를 보존한 18자리 ID로 정규화한다. */
export function normalizeSalesforceOrgId(value: string): string {
  if (!/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/u.test(value)) {
    throw new Error('Salesforce Org ID는 00D로 시작하는 15자리 또는 18자리여야 합니다.');
  }
  const suffixAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  const original = value.slice(0, 15);
  let suffix = '';
  for (let segment = 0; segment < 3; segment += 1) {
    let bits = 0;
    for (let position = 0; position < 5; position += 1) {
      const character = original[segment * 5 + position]!;
      if (character >= 'A' && character <= 'Z') bits |= 1 << position;
    }
    suffix += suffixAlphabet[bits]!;
  }
  const normalized = original + suffix;
  if (value.length === 18 && value !== normalized) throw new Error('Salesforce Org ID의 검사 문자가 올바르지 않습니다.');
  return normalized;
}
