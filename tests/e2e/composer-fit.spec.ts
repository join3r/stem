// The composer's controls row gives things up in order as the window narrows
// (context meter, then Fast/Web labels, then the model name) instead of
// wrapping onto a second line. Layout is a DOM fact a unit test cannot check.
import { test, expect } from './electron';
import type { ElectronApplication, Page } from '@playwright/test';

async function setWidth(app: ElectronApplication, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().endsWith('index.html'))!;
    const [, h] = win.getSize();
    win.setMinimumSize(200, 200);
    win.setSize(w, h);
  }, width);
}

const squeeze = (win: Page): Promise<string | null> =>
  win.locator('.composer-controls').getAttribute('data-squeeze');

test('the controls row squeezes onto one line instead of wrapping', async ({ electronApp, mainWindow }) => {
  const row = mainWindow.locator('.composer-controls');
  const oneLine = async (): Promise<boolean> =>
    row.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().height < 40);

  await setWidth(electronApp, 1400);
  await expect.poll(() => squeeze(mainWindow)).toBe('0');
  await expect(mainWindow.locator('.ctl-label').first()).toBeVisible();

  // Narrow enough to lose the meter and the labels, but the row stays one line.
  for (const width of [1000, 900, 800, 720, 660, 620]) {
    await setWidth(electronApp, width);
    await expect.poll(oneLine).toBe(true);
    if (process.env.SHOTS) await row.screenshot({ path: `${process.env.SHOTS}/row-${width}.png` });
  }
  await expect.poll(async () => Number(await squeeze(mainWindow))).toBeGreaterThan(1);
  await expect(mainWindow.locator('.ctl-label').first()).toBeHidden();
  // Fast/Web still reachable as icons, by their tooltip.
  await expect(mainWindow.getByRole('button', { name: /Web search/ })).toBeVisible();

  // Widening brings everything back.
  await setWidth(electronApp, 1400);
  await expect.poll(() => squeeze(mainWindow)).toBe('0');
  await expect(mainWindow.locator('.ctl-label').first()).toBeVisible();
});
