import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { Button, Panel, TextField } from '@td/ui';
import { NAME_MAX_LENGTH } from '@td/shared';
import type { LobbySummary } from '@td/protocol';
import { lobbyErrorText } from '../session/lobby-client.js';
import { useSessionStore } from '../session/session-store.js';
import { sessionActions } from '../session/session.js';
import { MenuShell } from './MenuShell.js';
import { ProfileBar } from './ProfileBar.js';

/**
 * Название комнаты по умолчанию.
 *
 * Двоеточие, а не «Комната Дмитрия», и это не вкусовщина. Родительный
 * падеж требует склонения, а склонение русских имён в общем виде
 * не делается: «Дмитрий» даёт «Дмитрия», «Илья» — «Ильи», «Ким»
 * не склоняется вовсе. Вдобавок игрок волен назваться ником, к которому
 * падежи неприменимы в принципе. Двоеточие снимает вопрос целиком.
 *
 * Длинное имя не должно приводить к отказу за длину названия, поэтому
 * при переполнении остаётся одно имя без приставки: игрок ничего
 * не вводил, и отказывать ему не за что.
 */
const defaultTitle = (name: string): string => {
  const full = `Комната: ${name}`;
  return full.length <= NAME_MAX_LENGTH ? full : name;
};

/**
 * Экран со списком комнат.
 *
 * Список живой: он обновляется потоком состояния, без кнопки
 * «обновить». Кнопка здесь была бы не удобством, а обманом — игрок
 * ломился бы в комнату, занятую полминуты назад.
 */
export const LobbyList = () => {
  const profile = useSessionStore((state) => state.profile);
  const lobbies = useSessionStore((state) => state.view.lobbies);
  const error = useSessionStore((state) => state.error);
  const joining = useSessionStore((state) => state.joiningComputer);
  // Компьютер держит открытую комнату наравне с людьми: нет комнаты —
  // нет и игры с ним, и сказать об этом надо прямо.
  const computerAvailable = useSessionStore((state) =>
    state.view.lobbies.some((lobby) => lobby.computer),
  );

  const [title, setTitle] = useState(() => defaultTitle(profile?.name ?? ''));
  const [busy, setBusy] = useState(false);

  const create = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    void sessionActions.createLobby(title).finally(() => setBusy(false));
  };

  return (
    <MenuShell aside={<RoomsPanel lobbies={lobbies} />}>
      <ProfileBar />

      <Panel title="Начать игру">
        <form onSubmit={create}>
          <div style={{ display: 'flex', gap: 'var(--td-space-2)', alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <TextField
                id="lobby-title"
                data-testid="lobby-title"
                label="Название комнаты"
                value={title}
                maxLength={NAME_MAX_LENGTH}
                autoComplete="off"
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <Button type="submit" data-testid="lobby-create" disabled={busy}>
              Создать
            </Button>
          </div>
        </form>

        <div
          style={{
            marginTop: 'var(--td-space-3)',
            paddingTop: 'var(--td-space-3)',
            borderTop: '1px solid var(--td-border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--td-space-3)',
          }}
        >
          <span style={{ color: 'var(--td-text-muted-3)', fontSize: 'var(--td-text-sm)' }}>
            {computerAvailable
              ? 'Соперника нет под рукой? Сыграйте против компьютера.'
              : 'Компьютерный соперник сейчас недоступен: его служба не отвечает.'}
          </span>
          <Button
            variant="ghost"
            data-testid="practice-start"
            // Кнопка, которая на нажатие не отвечает ничем, хуже
            // отсутствующей: игрок решит, что сломана игра.
            disabled={busy || joining || !computerAvailable}
            onClick={() => {
              void sessionActions.playAgainstComputer();
            }}
          >
            {joining ? 'Входим…' : 'Играть с компьютером'}
          </Button>
        </div>
      </Panel>

      {error !== null && (
        <div data-testid="lobby-error" style={{ color: 'var(--td-error)' }}>
          {lobbyErrorText[error]}
        </div>
      )}
    </MenuShell>
  );
};

/**
 * Колонка открытых комнат — справа от меню и постоянного размера.
 *
 * Размер постоянен намеренно. Список меняется сам, без действий игрока,
 * и растущая панель двигала бы кнопки меню ровно в тот момент, когда
 * игрок в них целится. Комнаты сверх помещающихся прокручиваются
 * внутри списка; заголовок с их числом при этом остаётся на месте.
 */
const RoomsPanel = ({ lobbies }: { lobbies: readonly LobbySummary[] }) => (
  <Panel
    title={`Открытые комнаты — ${String(lobbies.length)}`}
    data-testid="lobby-panel"
    style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}
  >
    <div className="td-menu-scroll">
      {lobbies.length === 0 ? (
        <p
          data-testid="lobby-empty"
          style={{ margin: 0, color: 'var(--td-text-muted-3)', lineHeight: 1.6 }}
        >
          Пока никто не ждёт соперника. Создайте комнату — она сразу появится у всех, кто смотрит на
          этот список.
        </p>
      ) : (
        <div
          data-testid="lobby-list"
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--td-space-2)' }}
        >
          {lobbies.map((lobby) => (
            <LobbyRow key={lobby.id} lobby={lobby} />
          ))}
        </div>
      )}
    </div>
  </Panel>
);

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--td-space-3)',
  padding: 'var(--td-space-2) var(--td-space-3)',
  background: 'var(--td-bg-content)',
  border: '1px solid var(--td-border-subtle)',
  borderRadius: 'var(--td-radius-control)',
};

/**
 * Строка в одну линию с многоточием.
 *
 * Обе подписи строки урезаются, а не переносятся: строка комнаты обязана
 * быть одной и той же высоты при любом названии и любом имени хозяина.
 * Иначе шесть комнат занимают то четыре строки, то шесть, и список
 * то помещается в колонку, то нет.
 */
const clipStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const LobbyRow = ({ lobby }: { lobby: LobbySummary }) => {
  const full = lobby.players >= lobby.capacity;

  return (
    <div style={rowStyle} data-testid="lobby-row" data-computer={String(lobby.computer)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={clipStyle} data-testid="lobby-row-title">
          {lobby.title}
        </span>
        <span
          style={{
            display: 'flex',
            gap: 'var(--td-space-1)',
            color: 'var(--td-text-muted-4)',
            fontSize: 'var(--td-text-sm)',
          }}
        >
          <span style={clipStyle}>создал {lobby.hostName}</span>

          {/* Пометка обязательна: игрок должен знать, с кем садится
              играть, а «Компьютер» вполне может оказаться прозвищем
              человека. Поэтому урезается имя хозяина, а не она: длинное
              имя иначе съедало бы её многоточием целиком. */}
          {lobby.computer && (
            <span style={{ flexShrink: 0 }} data-testid="lobby-row-computer">
              — компьютер
            </span>
          )}
        </span>
      </div>

      {/* Правая половина не сжимается: заполненность и кнопка входа —
          то, ради чего строку читают, и подрезать их в пользу названия
          нельзя. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--td-space-3)',
          flexShrink: 0,
        }}
      >
        <span
          data-testid="lobby-row-players"
          style={{
            fontFamily: 'var(--td-font-mono)',
            whiteSpace: 'nowrap',
            color: full ? 'var(--td-text-muted-4)' : 'var(--td-accent)',
          }}
        >
          {lobby.players} / {lobby.capacity}
        </span>

        <Button
          data-testid="lobby-join"
          disabled={full}
          // Заполненная комната не исчезает из списка, а показывается
          // недоступной: игрок должен видеть, что комната есть и что
          // места в ней кончились, а не гадать, куда она делась.
          variant={full ? 'ghost' : 'accent'}
          onClick={() => {
            void sessionActions.joinLobby(lobby.id);
          }}
        >
          {full ? 'Занято' : 'Войти'}
        </Button>
      </div>
    </div>
  );
};
