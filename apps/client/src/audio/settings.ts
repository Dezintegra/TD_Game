/**
 * Настройки звука: что игрок про них решил.
 *
 * Разбор отделён от хранилища намеренно — так же, как разбор профиля
 * отделён от `document.cookie` (`session/profile.ts`). Спорных случаев
 * здесь хватает: испорченный JSON, запись из прошлой версии клиента без
 * половины полей, значение за границами диапазона, хранилище, вовсе
 * недоступное. Каждый из них должен проверяться обычным тестом,
 * а не глазами в браузере.
 *
 * Все они означают для игрока одно и то же: настройки по умолчанию.
 * Исключений эти функции не бросают ни при каких данных: содержимое
 * хранилища правится руками и приходит из прошлых версий, то есть
 * является недоверенным вводом ровно так же, как сетевой кадр.
 */

export interface SoundSettings {
  /** Общий выключатель. Клавиша `M`. */
  readonly enabled: boolean;
  /** Общая громкость, от нуля до единицы. */
  readonly master: number;
  /** Громкость боя. */
  readonly battle: number;
  /** Громкость музыки. */
  readonly music: number;
}

/**
 * Значения по умолчанию.
 *
 * Звук включён: игра, которая молчит, пока не залезешь в настройки,
 * для большинства игроков молчит навсегда.
 *
 * Музыка тише боя вдвое. Бой несёт сведения о поле, музыка не несёт
 * ничего, и при равной громкости она мешала бы слышать то, ради чего
 * звук вообще заведён.
 */
export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  enabled: true,
  master: 0.8,
  battle: 0.9,
  music: 0.45,
};

export const SOUND_STORAGE_KEY = 'td_sound';

const level = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
};

/**
 * Разобрать сохранённое.
 *
 * Поля разбираются по одному, и недостающее не отменяет остальных:
 * запись из прошлой версии клиента, где не было громкости музыки,
 * обязана сохранить то, что игрок настроил про бой.
 */
export const parseSoundSettings = (raw: string | null | undefined): SoundSettings => {
  if (raw === undefined || raw === null || raw.length === 0) return DEFAULT_SOUND_SETTINGS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SOUND_SETTINGS;
  }

  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SOUND_SETTINGS;

  const record = parsed as Record<string, unknown>;

  return {
    enabled:
      typeof record['enabled'] === 'boolean' ? record['enabled'] : DEFAULT_SOUND_SETTINGS.enabled,
    master: level(record['master'], DEFAULT_SOUND_SETTINGS.master),
    battle: level(record['battle'], DEFAULT_SOUND_SETTINGS.battle),
    music: level(record['music'], DEFAULT_SOUND_SETTINGS.music),
  };
};

export const serializeSoundSettings = (settings: SoundSettings): string =>
  JSON.stringify({
    enabled: settings.enabled,
    master: settings.master,
    battle: settings.battle,
    music: settings.music,
  });

/**
 * Хранилище — `localStorage`, а не кука.
 *
 * Профиль лежит в куке потому, что его читает сервер. Громкость сервер
 * не читает и читать не должен, а кука уезжала бы с каждым запросом.
 *
 * Обращение обёрнуто в перехват намеренно: в приватном режиме некоторых
 * браузеров `localStorage` есть, но бросает на запись, и падать из-за
 * несохранённой громкости игра не должна.
 */
export const readSoundSettings = (): SoundSettings => {
  try {
    return parseSoundSettings(localStorage.getItem(SOUND_STORAGE_KEY));
  } catch {
    return DEFAULT_SOUND_SETTINGS;
  }
};

export const writeSoundSettings = (settings: SoundSettings): void => {
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, serializeSoundSettings(settings));
  } catch {
    // Не сохранилось — и ладно. Настройка действует до перезагрузки.
  }
};
