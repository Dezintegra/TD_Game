import { describe, expect, it } from 'vitest';
import {
  collectTokenLimits,
  effectiveTokenLimit,
  readTokenLimitCommand,
} from './user-token-limit.mjs';

const action = (text = 'Лимит токенов: 35000000', over = {}) => ({
  id: 'a1',
  date: '2026-09-07T10:00:00Z',
  idMemberCreator: 'owner',
  appCreator: null,
  agenticIdentity: null,
  data: { card: { id: 'card1' }, text },
  ...over,
});

describe('пользовательский лимит', () => {
  it('принимает полный бюджет и явный возврат общего', () => {
    expect(readTokenLimitCommand(action(), 'owner')).toMatchObject({
      value: 35000000,
      actionId: 'a1',
    });
    expect(readTokenLimitCommand(action('Лимит токенов: общий'), 'owner')).toMatchObject({
      value: null,
    });
  });

  it.each([
    { appCreator: { id: 'pipeline', authType: 'appKeyToken' } },
    { appCreator: undefined },
    { idMemberCreator: 'other' },
    { agenticIdentity: { id: 'agent' } },
  ])('отвергает нечеловеческое или неизвестное происхождение %j', (over) => {
    expect(readTokenLimitCommand(action(undefined, over), 'owner')).toBeNull();
  });

  it.each([
    'продолжай',
    'Разрешаю повысить лимит до 35000000',
    '🤖 Лимит токенов: 35000000',
    '> Лимит токенов: 35000000',
  ])('не толкует свободный текст как разрешение: %s', (text) => {
    expect(readTokenLimitCommand(action(text), 'owner')).toBeNull();
  });

  it.each(['0', '-1', '1.5', '35e6', '9007199254740992', 'null', '35000000\nпродолжай', ''])(
    'удерживает неверную команду %s',
    (raw) => {
      expect(readTokenLimitCommand(action(`Лимит токенов: ${raw}`), 'owner').error).toContain(
        'Неверный',
      );
    },
  );

  it('выбирает новую команду независимо от страницы, не наследует чужую', () => {
    const limits = {};
    collectTokenLimits(
      limits,
      [action('Лимит токенов: общий', { id: 'a2', date: '2026-09-08T00:00:00Z' })],
      'owner',
    );
    collectTokenLimits(limits, [action()], 'owner');
    expect(limits.card1.value).toBeNull();
    expect(limits.card2).toBeUndefined();
  });

  it('не скрывает новую ошибку старым разрешением', () => {
    const limits = {};
    collectTokenLimits(
      limits,
      [action(), action('Лимит токенов: -1', { id: 'a2', date: '2026-09-08T00:00:00Z' })],
      'owner',
    );
    expect(limits.card1.error).toBeTruthy();
  });

  it('выбирает индивидуальный предел, включая отключённый общий', () => {
    expect(
      effectiveTokenLimit({ userTokenLimit: { value: 35 } }, { codexMaxTaskTokens: null }).value,
    ).toBe(35);
    expect(
      effectiveTokenLimit({ userTokenLimit: { value: null } }, { codexMaxTaskTokens: 25 }).value,
    ).toBe(25);
    expect(effectiveTokenLimit({}, { codexMaxTaskTokens: null }).value).toBeNull();
  });
});
