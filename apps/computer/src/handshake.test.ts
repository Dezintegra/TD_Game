import { describe, expect, it } from 'vitest';
import { BACKOFF_MS, awaitAcceptance, offerDeclaration, pauseBefore } from './handshake.js';
import type { Answer } from './handshake.js';

/**
 * Проверяется поведение службы при неготовом сервере.
 *
 * Ожидание здесь поддельное: настоящие паузы превратили бы проверку
 * в полминуты сна ради трёх утверждений. Вместо этого записываются
 * длительности, о которых ожидание попросили, — величина проверяемая
 * и ровно та, ради которой всё написано.
 */

const collectingWait = (): { readonly pauses: number[]; wait: (ms: number) => Promise<void> } => {
  const pauses: number[] = [];
  return { pauses, wait: (ms) => (pauses.push(ms), Promise.resolve()) };
};

describe('объявление службы', () => {
  it('отличает недоступный сервер от отказавшего', async () => {
    const unreachable = await offerDeclaration({
      apiUrl: 'http://nowhere',
      secret: 'тайна',
      post: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(unreachable).toBe('unreachable');

    const refused = await offerDeclaration({
      apiUrl: 'http://nowhere',
      secret: 'не та',
      post: () => Promise.resolve({ ok: false }),
    });
    expect(refused).toBe('refused');

    const accepted = await offerDeclaration({
      apiUrl: 'http://nowhere',
      secret: 'тайна',
      post: () => Promise.resolve({ ok: true }),
    });
    expect(accepted).toBe('accepted');
  });

  it('объявляется пустым составом: это вопрос, а не заявка', async () => {
    let sent = '';
    await offerDeclaration({
      apiUrl: 'http://сервер',
      secret: 'тайна',
      post: (url, init) => {
        expect(url).toBe('http://сервер/api/computer/declare');
        sent = init.body;
        return Promise.resolve({ ok: true });
      },
    });

    expect(JSON.parse(sent)).toEqual({ secret: 'тайна', identities: [] });
  });
});

describe('ожидание сервера', () => {
  it('дожидается сервера, а не падает при первой неудаче', async () => {
    const answers: Answer[] = ['unreachable', 'unreachable', 'unreachable', 'accepted'];
    const { pauses, wait } = collectingWait();

    const accepted = await awaitAcceptance({
      offer: () => Promise.resolve(answers.shift() ?? 'accepted'),
      wait,
      log: () => undefined,
    });

    expect(accepted).toBe(true);
    expect(pauses).toEqual([500, 1_000, 2_000]);
  });

  it('пауза растёт и упирается в потолок', () => {
    expect(pauseBefore(0)).toBe(500);
    expect(pauseBefore(1)).toBe(1_000);
    // За потолком расписание повторяет последнее значение, а не растёт
    // дальше: служба, дождавшаяся сервера через час, обязана подняться
    // в течение полуминуты после его появления, а не через час.
    expect(pauseBefore(99)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]);
  });

  it('о причине говорит один раз, а не каждую попытку', async () => {
    const answers: Answer[] = ['unreachable', 'unreachable', 'refused', 'refused', 'accepted'];
    const said: string[] = [];
    const { wait } = collectingWait();

    await awaitAcceptance({
      offer: () => Promise.resolve(answers.shift() ?? 'accepted'),
      wait,
      log: (message) => said.push(message),
    });

    // Две причины подряд по два раза — две строки о причинах. Строка
    // в минуту про один и тот же неотвечающий сервер это не сведения,
    // а шум, сквозь который перестают читать и настоящие сообщения.
    const reasons = said.filter((message) => !message.startsWith('Объявление принято'));
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('не отвечает');
    expect(reasons[1]).toContain('регистрация закрыта');
  });

  it('бросает ожидание, когда служба уходит по сигналу', async () => {
    let leaving = false;
    const { wait } = collectingWait();

    const accepted = await awaitAcceptance({
      offer: () => {
        leaving = true;
        return Promise.resolve<Answer>('unreachable');
      },
      wait,
      log: () => undefined,
      stopped: () => leaving,
    });

    expect(accepted).toBe(false);
  });
});
