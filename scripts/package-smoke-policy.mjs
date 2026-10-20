export function packageSmokeCapabilities(help, requireCurrentFeatures) {
  const capabilities = {
    automaticPersonalConfig: /^\s+init(?:\s|$)/mu.test(help),
    stop: /^\s+stop(?:\s|$)/mu.test(help),
  };
  if (requireCurrentFeatures && (!capabilities.automaticPersonalConfig || !capabilities.stop)) {
    throw new Error('현재 원본 패키지의 init·stop 명령이 누락되었습니다.');
  }
  return capabilities;
}
