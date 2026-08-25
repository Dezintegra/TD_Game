/**
 * Рукопожатие с игровым сервером.
 *
 * Служба живёт в своём процессе и поднимается когда придётся: в compose
 * оба контейнера стартуют разом, а на машине разработчика сервер вообще
 * может подняться позже. Значит, первое объявление почти наверняка
 * придётся на неготовый сервер.
 *
 * Падать при этом нельзя. Перезапуск по кругу шумит в журнале и ничего
 * не чинит — а под `restart: unless-stopped` он ещё и вечен. Поэтому
 * служба ждёт с нарастающей паузой, тем же способом, каким
 * переподключается клиент.
 *
 * Почему рукопожатие вообще нужно, а не «объявлюсь заодно с первым
 * дежурным». Дежурный, чьё объявление сервер не принял, всё равно создал
 * бы комнату — и она встала бы в списке НЕПОМЕЧЕННОЙ, то есть
 * человеческой на вид. Игрок сел бы играть с компьютером, думая, что
 * играет с человеком. Недоступная игра с компьютером — неприятность;
 * игра, которая врёт о сопернике, — поломка обещания, на котором стоит
 * вся спецификация `computer-player`.
 */

/**
 * Что ответил сервер.
 *
 * Три исхода, а не два, и различать их обязательно: «не достучался»
 * лечится ожиданием, «не принял» — нет. Свалив их в одно `false`,
 * мы получили бы либо вечное молчание при неверном секрете, либо отказ
 * работать из-за того, что сервер поднимается на секунду дольше.
 */
export type Answer = 'accepted' | 'refused' | 'unreachable';

/** Минимум от `fetch`, который нужен объявлению. Внедряется ради тестов. */
export type PostLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ readonly ok: boolean }>;

export interface OfferOptions {
  readonly apiUrl: string;
  readonly secret: string;
  readonly post: PostLike;
}

/**
 * Одна попытка объявиться, ничего ещё не назвав.
 *
 * Объявление пустое: это вопрос «а меня примут?», а не заявка на
 * личности. Личности назовёт сама служба, когда наймёт первого
 * дежурного, — и назовёт по тому же самому пути.
 */
export const offerDeclaration = async (options: OfferOptions): Promise<Answer> => {
  try {
    const response = await options.post(`${options.apiUrl}/api/computer/declare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: options.secret, identities: [] }),
    });

    return response.ok ? 'accepted' : 'refused';
  } catch {
    // Сюда попадает и «соединение отвергнуто», и «имя не разрешается»,
    // и оборванный ответ. Все они лечатся одним и тем же — ожиданием.
    return 'unreachable';
  }
};

/**
 * Сколько ждать перед следующей попыткой.
 *
 * Растёт вдвое до минуты и на минуте останавливается. Потолок нужен
 * ровно затем, чтобы служба, дождавшаяся сервера через час, поднялась
 * в течение полуминуты после его появления, а не через час после.
 */
export const BACKOFF_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export const pauseBefore = (attempt: number, schedule: readonly number[] = BACKOFF_MS): number =>
  schedule[Math.min(attempt, schedule.length - 1)] ?? 0;

export interface AwaitOptions {
  /** Одна попытка объявиться. */
  readonly offer: () => Promise<Answer>;
  readonly wait: (ms: number) => Promise<void>;
  readonly log: (message: string) => void;
  /** Пора ли бросить ожидание: служба получила сигнал и уходит. */
  readonly stopped?: () => boolean;
  readonly schedule?: readonly number[];
}

const REASONS: Readonly<Record<Exclude<Answer, 'accepted'>, string>> = {
  unreachable: 'Сервер пока не отвечает. Жду и пробую снова.',
  refused:
    'Сервер не принял объявление: регистрация закрыта или секрет не тот. ' +
    'Дежурных не поднимаю — иначе их комнаты встали бы непомеченными.',
};

/**
 * Дождаться согласия сервера.
 *
 * Возвращает `true`, когда объявление принято, и `false`, когда ждать
 * перестали по сигналу.
 *
 * **Про журнал.** Причина называется при первой неудаче и потом только
 * при её смене. Строка в минуту про один и тот же неотвечающий сервер —
 * это не сведения, а шум, сквозь который перестают читать и настоящие
 * сообщения. Смена причины, наоборот, сведение важное: «не отвечал,
 * а теперь отказывает» означает, что сервер поднялся с другим секретом.
 */
export const awaitAcceptance = async (options: AwaitOptions): Promise<boolean> => {
  let attempt = 0;
  let said: Answer | undefined;

  for (;;) {
    if (options.stopped?.() === true) return false;

    const answer = await options.offer();
    if (answer === 'accepted') {
      if (attempt > 0) options.log(`Объявление принято с ${String(attempt + 1)}-й попытки.`);
      return true;
    }

    if (answer !== said) {
      options.log(REASONS[answer]);
      said = answer;
    }

    await options.wait(pauseBefore(attempt, options.schedule));
    attempt += 1;
  }
};
