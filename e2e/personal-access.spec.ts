import { expect, test } from '@playwright/test';
import { createWebServer } from '../src/web/server/app.js';

test('개인용 비밀번호 접속·모바일 로그아웃·재접속을 실제 서버에서 확인한다', async ({ page }, testInfo) => {
  const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true,
    accessPassword: 'personal-browser-test-password', databasePath: ':memory:',
    sfClient: { async runJson() { return { status: 0, result: { nonScratchOrgs: [] } }; } },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await page.goto(address);
    await expect(page.getByRole('heading', { name: '개인 배포 앱에 접속합니다.' })).toBeVisible();
    await expect(page.getByLabel('이메일', { exact: true })).toHaveCount(0);
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByLabel('접속 비밀번호')).toBeVisible();
      await expect(page.getByRole('button', { name: '접속', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), `${width}px 가로 넘침`).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`personal-access-${width}.png`), fullPage: true });
    }
    await page.getByLabel('접속 비밀번호').fill('personal-browser-test-password');
    await page.getByRole('button', { name: '접속', exact: true }).click();
    await expect(page.getByRole('heading', { name: '배포 대시보드', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '사용자 관리', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '배포 대시보드', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '인증 관리', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Salesforce 인증', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await expect(page.getByLabel('접속 비밀번호')).toBeVisible();
    await expect(page.getByLabel('이메일', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel('접속 비밀번호')).toBeVisible();
    await page.getByLabel('접속 비밀번호').fill('personal-browser-test-password');
    await page.getByRole('button', { name: '접속', exact: true }).click();
    await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    // Close Chromium's connections before waiting for the fixture HTTP server.
    await test.step('브라우저 연결 종료', () => page.context().close());
    await test.step('테스트 서버 종료', () => app.close());
  }
});
