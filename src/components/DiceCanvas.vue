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
const MAX_ROLL_TIME = 10000 // ms fallback in case bodies never sleep
// We will procedurally create geometries for each die type
let d100PairCounter = 0
// Arena constants
const ARENA_SIZE = 10
const ARENA_HEIGHT = 20
const WALL_THICKNESS = 0.4
let arenaGroup
// Cannon materials
let dieMaterial, groundMaterial, wallMaterialPhys

// Stability detection (results only after dice are truly settled)
let stableFrames = 0
const STABLE_FRAMES = 8 // ~130ms @60fps
const SPEED_EPS = 0.1
const ANG_EPS = 0.3
function bodiesUnderThreshold() {
  if (!physicsPairs.length) return false
  // If all are sleeping, we are stable
  const allSleeping = physicsPairs.every(p => p.body.sleepState === CANNON.Body.SLEEPING)
  if (allSleeping) return true
  // Otherwise, require small linear and angular speeds for everyone
  for (const p of physicsPairs) {
    const v = p.body.velocity
    const w = p.body.angularVelocity
    if (!v || !w) return false
    if (v.length() > SPEED_EPS || w.length() > ANG_EPS) return false
  }
  return true
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

function addFaceStickersBox(mesh) {
  if (!mesh.geometry || mesh.geometry.type !== 'BoxGeometry') return
  const geom = mesh.geometry
  const params = geom.parameters || {}
  const w = params.width ?? 1.2
  const h = params.height ?? 1.2
  const d = params.depth ?? 1.2
  const hw = w / 2, hh = h / 2, hd = d / 2
  // Order must match computeD6TopNumber face mapping: +X,-X,+Y,-Y,+Z,-Z -> [3,4,1,6,2,5]
  const normals = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
  ]
  const centers = [
    new THREE.Vector3(hw, 0, 0),
    new THREE.Vector3(-hw, 0, 0),
    new THREE.Vector3(0, hh, 0),
    new THREE.Vector3(0, -hh, 0),
    new THREE.Vector3(0, 0, hd),
    new THREE.Vector3(0, 0, -hd),
  ]
  const numbers = [3, 4, 1, 6, 2, 5]
  const zAxis = new THREE.Vector3(0, 0, 1)
  const q = new THREE.Quaternion()
  const epsilon = 0.01
  for (let i = 0; i < 6; i++) {
    const sticker = createFaceStickerMesh(numbers[i])
    q.setFromUnitVectors(zAxis, normals[i])
    sticker.quaternion.copy(q)
    const pos = centers[i].clone().add(normals[i].clone().multiplyScalar(epsilon))
    sticker.position.copy(pos)
    mesh.add(sticker)
  }
}

// --- Sticker-like labels (planes oriented to the face normal) ---
function createFaceStickerMesh(text) {
  const tex = createTextTexture(text)
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
  const size = 0.35
  const geo = new THREE.PlaneGeometry(size, size)
  const m = new THREE.Mesh(geo, mat)
  m.userData.isSticker = true
  m.renderOrder = 1
  return m
}

function addFaceStickersTriMesh(mesh) {
  const geom = mesh.geometry
  if (!geom || !geom.attributes?.position) return
  const pos = geom.attributes.position
  const index = geom.index
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), n = new THREE.Vector3()
  const center = new THREE.Vector3()
  let faceNo = 0
  const readVert = (i, out) => out.set(pos.getX(i), pos.getY(i), pos.getZ(i))
  const alignQuat = new THREE.Quaternion()
  const zAxis = new THREE.Vector3(0, 0, 1)
  const place = () => {
    faceNo += 1
    const sticker = createFaceStickerMesh(faceNo)
    alignQuat.setFromUnitVectors(zAxis, n)
    sticker.quaternion.copy(alignQuat)
    const offset = n.clone().multiplyScalar(0.06)
    sticker.position.copy(center).add(offset)
    mesh.add(sticker)
  }
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const ia = index.getX(i), ib = index.getX(i + 1), ic = index.getX(i + 2)
      readVert(ia, a); readVert(ib, b); readVert(ic, c)
      v1.subVectors(b, a)
      v2.subVectors(c, a)
      n.crossVectors(v1, v2).normalize()
      center.copy(a).add(b).add(c).multiplyScalar(1 / 3)
      place()
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      readVert(i, a); readVert(i + 1, b); readVert(i + 2, c)
      v1.subVectors(b, a)
      v2.subVectors(c, a)
      n.crossVectors(v1, v2).normalize()
      center.copy(a).add(b).add(c).multiplyScalar(1 / 3)
      place()
    }
  }
}

function addFaceStickersD12(mesh) {
  const geom = mesh.geometry
  if (!geom || !geom.attributes?.position) return
  const pos = geom.attributes.position
  const index = geom.index
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), n = new THREE.Vector3()
  const center = new THREE.Vector3()
  const clusters = [] // { n: Vector3 (avg), c: Vector3 (sum), count }
  const findCluster = (normal) => {
    // Match by angle threshold
    const dotThreshold = 0.995
    for (const cl of clusters) {
      if (cl.n.dot(normal) > dotThreshold) return cl
    }
    const cl = { n: normal.clone(), c: new THREE.Vector3(), count: 0 }
    clusters.push(cl)
    return cl
  }
  const readVert = (i, out) => out.set(pos.getX(i), pos.getY(i), pos.getZ(i))
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const ia = index.getX(i), ib = index.getX(i + 1), ic = index.getX(i + 2)
      readVert(ia, a); readVert(ib, b); readVert(ic, c)
      v1.subVectors(b, a)
      v2.subVectors(c, a)
      n.crossVectors(v1, v2).normalize()
      center.copy(a).add(b).add(c).multiplyScalar(1 / 3)
      const cl = findCluster(n)
      cl.n.add(n).normalize()
      cl.c.add(center)
      cl.count++
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      readVert(i, a); readVert(i + 1, b); readVert(i + 2, c)
      v1.subVectors(b, a)
      v2.subVectors(c, a)
      n.crossVectors(v1, v2).normalize()
      center.copy(a).add(b).add(c).multiplyScalar(1 / 3)
      const cl = findCluster(n)
      cl.n.add(n).normalize()
      cl.c.add(center)
      cl.count++
    }
  }
  const alignQuat = new THREE.Quaternion()
  const zAxis = new THREE.Vector3(0, 0, 1)
  let faceNo = 0
  for (const cl of clusters) {
    faceNo += 1
    const sticker = createFaceStickerMesh(faceNo)
    alignQuat.setFromUnitVectors(zAxis, cl.n)
    sticker.quaternion.copy(alignQuat)
    const cAvg = cl.c.clone().multiplyScalar(1 / cl.count)
    const offset = cl.n.clone().multiplyScalar(0.06)
    sticker.position.copy(cAvg).add(offset)
    mesh.add(sticker)
  }
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
  // Strict top-down view: camera above origin looking straight down
  camera.position.set(0, 15, 0)
  camera.up.set(0, 0, -1)
  camera.lookAt(0, 0, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width, height)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  container.value.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  // Only allow zoom (no rotation/pan) to keep view orthogonal from above
  controls.enableRotate = false
  controls.enablePan = false
  controls.enableZoom = true
  controls.minDistance = 8
  controls.maxDistance = 80
  controls.target.set(0, 0, 0)
  controls.update()

  const ambient = new THREE.AmbientLight(ambientColor, 0.6)
  scene.add(ambient)
  const dir = new THREE.DirectionalLight(lightColor, 1.1)
  // Raise the light higher and slightly offset for nicer shadows
  dir.position.set(6, 18, 8)
  dir.castShadow = true
  dir.shadow.mapSize.set(1024, 1024)
  dir.shadow.camera.near = 1
  dir.shadow.camera.far = 50
  scene.add(dir)

  const groundSize = 50
  const BOARD_TILING = 1 // fewer repeats -> larger tiles
  const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize)
  const texLoader = new THREE.TextureLoader()
  const boardTex = texLoader.load('/board_background.jpg')
  boardTex.wrapS = THREE.RepeatWrapping
  boardTex.wrapT = THREE.RepeatWrapping
  boardTex.repeat.set(BOARD_TILING, BOARD_TILING)
  boardTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy?.() || 4)
  // Casino felt-like material: subtle sheen and softer roughness
  const groundMat = new THREE.MeshPhysicalMaterial({
    map: boardTex,
    roughness: 0.45,
    metalness: 0.0,
    clearcoat: 0.12,
    clearcoatRoughness: 0.85,
    sheen: 0.75,
    sheenColor: new THREE.Color('#000000'),
    sheenRoughness: 0.6,
  })
  const ground = new THREE.Mesh(groundGeo, groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = 0
  ground.receiveShadow = true
  scene.add(ground)

  // Arena walls to keep dice within camera view
  arenaGroup = new THREE.Group()
  scene.add(arenaGroup)
  // Invisible wall material (rendered fully transparent). We'll also hide meshes.
  const wallMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
  // Create 4 walls: +X, -X, +Z, -Z
  const half = ARENA_SIZE / 2
  const wallGeoX = new THREE.BoxGeometry(WALL_THICKNESS, ARENA_HEIGHT, ARENA_SIZE)
  const wallGeoZ = new THREE.BoxGeometry(ARENA_SIZE, ARENA_HEIGHT, WALL_THICKNESS)
  const wallMeshes = []
  const wPos = [
    new THREE.Vector3( half, ARENA_HEIGHT / 2, 0), // +X
    new THREE.Vector3(-half, ARENA_HEIGHT / 2, 0), // -X
    new THREE.Vector3(0, ARENA_HEIGHT / 2,  half), // +Z
    new THREE.Vector3(0, ARENA_HEIGHT / 2, -half), // -Z
  ]
  const wGeo  = [wallGeoX, wallGeoX, wallGeoZ, wallGeoZ]
  for (let i = 0; i < 4; i++) {
    const mesh = new THREE.Mesh(wGeo[i], wallMat)
    mesh.position.copy(wPos[i])
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.visible = false
    arenaGroup.add(mesh)
    wallMeshes.push(mesh)
  }

  diceGroup = new THREE.Group()
  scene.add(diceGroup)

  // Physics world and ground (y = 0)
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) })
  world.allowSleep = true
  // Snappier solver for more lively contacts
  world.solver.iterations = 15
  world.solver.tolerance = 1e-3
  // Define specific materials for better control
  dieMaterial = new CANNON.Material('die')
  groundMaterial = new CANNON.Material('ground')
  wallMaterialPhys = new CANNON.Material('wall')
  // Default as fallback
  world.defaultContactMaterial.restitution = 0.35
  world.defaultContactMaterial.friction = 0.35
  // Contact pairs
  world.addContactMaterial(new CANNON.ContactMaterial(dieMaterial, groundMaterial, {
    restitution: 0.6,
    friction: 0.38,
  }))
  world.addContactMaterial(new CANNON.ContactMaterial(dieMaterial, wallMaterialPhys, {
    restitution: 0.5,
    friction: 0.32,
  }))
  world.addContactMaterial(new CANNON.ContactMaterial(dieMaterial, dieMaterial, {
    restitution: 0.45,
    friction: 0.35,
  }))

  const groundShape = new CANNON.Plane()
  groundBody = new CANNON.Body({ mass: 0 })
  groundBody.addShape(groundShape)
  // Rotate plane so its normal is +Y
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
  groundBody.material = groundMaterial
  world.addBody(groundBody)

  // Physics bodies for walls
  const wallBodies = []
  const wallHalfX = new CANNON.Vec3(WALL_THICKNESS / 2, ARENA_HEIGHT / 2, ARENA_SIZE / 2)
  const wallHalfZ = new CANNON.Vec3(ARENA_SIZE / 2, ARENA_HEIGHT / 2, WALL_THICKNESS / 2)
  const shapes = [new CANNON.Box(wallHalfX), new CANNON.Box(wallHalfX), new CANNON.Box(wallHalfZ), new CANNON.Box(wallHalfZ)]
  const bodyPositions = [
    new CANNON.Vec3( half, ARENA_HEIGHT / 2, 0),
    new CANNON.Vec3(-half, ARENA_HEIGHT / 2, 0),
    new CANNON.Vec3(0, ARENA_HEIGHT / 2,  half),
    new CANNON.Vec3(0, ARENA_HEIGHT / 2, -half),
  ]
  for (let i = 0; i < 4; i++) {
    const b = new CANNON.Body({ mass: 0 })
    b.addShape(shapes[i])
    b.position.copy(bodyPositions[i])
    b.material = wallMaterialPhys
    world.addBody(b)
    wallBodies.push(b)
  }
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
  const fg = options.fg ?? '#e2e8f0' // slate-200
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
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
    transparent: true,
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

// Place tiny camera-facing labels on every triangular face of a mesh.
// Labels are numbered in triangle iteration order so they match computeTopTriangleFaceValue.
function addFaceLabelsTriMesh(mesh) {
  const geom = mesh.geometry
  if (!geom || !geom.attributes?.position) return
  const pos = geom.attributes.position
  const index = geom.index
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), n = new THREE.Vector3()
  const center = new THREE.Vector3()
  let faceNo = 0
  const readVert = (i, out) => out.set(pos.getX(i), pos.getY(i), pos.getZ(i))
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const ia = index.getX(i), ib = index.getX(i + 1), ic = index.getX(i + 2)
      readVert(ia, a); readVert(ib, b); readVert(ic, c)
      v1.subVectors(b, a)
      v2.subVectors(c, a)
      n.crossVectors(v1, v2).normalize()
      center.copy(a).add(b).add(c).multiplyScalar(1 / 3)
      faceNo += 1
      const sprite = createLabelSprite(faceNo)
      sprite.scale.setScalar(0.18)
      const offset = n.clone().multiplyScalar(0.12)
      sprite.position.copy(center.clone().add(offset))
      mesh.add(sprite)
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      readVert(i, a); readVert(i + 1, b); readVert(i + 2, c)
      v1.subVectors(b, a)
      v2.subVectors(c, a)
      n.crossVectors(v1, v2).normalize()
      center.copy(a).add(b).add(c).multiplyScalar(1 / 3)
      faceNo += 1
      const sprite = createLabelSprite(faceNo)
      sprite.scale.setScalar(0.18)
      const offset = n.clone().multiplyScalar(0.12)
      sprite.position.copy(center.clone().add(offset))
      mesh.add(sprite)
    }
  }
}

// For d12 faces (pentagons) triangulated: cluster by face normal to place one label per face.
function addFaceLabelsD12(mesh) {
  const geom = mesh.geometry
  if (!geom || !geom.attributes?.position) return
  const pos = geom.attributes.position
  const index = geom.index
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), n = new THREE.Vector3()
  const center = new THREE.Vector3()
  const clusters = new Map() // key -> { n: Vector3 (avg), center: Vector3 (sum), count }
  const keyOf = (nx, ny, nz) => `${Math.round(nx * 100) / 100},${Math.round(ny * 100) / 100},${Math.round(nz * 100) / 100}`
  const addTri = () => {
    n.normalize()
    const k = keyOf(n.x, n.y, n.z)
    const cl = clusters.get(k)
    if (cl) {
      cl.n.add(n)
      cl.center.add(center)
      cl.count++
    } else {
      clusters.set(k, { n: n.clone(), center: center.clone(), count: 1 })
    }
  }
  const readVert = (i, out) => out.set(pos.getX(i), pos.getY(i), pos.getZ(i))
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const ia = index.getX(i), ib = index.getX(i + 1), ic = index.getX(i + 2)
      readVert(ia, a); readVert(ib, b); readVert(ic, c)
      v1.subVectors(b, a)
      v2.subVectors(c, a)
      n.crossVectors(v1, v2)
      center.copy(a).add(b).add(c).multiplyScalar(1 / 3)
      addTri()
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      readVert(i, a); readVert(i + 1, b); readVert(i + 2, c)
      v1.subVectors(b, a)
      v2.subVectors(c, a)
      n.crossVectors(v1, v2)
      center.copy(a).add(b).add(c).multiplyScalar(1 / 3)
      addTri()
    }
  }
  let faceNo = 0
  for (const [key, cl] of clusters) {
    faceNo += 1
    const nAvg = cl.n.normalize()
    const cAvg = cl.center.multiplyScalar(1 / cl.count)
    const sprite = createLabelSprite(faceNo)
    sprite.scale.setScalar(0.18)
    const offset = nAvg.clone().multiplyScalar(0.12)
    sprite.position.copy(cAvg.clone().add(offset))
    mesh.add(sprite)
  }
}

function createDieMesh(type) {
  switch (type) {
    case 'd4': {
      const mesh = new THREE.Mesh(
        new THREE.TetrahedronGeometry(1),
        new THREE.MeshStandardMaterial({ color: 0x60a5fa, metalness: 0.1, roughness: 0.6 })
      )
      addFaceStickersTriMesh(mesh)
      return mesh
    }
    case 'd6': {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 1.2, 1.2),
        new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.05, roughness: 0.6 })
      )
      addFaceStickersBox(mesh)
      return mesh
    }
    case 'd8': {
      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(1),
        new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.1, roughness: 0.6 })
      )
      addFaceStickersTriMesh(mesh)
      return mesh
    }
    case 'd10': {
      const mesh = new THREE.Mesh(
        createPentagonalBipyramidGeometry(0.9, 1.4),
        new THREE.MeshStandardMaterial({ color: 0x22d3ee, metalness: 0.1, roughness: 0.6 })
      )
      addFaceStickersTriMesh(mesh)
      return mesh
    }
    case 'd12': {
      const mesh = new THREE.Mesh(
        new THREE.DodecahedronGeometry(1),
        new THREE.MeshStandardMaterial({ color: 0xa78bfa, metalness: 0.1, roughness: 0.6 })
      )
      addFaceStickersD12(mesh)
      return mesh
    }
    case 'd20': {
      const mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1),
        new THREE.MeshStandardMaterial({ color: 0xef4444, metalness: 0.1, roughness: 0.6 })
      )
      addFaceStickersTriMesh(mesh)
      return mesh
    }
    case 'd100': {
      const mesh = new THREE.Mesh(
        createPentagonalBipyramidGeometry(0.9, 1.4),
        new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.1, roughness: 0.6 })
      )
      addFaceLabelsTriMesh(mesh)
      return mesh
    }
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
  const body = new CANNON.Body({ mass: 2.5 })
  body.addShape(shape)
  body.linearDamping = 0.12
  body.angularDamping = 0.15
  body.allowSleep = true
  body.sleepSpeedLimit = 0.08
  body.sleepTimeLimit = 0.8
  if (dieMaterial) body.material = dieMaterial
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
  mesh.traverse?.((n) => { if (n.isMesh && !n.userData?.isSticker) meshes.push(n) })
  if (meshes.length === 0 && mesh.isMesh && !mesh.userData?.isSticker) meshes.push(mesh)

  for (const m of meshes) {
    const geom = m.geometry
    if (!geom || !geom.attributes?.position) continue
    const pos = geom.attributes.position
    const index = geom.index
    const mat = m.matrixWorld
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
        n.crossVectors(v1, v2).normalize()
        const d = n.dot(up)
        if (d > bestDot) { bestDot = d; bestIndex = faceCount }
        faceCount++
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        readVert(i, a); readVert(i + 1, b); readVert(i + 2, c)
        v1.subVectors(b, a)
        v2.subVectors(c, a)
        n.crossVectors(v1, v2).normalize()
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
  mesh.traverse?.((n) => { if (n.isMesh && !n.userData?.isSticker) meshes.push(n) })
  if (meshes.length === 0 && mesh.isMesh && !mesh.userData?.isSticker) meshes.push(mesh)

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
    // normals will be derived from world-space vertex positions directly
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), n = new THREE.Vector3()
    const readVert = (i, out) => { out.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mat) }
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const ia = index.getX(i), ib = index.getX(i + 1), ic = index.getX(i + 2)
        readVert(ia, a); readVert(ib, b); readVert(ic, c)
        v1.subVectors(b, a)
        v2.subVectors(c, a)
        n.crossVectors(v1, v2).normalize()
        addNormal(n)
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        readVert(i, a); readVert(i + 1, b); readVert(i + 2, c)
        v1.subVectors(b, a)
        v2.subVectors(c, a)
        n.crossVectors(v1, v2).normalize()
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
  const startY = Math.max(10, camera?.position?.y ? camera.position.y - 3 : 10)
  const targetX = controls?.target?.x ?? 0
  const targetZ = controls?.target?.z ?? 0
  const jitterRadius = count > 1 ? 0.6 : 0
  for (let i = 0; i < count; i++) {
    if (type === 'd100') {
      const pairId = d100PairCounter++
      const baseX = targetX
      const baseZ = targetZ

      // Tens die
      const tMesh = createDieMesh('d10')
      tMesh.castShadow = true
      diceGroup.add(tMesh)
      const tBody = createBodyForMesh(tMesh)
      tBody.position.set(baseX - 0.6, startY + Math.random() * 2, baseZ)
      tBody.velocity.set((Math.random() - 0.5) * 8, -3 - Math.random() * 2, (Math.random() - 0.5) * 8)
      tBody.angularVelocity.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16)
      world.addBody(tBody)
      physicsPairs.push({ mesh: tMesh, body: tBody, type: 'd10', meta: { group: 'd100', role: 'tens', pairId } })

      // Ones die
      const oMesh = createDieMesh('d10')
      oMesh.castShadow = true
      diceGroup.add(oMesh)
      const oBody = createBodyForMesh(oMesh)
      oBody.position.set(baseX + 0.6, startY + Math.random() * 2, baseZ)
      oBody.velocity.set((Math.random() - 0.5) * 8, -3 - Math.random() * 2, (Math.random() - 0.5) * 8)
      oBody.angularVelocity.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16)
      world.addBody(oBody)
      physicsPairs.push({ mesh: oMesh, body: oBody, type: 'd10', meta: { group: 'd100', role: 'ones', pairId } })

    } else {
      const mesh = createDieMesh(type)
      mesh.castShadow = true
      diceGroup.add(mesh)

      const body = createBodyForMesh(mesh)
      const angle = count > 1 ? (i / count) * Math.PI * 2 : 0
      const ox = jitterRadius ? Math.cos(angle) * jitterRadius : 0
      const oz = jitterRadius ? Math.sin(angle) * jitterRadius : 0
      body.position.set(targetX + ox, startY + Math.random() * 2, targetZ + oz)
      body.velocity.set((Math.random() - 0.5) * 8, -3 - Math.random() * 2, (Math.random() - 0.5) * 8)
      body.angularVelocity.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16)
      world.addBody(body)
      physicsPairs.push({ mesh, body, type })
    }
  }

  rolling = true
  rollStartTime = performance.now()
  stableFrames = 0
  const check = () => {
    const elapsed = performance.now() - rollStartTime
    if (bodiesUnderThreshold()) {
      stableFrames++
    } else {
      stableFrames = 0
    }
    if (stableFrames >= STABLE_FRAMES || elapsed > MAX_ROLL_TIME) {
      const results = []
      // Group d100 pairs
      const d100Groups = new Map()
      for (const p of physicsPairs) {
        if (p.meta?.group === 'd100') {
          const id = p.meta.pairId
          if (!d100Groups.has(id)) d100Groups.set(id, {})
          const g = d100Groups.get(id)
          if (p.meta.role === 'tens') g.tens = p
          else if (p.meta.role === 'ones') g.ones = p
        }
      }
      // Process non-d100 dice
      for (const p of physicsPairs) {
        if (p.meta?.group === 'd100') continue
        let value
        if (p.type === 'd6') value = computeD6TopNumber(p.mesh)
        else if (p.type === 'd12') value = computeTopFaceByClustering(p.mesh, 12)
        else value = computeTopTriangleFaceValue(p.mesh) // d4,d8,d10,d20
        results.push({ type: p.type, value })
        placeLabelOnMesh(p.mesh, value)
      }
      // Process d100 groups
      for (const [id, g] of d100Groups) {
        if (!g.tens || !g.ones) continue
        const tensFace = computeTopTriangleFaceValue(g.tens.mesh) // 1..10
        const onesFace = computeTopTriangleFaceValue(g.ones.mesh) // 1..10
        const tens = ((tensFace % 10) * 10) // 0..90, where 10->0
        const ones = (onesFace % 10) // 0..9, where 10->0
        const final = (tens + ones) || 100
        results.push({ type: 'd100', value: final })
        // Labels on each die
        const tensLabel = tens === 0 ? '00' : String(tens)
        placeLabelOnMesh(g.tens.mesh, tensLabel)
        placeLabelOnMesh(g.ones.mesh, String(ones))
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
