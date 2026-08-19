import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  readonly title?: string;
  readonly children: ReactNode;
}

/**
 * Панель HUD: тёмная карточка, «парящая» над игровым полем
 * за счёт двойной тени и светлой грани сверху.
 */
export const Panel = ({ title, children, style, ...rest }: PanelProps) => {
  const baseStyle: CSSProperties = {
    background: 'var(--td-bg-panel)',
    border: '1px solid var(--td-border-subtle)',
    borderRadius: 'var(--td-radius-panel)',
    boxShadow: 'var(--td-shadow-panel), var(--td-inset-edge)',
    padding: 'var(--td-space-3)',
    color: 'var(--td-text-primary)',
    fontFamily: 'var(--td-font-ui)',
    fontSize: 'var(--td-text-md)',
  };

  const titleStyle: CSSProperties = {
    color: 'var(--td-text-muted-3)',
    fontSize: 'var(--td-text-sm)',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 'var(--td-ls-label)',
    marginBottom: 'var(--td-space-2)',
  };

  return (
    <div {...rest} style={{ ...baseStyle, ...style }}>
      {title !== undefined && <div style={titleStyle}>{title}</div>}
      {children}
    </div>
  );
};
