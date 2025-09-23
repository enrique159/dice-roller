import { reactive, computed, watch } from 'vue'

const STORAGE_KEY = 'dice-roller:state:v1'

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch (e) {
    console.warn('Failed to load state', e)
    return null
  }
}

const defaultState = {
  players: [], // { id, name }
  currentPlayerIndex: 0,
  history: [], // { id, timestamp, playerId, playerName, dice: [{type, value}], total }
}

const state = reactive(loadState() ?? defaultState)

watch(state, () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (e) {
    console.warn('Failed to persist state', e)
  }
}, { deep: true })

let nextPlayerId = state.players.reduce((m, p) => Math.max(m, p.id), 0) + 1
let nextHistoryId = state.history.reduce((m, h) => Math.max(m, h.id), 0) + 1

export function useGameStore() {
  const currentPlayer = computed(() => state.players[state.currentPlayerIndex] || null)

  function addPlayer(name) {
    if (!name || !name.trim()) return
    state.players.push({ id: nextPlayerId++, name: name.trim() })
    if (state.players.length === 1) state.currentPlayerIndex = 0
  }

  function removePlayer(id) {
    const idx = state.players.findIndex(p => p.id === id)
    if (idx !== -1) {
      state.players.splice(idx, 1)
      if (state.currentPlayerIndex >= state.players.length) {
        state.currentPlayerIndex = 0
      }
    }
  }

  function nextTurn() {
    if (state.players.length === 0) return
    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length
  }

  function addRoll(diceResults) {
    const player = currentPlayer.value
    const total = diceResults.reduce((s, d) => s + d.value, 0)
    state.history.unshift({
      id: nextHistoryId++,
      timestamp: Date.now(),
      playerId: player?.id ?? null,
      playerName: player?.name ?? '—',
      dice: diceResults,
      total,
    })
  }

  function clearHistory() {
    state.history = []
  }

  return {
    state,
    currentPlayer,
    addPlayer,
    removePlayer,
    nextTurn,
    addRoll,
    clearHistory,
  }
}
