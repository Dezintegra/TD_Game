import type { RuleTuning } from '@td/shared';

/**
 * Ключи, которыми правила двигают снаружи.
 *
 * Имя ключа человеческое, поле — из `RuleTuning`. Читает их приложение,
 * а не `packages/shared`: чтение среды и разбор командной строки — дело
 * приложения, библиотека остаётся изоморфной.
 */
export const TUNING_FLAGS: Readonly<Record<string, keyof RuleTuning>> = {
  income: 'income',
  speed: 'speed',
  'tower-hp': 'towerHealth',
  'base-hp': 'baseHealth',
  radius: 'unitRadius',
  map: 'map',
};
