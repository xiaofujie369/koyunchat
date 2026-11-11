<script setup lang="ts">
import { colorOf, initial } from '@/lib/utils'
defineProps<{ name?: string; seed?: unknown; color?: string; small?: boolean }>()
</script>
<template>
  <div class="ava" :class="{ s: small }" :style="{ background: color || colorOf(seed ?? name) }">{{ initial(name) }}</div>
</template>
<style scoped>
.ava { width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 600; font-size: 18px; flex-shrink: 0; user-select: none; }
.ava.s { width: 34px; height: 34px; font-size: 14px; }
</style>
