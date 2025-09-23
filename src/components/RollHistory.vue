<script setup>
import { computed } from 'vue'
import { useGameStore } from '../stores/gameStore'

const { state, clearHistory } = useGameStore()

const items = computed(() => state.history)

function formatTime(ts) {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
</script>

<template>
  <div class="card">
    <div class="flex items-center justify-between mb-2">
      <h2 class="text-lg font-semibold">Historial</h2>
      <button class="btn" @click="clearHistory" :disabled="items.length === 0">Limpiar</button>
    </div>

    <div v-if="items.length === 0" class="text-sm text-slate-400">Sin tiradas aún.</div>

    <ul v-else class="space-y-2 max-h-64 overflow-auto pr-1">
      <li v-for="h in items" :key="h.id" class="rounded border border-slate-700/60 bg-slate-900/50 p-2">
        <div class="flex items-center justify-between text-sm">
          <div class="flex items-center gap-2">
            <span class="text-slate-400">{{ formatTime(h.timestamp) }}</span>
            <span class="font-medium">{{ h.playerName }}</span>
          </div>
          <div class="text-slate-300">Total: <span class="font-bold">{{ h.total }}</span></div>
        </div>
        <div class="mt-1 text-xs text-slate-300">
          <span v-for="(d, idx) in h.dice" :key="idx" class="mr-2">
            {{ d.type }}: <span class="font-semibold">{{ d.value }}</span>
          </span>
        </div>
      </li>
    </ul>
  </div>
</template>
