import { describe, expect, it, vi } from 'vitest';

/**
 * Разбор настройки записи.
 *
 * Настройки читаются при загрузке модуля — один раз, а не при каждом
 * обращении. Поэтому тест не правит уже прочитанное значение, а сбрасывает
 * кеш модулей и загружает `config.ts` заново с нужным окружением.
 * Дописать сюда `process.env` после импорта было бы бесполезно: значение
 * к тому моменту уже вычислено.
 */
const enabledWith = async (value: string | undefined): Promise<boolean> => {
  const before = process.env['MATCHLOG'];

  if (value === undefined) delete process.env['MATCHLOG'];
  else process.env['MATCHLOG'] = value;

  vi.resetModules();

  try {
    const config = await import('./config.js');
    return config.MATCHLOG_ENABLED;
  } finally {
    if (before === undefined) delete process.env['MATCHLOG'];
    else process.env['MATCHLOG'] = before;
  }
};

describe('настройка записи матчей', () => {
  it('без переменной пишет', async () => {
    // Главное свойство: чтобы запись велась, помнить не надо ничего.
    await expect(enabledWith(undefined)).resolves.toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', ''])('значение «%s» выключает', async (value) => {
    await expect(enabledWith(value)).resolves.toBe(false);
  });

  it.each(['FALSE', 'Off', 'NO', ' 0 '])(
    'значение «%s» выключает независимо от регистра и пробелов',
    async (value) => {
      // Тот, кто пишет `MATCHLOG=False`, имеет в виду ровно то же,
      // что и `MATCHLOG=false`, и включённую запись он не ожидает.
      await expect(enabledWith(value)).resolves.toBe(false);
    },
  );

  it.each(['1', 'on', 'true', 'yes', 'да'])('значение «%s» включает', async (value) => {
    await expect(enabledWith(value)).resolves.toBe(true);
  });
});
