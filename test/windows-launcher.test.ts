import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Windows PowerShell 런처', () => {
  it('Node dotenv parser로 .env의 LOCAL 및 SFUD 변수를 읽고 기존 Process 환경을 보존한다', async () => {
    const launcher = await readFile(new URL('../sfud.ps1', import.meta.url), 'utf8');
    expect(launcher).toContain("Join-Path $PSScriptRoot '.env'");
    expect(launcher).toContain("const { parseEnv } = require('node:util');");
    expect(launcher).toContain("key === 'LOCAL'");
    expect(launcher).toContain('/^SFUD_[A-Z0-9_]+$/.test(key)');
    expect(launcher).toContain("GetEnvironmentVariable([string]$entry[0], 'Process')");
    expect(launcher).toContain("SetEnvironmentVariable([string]$entry[0], [string]$entry[1], 'Process')");
  });
});
