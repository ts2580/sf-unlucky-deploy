[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CliArgs
)

$cli = Join-Path $PSScriptRoot 'dist/cli.js'
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  throw '빌드 산출물 dist/cli.js를 찾을 수 없습니다. 먼저 npm ci와 npm run build를 실행하세요.'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  throw 'Node.js 20.19 이상이 필요합니다.'
}

$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path -LiteralPath $envFile -PathType Leaf) {
  $parser = @'
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const values = parseEnv(readFileSync(process.argv[1], 'utf8'));
const entries = Object.entries(values).filter(([key]) => key === 'LOCAL' || /^SFUD_[A-Z0-9_]+$/.test(key));
process.stdout.write(Buffer.from(JSON.stringify(entries), 'utf8').toString('base64'));
'@
  $encodedEntries = & $node.Source -e $parser $envFile
  if ($LASTEXITCODE -ne 0) {
    throw ".env 파일을 읽지 못했습니다: $envFile"
  }
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedEntries))
    $entries = if ($json -eq '[]') { @() } else { @($json | ConvertFrom-Json) }
  } catch {
    throw ".env 파일을 읽지 못했습니다: $envFile"
  }
  foreach ($entry in $entries) {
    if ($null -eq [Environment]::GetEnvironmentVariable([string]$entry[0], 'Process')) {
      [Environment]::SetEnvironmentVariable([string]$entry[0], [string]$entry[1], 'Process')
    }
  }
}

& $node.Source $cli @CliArgs
exit $LASTEXITCODE
