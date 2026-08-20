import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './Button.js';
import { Panel } from './Panel.js';
import { TextField } from './TextField.js';

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

describe('TextField', () => {
  it('показывает подпись и принимает значение', () => {
    render(<TextField label="Имя" defaultValue="Аня" />);
    expect(screen.getByText('Имя')).toBeDefined();
    expect(screen.getByDisplayValue('Аня')).toBeDefined();
  });

  it('показывает причину отказа, а не только красную рамку', () => {
    // Покрасить поле и не сказать почему — худший из возможных откликов.
    render(<TextField id="name" label="Имя" error="Введите имя" />);

    const input = screen.getByRole('textbox');
    expect(screen.getByText('Введите имя')).toBeDefined();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    // Причина связана с полем, поэтому читающий с экрана её услышит.
    expect(input.getAttribute('aria-describedby')).toBe('name-error');
  });

  it('без причины отказа не помечает поле неверным', () => {
    render(<TextField id="name" label="Имя" />);

    const input = screen.getByRole('textbox');
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });
});
