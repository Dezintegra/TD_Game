import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Panel, TextField } from '@td/ui';
import { NAME_MAX_LENGTH } from '@td/shared';
import { nameErrorText } from '../session/profile.js';
import { sessionActions } from '../session/session.js';
import { MenuShell } from './MenuShell.js';

/**
 * Экран представления — первое, что видит человек.
 *
 * Обходных путей отсюда нет намеренно: ни «войти гостем», ни
 * «пропустить». Безымянного игрока некуда поместить в списке комнат,
 * и соперник, увидевший там пустую строку, не поймёт, с кем играет.
 *
 * Проверка имени идёт на клиенте и отвечает в том же кадре: её исход
 * зависит только от введённой строки, и ждать ради него оборота пакета
 * незачем. Сервер проверит то же самое ещё раз тем же правилом
 * из `@td/shared` — клиенту он не верит.
 */
export const ProfileGate = () => {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    const rejected = sessionActions.identify(name);
    setError(rejected === null ? undefined : nameErrorText[rejected]);
  };

  return (
    <MenuShell>
      <Panel title="Как вас звать">
        <form onSubmit={submit} data-testid="profile-form">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--td-space-3)' }}>
            <TextField
              id="profile-name"
              data-testid="profile-name"
              label="Имя"
              value={name}
              error={error}
              autoFocus
              autoComplete="off"
              // Ограничение поля, а не только проверки: подрезать ввод
              // на месте честнее, чем принять двадцать пятый символ
              // и отказать за него после нажатия.
              maxLength={NAME_MAX_LENGTH}
              placeholder="Например, Аня"
              onChange={(event) => {
                setName(event.target.value);
                // Причина отказа снимается при первой же правке: она
                // относилась к прежнему вводу, а не к текущему.
                setError(undefined);
              }}
            />

            <Button type="submit" data-testid="profile-submit">
              Продолжить
            </Button>
          </div>
        </form>

        <p
          style={{
            marginTop: 'var(--td-space-3)',
            marginBottom: 0,
            color: 'var(--td-text-muted-4)',
            fontSize: 'var(--td-text-sm)',
            lineHeight: 1.6,
          }}
        >
          Имя сохранится в этом браузере и будет видно сопернику. Ни пароля, ни почты не требуется —
          профиль можно удалить и завести заново в любой момент.
        </p>
      </Panel>
    </MenuShell>
  );
};
