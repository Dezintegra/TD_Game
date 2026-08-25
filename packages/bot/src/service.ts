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
 * Устройство самое прямолинейное из возможных: компьютер держит в списке
 * открытую комнату наравне с людьми и ждёт, пока кто-нибудь войдёт.
 * Никакого особого пути в матч у него нет — ни заявки, ни подстановки
 * второго участника сервером. Значит, и в сервере нет ветки «а этот
 * участник ненастоящий», которая иначе разрослась бы до второго,
 * незаметно расходящегося с первым, устройства матча.
 *
 * Дежурных несколько, потому что игрок не может состоять больше чем
 * в одной комнате: одна личность — одна комната. Как только в комнату
 * дежурного вошёл гость, служба поднимает следующего дежурного, не
 * дожидаясь старта матча. Это ради гонки: двое, нажавшие «играть
 * с компьютером» одновременно, иначе получили бы один отказ «комната
 * занята» на двоих.
 */

export interface ComputerServiceOptions {
  readonly apiUrl: string;
  readonly wsUrl: string;
  readonly fetch: FetchLike;
  readonly openSocket: OpenSocket;
  /** Сколько матчей служба ведёт одновременно. */
  readonly maxMatches?: number;
  /**
   * Сколько свободных дежурных держать наготове.
   *
   * Один — минимум, при котором игра с компьютером вообще возможна,
   * и он же источник гонок: двое, нажавшие одновременно, дерутся
   * за единственную комнату, и одному достаётся отказ. Держать
   * про запас дешевле, чем разбирать этот отказ на стороне клиента.
   */
  readonly idleTarget?: number;
  /** Как зовут компьютер в списке комнат. */
  readonly name?: string;
  /** Как называется его комната. */
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
  /** Сколько дежурных ждёт соперника. */
  readonly idleCount: number;
  close(): void;
}

interface Agent {
  readonly id: string;
  readonly name: string;
  /** Занята ли его комната гостем. */
  crowded: boolean;
  /**
   * Запрос на создание комнаты уже отправлен, ответа ещё нет.
   *
   * Состояние приходит целиком и не мгновенно, поэтому между отправкой
   * запроса и приездом обновлённого состояния успевает прийти прежнее,
   * где комнаты ещё нет. Без этого флага дежурный создавал бы вторую
   * комнату, тут же выходя из первой.
   */
  creating: boolean;
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
  const idleTarget = Math.max(1, Math.min(options.idleTarget ?? 3, maxMatches));
  const name = options.name ?? DEFAULT_NAME;
  const title = options.title ?? DEFAULT_TITLE;
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
    [...agents.values()].filter((agent) => agent.match === null && !agent.crowded).length;

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
        ...(options.profile === undefined ? {} : { profile: options.profile }),
        openSocket: options.openSocket,
        ...(options.log === undefined ? {} : { log: options.log }),
        ...(options.measure === undefined ? {} : { measure: options.measure }),
        onOutcome: (outcome) => {
          options.log?.(
            `Компьютер ${agent.name}: матч ${key} окончен, победитель ${String(outcome.winner)}`,
          );
          // Отыграв, дежурный уходит: свободного места в комнате у него
          // больше нет, а новых поднимет `refill`.
          retire(agent);
          refill();
        },
      });

      refill();
      return;
    }

    const lobby = view.lobby;
    if (lobby === null) {
      // Комнаты нет — значит, её ещё не создали или она распалась.
      if (agent.creating) return;

      agent.creating = true;
      void api.create(agent.id, agent.name, title).finally(() => {
        agent.creating = false;
      });
      return;
    }

    const crowded = lobby.slots.length >= LOBBY_CAPACITY;
    if (crowded !== agent.crowded) {
      agent.crowded = crowded;
      // Следующий дежурный поднимается по факту входа гостя, а не
      // по старту матча: окно, в котором свободной комнаты нет вовсе,
      // должно быть как можно короче.
      if (crowded) refill();
    }

    // Готовность подтверждается, как только есть с кем играть, и заново
    // после каждого сброса: решать компьютеру нечего, но обходить общее
    // правило старта по обоюдной готовности он не должен.
    const mine = lobby.slots.find((slot) => slot.you);
    if (crowded && mine !== undefined && !mine.ready) {
      void api.setReady(agent.id, true);
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
    if (closed || secret === undefined || issued.size === 0) return;

    await api.declare(
      secret,
      [...issued].map((id) => ({ id, profile: options.profile ?? DEFAULT_PROFILE_ID })),
    );
  };

  const hire = (): void => {
    const id = options.makeId(nextIndex);
    nextIndex += 1;

    const agent: Agent = {
      id,
      name: nextIndex === 1 ? name : `${name} ${String(nextIndex)}`,
      crowded: false,
      creating: false,
      match: null,
      matchKey: null,
      stop: () => undefined,
    };

    agents.set(id, agent);
    issued.add(id);
    agent.stop = api.listen(id, (view) => react(agent, view));
    options.log?.(`Компьютер ${agent.name} дежурит`);

    // Объявляемся сразу за наймом, а не только по таймеру: между
    // созданием дежурного и первым обновлением проходят секунды,
    // и всё это время его комната стояла бы непомеченной — то есть
    // выглядела бы человеческой.
    void announce();
  };

  /**
   * Держать ровно одного свободного дежурного, пока есть место.
   *
   * Предел считается по числу дежурных, а не по числу идущих матчей,
   * и это не мелочь: агент, к которому уже вошёл гость, матча ещё
   * не начал, но и свободным больше не является. Считай мы только матчи,
   * служба нанимала бы нового дежурного на каждого вошедшего и уехала бы
   * за предел ровно в тот момент, когда её об этом просят чаще всего.
   */
  const refill = (): void => {
    if (closed) return;

    while (idleCount() < idleTarget && agents.size < maxMatches) hire();
  };

  /**
   * Служба начинается с рукопожатия, а не с найма.
   *
   * Пустое объявление — способ спросить «а меня вообще примут?», не
   * назвав ещё ни одной личности. Ответ решает, работать ли вообще.
   *
   * Почему это обязательно. Дежурный, чьё объявление сервер не принял,
   * всё равно создал бы комнату — и она встала бы в списке
   * **непомеченной**, то есть человеческой на вид. Игрок сел бы играть
   * с компьютером, думая, что играет с человеком. Недоступная игра
   * с компьютером — неприятность; игра, которая врёт о сопернике, —
   * поломка обещания, на котором стоит вся спецификация
   * `computer-player`.
   *
   * Поэтому при закрытой регистрации служба не поднимает никого,
   * а список комнат остаётся пустым — и клиент показывает игроку
   * причину, как того требует «Отсутствие компьютера видно,
   * а не молчаливо».
   */
  if (secret === undefined) {
    options.log?.(
      'Секрет не задан: служба не объявляется и дежурных не поднимает. ' +
        'Игра с компьютером будет недоступна.',
    );
  } else {
    void api.declare(secret, []).then((accepted) => {
      if (closed) return;

      if (!accepted) {
        options.log?.(
          'Сервер не принял объявление службы: регистрация закрыта или секрет не тот. ' +
            'Дежурных не поднимаю — иначе их комнаты встали бы непомеченными.',
        );
        return;
      }

      refill();
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
    profileOf: (playerId) =>
      issued.has(playerId) ? (options.profile ?? DEFAULT_PROFILE_ID) : undefined,
    get matchCount() {
      return matchCount();
    },
    get idleCount() {
      return idleCount();
    },
    close() {
      // Снимаем объявление ДО того, как отметились закрытыми: `announce`
      // и `withdraw` молчат после `closed`, и порядок здесь решает,
      // исчезнут комнаты сразу или через минуту.
      if (secret !== undefined && issued.size > 0) void api.withdraw(secret, [...issued]);

      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      for (const agent of [...agents.values()]) retire(agent);
    },
  };
};
