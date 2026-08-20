import { Hud } from '../hud/Hud.js';
import { screenOf, useSessionStore } from '../session/session-store.js';
import { LobbyList } from './LobbyList.js';
import { LobbyRoom } from './LobbyRoom.js';
import { ProfileGate } from './ProfileGate.js';

/**
 * Корень React-дерева: какой экран сейчас показывать.
 *
 * Экран не хранится, а выводится из состояния сессии, поэтому
 * невозможных положений — вроде экрана комнаты у игрока, которого
 * из неё уже выгнали, — здесь не бывает по построению.
 *
 * Обратите внимание, чего здесь нет: запуска игры. Матч поднимает
 * контроллер сессии вне React-дерева, а этот компонент лишь рисует
 * поверх него HUD. Запусти игру эффект — в `StrictMode` при разработке
 * он выполнился бы дважды, и на странице оказалось бы две сцены.
 */
export const App = () => {
  const screen = useSessionStore(screenOf);

  switch (screen) {
    case 'profile':
      return <ProfileGate />;
    case 'lobbies':
      return <LobbyList />;
    case 'room':
      return <LobbyRoom />;
    case 'match':
      return <Hud />;
  }
};
