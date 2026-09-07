export const TOKEN_LIMIT_PREFIX = 'Лимит токенов:';

/** Только явное действие владельца в Trello, не текст, переданный агентом. */
export function readTokenLimitCommand(action, ownerId) {
  if (
    !ownerId ||
    action.idMemberCreator !== ownerId ||
    action.appCreator !== null ||
    action.agenticIdentity != null ||
    !action.id ||
    !action.data?.card?.id ||
    !Number.isFinite(Date.parse(action.date))
  )
    return null;
  const text = String(action.data?.text ?? '').trim();
  if (!text.startsWith(TOKEN_LIMIT_PREFIX)) return null;
  const raw = text.slice(TOKEN_LIMIT_PREFIX.length).trim();
  const value = raw === 'общий' ? null : Number(raw);
  const valid =
    raw === 'общий' || (/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(value) && value > 0);
  return {
    actionId: action.id,
    at: action.date,
    value: valid ? value : null,
    ...(valid
      ? {}
      : {
          error:
            'Неверный лимит токенов. Напишите новым комментарием «Лимит токенов: 35000000» ' +
            '(полный бюджет, положительное целое) или «Лимит токенов: общий».',
        }),
  };
}

/** История приходит страницами от новой к старой; порядок внутри не предполагается. */
export function collectTokenLimits(target, actions, ownerId) {
  for (const action of actions) {
    const command = readTokenLimitCommand(action, ownerId);
    if (!command) continue;
    const cardId = action.data.card.id;
    const previous = target[cardId];
    if (
      !previous ||
      Date.parse(command.at) > Date.parse(previous.at) ||
      (command.at === previous.at && command.actionId > previous.actionId)
    )
      target[cardId] = command;
  }
}

/** Производное поле снимка не сериализуется в карточку и не берётся из отчёта. */
export function effectiveTokenLimit(task, config) {
  const command = task?.userTokenLimit;
  if (command?.error) return { value: null, error: command.error, source: 'user' };
  if (command?.value != null) {
    if (!Number.isSafeInteger(command.value) || command.value <= 0)
      return { value: null, error: 'Неверный индивидуальный лимит токенов', source: 'user' };
    return { value: command.value, error: null, source: 'user' };
  }
  return { value: config.codexMaxTaskTokens ?? null, error: null, source: 'config' };
}
