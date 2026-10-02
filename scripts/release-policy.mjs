export function getReleasePolicy(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/u.exec(tag);
  if (!match) throw new Error(`릴리즈 태그는 vX.Y.Z 또는 vX.Y.Z-rc.N 형식이어야 합니다: ${tag}`);
  const prerelease = match[4] !== undefined;
  return { branch: prerelease ? 'canary' : 'main', prerelease };
}
