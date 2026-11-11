import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

// 客户社区：编译结果放进 Go 程序的嵌入目录，静态资源走 /user/ 前缀
export default defineConfig({
  base: '/user/',
  plugins: [vue()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: { outDir: '../backend/web/user', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { proxy: { '/api': 'http://127.0.0.1:8790', '/uploads': 'http://127.0.0.1:8790', '/ws': { target: 'ws://127.0.0.1:8790', ws: true } } },
})
