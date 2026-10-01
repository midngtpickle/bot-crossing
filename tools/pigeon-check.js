import * as THREE from 'three'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'
import { Engine } from '../src/core/engine.js'
import { Settings, PRESETS } from '../src/core/settings.js'
import { Astronauts } from '../src/agents/astronauts.js'
import { loadCrew, crewRig, frameFor } from '../src/agents/crew.js'
import { installWorldCurve, setCurveView } from '../src/core/curve.js'

/**
 * The pigeons in fixed poses next to a bot, in the game's own renderer. Every pose is set
 * directly on the agent fields `Pigeons.write` reads, so what is on screen is exactly what the
 * colony draws for that state — without having to catch a live bird mid-flap.
 */
const output = document.querySelector('#results')
try {
  await loadCrew()
  installWorldCurve()
  setCurveView(new THREE.Vector3(), 0, 0)
  const settings = new Settings()
  Object.assign(settings.values, PRESETS.balanced.values, {
    renderScale: 1 / devicePixelRatio, autoQuality: false, bloom: true,
    bloomStrength: 0.25, tiltShift: false, colorGrade: false, antialias: true,
    shadows: 'high', fov: 30, exposure: 1,
  })
  const engine = new Engine(settings).mount(document.querySelector('#scene'))
  engine.renderer.setClearColor(0x29364b)
  const pmrem = new THREE.PMREMGenerator(engine.renderer)
  const hdr = await new HDRLoader().loadAsync('/assets/lighting/studio_small_09_1k.hdr')
  engine.scene.environment = pmrem.fromEquirectangular(hdr).texture
  engine.scene.environmentIntensity = 0.7
  hdr.dispose(); pmrem.dispose()
  engine.scene.add(new THREE.HemisphereLight(0xdae7ff, 0x596477, 0.3))
  const sun = new THREE.DirectionalLight(0xfff5e8, 1.2)
  sun.position.set(-2.5, 5, 4); sun.castShadow = true
  sun.shadow.mapSize.setScalar(2048)
  Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.1, far: 14 })
  sun.shadow.normalBias = 0.015; engine.scene.add(sun)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x3a465c, roughness: 0.92 }))
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.012; ground.receiveShadow = true; engine.scene.add(ground)

  const crew = new Astronauts(engine.scene, settings)
  const rig = crewRig()
  crew.setRig(rig)
  const spawn = (id, harness, status) => {
    crew._spawnAgent({ id, status, site: new THREE.Vector3(), thread: { harness, project: 'demo' } }, false)
    const a = crew.byId.get(id)
    a.scale = 1; a.state = 'at-site'
    return a
  }
  const bot = spawn('bot', 'claude-code', 'idle')
  bot.pos.set(-1.5, 0, 0); bot.frame = frameFor(rig.clips.idle, 0.4); bot.clipKey = 'idle'

  const POSES = [
    { name: 'standing', status: 'idle', set: () => ({}) },
    { name: 'pecking', status: 'working', set: () => ({ headPitch: 1.15 }) },
    { name: 'wings up', status: 'working', set: () => ({ fly: 1, flapRate: 1, flap: Math.PI / 2, y: 0.5 }) },
    { name: 'wings down', status: 'working', set: () => ({ fly: 1, flapRate: 1, flap: -Math.PI / 2, y: 0.5 }) },
    { name: 'waiting', status: 'waiting', set: () => ({ headPitch: -0.35, headTilt: 0.45 }) },
    { name: 'sleeping', status: 'sleeping', set: () => ({ crouch: 1, puff: 1.12, headPitch: 0.35 }) },
  ]
  const birds = POSES.map((pose, i) => {
    const p = spawn(`pigeon-${i}`, 'google-tasks', pose.status)
    p.pose = pose
    return p
  })

  let yaw = 0.5
  const place = (elapsed) => {
    birds.forEach((p, i) => {
      const s = p.pose.set()
      Object.assign(p, { fly: 0, flapRate: 0, flap: 0, headPitch: 0, headTilt: 0, crouch: 0, puff: 1, pitch: 0, bank: 0, headPush: 0 }, s)
      if (moving) {
        p.flap = elapsed * 17 + i
        if (p.pose.name === 'pecking') p.headPitch = Math.max(0, Math.sin(elapsed * 6)) * 1.15
      }
      p.pos.set(-0.6 + i * 0.75, s.y || 0, 0.2)
      p.yaw = yaw
    })
    bot.yaw = yaw
  }

  let moving = false
  const view = (angle = yaw, close = false) => {
    yaw = angle
    place(0)
    engine.camera.position.set(close ? -0.2 : 0.4, close ? 0.9 : 2.2, close ? 2.4 : 6.2)
    engine.camera.lookAt(close ? -0.2 : 0.4, close ? 0.3 : 0.45, 0)
    engine.camera.updateMatrixWorld()
    crew._writeMatrices(0, 1); engine.renderFrame()
    let still = document.querySelector('#still')
    if (!still) {
      still = document.createElement('img'); still.id = 'still'; still.alt = 'Fixed-pose pigeon render'
      Object.assign(still.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' })
      document.querySelector('#scene').appendChild(still)
    }
    still.src = engine.canvas.toDataURL('image/png')
    still.style.display = moving ? 'none' : 'block'
  }
  document.querySelector('#front').onclick = () => view(0)
  document.querySelector('#angle').onclick = () => view(0.5)
  document.querySelector('#side').onclick = () => view(Math.PI / 2)
  document.querySelector('#close').onclick = () => view(0.7, true)
  document.querySelector('#motion').onclick = (e) => {
    moving = !moving; e.target.textContent = moving ? 'Freeze' : 'Animate'
    view()
  }
  engine.add({ update(dt, elapsed) {
    if (moving) place(elapsed)
    crew._writeMatrices(elapsed, 1)
    output.textContent = JSON.stringify({ ready: true, moving, pigeons: crew.pigeonCount, calls: engine.renderer.info.render.calls }, null, 2)
  } })
  view(0.5); engine.start()
} catch (error) { output.textContent = error.stack }
