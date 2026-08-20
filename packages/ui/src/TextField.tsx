import type { CSSProperties, InputHTMLAttributes } from 'react';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /**
   * Причина, по которой введённое не годится.
   *
   * Не булев флаг «ошибка», а сам текст: показать поле красным
   * и не сказать почему — худший из возможных откликов. Поле само
   * связывает себя с сообщением через `aria-describedby`, поэтому
   * читающий с экрана слышит причину, а не только слово «неверно».
   */
  // `| undefined` явно: в проекте включён exactOptionalPropertyTypes,
  // и без него нельзя было бы передать значение, вычисленное как
  // «причина или ничего», — а это ровно то, что даёт проверка ввода.
  readonly error?: string | undefined;
  readonly label?: string | undefined;
}

/**
 * Однострочное поле ввода в гамме Dezintegra.
 *
 * Обводка меняется цветом, а не толщиной: изменение толщины сдвигает
 * содержимое на пиксель, и поле «дёргается» при фокусе.
 */
export const TextField = ({ error, label, style, id, ...rest }: TextFieldProps) => {
  const hasError = error !== undefined && error.length > 0;
  const errorId = id === undefined ? undefined : `${id}-error`;

  const inputStyle: CSSProperties = {
    width: '100%',
    background: 'var(--td-bg-input)',
    color: 'var(--td-text-primary)',
    border: '1px solid',
    borderColor: hasError ? 'var(--td-error)' : 'var(--td-border-control)',
    borderRadius: 'var(--td-radius-control)',
    padding: 'var(--td-space-2) var(--td-space-3)',
    fontFamily: 'var(--td-font-ui)',
    fontSize: 'var(--td-text-md)',
    transition: 'border-color var(--td-transition-item)',
  };

  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--td-space-1)' }}>
      {label !== undefined && (
        <span
          style={{
            color: 'var(--td-text-muted-3)',
            fontSize: 'var(--td-text-sm)',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 'var(--td-ls-label)',
          }}
        >
          {label}
        </span>
      )}

      <input
        {...rest}
        id={id}
        aria-invalid={hasError}
        aria-describedby={hasError ? errorId : undefined}
        style={{ ...inputStyle, ...style }}
      />

      {hasError && (
        <span id={errorId} style={{ color: 'var(--td-error)', fontSize: 'var(--td-text-sm)' }}>
          {error}
        </span>
      )}
    </label>
  );
};
