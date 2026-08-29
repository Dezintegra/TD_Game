import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { bootGame } from './helpers.js';

/**
 * ВРЕМЕННАЯ проверка: снимает экран матча в трёх размерах окна
 * и печатает обмер ключевых панелей.
 *
 * Заведена затем, что раскладку игрового экрана надо смотреть глазами,
 * а на рабочей машине не осталось памяти под браузер. Снимки складываются
 * в `test-results/`, откуда их забирает выгрузка артефактов; числа идут
 * в журнал прогона.
 *
 * Удалить сразу после просмотра.
 */

const DIR = 'test-results/hud';

const PANELS = [
  'side-own',
  'match-opponent',
  'toolbar',
  'production-panel',
  'build-panel',
  'nuke-panel',
  'aim-panel',
  'own-panel',
  'stats-toggle',
  'train-0',
  'upgrade-window',
] as const;

const measure = async (page: Page): Promise<string> =>
  page.evaluate((ids) => {
    const box = (id: string): string => {
      const node = document.querySelector(`[data-testid="${id}"]`);
      if (node === null) return `${id}: НЕТ`;
      const r = node.getBoundingClientRect();
      const out =
        r.width === 0 && r.height === 0
          ? 'скрыт'
          : `x=${String(Math.round(r.x))} y=${String(Math.round(r.y))} ш=${String(Math.round(r.width))} в=${String(Math.round(r.height))}`;
      const over =
        r.x < -1 || r.y < -1 || r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1
          ? ' ЗА КРАЕМ'
          : '';
      return `${id}: ${out}${over}`;
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

    // Иконки печатаются после рельефа, по одной за кадр: рельефа около
    // полутора секунд, иконок четырнадцать. На видеокарте runner'а —
    // программной — это заметно дольше, чем на живой машине.
    await page.waitForTimeout(12_000);

    await page.screenshot({ path: `${DIR}/${name}-закрыто.png` });
    console.log(`ОБМЕР ${name} закрыто\n  ${await measure(page)}`);

    // Клавишей, а не кнопкой: кнопка может оказаться за краем экрана,
    // и тогда снимок прокачки не снимется вовсе — а он-то и нужен,
    // чтобы увидеть, почему она за краем.
    await page.keyboard.press('KeyR');
    await page.waitForTimeout(800);

    await page.screenshot({ path: `${DIR}/${name}-прокачка.png` });
    console.log(`ОБМЕР ${name} прокачка\n  ${await measure(page)}`);
  });
};

shots('монитор', 1600, 900);
shots('ландшафт', 812, 375);
shots('портрет', 375, 812);
