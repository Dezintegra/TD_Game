import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'accent' | 'ghost' | 'danger';
  readonly children: ReactNode;
}

/**
 * Кнопка в гамме Dezintegra.
 *
 * Акцентный вариант — не заливка, а неоновая обводка со свечением.
 * Так на тёмном поле кнопка читается сразу, но не выжигает глаз
 * в матче, который длится десятки минут.
 */
const styleByVariant: Record<NonNullable<ButtonProps['variant']>, CSSProperties> = {
  accent: {
    background: 'transparent',
    color: 'var(--td-accent)',
    borderColor: 'var(--td-accent-50)',
    boxShadow: 'var(--td-glow-accent)',
  },
  ghost: {
    background: 'var(--td-bg-input)',
    color: 'var(--td-text-secondary)',
    borderColor: 'var(--td-border-control)',
  },
  danger: {
    background: 'transparent',
    color: 'var(--td-error)',
    borderColor: 'var(--td-error)',
  },
};

export const Button = ({ variant = 'accent', style, ...rest }: ButtonProps) => {
  const baseStyle: CSSProperties = {
    borderStyle: 'solid',
    borderWidth: 1,
    borderRadius: 'var(--td-radius-control)',
    padding: 'var(--td-space-2) var(--td-space-4)',
    fontFamily: 'var(--td-font-ui)',
    fontSize: 'var(--td-text-md)',
    fontWeight: 600,
    letterSpacing: 'var(--td-ls-button)',
    textTransform: 'uppercase',
    cursor: 'pointer',
    transition: 'background var(--td-transition-item), box-shadow var(--td-transition-item)',
  };

  return (
    <button
      type="button"
      {...rest}
      style={{ ...baseStyle, ...styleByVariant[variant], ...style }}
    />
  );
};
