import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './menu/App.js';
import { sessionActions } from './session/session.js';

/**
 * Точка входа клиента.
 *
 * React отвечает за меню и HUD, игровой цикл живёт вне его дерева —
 * это ключевое решение для отзывчивости: ни перерисовка интерфейса,
 * ни горячая перезагрузка при разработке не могут прервать матч.
 *
 * Здесь больше не запускается игра. Раньше матч начинался прямо
 * при загрузке страницы, теперь его поднимает контроллер сессии,
 * и только когда игрок этого попросил — тренировкой или готовностью
 * в комнате.
 */
const root = document.getElementById('root');
if (root === null) throw new Error('Не найден корневой элемент #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Профиль читается из куки после монтирования: если он есть, игрок
// минует представление и сразу видит список комнат.
sessionActions.start();

// Горячая перезагрузка: при замене модуля гасим матч и поток состояния,
// иначе после нескольких правок в браузере будет крутиться десяток
// параллельных игр и висеть столько же подписок.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    sessionActions.dispose();
  });
}
