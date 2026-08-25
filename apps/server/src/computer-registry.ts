/**
 * Кто из игроков — компьютер.
 *
 * Сервер обязан это знать: иначе комнату компьютера нечем пометить,
 * а врать игроку о том, с кем он играет, нельзя. Раньше ответ брался
 * прямым вызовом в память службы дежурных, которая живёт в том же
 * процессе. Это единственное, что мешало ей оттуда уехать.
 *
 * Здесь тот же ответ, но **объявленный, а не спрошенный**: служба при
 * запуске называет свои личности и манеру каждой, сервер запоминает
 * и дальше отвечает сам. Обращений за границу процесса во время матча
 * при этом ноль — а ответ нужен в горячих местах, и поход туда за ним
 * был бы неуместен.
 *
 * ## Почему объявление вообще принимается
 *
 * Раньше личности выдавал сервер (`makeId` передавался службе), и это
 * само по себе было доказательством: угадать их снаружи невозможно.
 * Теперь их порождает служба, а доверие даёт **общий секрет**.
 * Назваться компьютером со стороны по-прежнему нельзя, и свойство это
 * обязательное: без него игроку можно солгать о том, с кем он играет.
 *
 * ## Почему у объявления есть срок
 *
 * Служба в отдельном процессе может уйти, не попрощавшись — падение,
 * перезапуск, обрыв. Без срока сервер вечно считал бы компьютерными
 * личности процесса, которого больше нет, и показывал бы игроку комнаты,
 * в которые никто не войдёт.
 */

export interface ComputerIdentity {
  readonly id: string;
  /** Манера, которой играет этот дежурный. */
  readonly profile: string;
}

export interface ComputerRegistry {
  /** Манера этой личности. Чужой идентификатор — `undefined`. */
  profileOf(playerId: string): string | undefined;
  /**
   * Объявить личности и обновить срок.
   *
   * Возвращает `false`, если секрет не подошёл или регистрация закрыта.
   * Причина не различается намеренно: тому, кто подбирает секрет,
   * знать, закрыта регистрация или он ошибся, незачем.
   */
  declare(secret: string, identities: readonly ComputerIdentity[]): boolean;
  /**
   * Снять объявление: служба уходит по-хорошему.
   *
   * Нужно затем, чтобы комнаты компьютера исчезали сразу, а не
   * по истечении срока. Игрок не должен минуту смотреть на комнату,
   * в которую никто не войдёт.
   */
  withdraw(secret: string, ids: readonly string[]): boolean;
  /** Есть ли хоть одна живая личность. */
  readonly available: boolean;
  /** Сколько живых личностей известно. Для показаний и проверок. */
  readonly size: number;
}

export interface ComputerRegistryOptions {
  /**
   * Общий секрет. Пустой означает, что регистрация закрыта и игра
   * с компьютером недоступна.
   *
   * Умолчание именно пустое, а не какое-нибудь «changeme»: открытая
   * настежь регистрация по умолчанию однажды доедет до боевой машины,
   * и никто этого не заметит, пока не станет поздно.
   */
  readonly secret?: string;
  /** Сколько объявление действует без обновления, миллисекунды. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * Сколько объявление живёт без обновления.
 *
 * Втрое больше срока обновления (`COMPUTER_REFRESH_MS`): одно
 * пропущенное обновление — не повод объявлять службу мёртвой, сеть
 * не обязана быть ровной. Три подряд — повод.
 */
export const COMPUTER_TTL_MS = 60_000;

/** Как часто служба обязана подтверждать, что жива. */
export const COMPUTER_REFRESH_MS = 20_000;

interface Entry {
  readonly profile: string;
  expiresAtMs: number;
}

export const createComputerRegistry = (options: ComputerRegistryOptions = {}): ComputerRegistry => {
  const secret = options.secret ?? '';
  const ttlMs = options.ttlMs ?? COMPUTER_TTL_MS;
  const now = options.now ?? (() => Date.now());

  const entries = new Map<string, Entry>();

  /**
   * Сверка секрета.
   *
   * Пустой секрет не подходит ни к чему, включая пустое объявление:
   * иначе «регистрация закрыта» означало бы «регистрация открыта всем».
   */
  const admits = (offered: string): boolean => secret.length > 0 && offered === secret;

  /**
   * Убрать протухшее.
   *
   * Уборка ленивая — на каждом чтении, а не по таймеру. Таймер пришлось
   * бы снимать при остановке сервера и помнить о нём в тестах, а живых
   * личностей здесь единицы: обойти их дешевле, чем завести ещё одну
   * вещь, за которой надо следить.
   */
  const sweep = (): void => {
    const nowMs = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAtMs <= nowMs) entries.delete(id);
    }
  };

  return {
    profileOf(playerId) {
      sweep();
      return entries.get(playerId)?.profile;
    },

    declare(offered, identities) {
      if (!admits(offered)) return false;

      const expiresAtMs = now() + ttlMs;
      for (const identity of identities) {
        entries.set(identity.id, { profile: identity.profile, expiresAtMs });
      }

      return true;
    },

    withdraw(offered, ids) {
      if (!admits(offered)) return false;

      for (const id of ids) entries.delete(id);
      return true;
    },

    get available() {
      sweep();
      return entries.size > 0;
    },

    get size() {
      sweep();
      return entries.size;
    },
  };
};
