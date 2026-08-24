/**
 * Лист сравнения «до и после» из двух снимков пробной страницы.
 *
 * Временная оснастка того же изменения, что и `fx-probe-shot.mjs`.
 * Принимает каталог, в котором уже лежат `before.png`, `after.png`
 * и `compare.html`, и кладёт туда же `compare.png`.
 *
 *   node scripts/fx-probe-compare.mjs <каталог>
 */
import { chromium } from '@playwright/test';

const dir = process.argv[2];
if (dir === undefined) throw new Error('нужен каталог со снимками');

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1560, height: 2200 },
  deviceScaleFactor: 2,
});

await page.goto(`file:///${dir.replace(/\\/g, '/')}/compare.html`, { waitUntil: 'load' });
// Дать разложиться шрифтам и фоновым картинкам: без паузы снимок
// иногда выходит с пустыми рамками вместо кадров.
await page.waitForTimeout(800);

// Строкой, а не стрелкой: выражение выполняется в браузере.
const box = await page.evaluate('[document.body.scrollWidth, document.body.scrollHeight]');
await page.screenshot({
  path: `${dir}/compare.png`,
  clip: { x: 0, y: 0, width: box[0], height: box[1] },
});
await browser.close();
console.log('снято:', `${dir}/compare.png`, box.join('x'));
