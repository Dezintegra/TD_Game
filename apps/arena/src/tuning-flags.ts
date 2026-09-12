import type { RuleTuning } from '@td/shared';

/**
 * Ключи, которыми правила двигают снаружи.
 *
 * Имя ключа человеческое, поле — из `RuleTuning`. Читает их приложение,
 * а не `packages/shared`: чтение среды и разбор командной строки — дело
 * приложения, библиотека остаётся изоморфной.
 *
 * Ключей два рода, и разведены они здесь, а не в разборе, потому что
 * именно здесь видно, какого рода ключ: числовой берёт число, ключ-слово
 * берёт одно из названных слов. Сведи их в одну таблицу — и разбор
 * молча превратил бы `geometric` в `NaN`.
 */
export const TUNING_FLAGS: Readonly<Record<string, keyof RuleTuning>> = {
  income: 'income',
  'income-effect': 'incomeEffectPercent',
  'income-cost': 'incomeCostPercent',
  'income-base-cost': 'incomeBaseCost',
  speed: 'speed',
  'tower-hp': 'towerHealth',
  'base-hp': 'baseHealth',
  radius: 'unitRadius',
  map: 'map',
};

/** Ключи, чьё значение — слово, а не число. Проверяются при разборе. */
export const TUNING_CHOICE_FLAGS: Readonly<Record<string, keyof RuleTuning>> = {
  'income-effect-model': 'incomeEffectModel',
  'income-cost-model': 'incomeCostModel',
};
