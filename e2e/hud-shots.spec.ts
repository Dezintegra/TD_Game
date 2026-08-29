import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { bootGame } from './helpers.js';

/**
 * ВРЕМЕННАЯ проверка: снимает экран матча и печатает обмер панелей.
 *
 * Заведена затем, что раскладку надо смотреть глазами, а на рабочей
 * машине не осталось памяти под браузер. Удалить сразу после просмотра.
 */

const DIR = 'test-results/hud';

const PANELS = [
  'menu-open',
  'side-own',
  'match-opponent',
  'connection-status',
  'production-panel',
  'build-panel',
  'nuke-panel',
  'aim-panel',
  'own-panel',
  'stats-toggle',
  'target',
  'upgrade-window',
] as const;

const measure = async (page: Page): Promise<string> =>
  page.evaluate((ids) => {
    const box = (id: string): string => {
      const node = document.querySelector(`[data-testid="${id}"]`);
      if (node === null) return `${id}: НЕТ`;
      const r = node.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return `${id}: скрыт`;

      const over =
        r.x < -1 || r.y < -1 || r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1
          ? ' ЗА КРАЕМ'
          : '';

      return `${id}: x=${String(Math.round(r.x))} y=${String(Math.round(r.y))} ш=${String(Math.round(r.width))} в=${String(Math.round(r.height))}${over}`;
    };

    return [
      `окно ${String(window.innerWidth)}×${String(window.innerHeight)}`,
      ...ids.map(box),
    ].join('\n  ');
  }, PANELS);

const shots = (name: string, width: number, height: number): void => {
  test(`снимок ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await bootGame(page);
    await page.waitForTimeout(14_000);

    await page.screenshot({ path: `${DIR}/${name}-закрыто.png` });
    console.log(`ОБМЕР ${name} закрыто\n  ${await measure(page)}`);

    // Кнопка меню не должна ЕЗДИТЬ при обновлении строки связи. Меряем
    // её дважды с промежутком: строка обновляется на каждом ответе
    // сервера, и её ширина меняется вместе с числом знаков задержки.
    const before = await page.getByTestId('menu-open').boundingBox();
    await page.waitForTimeout(3000);
    const after = await page.getByTestId('menu-open').boundingBox();
    console.log(
      `КНОПКА МЕНЮ ${name}: до x=${String(before?.x)} y=${String(before?.y)}; после x=${String(after?.x)} y=${String(after?.y)}`,
    );

    await page.keyboard.press('KeyR');
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${DIR}/${name}-прокачка.png` });
    console.log(`ОБМЕР ${name} прокачка\n  ${await measure(page)}`);
  });
};

shots('монитор', 1600, 900);
shots('ландшафт', 812, 375);
shots('портрет', 375, 812);
