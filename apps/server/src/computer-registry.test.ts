import { describe, expect, it } from 'vitest';
import { createComputerRegistry } from './computer-registry.js';

/**
 * Реестр отвечает на вопрос «этот игрок — компьютер?».
 *
 * Вопрос не праздный: от ответа зависит пометка комнаты и запись манеры
 * в записи матча. Соврать здесь значит соврать игроку о том, с кем он
 * играет, поэтому проверяется не только то, что реестр отвечает,
 * но и то, что подделать ответ нельзя.
 */

const SECRET = 'секрет-службы';
const swarm = [{ id: 'computer-1', profile: 'swarm' }];

describe('реестр компьютерных личностей', () => {
  it('объявленная личность узнаётся вместе с манерой', () => {
    const registry = createComputerRegistry({ secret: SECRET });

    expect(registry.declare(SECRET, swarm)).toBe(true);
    expect(registry.profileOf('computer-1')).toBe('swarm');
    expect(registry.available).toBe(true);
  });

  it('чужой идентификатор компьютерным не считается', () => {
    const registry = createComputerRegistry({ secret: SECRET });
    registry.declare(SECRET, swarm);

    expect(registry.profileOf('человек-7')).toBeUndefined();
  });

  it('без верного секрета объявление отвергается', () => {
    // Иначе назваться компьютером мог бы кто угодно — и игроку
    // солгали бы о том, с кем он играет.
    const registry = createComputerRegistry({ secret: SECRET });

    expect(registry.declare('', swarm)).toBe(false);
    expect(registry.declare('не тот секрет', swarm)).toBe(false);
    expect(registry.profileOf('computer-1')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('пустой секрет закрывает регистрацию, а не открывает её всем', () => {
    // Самая опасная из возможных ошибок здесь: «секрет не задан»
    // прочитанное как «сверять нечего».
    const registry = createComputerRegistry({});

    expect(registry.declare('', swarm)).toBe(false);
    expect(registry.declare('что угодно', swarm)).toBe(false);
    expect(registry.available).toBe(false);
  });

  it('объявление протухает без обновления', () => {
    let ms = 1000;
    const registry = createComputerRegistry({ secret: SECRET, ttlMs: 5000, now: () => ms });
    registry.declare(SECRET, swarm);

    ms += 4999;
    expect(registry.profileOf('computer-1')).toBe('swarm');

    ms += 2;
    // Служба ушла, не попрощавшись. Без срока сервер вечно показывал бы
    // комнаты процесса, которого больше нет.
    expect(registry.profileOf('computer-1')).toBeUndefined();
    expect(registry.available).toBe(false);
  });

  it('обновление продлевает срок', () => {
    let ms = 1000;
    const registry = createComputerRegistry({ secret: SECRET, ttlMs: 5000, now: () => ms });
    registry.declare(SECRET, swarm);

    ms += 4000;
    registry.declare(SECRET, swarm);
    ms += 4000;

    expect(registry.profileOf('computer-1')).toBe('swarm');
  });

  it('уход по-хорошему убирает личности сразу', () => {
    // Игрок не должен минуту смотреть на комнату, в которую никто
    // не войдёт.
    const registry = createComputerRegistry({ secret: SECRET });
    registry.declare(SECRET, swarm);

    expect(registry.withdraw(SECRET, ['computer-1'])).toBe(true);
    expect(registry.available).toBe(false);
  });

  it('снять чужое объявление без секрета нельзя', () => {
    const registry = createComputerRegistry({ secret: SECRET });
    registry.declare(SECRET, swarm);

    expect(registry.withdraw('не тот секрет', ['computer-1'])).toBe(false);
    expect(registry.profileOf('computer-1')).toBe('swarm');
  });

  it('манера объявляется без единой личности', () => {
    // Главное свойство после отказа от дежурных: их не бывает, пока
    // никого не позвали, а список манер нужен игроку ровно в этот
    // момент — ДО приглашения. Объяви мы манеры через личности, список
    // был бы пуст именно тогда, когда он нужен.
    const registry = createComputerRegistry({ secret: SECRET });

    expect(registry.declare(SECRET, [], [{ id: 'swarm', title: 'Матч с компьютером' }])).toBe(true);
    expect(registry.profiles).toEqual([{ id: 'swarm', title: 'Матч с компьютером' }]);
    expect(registry.size).toBe(0);
  });

  it('манера протухает без обновления, как и личности', () => {
    // Служба вправе уйти не попрощавшись. Без срока игроку вечно
    // предлагали бы соперника, которого некому прислать.
    let ms = 1000;
    const registry = createComputerRegistry({ secret: SECRET, ttlMs: 5000, now: () => ms });
    registry.declare(SECRET, [], [{ id: 'swarm', title: 'Матч с компьютером' }]);

    ms += 4999;
    expect(registry.profiles).toHaveLength(1);

    ms += 2;
    expect(registry.profiles).toEqual([]);
  });

  it('манера снимается отдельным списком, а не вместе с личностями', () => {
    // Служба вправе уйти, не подняв ни одного дежурного, — и тогда
    // снимать по личностям было бы нечего.
    const registry = createComputerRegistry({ secret: SECRET });
    registry.declare(SECRET, [], [{ id: 'swarm', title: 'Матч с компьютером' }]);

    expect(registry.withdraw(SECRET, [])).toBe(true);
    expect(registry.profiles).toHaveLength(1);

    expect(registry.withdraw(SECRET, [], ['swarm'])).toBe(true);
    expect(registry.profiles).toEqual([]);
  });

  it('манеры разных служб не путаются', () => {
    const registry = createComputerRegistry({ secret: SECRET });
    registry.declare(SECRET, [
      { id: 'computer-1', profile: 'swarm' },
      { id: 'computer-2', profile: 'bulwark' },
    ]);

    expect(registry.profileOf('computer-1')).toBe('swarm');
    expect(registry.profileOf('computer-2')).toBe('bulwark');
    expect(registry.size).toBe(2);
  });
});
