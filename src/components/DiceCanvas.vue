<script setup>
import { onMounted, onBeforeUnmount, ref, watch, defineEmits, defineExpose } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const emit = defineEmits(['rolled'])

const container = ref(null)
let scene, camera, renderer, controls, animationId
let diceGroup
let gltfLoader
const models = new Map() // type -> THREE.Object3D
const modelPaths = {
  d4: '/models/dice/d4.glb',
  d6: '/models/dice/d6.glb',
  d8: '/models/dice/d8.glb',
  d10: '/models/dice/d10.glb',
  d12: '/models/dice/d12.glb',
  d20: '/models/dice/d20.glb',
  d100: '/models/dice/d100.glb', // opcional: algunos usan el mismo que d10
}

function createLabelSprite(text) {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  // background with rounded rect
  ctx.fillStyle = 'rgba(30, 41, 59, 0.85)'
  ctx.strokeStyle = '#93c5fd'
  const r = size * 0.12
  const pad = size * 0.06
  const w = size - pad * 2
  const h = size - pad * 2
  ctx.lineWidth = size * 0.04
  ctx.beginPath()
  ctx.moveTo(pad + r, pad)
  ctx.arcTo(pad + w, pad, pad + w, pad + h, r)
  ctx.arcTo(pad + w, pad + h, pad, pad + h, r)
  ctx.arcTo(pad, pad + h, pad, pad, r)
  ctx.arcTo(pad, pad, pad + w, pad, r)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  // text
  ctx.fillStyle = '#e2e8f0'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${Math.floor(size * 0.6)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`
  ctx.fillText(String(text), size / 2, size / 2 + size * 0.02)
  const tex = new THREE.CanvasTexture(canvas)
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })
  const sprite = new THREE.Sprite(mat)
  const scale = 0.9
  sprite.scale.setScalar(scale)
  return sprite
}

const ambientColor = 0xb0c4de
const lightColor = 0xffffff

function setupScene() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color('#0b1220')

  const width = container.value.clientWidth
  const height = container.value.clientHeight

  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000)
  camera.position.set(6, 6, 10)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width, height)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  container.value.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true

  const ambient = new THREE.AmbientLight(ambientColor, 0.6)
  scene.add(ambient)
  const dir = new THREE.DirectionalLight(lightColor, 1.1)
  dir.position.set(5, 10, 7)
  dir.castShadow = true
  dir.shadow.mapSize.set(1024, 1024)
  dir.shadow.camera.near = 1
  dir.shadow.camera.far = 50
  scene.add(dir)

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(50, 50),
    new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 1 })
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.y = 0
  ground.receiveShadow = true
  scene.add(ground)

  // Visual grid on top of ground for better spatial reference
  const grid = new THREE.GridHelper(50, 50, 0x334155, 0x1f2937)
  grid.position.y = 0.001
  scene.add(grid)

  diceGroup = new THREE.Group()
  scene.add(diceGroup)
}

function resize() {
  if (!renderer || !camera || !container.value) return
  const w = container.value.clientWidth
  const h = container.value.clientHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
}

function animate() {
  controls?.update()
  animationId = requestAnimationFrame(animate)
  renderer.render(scene, camera)
}

function clearDice() {
  while (diceGroup.children.length) {
    const c = diceGroup.children.pop()
    c.geometry?.dispose?.()
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach(m => {
        if (m.map && m.map.dispose) m.map.dispose()
        m.dispose()
      })
      else {
        if (c.material.map && c.material.map.dispose) c.material.map.dispose()
        c.material.dispose()
      }
    }
    // Also dispose any Sprite children used as labels
    c.traverse?.((n) => {
      if (n.isSprite && n.material) {
        if (n.material.map && n.material.map.dispose) n.material.map.dispose()
        n.material.dispose()
      }
    })
  }
}

function enableShadows(obj) {
  obj.traverse?.((n) => {
    if (n.isMesh) {
      n.castShadow = true
      n.receiveShadow = true
      if (n.material) {
        const mats = Array.isArray(n.material) ? n.material : [n.material]
        mats.forEach(m => {
          if (m.map) m.map.anisotropy = 4
        })
      }
    }
  })
}

function cloneModel(type) {
  const base = models.get(type)
  if (!base) return null
  const clone = base.clone(true)
  enableShadows(clone)
  return clone
}

function createTextTexture(text, options = {}) {
  const size = options.size ?? 256
  const bg = options.bg ?? '#0b3b2e' // dark teal-ish
  const fg = options.fg ?? '#e2e8f0' // slate-200
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  // background
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, size, size)
  // border
  ctx.strokeStyle = '#10b981'
  ctx.lineWidth = size * 0.03
  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, size - ctx.lineWidth * 2, size - ctx.lineWidth * 2)
  // text
  ctx.fillStyle = fg
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${Math.floor(size * 0.55)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`
  ctx.fillText(String(text), size / 2, size / 2)
  const texture = new THREE.CanvasTexture(canvas)
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}

function createD6Materials() {
  // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z
  const numbers = [3, 4, 1, 6, 2, 5]
  return numbers.map(n => new THREE.MeshStandardMaterial({
    map: createTextTexture(n),
    metalness: 0.05,
    roughness: 0.6,
  }))
}

async function preloadModels() {
  gltfLoader = gltfLoader || new GLTFLoader()
  const entries = Object.entries(modelPaths)
  await Promise.all(entries.map(([type, path]) => new Promise((resolve) => {
    gltfLoader.load(path, (gltf) => {
      const scene = gltf.scene || gltf.scenes?.[0]
      if (scene) {
        // Normalize scale to roughly ~1.2 units tall like our primitives
        const box = new THREE.Box3().setFromObject(scene)
        const size = new THREE.Vector3()
        box.getSize(size)
        const target = 1.2
        const maxDim = Math.max(size.x, size.y, size.z) || 1
        const scale = target / maxDim
        scene.scale.setScalar(scale)
        enableShadows(scene)
        models.set(type, scene)
      }
      resolve()
    }, undefined, () => resolve())
  })))
  // If no explicit d100 model but we have d10, reuse it visually for percentile
  if (!models.get('d100') && models.get('d10')) {
    models.set('d100', models.get('d10'))
  }
}

function createDieMesh(type) {
  // Basic placeholder geometries for polyhedral dice
  const model = cloneModel(type)
  if (model) {
    // Wrap in an Object3D so we can animate/position uniformly
    const wrapper = new THREE.Object3D()
    wrapper.add(model)
    return wrapper
  }
  switch (type) {
    case 'd4':
      return new THREE.Mesh(
        new THREE.TetrahedronGeometry(1),
        new THREE.MeshStandardMaterial({ color: 0x60a5fa, metalness: 0.1, roughness: 0.6 })
      )
    case 'd6':
      return new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 1.2, 1.2),
        createD6Materials()
      )
    case 'd8':
      return new THREE.Mesh(
        new THREE.OctahedronGeometry(1),
        new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.1, roughness: 0.6 })
      )
    case 'd10':
      // Approximate with an Icosahedron placeholder visually for now
      return new THREE.Mesh(
        new THREE.IcosahedronGeometry(1, 0),
        new THREE.MeshStandardMaterial({ color: 0x22d3ee, metalness: 0.1, roughness: 0.6 })
      )
    case 'd12':
      return new THREE.Mesh(
        new THREE.DodecahedronGeometry(1),
        new THREE.MeshStandardMaterial({ color: 0xa78bfa, metalness: 0.1, roughness: 0.6 })
      )
    case 'd20':
      return new THREE.Mesh(
        new THREE.IcosahedronGeometry(1),
        new THREE.MeshStandardMaterial({ color: 0xef4444, metalness: 0.1, roughness: 0.6 })
      )
    default:
      return new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 1.2, 1.2),
        new THREE.MeshStandardMaterial({ color: 0x94a3b8 })
      )
  }
}

function rollAnimation(mesh) {
  const start = performance.now()
  const duration = 1200 + Math.random() * 600
  const startRot = mesh.rotation.clone()
  const targetRot = new THREE.Euler(
    startRot.x + (Math.PI * 4) * (0.8 + Math.random() * 0.4),
    startRot.y + (Math.PI * 4) * (0.8 + Math.random() * 0.4),
    startRot.z + (Math.PI * 4) * (0.8 + Math.random() * 0.4)
  )
  function tick(now) {
    const t = Math.min(1, (now - start) / duration)
    const ease = 1 - Math.pow(1 - t, 3) // easeOutCubic
    mesh.rotation.x = startRot.x + (targetRot.x - startRot.x) * ease
    mesh.rotation.y = startRot.y + (targetRot.y - startRot.y) * ease
    mesh.rotation.z = startRot.z + (targetRot.z - startRot.z) * ease
    if (t < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

function getDieMax(type) {
  switch (type) {
    case 'd4': return 4
    case 'd6': return 6
    case 'd8': return 8
    case 'd10': return 10
    case 'd12': return 12
    case 'd20': return 20
    case 'd100': return 100
    default: return 6
  }
}

function randomRoll(type) {
  const max = getDieMax(type)
  return 1 + Math.floor(Math.random() * max)
}

function layoutDice(count) {
  const spacing = 2.2
  const perRow = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / perRow)
  const startX = -((perRow - 1) * spacing) / 2
  const startZ = -((rows - 1) * spacing) / 2
  let i = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < perRow && i < count; c++, i++) {
      const m = diceGroup.children[i]
      // Compute bounding box height to place die on top of ground (y=0)
      const box = new THREE.Box3().setFromObject(m)
      const size = new THREE.Vector3()
      box.getSize(size)
      const halfH = (isFinite(size.y) && size.y > 0) ? size.y / 2 : 0.6
      const y = halfH + 0.02
      m.position.set(startX + c * spacing, y, startZ + r * spacing)
    }
  }
}

function rollDice({ type = 'd20', count = 1 } = {}) {
  clearDice()
  const results = []
  for (let i = 0; i < count; i++) {
    const mesh = createDieMesh(type)
    mesh.castShadow = true
    mesh.position.set((Math.random() - 0.5) * 4, 1 + Math.random() * 1, (Math.random() - 0.5) * 4)
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI)
    diceGroup.add(mesh)
    rollAnimation(mesh)

    if (type === 'd100') {
      // use two d10 to simulate d100: tens + ones
      const tens = Math.floor(Math.random() * 10) * 10
      const ones = Math.floor(Math.random() * 10)
      const value = tens + ones || 100
      results.push({ type: 'd100', value })
      const label = createLabelSprite(value)
      label.position.set(0, 1.5, 0)
      mesh.add(label)
    } else {
      const value = randomRoll(type)
      results.push({ type, value })
      const label = createLabelSprite(value)
      label.position.set(0, 1.5, 0)
      mesh.add(label)
    }
  }
  layoutDice(count)
  // Notify parent after short delay to simulate end of roll
  setTimeout(() => emit('rolled', results), 800)
}

defineExpose({ rollDice })

onMounted(() => {
  setupScene()
  // Preload optional GLTF models if present in /public/models/dice
  preloadModels().catch(() => {})
  animate()
  window.addEventListener('resize', resize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  cancelAnimationFrame(animationId)
  renderer?.dispose?.()
})
</script>

<template>
  <div ref="container" class="w-full h-full rounded-lg border border-slate-700/60"></div>
</template>

<style scoped>
:host, .host {
  display: contents;
}
</style>
