import type { CSSProperties, ReactNode } from 'react';
import type { RejectReason } from '@td/shared';
import { useHudStore } from '../game/store.js';
import { REJECT_LABEL } from './labels.js';

/**
 * Отклик на отклонённую команду.
 *
 * До этого щелчок по клетке, куда строить нельзя, не приводил ни к чему:
 * команда уходила, ядро её выбрасывало, интерфейс молчал. Игрок не знал
 * даже, засчитано ли нажатие. Это прямо нарушало главное требование
 * проекта — любое действие даёт визуальный отклик в том же кадре.
 *
 * Откликов два, и они дополняют друг друга. Строка объясняет причину,
 * но требует прочтения; вздрагивание нужной панели показывает, ГДЕ
 * проблема, и считывается боковым зрением, не отрывая внимания от боя.
 */

const stackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 'var(--td-space-1)',
  // Сообщения перекрывают игровое поле и не должны перехватывать клики:
  // игрок, промахнувшийся мимо клетки, будет целиться туда же ещё раз,
  // и поймать этот второй щелчок всплывшей подсказкой — издевательство.
  pointerEvents: 'none',
};

const noticeStyle: CSSProperties = {
  padding: 'var(--td-space-1) var(--td-space-3)',
  border: '1px solid var(--td-error)',
  borderRadius: 'var(--td-radius-control)',
  background: 'var(--td-bg-overlay)',
  color: 'var(--td-error)',
  fontSize: 'var(--td-text-sm)',
  whiteSpace: 'nowrap',
};

export const NoticeStack = () => {
  const notices = useHudStore((state) => state.notices);

  if (notices.length === 0) return null;

  return (
    <div style={stackStyle} data-testid="notices">
      {notices.map((notice) => (
        <div key={notice.id} className="td-notice" style={noticeStyle} data-reason={notice.reason}>
          {REJECT_LABEL[notice.reason]}
        </div>
      ))}
    </div>
  );
};

/**
 * Номер последнего отказа с такой причиной, ноль — такого не было.
 *
 * Перебор идёт с конца, и это не мелочь: так номер остаётся прежним,
 * пока свежий отказ жив, и не меняется в момент, когда гаснет более
 * старый. Иначе панель вздрагивала бы ещё раз ни с того ни с сего —
 * просто оттого, что истёк срок у соседнего сообщения.
 */
export const useNudge = (reason: RejectReason): number =>
  useHudStore((state) => {
    for (let index = state.notices.length - 1; index >= 0; index -= 1) {
      const notice = state.notices[index];
      if (notice !== undefined && notice.reason === reason) return notice.id;
    }

    return 0;
  });

/**
 * Обёртка, вздрагивающая при каждом новом отказе.
 *
 * Ключ на внутреннем элементе — не украшение и не оптимизация. CSS
 * не перезапускает анимацию, которая уже идёт, поэтому второй отказ
 * подряд не был бы виден вовсе. Смена ключа размонтирует элемент
 * и монтирует заново, и анимация начинается сначала.
 */
export const Nudge = ({ reason, children }: { reason: RejectReason; children: ReactNode }) => {
  const trigger = useNudge(reason);

  return (
    <span key={trigger} className={trigger > 0 ? 'td-shake' : undefined}>
      {children}
    </span>
  );
};
