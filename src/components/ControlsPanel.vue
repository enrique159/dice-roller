<script setup>
import { ref, defineEmits } from 'vue'

const emit = defineEmits(['request-roll'])

const diceType = ref('d20')
const count = ref(1)

const diceOptions = [
  { value: 'd4', label: 'd4' },
  { value: 'd6', label: 'd6' },
  { value: 'd8', label: 'd8' },
  { value: 'd10', label: 'd10' },
  { value: 'd12', label: 'd12' },
  { value: 'd20', label: 'd20' },
  { value: 'd100', label: 'd100' },
]

function roll() {
  const n = Math.max(1, Math.min(20, Number(count.value) || 1))
  emit('request-roll', { type: diceType.value, count: n })
}
</script>

<template>
  <div class="card flex flex-wrap items-end gap-3">
    <div class="flex flex-col">
      <label class="text-xs text-slate-300 mb-1">Tipo de dado</label>
      <select v-model="diceType" class="bg-slate-900/60 border border-slate-700 rounded px-3 py-2">
        <option v-for="o in diceOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>

    <div class="flex flex-col">
      <label class="text-xs text-slate-300 mb-1">Cantidad</label>
      <input v-model.number="count" type="number" min="1" max="20"
             class="w-24 bg-slate-900/60 border border-slate-700 rounded px-3 py-2" />
    </div>

    <button class="btn" @click="roll">
      Lanzar
    </button>
  </div>
</template>
