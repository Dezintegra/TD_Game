import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startGame } from './game/bootstrap.js';
import { Hud } from './hud/Hud.js';

/**
 * Точка входа клиента.
 *
 * Игра и React стартуют независимо друг от друга — это ключевое решение
 * для отзывчивости. Игровой цикл не находится внутри React-дерева,
 * поэтому ни перерисовка HUD, ни горячая перезагрузка при разработке
 * не могут его прервать.
 */
const sceneHost = document.createElement('div');
sceneHost.id = 'scene';
document.body.appendChild(sceneHost);

const hudHost = document.getElementById('root');
if (hudHost === null) throw new Error('Не найден корневой элемент #root');

createRoot(hudHost).render(
  <StrictMode>
    <Hud />
  </StrictMode>,
);

const game = await startGame(sceneHost);

// Горячая перезагрузка: при замене модуля гасим старый цикл,
// иначе после нескольких правок в браузере будет крутиться
// десяток параллельных игр.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    game.stop();
    sceneHost.remove();
  });
}
