import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import './style.css'

// 地址和旧版保持一致：#/room/5、#/join/邀请码、#/login?code=一次性登录码
const Blank = { render: () => null }
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: Blank },
    { path: '/room/:id', component: Blank },
    { path: '/join/:code', component: Blank },
    { path: '/login', component: Blank },
    { path: '/:p(.*)*', redirect: '/' },
  ],
})
createApp(App).use(router).mount('#app')
