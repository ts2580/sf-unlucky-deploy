export interface XmlComparisonChange {
  kind?: 'ADDED' | 'REMOVED' | 'MODIFIED' | 'REORDERED';
  path: string;
  before?: string;
  after?: string;
}

export interface ComparisonFileDifference {
  path: string;
  status: string;
  kind?: 'xml' | 'text' | 'binary';
  unifiedDiff?: string;
  xmlChanges?: XmlComparisonChange[];
  xmlSemanticStatus?: 'EQUAL' | 'DIFFERENT';
  xmlComparisonPolicy?: 'REGISTERED' | 'GENERIC';
  rawContentChanged?: boolean;
  leftSha256?: string;
  rightSha256?: string;
  leftSize?: number;
  rightSize?: number;
}

interface ComparisonFileDiffProps {
  file: ComparisonFileDifference;
  sourceLabel: string;
  targetLabel: string;
  sourceSide: 'before' | 'after';
}

export function ComparisonFileDiff({ file, sourceLabel, targetLabel, sourceSide }: ComparisonFileDiffProps) {
  const hasTextDiff = file.unifiedDiff !== undefined && file.unifiedDiff.length > 0;
  const hasXmlDiff = file.xmlChanges !== undefined && file.xmlChanges.length > 0;
  const hasBinaryDiff = file.kind === 'binary' && file.status === 'MODIFIED';
  const hasSemanticNote = file.kind === 'xml' && file.rawContentChanged === true
    && file.xmlSemanticStatus !== undefined;
  if (!hasTextDiff && !hasXmlDiff && !hasBinaryDiff && !hasSemanticNote) return null;
  const targetSide = sourceSide === 'before' ? 'after' : 'before';

  return (
    <section className="file-diff-panel" aria-label={`${file.path} Source와 Target 차이`}>
      <div className="file-diff-sides">
        <DiffSideHeader side="source" label={sourceLabel} changeKind={sideChangeKind(sourceSide)} />
        <DiffSideHeader side="target" label={targetLabel} changeKind={sideChangeKind(targetSide)} />
      </div>
      {hasTextDiff && <UnifiedDiff diff={file.unifiedDiff!} />}
      {hasXmlDiff && <XmlDiff changes={file.xmlChanges!} sourceSide={sourceSide} />}
      {hasSemanticNote && <p className={`xml-semantic-note xml-semantic-${file.xmlSemanticStatus!.toLowerCase()}`}>
        원문 SHA-256은 다릅니다. XML 의미 비교는 {file.xmlSemanticStatus === 'EQUAL' ? '동일' : '변경'}이며,
        {' '}{file.xmlComparisonPolicy === 'REGISTERED' ? 'metadata type 등록 정책' : 'generic 정책'}을 사용했습니다.
      </p>}
      {hasBinaryDiff && <BinaryDiff file={file} sourceSide={sourceSide} />}
    </section>
  );
}

function DiffSideHeader({ side, label, changeKind }: {
  side: 'source' | 'target';
  label: string;
  changeKind: 'added' | 'removed';
}) {
  return <div className={`diff-side-header diff-side-${side} diff-line-${changeKind}`} data-diff-side={side}><span>{side.toUpperCase()}</span><strong>{label}</strong></div>;
}

function UnifiedDiff({ diff }: { diff: string }) {
  const lines = diff.split('\n')
    .filter((line, index, all) => !(index === all.length - 1 && line === ''))
    .filter((line) => !line.startsWith('Index: ')
      && !line.startsWith('--- ')
      && !line.startsWith('+++ ')
      && !/^={3,}$/u.test(line));

  return (
    <pre className="file-diff-code" aria-label="줄 단위 변경 내용">
      {lines.map((line, index) => {
        const kind = diffLineKind(line);
        return <span className={`diff-line diff-line-${kind}`} data-diff-kind={kind} key={`${index}-${line}`}>{line || ' '}</span>;
      })}
    </pre>
  );
}

function XmlDiff({ changes, sourceSide }: {
  changes: XmlComparisonChange[];
  sourceSide: 'before' | 'after';
}) {
  return (
    <div className="xml-diff-list" aria-label="XML 경로별 변경 내용">
      {changes.map((change, index) => {
        const sourceValue = change[sourceSide];
        const targetSide = sourceSide === 'before' ? 'after' : 'before';
        const targetValue = change[targetSide];
        return <article className="xml-diff-change" key={`${change.path}-${index}`}>
          <div className="xml-diff-path"><code>{change.path}</code><span>{change.kind ?? 'MODIFIED'}</span></div>
          <div className="xml-diff-values">
            <DiffValue side="source" value={sourceValue} changeKind={sideChangeKind(sourceSide)} />
            <DiffValue side="target" value={targetValue} changeKind={sideChangeKind(targetSide)} />
          </div>
        </article>;
      })}
    </div>
  );
}

function DiffValue({ side, value, changeKind }: {
  side: 'source' | 'target';
  value: string | undefined;
  changeKind: 'added' | 'removed';
}) {
  return <div className={`xml-diff-value diff-value-${side} diff-line-${changeKind}`} data-diff-side={side} data-diff-kind={changeKind}><b aria-hidden="true">{changeKind === 'added' ? '+' : '−'}</b><code>{value ?? '값 없음'}</code></div>;
}

function BinaryDiff({ file, sourceSide }: {
  file: ComparisonFileDifference;
  sourceSide: 'before' | 'after';
}) {
  const sourceIsBefore = sourceSide === 'before';
  return (
    <div className="binary-diff" aria-label="바이너리 파일 해시 차이">
      <BinaryValue side="source" sha256={sourceIsBefore ? file.leftSha256 : file.rightSha256} size={sourceIsBefore ? file.leftSize : file.rightSize} changeKind={sourceIsBefore ? 'removed' : 'added'} />
      <BinaryValue side="target" sha256={sourceIsBefore ? file.rightSha256 : file.leftSha256} size={sourceIsBefore ? file.rightSize : file.leftSize} changeKind={sourceIsBefore ? 'added' : 'removed'} />
    </div>
  );
}

function BinaryValue({ side, sha256, size, changeKind }: {
  side: 'source' | 'target';
  sha256: string | undefined;
  size: number | undefined;
  changeKind: 'added' | 'removed';
}) {
  return <div className={`binary-diff-value diff-line-${changeKind}`} data-diff-side={side} data-diff-kind={changeKind}><strong>{side.toUpperCase()}</strong><code>{sha256 ?? '해시 없음'}</code><small>{size ?? 0} bytes</small></div>;
}

function sideChangeKind(side: 'before' | 'after'): 'added' | 'removed' {
  return side === 'before' ? 'removed' : 'added';
}

function diffLineKind(line: string): 'added' | 'removed' | 'header' | 'hunk' | 'context' {
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return 'header';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}
