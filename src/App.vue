<script setup>
import DiceCanvas from './components/DiceCanvas.vue'
import ControlsPanel from './components/ControlsPanel.vue'
import PlayersPanel from './components/PlayersPanel.vue'
import RollHistory from './components/RollHistory.vue'
import { useGameStore } from './stores/gameStore'
import { ref } from 'vue'

const { addRoll, nextTurn, currentPlayer } = useGameStore()

const diceCanvasRef = ref(null)

function onRequestRoll(opts) {
  diceCanvasRef.value?.rollDice(opts)
}

function onRolled(results) {
  addRoll(results)
  // Avanzar turno automáticamente después de cada tirada
  nextTurn()
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <header class="border-b border-slate-800/80 bg-slate-900/80">
      <div class="mx-auto max-w-7xl px-4 py-3 flex items-center justify-between">
        <h1 class="text-xl font-semibold">Roller Dice 3D</h1>
        <div class="text-sm text-slate-300">
          Turno: <span class="font-semibold">{{ currentPlayer?.name ?? '—' }}</span>
        </div>
      </div>
    </header>

    <main class="flex-1 mx-auto max-w-7xl w-full grid grid-cols-1 lg:grid-cols-3 gap-4 p-4">
      <section class="lg:col-span-2 flex flex-col gap-4">
        <div class="card h-[480px]">
          <DiceCanvas ref="diceCanvasRef" @rolled="onRolled" />
        </div>
        <ControlsPanel @request-roll="onRequestRoll" />
      </section>
      <aside class="flex flex-col gap-4">
        <PlayersPanel />
        <RollHistory />
      </aside>
    </main>

    <footer class="border-t border-slate-800/80 py-3 text-center text-xs text-slate-400">
      Hecho con Vue 3, Vite, Tailwind y Three.js
    </footer>
  </div>
  
</template>

<style scoped>
</style>
