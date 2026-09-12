import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { bootGame, rockDiagnostics } from './helpers.js';

test('скалы догоняют zoom 4 и перемещение без исчезновения и накопления деталей', async ({
  page,
}, info) => {
  await bootGame(page);
  await expect
    .poll(async () => (await rockDiagnostics(page))?.cells.length ?? 0)
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await rockDiagnostics(page))?.initialRemaining, { timeout: 30000 })
    .toBe(0);
  const canvas = page.locator('#scene canvas');
  const bounds = (await canvas.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const initial = (await rockDiagnostics(page))!;
  const middle = initial.cells.reduce(
    (sum, cell) => ({
      x: sum.x + cell.minimap.x / initial.cells.length,
      y: sum.y + cell.minimap.y / initial.cells.length,
    }),
    { x: 0, y: 0 },
  );
  const rock = [...initial.cells].sort(
    (a, b) =>
      Math.hypot(a.minimap.x - middle.x, a.minimap.y - middle.y) -
      Math.hypot(b.minimap.x - middle.x, b.minimap.y - middle.y),
  )[0]!;
  await page.mouse.click(bounds.x + rock.minimap.x, bounds.y + rock.minimap.y);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -10000);
  await expect.poll(async () => (await rockDiagnostics(page))?.zoom).toBe(4);

  // Сэмплы rAF наблюдают каждый кадр перехода, а не только финальное состояние.
  await page.evaluate(async () => {
    const path = '/src/game/scene.ts';
    const module = await import(/* @vite-ignore */ path);
    const evidence = { frames: 0, missing: false, overLimit: false };
    Object.assign(window, { rockEvidence: evidence });
    const sample = () => {
      const state = module.readRockDiagnostics();
      if (!state || evidence.frames >= 600) return;
      evidence.frames += 1;
      evidence.missing ||= state.cells.some((cell: { alive: boolean }) => !cell.alive);
      evidence.overLimit ||= state.actualBytes > state.limitBytes;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  const settle = async () => {
    await expect
      .poll(async () => (await rockDiagnostics(page))?.remaining, { timeout: 30000 })
      .toBe(0);
    const state = (await rockDiagnostics(page))!;
    expect(state.error).toBeNull();
    expect(state.cells.some((cell) => cell.visible)).toBe(true);
    for (const cell of state.cells) {
      expect(cell.alive).toBe(true);
      expect(cell.density).toBe(cell.target);
      if (cell.visible) expect(cell.physicalDensity).toBeGreaterThanOrEqual(state.scale);
      else expect(cell.density).toBe(cell.base);
    }
    expect(state.actualBytes).toBeLessThanOrEqual(state.limitBytes);
    return state;
  };
  const first = await settle();
  await canvas.screenshot({ path: info.outputPath('zoom-4.png') });
  await info.attach('zoom-4', { path: info.outputPath('zoom-4.png'), contentType: 'image/png' });
  for (const direction of [1, -1]) {
    const before = (await rockDiagnostics(page))!;
    const key = direction === 1 ? 'ArrowRight' : 'ArrowLeft';
    await page.keyboard.down(key);
    await page.waitForTimeout(500);
    await page.keyboard.up(key);
    const moved = (await rockDiagnostics(page))!;
    expect(moved.centre).not.toEqual(before.centre);
    const state = await settle();
    expect(state.terrainRebuildCount).toBe(first.terrainRebuildCount);
    await canvas.screenshot({ path: info.outputPath(`pan-${direction}.png`) });
  }
  const evidence = await page.evaluate(
    () =>
      (
        window as unknown as {
          rockEvidence: { frames: number; missing: boolean; overLimit: boolean };
        }
      ).rockEvidence,
  );
  expect(evidence.frames).toBeGreaterThan(0);
  expect(evidence.missing).toBe(false);
  expect(evidence.overLimit).toBe(false);
  await writeFile(
    info.outputPath('density.json'),
    JSON.stringify({ first, last: await rockDiagnostics(page), evidence }, null, 2),
  );
  await info.attach('density', {
    path: info.outputPath('density.json'),
    contentType: 'application/json',
  });
});
