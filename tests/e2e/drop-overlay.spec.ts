// The drag-to-place overlay with many Files subfolders: every tile must sit
// inside the window (you can't scroll mid-drag), and past what fits the grid
// ends in an "Other folder…" tile instead of squeezing names into slivers.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, launchApp, mainWindowOf, removeUserData } from './electron';

async function fire(win: Page, type: 'dragenter' | 'dragover', x: number, y: number) {
  await win.evaluate(
    ([t, cx, cy]) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['hi'], 'hello.txt', { type: 'text/plain' }));
      document.body.dispatchEvent(
        new DragEvent(t as string, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: cx as number,
          clientY: cy as number
        })
      );
    },
    [type, x, y] as const
  );
}

/** Enter, let the overlay and its folder list render, then hover like a real drag. */
async function dragFileOver(win: Page, x: number, y: number) {
  await fire(win, 'dragenter', x, y);
  await expect(win.locator('.drop-overlay')).toBeVisible();
  await win.waitForTimeout(300);
  await fire(win, 'dragover', x, y);
}

async function overlayWith(count: number, run: (win: Page) => Promise<void>) {
  const filesDir = mkdtempSync(join(tmpdir(), 'stem-files-'));
  for (let i = 1; i <= count; i++) mkdirSync(join(filesDir, `folder-${String(i).padStart(2, '0')}`));
  const { app, userDataDir } = await launchApp({
    env: { STEM_FILES_DIR: filesDir }
  });
  try {
    const win = await mainWindowOf(app);
    await win.waitForLoadState('domcontentloaded');
    await win.setViewportSize({ width: 1280, height: 800 });
    await run(win);
  } finally {
    await app.close().catch(() => {});
    removeUserData(userDataDir);
    removeUserData(filesDir);
  }
}

async function expectTilesInside(win: Page) {
  const vp = win.viewportSize()!;
  const boxes = await win.locator('.drop-tile').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        h: r.height,
        name: e.querySelector('.drop-tile-name')!.scrollWidth
      };
    })
  );
  expect(boxes.length).toBeGreaterThan(0);
  for (const b of boxes) {
    expect(b.bottom).toBeLessThanOrEqual(vp.height);
    expect(b.h).toBeGreaterThanOrEqual(44);
  }
}

test('a handful of folders get roomy tiles and no overflow tile', async () => {
  await overlayWith(3, async (win) => {
    await dragFileOver(win, 1000, 600);
    await expect(win.locator('.drop-tile')).toHaveCount(3);
    await expect(win.locator('.drop-tile.other')).toHaveCount(0);
    await expectTilesInside(win);
    await win.screenshot({ path: test.info().outputPath('drop-3.png') });
  });
});

test('dozens of folders fit in a multi-column grid', async () => {
  await overlayWith(24, async (win) => {
    await dragFileOver(win, 1000, 600);
    await expect(win.locator('.drop-tile')).toHaveCount(24);
    await expectTilesInside(win);
    // The tile under the cursor lights up.
    await expect(win.locator('.drop-tile.active')).toHaveCount(1);
    await win.screenshot({ path: test.info().outputPath('drop-24.png') });
  });
});

test('too many folders end in an "Other folder…" tile', async () => {
  await overlayWith(90, async (win) => {
    await dragFileOver(win, 1000, 200);
    await expect(win.locator('.drop-band.root.active')).toHaveCount(1);
    await expect(win.locator('.drop-tile.other')).toHaveCount(1);
    await expect(win.locator('.drop-tile.other')).toContainText('more…');
    await expectTilesInside(win);
    await win.screenshot({ path: test.info().outputPath('drop-90.png') });
  });
});
