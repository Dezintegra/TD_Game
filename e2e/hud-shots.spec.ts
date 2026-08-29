import { test } from '@playwright/test';
import { bootGame } from './helpers.js';

/**
 * ВРЕМЕННАЯ проверка: снимает экран матча в трёх размерах окна.
 *
 * Заведена затем, что раскладку игрового экрана надо смотреть глазами,
 * а на рабочей машине не осталось памяти под браузер. Снимки складываются
 * в `test-results/`, откуда их забирает выгрузка артефактов.
 *
 * Удалить сразу после просмотра.
 */

const DIR = 'test-results/hud';

const shots = (name: string, width: number, height: number): void => {
  test(`снимок ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await bootGame(page);

    // Иконки печатаются после рельефа, по одной за кадр: рельефа около
    // полутора секунд, иконок четырнадцать.
    await page.waitForTimeout(9000);

    await page.screenshot({ path: `${DIR}/${name}-закрыто.png` });

    await page.getByTestId('stats-toggle').click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${DIR}/${name}-прокачка.png` });
  });
};

shots('монитор', 1600, 900);
shots('ландшафт', 812, 375);
shots('портрет', 375, 812);
