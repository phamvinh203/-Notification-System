import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// dev: proxy /api/* sang backend (chạy npm run dev ở thư mục gốc), bỏ tiền tố /api khi forward.
// Dùng tiền tố riêng để không đụng SPA route của dashboard (cả hai đều có /notifications).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
