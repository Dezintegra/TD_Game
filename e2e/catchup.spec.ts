import { expect, test } from '@playwright/test';
import { bootGame, diagnosticNumber } from './helpers.js';

/**
 * Возврат в идущий матч перезагрузкой страницы.
 *
 * Это самый обычный способ вернуться, и он заводит разом обе отложенные
 * работы клиента: запекание рельефа с нуля и догон ушедшего вперёд
 * матча по истории команд. Ради этого случая бюджет кадра и сделан
 * общим — до него два бюджета в таком кадре складывались.
 *
 * Чего здесь НЕТ и почему. Утверждений про число порций догона и про
 * то, сколько раз обновилась полоса восстановления, тут нет намеренно:
 * на быстрой машине догон в тысячу тиков укладывается в один-два кадра,
 * и показывать по дороге просто нечего. Такая проверка молча проходила
 * бы, ничего не проверив, а на медленной машине падала бы по-разному.
 * Нарезка проверяется там, где порции задаются бюджетом и утверждение
 * точное, — в `packages/netplay/src/guest.catchup.test.ts`.
 *
 * Здесь проверяется то, что верно на любой машине: матч после
 * перезагрузки тот же, мир восстановлен полностью и продолжает идти.
 */

/** Тик, до которого доводим матч перед перезагрузкой. */
const AHEAD_TICKS = 300;

test('перезагрузка посреди матча возвращает в тот же матч', async ({ page }) => {
  await bootGame(page);

  const seed = await diagnosticNumber(page, 'seed');

  await expect
    .poll(async () => diagnosticNumber(page, 'sync-tick'), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(AHEAD_TICKS);

  await page.reload();

  // Тот же матч, а не новый: карта совпадает, и мир не начинается
  // с нуля. Seed — единственное, чем это проверяется отсюда.
  await expect(page.locator('#scene canvas')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => diagnosticNumber(page, 'seed'), { timeout: 30_000 }).toBe(seed);

  // Мир восстановлен целиком по истории команд: подтверждённый тик
  // догнал прежний, а не начался заново.
  await expect
    .poll(async () => diagnosticNumber(page, 'sync-tick'), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(AHEAD_TICKS);

  // И матч идёт дальше, а не замер на догнанном тике.
  const restored = await diagnosticNumber(page, 'sync-tick');
  await expect
    .poll(async () => diagnosticNumber(page, 'sync-tick'), { timeout: 30_000 })
    .toBeGreaterThan(restored);

  // Полоса восстановления убрана: фаза матча снова обычная.
  await expect(page.getByTestId('match-phase')).toBeHidden();
});
