import { renderReverb } from './reverb.js';
import { MUSIC_VOICES, renderMusicVoice } from './music.js';
import type { MusicVoice } from './music.js';
import { SOUNDS, VARIANTS, renderSound } from './sounds.js';
import type { Sound } from './sounds.js';

/**
 * Выпечка звуков в рабочем потоке.
 *
 * Двадцать семь секунд звука — миллион с четвертью отсчётов, и на этой
 * машине они считаются восемьсот пятьдесят миллисекунд. На главном потоке
 * это полсекунды застывшего меню, а на слабой машине — вдвое-втрое
 * больше. Разложить работу по кадрам не выйдет: самый долгий отдельный
 * звук считается около двухсот миллисекунд за раз, а разрезать выкладку
 * по диапазонам отсчётов нельзя — она держит состояние фильтров
 * в замыкании.
 *
 * Поэтому она уезжает сюда целиком. Готовые массивы возвращаются
 * по одному, по мере готовности, передачей владения: копирования
 * не происходит, и главный поток получает первый звук через десяток
 * миллисекунд после начала, а не через секунду.
 *
 * Порядок важен. Первым идёт отклик помещения — без него звучать нечему
 * будет некуда, — потом частое и короткое, потом редкое и долгое.
 * Ядерный удар считается последним: он самый дорогой, и до него игрок
 * доберётся в лучшем случае через минуту.
 */

export interface BakeRequest {
  readonly sampleRate: number;
}

export type BakeMessage =
  | { readonly kind: 'reverb'; readonly left: Float32Array; readonly right: Float32Array }
  | { readonly kind: 'music'; readonly voice: MusicVoice; readonly samples: Float32Array }
  | {
      readonly kind: 'sound';
      readonly sound: Sound;
      readonly variant: number;
      readonly samples: Float32Array;
    }
  | { readonly kind: 'done' };

/**
 * Очередь выпечки: сначала то, что понадобится в первые секунды матча.
 *
 * Порядок задан списком, а не сортировкой, потому что зависит он
 * не от какого-то одного свойства звука, а от того, когда игрок его
 * услышит.
 */
const ORDER: readonly Sound[] = [
  'bolt-unit',
  'blast-unit',
  'bolt-tower',
  'rotor',
  'beam-unit',
  'arc',
  'beam-tower',
  'missile',
  'blast-structure',
  'blast-general',
  'nuke-fall',
  'nuke-blast',
] as readonly Sound[];

const queue = (): readonly Sound[] => {
  const seen = new Set<Sound>(ORDER);
  // Хвостом — всё, чего в списке не оказалось. Список приходится
  // держать руками, и забытый в нём звук должен всё равно испечься,
  // пусть и последним.
  return [...ORDER, ...SOUNDS.filter((sound) => !seen.has(sound))];
};

self.onmessage = (event: MessageEvent<BakeRequest>): void => {
  const { sampleRate } = event.data;

  const [left, right] = renderReverb(sampleRate);
  const reverb: BakeMessage = { kind: 'reverb', left, right };
  self.postMessage(reverb, { transfer: [left.buffer, right.buffer] });

  // Музыка идёт сразу за откликом: её всего полторы секунды звука
  // на четыре инструмента, а начаться она должна раньше первого
  // выстрела — иначе матч открывается тишиной.
  for (const voice of MUSIC_VOICES) {
    const samples = renderMusicVoice(voice, sampleRate);
    const message: BakeMessage = { kind: 'music', voice, samples };
    self.postMessage(message, { transfer: [samples.buffer] });
  }

  for (const sound of queue()) {
    for (let variant = 0; variant < VARIANTS[sound]; variant += 1) {
      const samples = renderSound(sound, variant, sampleRate);
      const message: BakeMessage = { kind: 'sound', sound, variant, samples };
      self.postMessage(message, { transfer: [samples.buffer] });
    }
  }

  self.postMessage({ kind: 'done' } satisfies BakeMessage);
};
