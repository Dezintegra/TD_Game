import type { CSSProperties } from 'react';
import { Button, Panel } from '@td/ui';
import { LOBBY_CAPACITY } from '@td/protocol';
import type { LobbySlotView } from '@td/protocol';
import { lobbyErrorText } from '../session/lobby-client.js';
import { readyOf, useSessionStore } from '../session/session-store.js';
import { sessionActions } from '../session/session.js';
import { MenuShell } from './MenuShell.js';
import { ProfileBar } from './ProfileBar.js';

/**
 * Комната: двое видят друг друга и договариваются начать.
 *
 * Готовность каждого видна обоим — игрок обязан понимать, ждут его
 * или он ждёт. Своё нажатие перекрашивает кнопку немедленно, до ответа
 * сервера: отклик в том же кадре не перестаёт быть требованием
 * за пределами матча.
 */
export const LobbyRoom = () => {
  const lobby = useSessionStore((state) => state.view.lobby);
  const error = useSessionStore((state) => state.error);
  const ready = useSessionStore(readyOf);

  if (lobby === null) return null;

  const alone = lobby.slots.length < LOBBY_CAPACITY;
  const someoneLost = lobby.slots.some((slot) => !slot.connected);

  const empty = Array.from(
    { length: Math.max(0, LOBBY_CAPACITY - lobby.slots.length) },
    (_value, index) => index,
  );

  return (
    <MenuShell>
      <ProfileBar />

      <Panel title={lobby.title} data-testid="room">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--td-space-2)' }}>
          {lobby.slots.map((slot) => (
            <Slot key={slot.name + String(slot.you)} slot={slot} />
          ))}
          {empty.map((index) => (
            <WaitingSlot key={index} />
          ))}
        </div>

        <div
          style={{
            marginTop: 'var(--td-space-4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--td-space-3)',
          }}
        >
          <Button
            variant="ghost"
            data-testid="room-leave"
            onClick={() => {
              void sessionActions.leaveLobby();
            }}
          >
            Выйти
          </Button>

          <Button
            data-testid="room-ready"
            data-ready={ready ? 'yes' : 'no'}
            // Готовность в одиночестве ничего не выражает: согласие дают
            // на конкретного соперника, а его ещё нет.
            disabled={alone}
            variant={ready ? 'ghost' : 'accent'}
            onClick={() => {
              void sessionActions.toggleReady(!ready);
            }}
          >
            {ready ? 'Не готов' : 'Готов'}
          </Button>
        </div>

        <p
          data-testid="room-hint"
          style={{
            margin: 'var(--td-space-3) 0 0',
            color: 'var(--td-text-muted-3)',
            fontSize: 'var(--td-text-sm)',
            lineHeight: 1.6,
          }}
        >
          {alone
            ? 'Ждём соперника. Пока вы один, готовность недоступна.'
            : someoneLost
              ? 'У соперника пропала связь. Матч не начнётся, пока он не вернётся.'
              : 'Матч начнётся, как только готовность подтвердят оба.'}
        </p>
      </Panel>

      {error !== null && (
        <div data-testid="room-error" style={{ color: 'var(--td-error)' }}>
          {lobbyErrorText[error]}
        </div>
      )}
    </MenuShell>
  );
};

const slotStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--td-space-3)',
  padding: 'var(--td-space-2) var(--td-space-3)',
  background: 'var(--td-bg-content)',
  border: '1px solid var(--td-border-subtle)',
  borderRadius: 'var(--td-radius-control)',
};

const Slot = ({ slot }: { slot: LobbySlotView }) => (
  <div
    style={{
      ...slotStyle,
      borderColor: slot.ready ? 'var(--td-accent-50)' : 'var(--td-border-subtle)',
    }}
    data-testid="room-slot"
    data-ready={slot.ready ? 'yes' : 'no'}
    data-you={slot.you ? 'yes' : 'no'}
  >
    <span style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--td-space-2)' }}>
      <span style={{ fontFamily: 'var(--td-font-mono)' }}>{slot.name}</span>
      {slot.you && (
        <span style={{ color: 'var(--td-text-muted-4)', fontSize: 'var(--td-text-sm)' }}>вы</span>
      )}
    </span>

    <span
      style={{
        fontSize: 'var(--td-text-sm)',
        color: !slot.connected
          ? 'var(--td-warning)'
          : slot.ready
            ? 'var(--td-accent)'
            : 'var(--td-text-muted-3)',
      }}
    >
      {!slot.connected ? 'связь потеряна' : slot.ready ? 'готов' : 'не готов'}
    </span>
  </div>
);

const WaitingSlot = () => (
  <div
    style={{ ...slotStyle, borderStyle: 'dashed', color: 'var(--td-text-muted-4)' }}
    data-testid="room-slot-empty"
  >
    <span>место свободно</span>
    <span style={{ fontSize: 'var(--td-text-sm)' }}>ждём соперника</span>
  </div>
);
