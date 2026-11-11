<script setup lang="ts">
import { computed } from 'vue'
import { NConfigProvider, NDialogProvider, NMessageProvider, darkTheme, useOsTheme, type GlobalThemeOverrides } from 'naive-ui'
import Shell from './components/Shell.vue'

const os = useOsTheme()
const dark = computed(() => os.value === 'dark')
const overrides = computed<GlobalThemeOverrides>(() => ({
  common: {
    primaryColor: dark.value ? '#9d8ff0' : '#7c6bd6', primaryColorHover: dark.value ? '#ada1f3' : '#8b7be0',
    primaryColorPressed: '#6a59c8', primaryColorSuppl: '#8b7be0', borderRadius: '10px',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei UI', 'Segoe UI', sans-serif",
    bodyColor: dark.value ? '#171614' : '#f7f5f0', cardColor: dark.value ? '#222019' : '#ffffff', modalColor: dark.value ? '#222019' : '#ffffff',
  },
}))
</script>

<template>
  <NConfigProvider :theme="dark ? darkTheme : null" :theme-overrides="overrides">
    <NMessageProvider placement="top"><NDialogProvider><Shell /></NDialogProvider></NMessageProvider>
  </NConfigProvider>
</template>
