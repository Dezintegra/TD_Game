import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { matchLogPlugin } from './src/matchlog-plugin.js';

export default defineConfig({
  // Плагин записи матчей объявлен с `apply: 'serve'`, поэтому в сборку
  // не попадает: обработчика приёма записи в промышленном приложении
  // не существует физически, а не по условию.
  plugins: [react(), matchLogPlugin()],
  server: {
    // Хост задан явно, а не оставлен по умолчанию: 'localhost' на Windows
    // разрешается в IPv6-адрес ::1, и тогда обращение на 127.0.0.1
    // не доходит — на это спотыкается Playwright и любой внешний инструмент.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
