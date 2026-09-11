import { LOBBY_CAPACITY } from '@td/protocol';
import { DEFAULT_PROFILE_ID } from '@td/ai';
import type { PlayerView } from '@td/protocol';
import { createLobbyApi } from './lobby-api.js';
import type { FetchLike, LobbyApi } from './lobby-api.js';
import { joinMatch } from './participant.js';
import type { OpenSocket, Participant, ParticipantMeasure } from './participant.js';

/**
 * Служба компьютерных соперников.
 *
 * Компьютер приходит ПО ПРИГЛАШЕНИЮ и никаких комнат не держит.
 * Игрок заводит свою комнату и зовёт в неё соперника выбранной манеры;
 * служба видит приглашение в том же списке комнат, что видят игроки,
 * поднимает дежурного и входит гостем — тем же запросом `join`,
 * которым входит человек.
 *
 * Особого пути в матч у компьютера по-прежнему нет — ни подстановки
 * второго участника сервером, ни отдельной ветки «а этот участник
 * ненастоящий». Меняется только то, КТО заводит комнату.
 *
 * **Почему не дежурные комнаты, как было раньше.** Дежурные висели
 * в списке всегда: три службы по три дежурных, девять комнат и девять
 * потоков состояния круглые сутки, даже когда в игру не заходил никто.
 * Владелец продукта потребовал прямо: «пусть ничего не крутится, пока
 * никто не играет». Здесь и не крутится — служба держит один поток
 * на манеру и ждёт, ничего не тратя.
 *
 * Побочно исчезла и гонка, ради которой дежурных держали по нескольку:
 * двое, зовущие компьютера одновременно, зовут его каждый в СВОЮ
 * комнату, и делить им нечего.
 */

export interface ComputerServiceOptions {
  readonly apiUrl: string;
  readonly wsUrl: string;
  readonly fetch: FetchLike;
  readonly openSocket: OpenSocket;
  /** Сколько матчей служба ведёт одновременно. */
  readonly maxMatches?: number;
  /** Как зовут компьютер в составе комнаты. */
  readonly name?: string;
  /** Как манера этой службы называется игроку в выборе соперника. */
  readonly title?: string;
  /**
   * Какой манерой играют все дежурные этой службы.
   *
   * Одна служба — одна манера. Дежурные различаются только порядковым
   * номером, и объяснять игроку, чем «Компьютер 2» отличается
   * от «Компьютера 3», было бы нечем; разные манеры показываются разными
   * комнатами.
   */
  readonly profile?: string;
  /**
   * Как выдаются идентификаторы дежурных.
   *
   * Случайные. Прежде этого хватало и как доказательства: идентификаторы
   * придумывал сервер, и назваться компьютером со стороны было
   * невозможно просто потому, что угадать их нельзя.
   *
   * Теперь доказывает не случайность, а **секрет**: служба объявляет свои
   * личности, предъявляя его, и сервер верит объявлению, а не догадке
   * о происхождении идентификатора. Случайность при этом остаётся —
   * она мешает случайному совпадению с прозвищем живого игрока.
   */
  readonly makeId: (index: number) => string;
  /**
   * Общий секрет, которым служба заверяет свои личности перед сервером.
   *
   * Не указан — служба не объявляется вовсе, и сервер её дежурных
   * компьютерными не считает. Это не поломка, а рабочий случай: так
   * ведут себя тесты, которым сервер нужен, а соперник нет.
   */
  readonly secret?: string;
  /** Как часто подтверждать, что служба жива, миллисекунды. */
  readonly refreshMs?: number;
  readonly log?: (message: string) => void;
  /**
   * Приборы раздумий. Отсутствуют — не меряется ничего.
   *
   * Одна служба — одна манера, поэтому размечать показания именем
   * профиля можно здесь, на службе, а не тянуть имя через каждого
   * дежурного.
   */
  readonly measure?: ParticipantMeasure | undefined;
}

export interface ComputerService {
  /** Принадлежит ли идентификатор этой службе. */
  owns(playerId: string): boolean;
  /**
   * Каким профилем играет этот дежурный. Чужой идентификатор — `undefined`.
   *
   * Тот же источник, что и `owns`, и это не удобство, а требование:
   * два обработчика — «это компьютер» и «вот его профиль» — однажды
   * разойдутся, и сторона запишется человеческой при живом компьютере.
   */
  profileOf(playerId: string): string | undefined;
  /** Сколько матчей ведётся сейчас. */
  readonly matchCount: number;
  /** Сколько дежурных поднято и ещё не отыграло. */
  readonly idleCount: number;
  close(): void;
}

interface Agent {
  readonly id: string;
  readonly name: string;
  /** В какую комнату он позван. */
  readonly lobbyId: string;
  /**
   * Запрос на вход уже отправлен, ответа ещё нет.
   *
   * Состояние приходит целиком и не мгновенно: между отправкой запроса
   * и приездом обновлённого состояния успевает прийти прежнее, где
   * дежурного в комнате ещё нет. Без этого флага он слал бы второй
   * запрос на вход туда, где уже сидит.
   */
  joining: boolean;
  match: Participant | null;
  matchKey: string | null;
  stop: () => void;
}

const DEFAULT_NAME = 'Компьютер';
const DEFAULT_TITLE = 'Матч с компьютером';

export const createComputerService = (options: ComputerServiceOptions): ComputerService => {
  // Тридцать два, а не восемь: матч обходится серверу примерно
  // в полторы миллисекунды процессорного времени на секунду реального,
  // так что упереться в счёт мы не рискуем. Зато упереться в предел
  // легко — брошенный матч держит своего дежурного до истечения отсрочки
  // на возврат, то есть полминуты после ухода игрока.
  const maxMatches = options.maxMatches ?? 32;
  const name = options.name ?? DEFAULT_NAME;
  const title = options.title ?? DEFAULT_TITLE;
  const profile = options.profile ?? DEFAULT_PROFILE_ID;
  // Пустой секрет считается отсутствующим: «задан, но пуст» и «не задан»
  // означают здесь одно и то же — сверять нечем.
  const secret = options.secret === undefined || options.secret === '' ? undefined : options.secret;
  const refreshMs = options.refreshMs ?? 20_000;

  const api: LobbyApi = createLobbyApi({
    apiUrl: options.apiUrl,
    fetch: options.fetch,
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  const agents = new Map<string, Agent>();
  /**
   * Все когда-либо выданные идентификаторы.
   *
   * Отдельно от живых дежурных: отыгравший агент уходит, а его сторона
   * в только что законченном матче обязана остаться помеченной
   * компьютерной. Иначе на экране итога соперник задним числом
   * превратился бы в человека.
   */
  const issued = new Set<string>();
  let nextIndex = 0;
  let closed = false;

  const matchCount = (): number =>
    [...agents.values()].filter((agent) => agent.match !== null).length;

  const idleCount = (): number =>
    [...agents.values()].filter((agent) => agent.match === null).length;

  const retire = (agent: Agent): void => {
    agent.match?.stop();
    agent.stop();
    agents.delete(agent.id);
    void api.leave(agent.id);
  };

  /**
   * Что делать с пришедшим состоянием.
   *
   * Обработчик идемпотентен: состояние приходит целиком, а не дельтой,
   * поэтому «уже сделано» распознаётся по самому состоянию, а не по
   * памяти о прошлых событиях. Событие можно потерять или получить
   * дважды — на итог это не влияет.
   */
  const react = (agent: Agent, view: PlayerView): void => {
    if (closed) return;

    const match = view.match;
    if (match !== null) {
      const key = match.matchId;
      if (agent.matchKey === key) return;

      agent.matchKey = key;
      agent.match = joinMatch({
        wsUrl: options.wsUrl,
        ticket: match.ticket,
        seed: match.seed,
        side: match.side,
        profile,
        openSocket: options.openSocket,
        ...(options.log === undefined ? {} : { log: options.log }),
        ...(options.measure === undefined ? {} : { measure: options.measure }),
        onOutcome: (outcome) => {
          options.log?.(
            `Компьютер ${agent.name}: матч ${key} окончен, победитель ${String(outcome.winner)}`,
          );
          // Отыграв, дежурный уходит совсем: следующего поднимет
          // следующее приглашение, а держать его без дела незачем.
          retire(agent);
        },
      });

      return;
    }

    const lobby = view.lobby;
    if (lobby === null) {
      // Дежурного в комнате нет. Либо он туда ещё не дошёл — тогда его
      // ведёт `joining`, — либо комната распалась, пока он шёл, и делать
      // ему больше нечего.
      if (agent.joining) return;

      options.log?.(`Компьютер ${agent.name}: комната ${agent.lobbyId} распалась`);
      retire(agent);
      return;
    }

    // Готовность подтверждается, как только есть с кем играть, и заново
    // после каждого сброса: решать компьютеру нечего, но обходить общее
    // правило старта по обоюдной готовности он не должен.
    const crowded = lobby.slots.length >= LOBBY_CAPACITY;
    const mine = lobby.slots.find((slot) => slot.you);
    if (crowded && mine !== undefined && !mine.ready) {
      void api.setReady(agent.id, true);
    }
  };

  /**
   * Что делать с приглашениями в общем списке комнат.
   *
   * Служба смотрит на тот же список, что и игроки, — своего канала
   * у неё нет и заводить его незачем: приглашение не секрет, а сам
   * список уже приходит потоком и уже обновляется сам.
   */
  const watch = (view: PlayerView): void => {
    if (closed) return;

    for (const room of view.lobbies) {
      if (room.wanted !== profile) continue;
      // В эту комнату уже идут или уже пришли. Состояние приходит
      // целиком и не мгновенно, и без этой проверки на каждый кадр
      // с непогасшим приглашением поднимался бы новый дежурный.
      if ([...agents.values()].some((agent) => agent.lobbyId === room.id)) continue;
      if (room.players >= LOBBY_CAPACITY) continue;
      if (agents.size >= maxMatches) {
        options.log?.(`Компьютер ${name}: мест нет, приглашение в ${room.id} пропущено`);
        continue;
      }

      hire(room.id);
    }
  };

  /**
   * Сказать серверу, кто мы такие.
   *
   * Объявляются все когда-либо выданные личности, а не только живые
   * дежурные: отыгравший агент уходит, а его сторона в только что
   * законченном матче обязана остаться помеченной компьютерной. Иначе
   * на экране итога соперник задним числом превратился бы в человека —
   * ровно та беда, ради которой `issued` и заведён отдельно от `agents`.
   */
  const announce = async (): Promise<void> => {
    if (closed || secret === undefined) return;

    // Личности и манера объявляются РАЗНЫМИ списками. Личности —
    // все когда-либо выданные, а не только живые: отыгравший агент
    // уходит, а его сторона в только что законченном матче обязана
    // остаться помеченной компьютерной, иначе на экране итога соперник
    // задним числом превратился бы в человека.
    //
    // Манера же объявляется ВСЕГДА, даже когда живых дежурных нет вовсе.
    // Их и не бывает, пока никто не позвал, — а список манер нужен игроку
    // ровно в этот момент, до приглашения.
    await api.declare(
      secret,
      [...issued].map((id) => ({ id, profile })),
      [{ id: profile, title }],
    );
  };

  const hire = (lobbyId: string): void => {
    const id = options.makeId(nextIndex);
    nextIndex += 1;

    const agent: Agent = {
      id,
      name: nextIndex === 1 ? name : `${name} ${String(nextIndex)}`,
      lobbyId,
      joining: true,
      match: null,
      matchKey: null,
      stop: () => undefined,
    };

    agents.set(id, agent);
    issued.add(id);
    agent.stop = api.listen(id, (view) => react(agent, view));
    options.log?.(`Компьютер ${agent.name} идёт в комнату ${lobbyId}`);

    // Объявляемся ПЕРЕД входом, а не после: сервер помечает комнату
    // компьютерной по объявленным личностям, и войди дежурный раньше
    // объявления — комната мелькнула бы в списке человеческой.
    void announce()
      .then(() => api.join(agent.id, agent.name, lobbyId))
      .then((entered) => {
        if (!entered) {
          options.log?.(`Компьютер ${agent.name}: войти в ${lobbyId} не вышло`);
          retire(agent);
        }
      })
      .finally(() => {
        agent.joining = false;
      });
  };

  /**
   * Служба начинается с рукопожатия.
   *
   * Пустое объявление — способ спросить «а меня вообще примут?», не
   * назвав ещё ни одной личности. Ответ решает, работать ли вообще.
   *
   * Почему это обязательно. Дежурный, чьё объявление сервер не принял,
   * всё равно вошёл бы в комнату — и встал бы в ней **непомеченным**,
   * то есть человеком на вид. Игрок сел бы играть с компьютером, думая,
   * что играет с человеком. Недоступная игра с компьютером —
   * неприятность; игра, которая врёт о сопернике, — поломка обещания,
   * на котором стоит вся спецификация `computer-player`.
   *
   * Поэтому при закрытой регистрации служба не смотрит на приглашения
   * вовсе, манеру не объявляет — и в выборе соперника её нет. Клиент
   * показывает игроку причину, как того требует «Отсутствие компьютера
   * видно, а не молчаливо».
   */
  let watcher: (() => void) | undefined;

  if (secret === undefined) {
    options.log?.(
      'Секрет не задан: служба не объявляется и приглашений не слушает. ' +
        'Игра с компьютером будет недоступна.',
    );
  } else {
    void api.declare(secret, [], [{ id: profile, title }]).then((accepted) => {
      if (closed) return;

      if (!accepted) {
        options.log?.(
          'Сервер не принял объявление службы: регистрация закрыта или секрет не тот. ' +
            'Приглашений не слушаю — иначе дежурный встал бы в комнате непомеченным.',
        );
        return;
      }

      // Один поток на всю службу, и он же — всё, что она тратит,
      // пока её не позвали.
      //
      // Личность у наблюдателя своя и НЕ объявляется компьютерной:
      // он ни в какую комнату не входит, а объявленная личность без
      // комнаты только мешала бы счёту живых дежурных. Отдельный номер
      // берётся из общего счётчика, чтобы не столкнуться с дежурным.
      const watcherId = `${options.makeId(nextIndex)}-watch`;
      nextIndex += 1;
      watcher = api.listen(watcherId, watch);
      options.log?.(`Компьютер ${name} ждёт приглашений манерой «${title}»`);
    });
  }

  /**
   * Подтверждать, что служба жива.
   *
   * Таймер помечен `unref`: он не должен держать процесс. Иначе тесты,
   * поднявшие службу, не завершились бы никогда — те же грабли, что
   * у таймеров реестра матчей.
   */
  const heartbeat =
    secret === undefined ? undefined : setInterval(() => void announce(), refreshMs);
  heartbeat?.unref?.();

  return {
    owns: (playerId) => issued.has(playerId),
    profileOf: (playerId) => (issued.has(playerId) ? profile : undefined),
    get matchCount() {
      return matchCount();
    },
    get idleCount() {
      return idleCount();
    },
    close() {
      // Снимаем объявление ДО того, как отметились закрытыми: `announce`
      // и `withdraw` молчат после `closed`, и порядок здесь решает,
      // исчезнет манера из выбора сразу или через минуту.
      //
      // Манера снимается всегда, а личности — если были: служба вправе
      // уйти, не подняв ни одного дежурного, и это обычный случай,
      // а не исключение.
      if (secret !== undefined) void api.withdraw(secret, [...issued], [profile]);

      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      watcher?.();
      for (const agent of [...agents.values()]) retire(agent);
    },
  };
};
