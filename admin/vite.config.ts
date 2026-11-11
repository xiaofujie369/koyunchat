import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// 编译结果放进 Go 程序的嵌入目录，静态资源走 /admin/ 前缀
export default defineConfig({
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: { outDir: '../backend/web/admin', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { proxy: { '/api': 'http://127.0.0.1:8790', '/uploads': 'http://127.0.0.1:8790', '/ws': { target: 'ws://127.0.0.1:8790', ws: true } } },
})
