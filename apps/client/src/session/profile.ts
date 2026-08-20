import { NAME_MAX_LENGTH, NAME_MIN_LENGTH, NameError, checkName } from '@td/shared';

/**
 * Профиль игрока: имя, которым он представился, и выданный ему
 * идентификатор.
 *
 * Разбор вынесен в чистые функции над строками и отделён
 * от `document.cookie` намеренно. Спорных случаев здесь много — пустое
 * имя, пробелы по краям, испорченный JSON, запись без половины полей, —
 * и каждый из них должен проверяться обычным тестом, а не глазами
 * в браузере.
 *
 * Проверка самого имени живёт в `@td/shared`: то же правило применяет
 * сервер, и разойтись двум копиям нельзя.
 */
export interface Profile {
  /** Выдаётся при создании, игроку не показывается и им не правится. */
  readonly id: string;
  readonly name: string;
}

export const PROFILE_COOKIE = 'td_profile';

/**
 * Год — срок, после которого забытый профиль на общем компьютере
 * перестаёт быть чужим следом.
 */
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export const nameErrorText: Record<NameError, string> = {
  [NameError.Empty]: 'Введите имя',
  [NameError.TooShort]: `Не короче ${String(NAME_MIN_LENGTH)} символов`,
  [NameError.TooLong]: `Не длиннее ${String(NAME_MAX_LENGTH)} символов`,
};

/**
 * Разбор значения куки.
 *
 * Возвращает `null` на всё, что не является целым профилем: пустую
 * строку, неразбираемый JSON, запись без имени или без идентификатора,
 * имя, не проходящее проверку. Для игрока все эти случаи означают одно
 * и то же — он здесь впервые, — и разделять их незачем.
 *
 * Исключений не бросает: содержимое куки правится руками и приходит
 * из прошлых версий клиента, то есть является недоверенным вводом
 * ровно так же, как сетевой кадр.
 */
export const parseProfile = (raw: string | undefined): Profile | null => {
  if (raw === undefined || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const { id, name } = parsed as { id?: unknown; name?: unknown };
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof name !== 'string') return null;

  const checked = checkName(name);
  if (!checked.ok) return null;

  return { id, name: checked.name };
};

export const serializeProfile = (profile: Profile): string =>
  encodeURIComponent(JSON.stringify({ id: profile.id, name: profile.name }));

/**
 * Достаёт значение куки из строки вида `a=1; b=2`.
 *
 * Отдельная функция, а не выражение внутри `readProfile`: строка кук
 * устроена неудобно (разделитель с пробелом, значение может содержать
 * знак равенства), и разбирать её лучше в одном месте с тестами.
 */
export const cookieValue = (cookieString: string, key: string): string | undefined => {
  for (const part of cookieString.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    if (trimmed.slice(0, separator) === key) return trimmed.slice(separator + 1);
  }
  return undefined;
};

/**
 * Новый идентификатор профиля.
 *
 * `crypto.randomUUID` доступен только в защищённом контексте — по HTTPS
 * и на `localhost`. Открыть игру со второго устройства по локальному
 * IP-адресу, то есть по обычному http, — обыденный случай при разработке,
 * и там функции не будет.
 *
 * Запасной путь на `Math.random` в `packages/sim` был бы преступлением,
 * здесь — нет: идентификатор профиля не входит в состояние мира
 * и на симуляцию не влияет никак. От него требуется лишь не совпасть
 * с чужим.
 */
export const createProfileId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const chunk = (): string =>
    Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, '0');

  return `${chunk()}-${chunk()}-${chunk()}-${chunk()}`;
};

export const readProfile = (): Profile | null =>
  parseProfile(cookieValue(document.cookie, PROFILE_COOKIE));

export const writeProfile = (profile: Profile): void => {
  // SameSite=Lax, а не Strict: профиль должен переживать переход
  // на игру по ссылке из мессенджера, а защищать здесь нечего.
  document.cookie =
    `${PROFILE_COOKIE}=${serializeProfile(profile)}` +
    `; path=/; max-age=${String(COOKIE_MAX_AGE_SECONDS)}; SameSite=Lax`;
};

export const clearProfile = (): void => {
  document.cookie = `${PROFILE_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
};
