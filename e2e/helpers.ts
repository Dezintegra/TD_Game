import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Общие шаги сквозных проверок.
 *
 * Вынесены в отдельный файл, потому что путь в игру удлинился: матч
 * больше не начинается сам при загрузке страницы, сначала игрок
 * называет себя. Повторять эти три строки в каждом тесте значило бы
 * править их все при следующей правке формы.
 *
 * Playwright берёт в работу только `*.spec.ts`, поэтому этот файл
 * тестом не считается.
 */

/**
 * Представиться и дойти до списка комнат.
 *
 * У каждого теста свой контекст браузера, то есть чистые куки, поэтому
 * форма представления показывается всякий раз.
 */
export const identify = async (page: Page, name: string): Promise<void> => {
  await page.goto('/');
  await page.getByTestId('profile-name').fill(name);
  await page.getByTestId('profile-submit').click();
  await expect(page.getByTestId('profile-name-shown')).toHaveText(name);
};

/** Представиться и начать тренировочный матч против компьютера. */
export const bootGame = async (page: Page): Promise<void> => {
  await identify(page, 'Тестер');
  await page.getByTestId('practice-start').click();
  await expect(page.locator('#scene canvas')).toBeVisible();
  // Клика по полю здесь намеренно нет. Горячие клавиши слушает window,
  // поэтому фокуса на body достаточно, а клик пришлось бы целить мимо
  // панелей HUD — и тест ломался бы от любой правки вёрстки.
};

/**
 * Название комнаты, не совпадающее с чужими.
 *
 * Тесты идут параллельно и видят общий список комнат на одном сервере.
 * Общее название сделало бы проверки взаимозависимыми: тест находил бы
 * комнату соседнего теста и входил в неё.
 *
 * Длина ограничена двадцатью символами — тем же правилом, что и имя
 * игрока, поэтому суффикс короткий.
 */
export const uniqueTitle = (): string => `Комн-${Math.random().toString(36).slice(2, 7)}`;

/** Число из подписи HUD: отбрасывает единицы измерения и проценты. */
export const number = async (page: Page, testId: string): Promise<number> =>
  Number((await page.getByTestId(testId).textContent())?.replace(/[^\d.-]/g, ''));
