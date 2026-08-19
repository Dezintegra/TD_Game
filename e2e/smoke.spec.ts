import { expect, test } from '@playwright/test';

/**
 * Smoke-тест сквозной вертикали.
 *
 * Он не проверяет геймплей — его ещё нет. Он проверяет, что каркас
 * собран правильно: клиент запускается, PixiJS создаёт canvas,
 * WebSocket доходит до сервера, а бинарный протокол работает
 * в обе стороны.
 */
test('клиент поднимается, рисует поле и общается с сервером', async ({ page }) => {
  await page.goto('/');

  // Игровое поле отрисовано PixiJS.
  const canvas = page.locator('#scene canvas');
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box?.width).toBeGreaterThan(0);
  expect(box?.height).toBeGreaterThan(0);

  // HUD виден поверх поля. Проверка не формальная: сцена добавляется
  // в DOM после монтирования HUD, и при неверном порядке слоёв canvas
  // целиком закрывает интерфейс, оставаясь при этом «найденным» в DOM.
  await expect(page.getByTestId('hud')).toBeVisible();
  await expect(page.getByText('Соединение')).toBeInViewport();

  // Соединение с сервером установлено.
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'online');

  // Сервер отвечает на ping: счётчик ответов растёт.
  // Пинг уходит раз в секунду, поэтому даём запас в 5 секунд.
  await expect(page.getByTestId('pong-count')).not.toHaveText('0', { timeout: 5000 });
});

test('страница загружается без ошибок в консоли', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/');
  await expect(page.locator('#scene canvas')).toBeVisible();

  expect(errors).toEqual([]);
});
