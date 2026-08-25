import { isAbsolute } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * Разбор настройки-выключателя.
 *
 * Настройки читаются при загрузке модуля — один раз, а не при каждом
 * обращении. Поэтому тест не правит уже прочитанное значение, а сбрасывает
 * кеш модулей и загружает `config.ts` заново с нужным окружением.
 * Дописать сюда `process.env` после импорта было бы бесполезно: значение
 * к тому моменту уже вычислено.
 *
 * Помощник общий на обе настройки намеренно. Выключатели обязаны
 * понимать одни и те же слова: тот, кто выключил запись матчей словом
 * `off`, вправе ожидать, что и показания выключаются им же.
 */
const flagWith = async (
  name: 'MATCHLOG' | 'TELEMETRY',
  value: string | undefined,
): Promise<boolean> => {
  const before = process.env[name];

  if (value === undefined) delete process.env[name];
  else process.env[name] = value;

  vi.resetModules();

  try {
    const config = await import('./config.js');
    return name === 'MATCHLOG' ? config.MATCHLOG_ENABLED : config.TELEMETRY_ENABLED;
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
};

const dirWith = async (value: string | undefined): Promise<string> => {
  const before = process.env['TELEMETRY_DIR'];

  if (value === undefined) delete process.env['TELEMETRY_DIR'];
  else process.env['TELEMETRY_DIR'] = value;

  vi.resetModules();

  try {
    const config = await import('./config.js');
    return config.TELEMETRY_DIR;
  } finally {
    if (before === undefined) delete process.env['TELEMETRY_DIR'];
    else process.env['TELEMETRY_DIR'] = before;
  }
};

describe.each(['MATCHLOG', 'TELEMETRY'] as const)('настройка %s', (name) => {
  it('без переменной включена', async () => {
    // Главное свойство: чтобы велась запись, помнить не надо ничего.
    await expect(flagWith(name, undefined)).resolves.toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', ''])('значение «%s» выключает', async (value) => {
    await expect(flagWith(name, value)).resolves.toBe(false);
  });

  it.each(['FALSE', 'Off', 'NO', ' 0 '])(
    'значение «%s» выключает независимо от регистра и пробелов',
    async (value) => {
      // Тот, кто пишет `MATCHLOG=False`, имеет в виду ровно то же,
      // что и `MATCHLOG=false`, и включённую запись он не ожидает.
      await expect(flagWith(name, value)).resolves.toBe(false);
    },
  );

  it.each(['1', 'on', 'true', 'yes', 'да'])('значение «%s» включает', async (value) => {
    await expect(flagWith(name, value)).resolves.toBe(true);
  });
});

describe('каталог показаний', () => {
  it('без переменной лежит в корне и путь абсолютный', async () => {
    // Относительный путь означал бы «куда-то относительно того, откуда
    // запустили», а запускают службу из разных мест.
    const dir = await dirWith(undefined);

    expect(isAbsolute(dir)).toBe(true);
    expect(dir.endsWith('.telemetry')).toBe(true);
  });

  it('переменная переопределяет каталог', async () => {
    // Сверяется хвост пути, а не строка целиком: `resolve` на Windows
    // приставит к `/data/telemetry` букву текущего диска, и точное
    // равенство сделало бы проверку непереносимой.
    const dir = await dirWith('/data/telemetry');

    expect(isAbsolute(dir)).toBe(true);
    expect(dir.replace(/\\/gu, '/').endsWith('/data/telemetry')).toBe(true);
  });
});
