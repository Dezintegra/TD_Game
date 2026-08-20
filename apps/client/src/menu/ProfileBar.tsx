import { useState } from 'react';
import { Button, Panel } from '@td/ui';
import { useSessionStore } from '../session/session-store.js';
import { sessionActions } from '../session/session.js';
import { LinkState, rowStyle } from './MenuShell.js';

/**
 * Полоса «вы вошли как ...» с удалением профиля.
 *
 * Есть на каждом экране меню: сменить имя — обыденное желание,
 * и гонять за ним игрока на отдельный экран настроек незачем.
 *
 * Удаление спрашивает подтверждение, и спрашивает его здесь же,
 * а не системным окном браузера. Причина не в красоте: системное окно
 * останавливает страницу целиком, а страница в этот момент держит
 * поток состояния комнат. Подтверждение прямо в полосе ничего
 * не останавливает.
 */
export const ProfileBar = () => {
  const profile = useSessionStore((state) => state.profile);
  const [asking, setAsking] = useState(false);

  if (profile === null) return null;

  return (
    <Panel data-testid="profile-bar">
      <div style={rowStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span
            style={{
              color: 'var(--td-text-muted-3)',
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: 'var(--td-ls-label)',
            }}
          >
            вы вошли как
          </span>
          <span
            data-testid="profile-name-shown"
            style={{
              fontFamily: 'var(--td-font-mono)',
              fontSize: 'var(--td-text-lg)',
              color: 'var(--td-accent)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {profile.name}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--td-space-3)' }}>
          <LinkState />

          {asking ? (
            <div style={{ display: 'flex', gap: 'var(--td-space-2)' }}>
              <Button
                variant="danger"
                data-testid="profile-forget-confirm"
                onClick={() => {
                  void sessionActions.forget();
                }}
              >
                Удалить
              </Button>
              <Button variant="ghost" onClick={() => setAsking(false)}>
                Отмена
              </Button>
            </div>
          ) : (
            <Button variant="ghost" data-testid="profile-forget" onClick={() => setAsking(true)}>
              Сменить профиль
            </Button>
          )}
        </div>
      </div>

      {asking && (
        <p
          style={{
            margin: 'var(--td-space-2) 0 0',
            color: 'var(--td-text-muted-4)',
            fontSize: 'var(--td-text-sm)',
          }}
        >
          Профиль будет удалён без возможности вернуть, а место в комнате освободится.
        </p>
      )}
    </Panel>
  );
};
