import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Приёмника записи матчей здесь больше нет. Запись ведёт игровой сервер:
// он один знает и состав сторон, и профиль компьютерного участника,
// и все идущие матчи разом. См. apps/server/src/recording.ts.
export default defineConfig({
  plugins: [react()],
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
