import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './Button.js';
import { Panel } from './Panel.js';

describe('Button', () => {
  it('рендерит переданный текст', () => {
    render(<Button>Построить</Button>);
    expect(screen.getByRole('button', { name: 'Построить' })).toBeDefined();
  });

  it('по умолчанию имеет type="button", чтобы не сабмитить формы случайно', () => {
    render(<Button>Готово</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });
});

describe('Panel', () => {
  it('показывает заголовок и содержимое', () => {
    render(<Panel title="Ресурсы">Золото: 200</Panel>);
    expect(screen.getByText('Ресурсы')).toBeDefined();
    expect(screen.getByText('Золото: 200')).toBeDefined();
  });

  it('работает без заголовка', () => {
    render(<Panel>Только текст</Panel>);
    expect(screen.getByText('Только текст')).toBeDefined();
  });
});
