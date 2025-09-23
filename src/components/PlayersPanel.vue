<script setup>
import { ref } from 'vue'
import { useGameStore } from '../stores/gameStore'

const { state, currentPlayer, addPlayer, removePlayer, nextTurn } = useGameStore()

const newPlayer = ref('')

function add() {
  if (!newPlayer.value.trim()) return
  addPlayer(newPlayer.value)
  newPlayer.value = ''
}
</script>

<template>
  <div class="card space-y-3">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold">Jugadores</h2>
      <button class="btn" @click="nextTurn" :disabled="state.players.length === 0">Siguiente turno</button>
    </div>

    <div class="flex gap-2">
      <input v-model="newPlayer" type="text" placeholder="Nombre"
             class="flex-1 bg-slate-900/60 border border-slate-700 rounded px-3 py-2" />
      <button class="btn" @click="add">Agregar</button>
    </div>

    <ul class="divide-y divide-slate-700/60">
      <li v-for="(p, idx) in state.players" :key="p.id" class="flex items-center justify-between py-2">
        <div class="flex items-center gap-2">
          <span class="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold"
                :class="idx === state.currentPlayerIndex ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-200'">
            {{ idx + 1 }}
          </span>
          <span :class="idx === state.currentPlayerIndex ? 'text-indigo-300' : ''">{{ p.name }}</span>
          <span v-if="currentPlayer?.id === p.id" class="text-xs text-slate-400">(Turno)</span>
        </div>
        <button class="btn" @click="removePlayer(p.id)">Eliminar</button>
      </li>
    </ul>
  </div>
</template>
