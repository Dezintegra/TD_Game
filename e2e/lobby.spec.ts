import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { identify, uniqueTitle } from './helpers.js';

/**
 * Мета-слой: представление, комнаты, обоюдная готовность.
 *
 * Ключевые проверки здесь идут на двух контекстах браузера — двух
 * независимых наборах кук и вкладок. Иначе главное свойство комнаты
 * не проверить вовсе: она существует ради того, чтобы двое увидели
 * друг друга, и одним браузером этого не изобразить.
 */

/** Создать комнату и дождаться, пока она откроется у создателя. */
const createRoom = async (page: Page, title: string): Promise<void> => {
  await page.getByTestId('lobby-title').fill(title);
  await page.getByTestId('lobby-create').click();
  await expect(page.getByTestId('room')).toBeVisible();
};

/** Строка списка с нужным названием — своя, а не соседнего теста. */
const rowOf = (page: Page, title: string) =>
  page.getByTestId('lobby-row').filter({ hasText: title });

test('профиль переживает перезагрузку и удаляется по требованию', async ({ page }) => {
  await identify(page, 'Аня');

  await page.reload();
  // Повторно представляться не требуется: профиль лежит в куке.
  await expect(page.getByTestId('profile-name-shown')).toHaveText('Аня');
  await expect(page.getByTestId('profile-form')).toBeHidden();

  await page.getByTestId('profile-forget').click();
  await page.getByTestId('profile-forget-confirm').click();

  // Возврат к представлению, причём поле пустое: прежнее имя
  // не подставляется, иначе «удалить» выглядело бы как «переименовать».
  await expect(page.getByTestId('profile-form')).toBeVisible();
  await expect(page.getByTestId('profile-name')).toHaveValue('');

  await page.getByTestId('profile-name').fill('Боря');
  await page.getByTestId('profile-submit').click();
  await expect(page.getByTestId('profile-name-shown')).toHaveText('Боря');
});

test('имя проверяется до создания профиля', async ({ page }) => {
  await page.goto('/');

  // Пустое поле: отклик обязан прийти в том же кадре, без обращения
  // к серверу, потому что исход зависит только от введённой строки.
  await page.getByTestId('profile-submit').click();
  await expect(page.getByText('Введите имя')).toBeVisible();
  await expect(page.getByTestId('profile-form')).toBeVisible();

  // Одна буква — уже другая причина, а не та же самая.
  await page.getByTestId('profile-name').fill('я');
  await page.getByTestId('profile-submit').click();
  await expect(page.getByText('Не короче 2 символов')).toBeVisible();

  await page.getByTestId('profile-name').fill('Аня');
  await page.getByTestId('profile-submit').click();
  await expect(page.getByTestId('profile-name-shown')).toHaveText('Аня');
});

test('созданная комната появляется у соседа без обновления страницы', async ({ browser }) => {
  const watching = await browser.newContext();
  const creating = await browser.newContext();

  try {
    const watcher = await watching.newPage();
    const creator = await creating.newPage();
    const title = uniqueTitle();

    await identify(watcher, 'Аня');
    await identify(creator, 'Боря');

    await createRoom(creator, title);

    // Ни перезагрузки, ни кнопки «обновить»: строка обязана приехать
    // сама. Список без этого — снимок, по которому игрок ломился бы
    // в занятую комнату.
    await expect(rowOf(watcher, title)).toBeVisible();
    await expect(rowOf(watcher, title).getByTestId('lobby-row-players')).toHaveText('1 / 2');
  } finally {
    await watching.close();
    await creating.close();
  }
});

test('двое сходятся в комнате, и обоюдная готовность начинает матч', async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();

  try {
    const anya = await firstContext.newPage();
    const borya = await secondContext.newPage();
    const title = uniqueTitle();

    await identify(anya, 'Аня');
    await identify(borya, 'Боря');

    await createRoom(anya, title);
    await rowOf(borya, title).getByTestId('lobby-join').click();

    // Оба видят полный состав.
    await expect(borya.getByTestId('room')).toBeVisible();
    await expect(anya.getByTestId('room-slot')).toHaveCount(2);
    await expect(borya.getByTestId('room-slot')).toHaveCount(2);

    // Готовность одного видна другому.
    await anya.getByTestId('room-ready').click();
    await expect(
      borya.getByTestId('room-slot').filter({ hasText: 'Аня' }),
    ).toHaveAttribute('data-ready', 'yes');

    // Пока готов один — матч не начинается.
    await expect(anya.locator('#scene canvas')).toBeHidden();

    await borya.getByTestId('room-ready').click();

    // Матч начался у обоих.
    await expect(anya.locator('#scene canvas')).toBeVisible();
    await expect(borya.locator('#scene canvas')).toBeVisible();

    // Карта общая: seed совпадает.
    const seedOfAnya = await anya.getByTestId('seed').textContent();
    await expect(borya.getByTestId('seed')).toHaveText(seedOfAnya ?? '');

    // Стороны разные, и каждый видит имя соперника, а не своё.
    await expect(anya.getByTestId('match-opponent')).toHaveAttribute('data-side', '0');
    await expect(borya.getByTestId('match-opponent')).toHaveAttribute('data-side', '1');
    await expect(anya.getByTestId('match-opponent')).toContainText('Боря');
    await expect(borya.getByTestId('match-opponent')).toContainText('Аня');

    // Сторона доехала до самой симуляции, а не осталась в меню.
    // Атрибут берётся из снимка матча, который заполняет игровой цикл,
    // поэтому проверка отличает «сервер назначил сторону 1»
    // от «игрок действительно играет стороной 1».
    await expect(anya.getByTestId('hud')).toHaveAttribute('data-local-player', '0');
    await expect(borya.getByTestId('hud')).toHaveAttribute('data-local-player', '1');

    // Матч из комнаты не притворяется сетевым и не предлагает
    // перезапуск на новой карте.
    await expect(anya.getByTestId('match-offline-warning')).toBeVisible();
    await expect(anya.getByTestId('restart')).toBeHidden();

    // Комната ушла из списка открытых: войти в неё уже нельзя.
    const onlooker = await firstContext.newPage();
    await onlooker.goto('/');
    await expect(rowOf(onlooker, title)).toHaveCount(0);

    // Выход возвращает в меню и гасит поле.
    await anya.getByTestId('match-leave').click();
    await expect(anya.getByTestId('menu')).toBeVisible();
    await expect(anya.locator('#scene canvas')).toHaveCount(0);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test('готовность недоступна в одиночестве и сбрасывается уходом соперника', async ({
  browser,
}) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();

  try {
    const anya = await firstContext.newPage();
    const borya = await secondContext.newPage();
    const title = uniqueTitle();

    await identify(anya, 'Аня');
    await identify(borya, 'Боря');

    await createRoom(anya, title);
    // Согласие дают на конкретного соперника, а его ещё нет.
    await expect(anya.getByTestId('room-ready')).toBeDisabled();
    await expect(anya.getByTestId('room-hint')).toContainText('Ждём соперника');

    await rowOf(borya, title).getByTestId('lobby-join').click();
    await expect(anya.getByTestId('room-ready')).toBeEnabled();

    await anya.getByTestId('room-ready').click();
    await expect(anya.getByTestId('room-ready')).toHaveAttribute('data-ready', 'yes');

    // Уход соперника снимает готовность оставшегося: иначе следующий
    // вошедший запустил бы матч первым нажатием.
    await borya.getByTestId('room-leave').click();
    await expect(anya.getByTestId('room-slot')).toHaveCount(1);
    await expect(anya.getByTestId('room-ready')).toHaveAttribute('data-ready', 'no');
    await expect(anya.locator('#scene canvas')).toHaveCount(0);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test('заполненная комната показана занятой, а не исчезает', async ({ browser }) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);

  try {
    const [anya, borya, vova] = await Promise.all(contexts.map((context) => context.newPage()));
    if (anya === undefined || borya === undefined || vova === undefined) {
      throw new Error('Не открылись три вкладки');
    }

    const title = uniqueTitle();

    await identify(anya, 'Аня');
    await identify(borya, 'Боря');
    await identify(vova, 'Вова');

    await createRoom(anya, title);
    await rowOf(borya, title).getByTestId('lobby-join').click();
    await expect(borya.getByTestId('room')).toBeVisible();

    // Третий видит комнату и видит, что мест нет. Скрывать её было бы
    // хуже: игрок гадал бы, куда она делась.
    const row = rowOf(vova, title);
    await expect(row.getByTestId('lobby-row-players')).toHaveText('2 / 2');
    await expect(row.getByTestId('lobby-join')).toBeDisabled();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
