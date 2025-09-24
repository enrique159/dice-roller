<script setup>
import { onMounted, onBeforeUnmount, ref, defineEmits, defineExpose } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import * as CANNON from 'cannon-es'

const emit = defineEmits(['rolled'])

const container = ref(null)
let scene, camera, renderer, controls, animationId
let diceGroup
// gltfLoader removed (no GLTF models)
let world, groundBody
const physicsPairs = [] // { mesh, body, type }
let rolling = false
let rollStartTime = 0
const MAX_ROLL_TIME = 6000 // ms fallback in case bodies never sleep
// We will procedurally create geometries for each die type

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

function createConvexPolyhedronFromMesh(mesh) {
  const geom = mesh.geometry
  if (!geom || !geom.attributes?.position) return null
  const pos = geom.attributes.position
  const hasIndex = !!geom.index
  const idx = geom.index
  // Deduplicate vertices with rounding for stability
  const keyOf = (x, y, z) => `${Math.round(x * 1000) / 1000},${Math.round(y * 1000) / 1000},${Math.round(z * 1000) / 1000}`
  const map = new Map()
  const vertices = [] // CANNON.Vec3
  const getIndex = (x, y, z) => {
    const k = keyOf(x, y, z)
    let id = map.get(k)
    if (id === undefined) {
      id = vertices.length
      vertices.push(new CANNON.Vec3(x, y, z))
      map.set(k, id)
    }
    return id
  }
  const faces = [] // number[][]
  const readVert = (i) => ({ x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) })
  if (hasIndex) {
    for (let i = 0; i < idx.count; i += 3) {
      const ia = idx.getX(i), ib = idx.getX(i + 1), ic = idx.getX(i + 2)
      const a = readVert(ia), b = readVert(ib), c = readVert(ic)
      const A = getIndex(a.x, a.y, a.z)
      const B = getIndex(b.x, b.y, b.z)
      const C = getIndex(c.x, c.y, c.z)
      faces.push([A, B, C])
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      const a = readVert(i), b = readVert(i + 1), c = readVert(i + 2)
      const A = getIndex(a.x, a.y, a.z)
      const B = getIndex(b.x, b.y, b.z)
      const C = getIndex(c.x, c.y, c.z)
      faces.push([A, B, C])
    }
  }
  if (vertices.length < 4 || faces.length < 4) return null
  return new CANNON.ConvexPolyhedron({ vertices, faces })
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

  // Physics world and ground (y = 0)
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) })
  world.allowSleep = true
  world.defaultContactMaterial.restitution = 0.3
  world.defaultContactMaterial.friction = 0.4

  const groundShape = new CANNON.Plane()
  groundBody = new CANNON.Body({ mass: 0 })
  groundBody.addShape(groundShape)
  // Rotate plane so its normal is +Y
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
  world.addBody(groundBody)
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
  if (world) {
    world.step(1 / 60)
    for (const p of physicsPairs) {
      const bp = p.body.position
      const bq = p.body.quaternion
      p.mesh.position.set(bp.x, bp.y, bp.z)
      p.mesh.quaternion.set(bq.x, bq.y, bq.z, bq.w)
    }
  }
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
  // Remove physics bodies
  while (physicsPairs.length) {
    const p = physicsPairs.pop()
    if (p?.body) world?.removeBody(p.body)
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

// cloneModel removed; GLTF models not used

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

function createPentagonalBipyramidGeometry(radius = 0.9, height = 1.2) {
  const half = height / 2
  const apexTop = new THREE.Vector3(0, half, 0)
  const apexBottom = new THREE.Vector3(0, -half, 0)
  const ring = []
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2
    ring.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius))
  }
  // Build vertices array
  const vertices = [apexTop, apexBottom, ...ring]
  // Indices: top fan (apexTop, i, i+1), bottom fan (apexBottom, i+1, i)
  const indices = []
  for (let i = 0; i < 5; i++) {
    const i0 = 2 + i
    const i1 = 2 + ((i + 1) % 5)
    // top triangle
    indices.push(0, i0, i1)
    // bottom triangle
    indices.push(1, i1, i0)
  }
  const pos = new Float32Array(vertices.length * 3)
  vertices.forEach((v, i) => { pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z })
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geom.setIndex(indices)
  geom.computeVertexNormals()
  return geom
}

function createDieMesh(type) {
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
      return new THREE.Mesh(
        createPentagonalBipyramidGeometry(0.9, 1.4),
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
    case 'd100':
      return new THREE.Mesh(
        createPentagonalBipyramidGeometry(0.9, 1.4),
        new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.1, roughness: 0.6 })
      )
    default:
      return new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 1.2, 1.2),
        new THREE.MeshStandardMaterial({ color: 0x94a3b8 })
      )
  }
}

// ---- Physics helpers ----
function createBodyForMesh(mesh) {
  // Prefer accurate convex polyhedron for stability and correct resting faces
  let shape = null
  try {
    shape = createConvexPolyhedronFromMesh(mesh)
  } catch (e) {
    shape = null
  }
  if (!shape) {
    // Fallback to box approximation
    const box3 = new THREE.Box3().setFromObject(mesh)
    const size = new THREE.Vector3()
    box3.getSize(size)
    const hx = Math.max(0.1, size.x / 2)
    const hy = Math.max(0.1, size.y / 2)
    const hz = Math.max(0.1, size.z / 2)
    shape = new CANNON.Box(new CANNON.Vec3(hx, hy, hz))
  }
  const body = new CANNON.Body({ mass: 1 })
  body.addShape(shape)
  body.linearDamping = 0.25
  body.angularDamping = 0.3
  body.allowSleep = true
  body.sleepSpeedLimit = 0.1
  body.sleepTimeLimit = 0.6
  return body
}

function computeD6TopNumber(mesh) {
  // Box face order: +X, -X, +Y, -Y, +Z, -Z -> numbers [3,4,1,6,2,5]
  const faceNumbers = [3, 4, 1, 6, 2, 5]
  const up = new THREE.Vector3(0, 1, 0)
  const dirs = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
  ]
  let bestIdx = 0
  let bestDot = -Infinity
  const q = mesh.quaternion
  for (let i = 0; i < dirs.length; i++) {
    const v = dirs[i].clone().applyQuaternion(q)
    const d = v.dot(up)
    if (d > bestDot) {
      bestDot = d
      bestIdx = i
    }
  }
  return faceNumbers[bestIdx]
}

// For polyhedra made of triangular faces (d4, d8, d10 bipyramid, d20)
function computeTopTriangleFaceValue(mesh) {
  const up = new THREE.Vector3(0, 1, 0)
  // Gather triangle normals in world space
  let bestDot = -Infinity
  let bestIndex = 0
  let faceCount = 0

  // Support group meshes (wrapper) by traversing
  const meshes = []
  mesh.traverse?.((n) => { if (n.isMesh) meshes.push(n) })
  if (meshes.length === 0 && mesh.isMesh) meshes.push(mesh)

  for (const m of meshes) {
    const geom = m.geometry
    if (!geom || !geom.attributes?.position) continue
    const pos = geom.attributes.position
    const index = geom.index
    const mat = m.matrixWorld
    const nMat = new THREE.Matrix3().getNormalMatrix(mat)
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), n = new THREE.Vector3()

    const readVert = (i, out) => {
      out.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mat)
    }
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const ia = index.getX(i), ib = index.getX(i + 1), ic = index.getX(i + 2)
        readVert(ia, a); readVert(ib, b); readVert(ic, c)
        v1.subVectors(b, a)
        v2.subVectors(c, a)
        n.crossVectors(v1, v2).applyMatrix3(nMat).normalize()
        const d = n.dot(up)
        if (d > bestDot) { bestDot = d; bestIndex = faceCount }
        faceCount++
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        readVert(i, a); readVert(i + 1, b); readVert(i + 2, c)
        v1.subVectors(b, a)
        v2.subVectors(c, a)
        n.crossVectors(v1, v2).applyMatrix3(nMat).normalize()
        const d = n.dot(up)
        if (d > bestDot) { bestDot = d; bestIndex = faceCount }
        faceCount++
      }
    }
  }
  // Map triangle index to 1..faceCount. For regular solids, triangle count equals face count.
  const value = (bestIndex % faceCount) + 1
  return value
}

// For d12 (faces are pentagons triangulated). Cluster triangle normals to unique faces.
function computeTopFaceByClustering(mesh, expectedFaces) {
  const up = new THREE.Vector3(0, 1, 0)
  const clusters = new Map() // key -> { normal: Vector3 (avg), dot: number (avg), count }
  const meshes = []
  mesh.traverse?.((n) => { if (n.isMesh) meshes.push(n) })
  if (meshes.length === 0 && mesh.isMesh) meshes.push(mesh)

  const addNormal = (nWorld) => {
    // Quantize to 2 decimals to cluster co-planar triangles
    const qx = Math.round(nWorld.x * 100) / 100
    const qy = Math.round(nWorld.y * 100) / 100
    const qz = Math.round(nWorld.z * 100) / 100
    const key = `${qx},${qy},${qz}`
    const dot = nWorld.dot(up)
    const c = clusters.get(key)
    if (c) {
      c.dot = (c.dot * c.count + dot) / (c.count + 1)
      c.count++
    } else {
      clusters.set(key, { normal: new THREE.Vector3(qx, qy, qz), dot, count: 1 })
    }
  }

  for (const m of meshes) {
    const geom = m.geometry
    if (!geom || !geom.attributes?.position) continue
    const pos = geom.attributes.position
    const index = geom.index
    const mat = m.matrixWorld
    const nMat = new THREE.Matrix3().getNormalMatrix(mat)
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), n = new THREE.Vector3()
    const readVert = (i, out) => { out.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mat) }
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const ia = index.getX(i), ib = index.getX(i + 1), ic = index.getX(i + 2)
        readVert(ia, a); readVert(ib, b); readVert(ic, c)
        v1.subVectors(b, a)
        v2.subVectors(c, a)
        n.crossVectors(v1, v2).applyMatrix3(nMat).normalize()
        addNormal(n)
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        readVert(i, a); readVert(i + 1, b); readVert(i + 2, c)
        v1.subVectors(b, a)
        v2.subVectors(c, a)
        n.crossVectors(v1, v2).applyMatrix3(nMat).normalize()
        addNormal(n)
      }
    }
  }

  let bestKey = null
  let bestDot = -Infinity
  let i = 0
  let bestIdx = 0
  for (const [key, cluster] of clusters) {
    if (cluster.dot > bestDot) { bestDot = cluster.dot; bestKey = key; bestIdx = i }
    i++
  }
  // Map cluster index to 1..expectedFaces
  const value = (bestIdx % expectedFaces) + 1
  return value
}

function allBodiesSleeping() {
  return physicsPairs.length > 0 && physicsPairs.every(p => p.body.sleepState === CANNON.Body.SLEEPING)
}

function placeLabelOnMesh(mesh, value) {
  const label = createLabelSprite(value)
  const box = new THREE.Box3().setFromObject(mesh)
  const size = new THREE.Vector3()
  box.getSize(size)
  const y = (size.y / 2 || 0.6) + 0.4
  label.position.set(0, y, 0)
  mesh.add(label)
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
  if (rolling) return
  clearDice()
  const startY = 10
  const range = 4
  for (let i = 0; i < count; i++) {
    const mesh = createDieMesh(type)
    mesh.castShadow = true
    diceGroup.add(mesh)

    const body = createBodyForMesh(mesh)
    const x = (Math.random() - 0.5) * range
    const z = (Math.random() - 0.5) * range
    body.position.set(x, startY + Math.random() * 2, z)
    body.velocity.set((Math.random() - 0.5) * 6, -2 - Math.random() * 2, (Math.random() - 0.5) * 6)
    body.angularVelocity.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12)
    world.addBody(body)
    physicsPairs.push({ mesh, body, type })
  }

  rolling = true
  rollStartTime = performance.now()
  const check = () => {
    if (allBodiesSleeping() || (performance.now() - rollStartTime) > MAX_ROLL_TIME) {
      const results = []
      for (const p of physicsPairs) {
        let value
        if (p.type === 'd6') {
          value = computeD6TopNumber(p.mesh)
        } else if (p.type === 'd4' || p.type === 'd8' || p.type === 'd10' || p.type === 'd20') {
          value = computeTopTriangleFaceValue(p.mesh)
        } else if (p.type === 'd12') {
          value = computeTopFaceByClustering(p.mesh, 12)
        } else if (p.type === 'd100') {
          // Keep percentile logic for now (two d10 approach planned)
          const tens = Math.floor(Math.random() * 10) * 10
          const ones = Math.floor(Math.random() * 10)
          value = tens + ones || 100
        } else {
          value = computeTopTriangleFaceValue(p.mesh)
        }
        results.push({ type: p.type, value })
        placeLabelOnMesh(p.mesh, value)
      }
      emit('rolled', results)
      rolling = false
    } else {
      requestAnimationFrame(check)
    }
  }
  requestAnimationFrame(check)
}

defineExpose({ rollDice })

onMounted(() => {
  setupScene()
  // GLTF preload removed: all dice share d6 visuals
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
