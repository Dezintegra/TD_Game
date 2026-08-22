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

/**
 * Представиться и начать матч против компьютера.
 *
 * Матч теперь идёт через сервер, как и всякий другой: клиент входит
 * в дежурную комнату компьютера и подтверждает готовность. Отсюда
 * и ожидание подольше — надо дождаться, пока служба компьютера поднимет
 * комнату, а сервер сведёт двоих и дождётся обоих подключений.
 */
export const bootGame = async (page: Page): Promise<void> => {
  await identify(page, 'Тестер');

  const start = page.getByTestId('practice-start');
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();

  await expect(page.locator('#scene canvas')).toBeVisible({ timeout: 15_000 });
  // Дожидаемся первого подтверждённого тика: до него мир стоит на нуле,
  // и проверки вроде «энергия копится» ловили бы не игру, а ожидание.
  await expect(page.getByTestId('diagnostics')).toHaveAttribute('data-sync-tick', /[1-9]/, {
    timeout: 20_000,
  });
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

/**
 * Диагностическая величина из разметки.
 *
 * Seed, номер тика, частота кадров и доля скал игроку не показываются:
 * они ничего ему не говорят и занимают внимание, которого в матче
 * реального времени нет. Но убрать их совсем нельзя — seed единственное,
 * чем ОТСЮДА проверяется, что у обоих участников одна и та же карта.
 * Поэтому они живут атрибутами на отдельном элементе, и читать их надо
 * так, а не по тексту на экране.
 */
export const diagnostic = async (page: Page, name: string): Promise<string> =>
  (await page.getByTestId('diagnostics').getAttribute(`data-${name}`)) ?? '';

export const diagnosticNumber = async (page: Page, name: string): Promise<number> =>
  Number(await diagnostic(page, name));

/**
 * Открыть меню матча.
 *
 * Выход и перезапуск переехали в него с постоянных панелей: они нужны раз
 * за партию, а место занимали весь матч. Esc открывает меню только тогда,
 * когда отменять нечего, поэтому перед вызовом не должно быть ни выбранной
 * постройки, ни наведённого удара, ни выделения.
 */
export const openMatchMenu = async (page: Page): Promise<void> => {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('match-menu')).toBeVisible();
};
