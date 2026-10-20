import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createWebServer } from '../src/web/server/app.js';

for (const width of [1440, 390]) {
  test(`Git 사설 IP 검사 기본값·저장·오류 복구를 실제 서버에서 확인한다 (${width}px)`, async ({ page }, testInfo) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-network-browser-'));
    const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true,
      databasePath: path.join(root, 'state.db'), assetsDirectory: path.resolve('dist/ui'),
      sfClient: { async runJson() { return { status: 0, result: { nonScratchOrgs: [] } }; } },
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${address}/settings`);
      const panel = page.getByRole('region', { name: '셀프호스팅 Git 허용 IP' });
      const checkbox = panel.getByRole('checkbox', { name: '사설 IP 검사', exact: true });
      const toggle = panel.getByText('사설 IP 검사', { exact: true });
      await expect(checkbox).toBeEnabled();
      await expect(checkbox).not.toBeChecked();
      await toggle.click();
      await expect(checkbox).toBeChecked();
      await expect(panel.getByRole('status')).toContainText('사설 IP 검사를 켰습니다');
      expect(app.sfudRuntime.gitAllowedIps.policy.checkPrivateIps).toBe(true);

      await panel.getByRole('button', { name: 'IP 등록', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '허용 Git IP 등록' });
      await dialog.getByLabel('IPv4 또는 IPv6 주소').fill('192.168.10.25');
      await dialog.getByRole('button', { name: '등록', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.reload();
      await expect(checkbox).toBeChecked();
      await expect(panel.getByRole('table')).toContainText('192.168.10.25');
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`git-network-enabled-${width}.png`), fullPage: true });

      await page.route('**/api/v1/admin/git-allowed-ips', (route) => route.request().method() === 'PATCH'
        ? route.fulfill({ status: 500, json: { error: { code: 'FIXTURE_SAVE_FAILED', message: '설정 저장 실패' } } })
        : route.continue());
      await toggle.click();
      await expect(panel.getByRole('alert')).toContainText('설정 저장 실패');
      await expect(checkbox).toBeChecked();
      expect(app.sfudRuntime.gitAllowedIps.policy.checkPrivateIps).toBe(true);
      await page.unroute('**/api/v1/admin/git-allowed-ips');
      await toggle.click();
      await expect(checkbox).not.toBeChecked();
      await expect(panel.getByRole('status')).toContainText('사설 IP 검사를 껐습니다');
      await page.reload();
      await expect(checkbox).toBeEnabled();
      await expect(checkbox).not.toBeChecked();
      await expect(panel.getByRole('table')).toContainText('192.168.10.25');
      expect(app.sfudRuntime.gitAllowedIps.policy.checkPrivateIps).toBe(false);
      expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`git-network-disabled-${width}.png`), fullPage: true });
    } finally {
      await page.context().close();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
