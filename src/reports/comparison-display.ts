/** Policy diagnostics remain in comparison data; screens show actionable warnings. */
export function comparisonDisplayWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((warning) => !warning.startsWith('등록된 XML semantic 정책이 없어 generic 비교를 사용한 metadata type:'));
}
