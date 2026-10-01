import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { projectHitPoint, bodyHitDistance } from './picking.js'

/**
 * Carrier pigeons: how a Google Tasks list and its open tasks show up in the colony.
 *
 * A task is not a coding agent, so it does not get a bot. It gets a pigeon instead — one that
 * waits in the ship until a bot from the same repo comes out, flies out alongside it, rides
 * escort over its shoulder on the walk to the zone, and lands on the deck beside it once it
 * stops. Every pigeon still *is* an agent as far as the rest of the colony is concerned —
 * same roster entry, same status, same badge, same click-to-open — and `Astronauts` owns the
 * list. This file owns only what makes one a bird: how it moves (it flies, so it ignores the
 * nav grid except to keep its feet off rooftops), how it is drawn (a handful of procedural
 * instanced meshes), and how it is picked.
 *
 * Status reads in the body language rather than in a face: a working pigeon pecks at the
 * ground, a waiting one cocks its head and flicks a wing, a blocked one puffs up and shakes,
 * a finished one hops and flutters, an idle one potters and a sleeping one sits with its head
 * pulled in. The capsule on its leg glows the status colour — it is a carrier pigeon, and
 * that is the message it is carrying.
 */

/** Google Tasks threads, and the errands their open tasks fan out into, are pigeons. */
export const isPigeonThread = (thread) => thread?.harness === 'google-tasks'

/** Authored in metres, feet at the origin; the whole bird is scaled once by this. */
export const PIGEON_SCALE = 1.35

const FLY_SPEED = 4.4
const HOP_SPEED = 1.1
/** Escort height over the deck, and the height it climbs to for a longer hop. */
const ESCORT_ALT = 1.55
const CRUISE_ALT = 2.3
/** Further than this from its spot and it takes off rather than walking. */
const TAKEOFF_DIST = 2.2
/** Close enough to its spot to stop walking. */
const SPOT_REACHED = 0.12
/** How far beside its bot a pigeon sits. */
const PERCH_RADIUS = 0.82
/** Seconds a bot has to stand still before its pigeon decides it has stopped for good. */
const SETTLE_DELAY = 0.7

/** Angles off the bot's facing, beside and a little behind it, so it never sits in its path. */
const PERCH_ANGLES = [1.95, -1.95, 2.55, -2.55, 1.35, -1.35, Math.PI]

/** Subtle plumage variety, multiplied over the painted greys. */
const PLUMAGE = [0xffffff, 0xf1ede6, 0xdadfe8, 0xead8ca, 0xc9cdd8]

/** Leg capsule glow per status — the same palette the bots' trim uses. */
const BAND = {
  working: [0.35, 2.2, 1.0],
  waiting: [0.45, 1.4, 2.8],
  blocked: [2.8, 0.45, 0.4],
  celebrating: [2.7, 2.0, 0.55],
  idle: [1.0, 1.25, 1.4],
  sleeping: [0.6, 0.65, 1.1],
  spawning: [2.2, 1.3, 0.65],
  leaving: [0.9, 0.9, 1.0],
}

// Where the moving parts hang off the body, in the bird's own (unscaled) units.
const NECK = { y: 0.27, z: 0.1 }
const SHOULDER = { x: 0.1, y: 0.285, z: 0.06 }
const HIP = { y: 0.13 }

export class Pigeons {
  constructor(group, capacity) {
    this.group = group
    this.capacity = capacity
    const mat = (roughness) =>
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness, metalness: 0.02, vertexColors: true })

    this.parts = {
      body: instanced(bodyGeometry(), mat(0.82), capacity),
      head: instanced(headGeometry(), mat(0.5), capacity),
      wingR: instanced(wingGeometry(1), mat(0.78), capacity),
      wingL: instanced(wingGeometry(-1), mat(0.78), capacity),
      legs: instanced(legGeometry(), mat(0.6), capacity),
      band: instanced(bandGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true }), capacity),
    }
    for (const mesh of Object.values(this.parts)) group.add(mesh)

    this.drawn = []
    this._root = new THREE.Matrix4()
    this._local = new THREE.Matrix4()
    this._out = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._e = new THREE.Euler(0, 0, 0, 'YXZ')
    this._v = new THREE.Vector3()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._goal = new THREE.Vector3()
    this._hit = [{}, {}, {}]
  }

  setShadows(on) {
    for (const name of ['body', 'head', 'wingR', 'wingL']) this.parts[name].castShadow = on
  }

  /** The bird-specific fields, layered onto an ordinary agent when it is spawned. */
  init(agent) {
    const h = agent.walkPersonality
    Object.assign(agent, {
      kind: 'pigeon',
      plumage: PLUMAGE[Math.floor(h * PLUMAGE.length) % PLUMAGE.length],
      speed: FLY_SPEED * (0.9 + h * 0.2),
      fly: agent.state === 'spawning' ? 1 : 0,
      flap: Math.random() * Math.PI * 2,
      flapRate: 0,
      vy: 0,
      bank: 0,
      pitch: 0,
      headPitch: 0,
      headTilt: 0,
      headPush: 0,
      puff: 1,
      crouch: 0,
      flick: 0,
      hopT: -1,
      peckAt: 0,
      peckT: -1,
      lookAt: 0,
      tiltTarget: 0,
      wanderAt: 0,
      companion: null,
      slot: 0,
      still: 0,
      perch: new THREE.Vector3(NaN, 0, NaN),
      perchFrom: new THREE.Vector3(NaN, 0, NaN),
      badgeLift: 0.82,
      bandColor: new THREE.Color(1, 1, 1),
    })
    this.applyStatus(agent)
  }

  applyStatus(agent) {
    const c = BAND[agent.status] || BAND.idle
    agent.bandColor.setRGB(c[0], c[1], c[2])
    agent.peckT = -1
    agent.peckAt = 0
  }

  /**
   * Hand every pigeon a bot to keep company with: one from its own repo, spreading the flock
   * across them so no single bot ends up standing in a crowd of birds. A pigeon keeps the bot
   * it has for as long as that bot is on the map, and only looks for another when it goes.
   */
  assignCompanions(agents) {
    const bots = new Map()
    const flocks = new Map()
    for (const a of agents) {
      if (a.kind === 'pigeon' || a.state === 'gone' || a.state === 'leaving') continue
      const project = a.thread?.project
      if (!project) continue
      let list = bots.get(project)
      if (!list) bots.set(project, (list = []))
      list.push(a)
    }
    for (const p of agents) {
      if (p.kind !== 'pigeon' || p.state === 'gone') continue
      const project = p.thread?.project
      const c = p.companion
      const valid = c && c.state !== 'gone' && c.state !== 'leaving' && c.thread?.project === project
      if (!valid) p.companion = null
    }
    for (const p of agents) {
      if (p.kind !== 'pigeon' || p.state === 'gone' || p.state === 'leaving') continue
      if (!p.companion) {
        const list = bots.get(p.thread?.project)
        if (list?.length) {
          let best = null
          let bestLoad = Infinity
          for (const bot of list) {
            const load = (flocks.get(bot)?.length ?? 0) + ((hashPair(p.id, bot.id) & 0xff) / 512)
            if (load < bestLoad) {
              bestLoad = load
              best = bot
            }
          }
          p.companion = best
        }
      }
      const key = p.companion || p.thread?.project || p
      let flock = flocks.get(key)
      if (!flock) flocks.set(key, (flock = []))
      flock.push(p)
    }
    // Slots by id, so a pigeon keeps its side of the bot when another one arrives or leaves.
    for (const flock of flocks.values()) {
      flock.sort((a, b) => (a.id < b.id ? -1 : 1))
      flock.forEach((p, i) => {
        if (p.slot !== i) {
          p.slot = i
          p.perchFrom.x = NaN
        }
      })
    }
  }

  /** Still in the ship: out it comes as soon as its bot does, or on its own if there is none. */
  release(agent, host) {
    const c = agent.companion
    const ready = c ? c.state !== 'queued' : agent.stateAge > 1.2 + (agent.walkPersonality * 2)
    if (!ready || agent.stateAge < 0.15 + agent.walkPersonality * 0.35) return
    const airlock = host.world?.shipAirlock?.()
    if (airlock) agent.pos.copy(airlock)
    agent.state = 'spawning'
    agent.stateAge = 0
    agent.fly = 1
    agent.flapRate = 1
    agent.groundY = null
  }

  step(agent, host, dt, elapsed, anim) {
    const ground = this._ground(agent, host)
    switch (agent.state) {
      case 'spawning': {
        agent.scale = Math.min(1, agent.scale + dt * 3)
        // Out of the airlock and up: a short burst along the ramp's line before it turns for
        // its bot, so it reads as leaving through the door rather than through the hull.
        const door = host.world?.shipDoor?.()
        const airlock = host.world?.shipAirlock?.()
        if (door && airlock) {
          const dx = door.x - airlock.x
          const dz = door.z - airlock.z
          const len = Math.hypot(dx, dz) || 1
          this._goal.set(door.x + (dx / len) * 2.5, 0, door.z + (dz / len) * 2.5)
        } else this._goal.copy(agent.pos)
        this._fly(agent, this._goal, ground + CRUISE_ALT, dt, 0.8)
        if (agent.stateAge > 0.9) {
          agent.state = 'walking'
          agent.stateAge = 0
        }
        break
      }

      case 'walking': {
        agent.scale = Math.min(1, agent.scale + dt * 3)
        const c = agent.companion
        const escorting = c && (c.state === 'spawning' || c.state === 'walking' || (c.groundSpeed || 0) > 0.15)
        if (escorting) {
          agent.still = 0
          this._escortSpot(agent, c, this._goal)
          const bob = Math.sin(elapsed * 1.7 + agent.phase) * 0.18
          this._fly(agent, this._goal, (c.groundY ?? ground) + ESCORT_ALT + bob, dt, 1.25)
          break
        }
        agent.still += dt
        this._perchSpot(agent, host, this._goal)
        const d = Math.hypot(this._goal.x - agent.pos.x, this._goal.z - agent.pos.z)
        // Glide in: height falls away with the distance left, so it lands rather than drops.
        const alt = agent.still < SETTLE_DELAY && c ? ESCORT_ALT : Math.min(CRUISE_ALT, d * 0.55)
        this._fly(agent, this._goal, ground + alt, dt, 1)
        if (d < 0.18 && agent.pos.y - ground < 0.12) {
          agent.state = 'at-site'
          agent.stateAge = 0
          agent.vel.set(0, 0, 0)
          agent.vy = 0
          agent.pos.y = ground
        }
        // Never circle forever: a spot it cannot settle on is close enough.
        if (agent.stateAge > 30) this._perchSpot(agent, host, agent.perch, true)
        break
      }

      case 'at-site': {
        agent.fly = THREE.MathUtils.damp(agent.fly, 0, 10, dt)
        const c = agent.companion
        if (c && (c.state === 'walking' || c.state === 'spawning')) {
          this._takeOff(agent)
          break
        }
        this._perchSpot(agent, host, this._goal)
        const d = Math.hypot(this._goal.x - agent.pos.x, this._goal.z - agent.pos.z)
        if (d > TAKEOFF_DIST) {
          this._takeOff(agent)
          break
        }
        if (d > SPOT_REACHED && agent.peckT < 0) this._hop(agent, this._goal, d, dt)
        else {
          agent.vel.set(0, 0, 0)
          this._behave(agent, c, dt, elapsed)
        }
        agent.pos.y = ground + Math.max(0, agent.hop)
        break
      }

      case 'leaving': {
        const airlock = host.world?.shipAirlock?.() || agent.site
        const d = Math.hypot(airlock.x - agent.pos.x, airlock.z - agent.pos.z)
        this._fly(agent, airlock, d < 3 ? airlock.y : ground + CRUISE_ALT, dt, 1.1)
        if (d < 1.2) agent.scale = Math.max(0, agent.scale - dt * 2.5)
        if (agent.scale <= 0.001 || agent.stateAge > 20) agent.state = 'gone'
        break
      }
    }

    // Bookkeeping the rest of the colony reads off every agent.
    const speed = Math.hypot(agent.vel.x, agent.vel.z)
    agent.groundSpeed = THREE.MathUtils.damp(agent.groundSpeed || 0, speed, 12, dt)
    agent.walkAmp = 0
    agent.phase += dt * (2 + speed * 6) * anim
    if (speed > 0.05) agent.targetYaw = Math.atan2(agent.vel.x, agent.vel.z)
    const before = agent.yaw
    agent.yaw = angleDamp(agent.yaw, agent.targetYaw, agent.fly > 0.5 ? 5 : 9, dt)
    let turn = agent.yaw - before
    if (turn > Math.PI) turn -= Math.PI * 2
    if (turn < -Math.PI) turn += Math.PI * 2
    agent.bank = THREE.MathUtils.damp(agent.bank, THREE.MathUtils.clamp((-turn / Math.max(dt, 1e-4)) * 0.22, -0.6, 0.6) * agent.fly, 6, dt)
    agent.pitch = THREE.MathUtils.damp(agent.pitch, THREE.MathUtils.clamp(-agent.vy * 0.18, -0.45, 0.45) * agent.fly, 6, dt)
    this._wings(agent, dt, anim)
  }

  _ground(agent, host) {
    const groundAt = host.world?.groundAt
    if (!groundAt) return 0
    if (agent.groundY === null || Math.abs(agent.pos.x - agent.groundX) + Math.abs(agent.pos.z - agent.groundZ) > 0.2) {
      agent.groundX = agent.pos.x
      agent.groundZ = agent.pos.z
      agent.groundY = groundAt(agent.pos.x, agent.pos.z)
    }
    return agent.groundY
  }

  /** Steer toward `goal` at height `y`. Horizontal and vertical are eased separately. */
  _fly(agent, goal, y, dt, factor) {
    const dx = goal.x - agent.pos.x
    const dz = goal.z - agent.pos.z
    const d = Math.hypot(dx, dz)
    const want = agent.speed * factor * Math.min(1, d / 1.4)
    if (d > 0.01) {
      agent.vel.x = THREE.MathUtils.damp(agent.vel.x, (dx / d) * want, 4, dt)
      agent.vel.z = THREE.MathUtils.damp(agent.vel.z, (dz / d) * want, 4, dt)
    } else agent.vel.set(0, 0, 0)
    const vy = THREE.MathUtils.clamp((y - agent.pos.y) * 2.2, -2.2, 3)
    agent.vy = THREE.MathUtils.damp(agent.vy, vy, 5, dt)
    agent.pos.x += agent.vel.x * dt
    agent.pos.z += agent.vel.z * dt
    agent.pos.y += agent.vy * dt
    agent.fly = THREE.MathUtils.damp(agent.fly, 1, 8, dt)
    agent.hop = 0
  }

  _takeOff(agent) {
    agent.state = 'walking'
    agent.stateAge = 0
    agent.still = 0
    agent.vy = 2.2
    agent.peckT = -1
    agent.hopT = -1
    agent.flapRate = 1
  }

  /** A pigeon walks in little bursts with its head going like a metronome. */
  _hop(agent, goal, d, dt) {
    const dx = (goal.x - agent.pos.x) / d
    const dz = (goal.z - agent.pos.z) / d
    const want = HOP_SPEED * Math.min(1, d / 0.4 + 0.25)
    agent.vel.x = THREE.MathUtils.damp(agent.vel.x, dx * want, 10, dt)
    agent.vel.z = THREE.MathUtils.damp(agent.vel.z, dz * want, 10, dt)
    agent.pos.x += agent.vel.x * dt
    agent.pos.z += agent.vel.z * dt
    agent.hop = 0
    agent.headPitch = THREE.MathUtils.damp(agent.headPitch, 0, 10, dt)
    agent.headTilt = THREE.MathUtils.damp(agent.headTilt, 0, 10, dt)
    // The thrust-and-hold: the head shoots forward on each step and holds still in space.
    const s = (agent.phase / (Math.PI * 2)) % 1
    agent.headPush = s < 0.35 ? s / 0.35 : 1 - (s - 0.35) / 0.65
  }

  /** On the ground, beside its bot, doing whatever its status says. */
  _behave(agent, companion, dt, elapsed) {
    const status = agent.status
    agent.headPush = THREE.MathUtils.damp(agent.headPush, 0, 8, dt)
    // Face roughly the way its bot does, so the two of them read as a pair.
    if (elapsed > agent.lookAt) {
      agent.lookAt = elapsed + 1.5 + Math.random() * 3.5
      const base = companion ? companion.yaw : agent.yaw
      agent.targetYaw = base + (Math.random() - 0.5) * 1.6
      agent.tiltTarget = (Math.random() - 0.5) * 0.9
    }

    let pitch = 0
    let tilt = 0
    let puff = 1
    let crouch = 0
    agent.hop = 0

    if (status === 'working' || status === 'idle') {
      // Pecking at the deck: quick jabs, a pause, another.
      if (agent.peckT >= 0) {
        agent.peckT += dt
        const t = agent.peckT
        pitch = t < 0.12 ? (t / 0.12) * 1.15 : t < 0.26 ? 1.15 : Math.max(0, 1.15 - (t - 0.26) * 6)
        if (t > 0.5) agent.peckT = -1
      } else if (elapsed > agent.peckAt) {
        const busy = status === 'working'
        agent.peckAt = elapsed + (busy ? 0.35 + Math.random() * 1.1 : 2 + Math.random() * 4)
        agent.peckT = 0
      } else tilt = agent.tiltTarget * 0.4
    } else if (status === 'waiting') {
      // Head cocked, looking up at you, with a wing flicked now and then.
      pitch = -0.35 + Math.sin(elapsed * 3.1 + agent.phase) * 0.08
      tilt = Math.sin(elapsed * 1.3 + agent.phase) > 0 ? 0.45 : -0.45
      if (Math.sin(elapsed * 0.9 + agent.phase * 3) > 0.97) agent.flick = 1
    } else if (status === 'blocked') {
      // Puffed up and cross, with a shake of the head every so often.
      puff = 1.2
      tilt = Math.sin(elapsed * 2.2 + agent.phase) > 0.8 ? Math.sin(elapsed * 38) * 0.5 : 0
      pitch = 0.15
    } else if (status === 'celebrating') {
      // Little hops with a flutter at the top of each one.
      const t = (elapsed * 0.85 + agent.walkPersonality) % 1
      agent.hop = t < 0.3 ? Math.sin((t / 0.3) * Math.PI) * 0.22 : 0
      if (t < 0.3) agent.flick = 1
      pitch = -0.25
      agent.targetYaw += dt * 0.9
    } else if (status === 'sleeping') {
      crouch = 1
      puff = 1.12
      pitch = 0.35
    }

    agent.headPitch = THREE.MathUtils.damp(agent.headPitch, pitch, agent.peckT >= 0 ? 30 : 8, dt)
    agent.headTilt = THREE.MathUtils.damp(agent.headTilt, tilt, 10, dt)
    agent.puff = THREE.MathUtils.damp(agent.puff, puff, 4, dt)
    agent.crouch = THREE.MathUtils.damp(agent.crouch, crouch, 3, dt)

    // An idler wanders off a step or two from its spot and back.
    if (status === 'idle' && elapsed > agent.wanderAt) {
      agent.wanderAt = elapsed + 4 + Math.random() * 6
      agent.perchFrom.x = NaN
      agent.jitter = (agent.jitter || 0) + 1
    }
  }

  _wings(agent, dt, anim) {
    agent.flick = Math.max(0, agent.flick - dt * 3)
    // Climbing beats hard, cruising beats steadily, descending glides.
    const target = agent.fly > 0.5 ? (agent.vy < -0.4 ? 0 : agent.vy > 0.4 ? 1.35 : 1) : agent.flick > 0 ? 1.4 : 0
    agent.flapRate = THREE.MathUtils.damp(agent.flapRate, target, 6, dt)
    agent.flap += dt * 17 * Math.max(agent.flapRate, agent.fly > 0.5 ? 0.05 : 0) * anim
  }

  /** Off its bot's shoulder while the bot walks: beside it, up in the air. */
  _escortSpot(agent, c, out) {
    const side = agent.slot % 2 === 0 ? 1 : -1
    const ring = Math.floor(agent.slot / 2)
    const a = c.yaw + side * (1.7 + ring * 0.5)
    const r = 0.9 + ring * 0.35
    // Leading a touch, so it keeps up instead of trailing.
    return out.set(c.pos.x + Math.sin(a) * r + c.vel.x * 0.25, 0, c.pos.z + Math.cos(a) * r + c.vel.z * 0.25)
  }

  /**
   * Where it sits: beside its bot, picked once the bot has stopped and kept until the bot
   * moves off, so a bot turning on the spot to face its work does not send the bird round
   * it in circles. Falls back to the zone's work site when the repo has no bot.
   */
  _perchSpot(agent, host, out, force = false) {
    const c = agent.companion
    const base = c ? c.pos : agent.site
    const ref = agent.perchFrom
    const moved = Number.isNaN(ref.x) || Math.hypot(base.x - ref.x, base.z - ref.z) > 0.9
    if (moved || force) {
      ref.set(base.x, 0, base.z)
      const nav = host.nav
      const facing = c ? c.yaw : (agent.walkPersonality * Math.PI * 2)
      const ring = Math.floor(agent.slot / PERCH_ANGLES.length)
      const r = PERCH_RADIUS + ring * 0.38 + (agent.status === 'idle' ? ((agent.jitter || 0) % 3) * 0.18 : 0)
      const start = agent.slot % PERCH_ANGLES.length
      let found = false
      for (let i = 0; i < PERCH_ANGLES.length * 2 && !found; i++) {
        const a = facing + PERCH_ANGLES[(start + i) % PERCH_ANGLES.length] + (i >= PERCH_ANGLES.length ? 0.3 : 0)
        const x = base.x + Math.sin(a) * r
        const z = base.z + Math.cos(a) * r
        if (nav && (nav.isBlocked(x, z) || nav.insideKeep(x, z))) continue
        agent.perch.set(x, 0, z)
        found = true
      }
      if (!found) agent.perch.set(base.x + Math.sin(facing + 2) * r, 0, base.z + Math.cos(facing + 2) * r)
    }
    return out.copy(agent.perch)
  }

  // ── drawing ───────────────────────────────────────────────────────────────────────────

  write(agents, elapsed) {
    const { body, head, wingR, wingL, legs, band } = this.parts
    const root = this._root
    const local = this._local
    const out = this._out
    const q = this._q
    const e = this._e
    const v = this._v
    const s = this._s
    const c = this._c
    let n = 0
    this.drawn.length = 0

    for (const agent of agents) {
      if (agent.kind !== 'pigeon') continue
      if (n >= this.capacity) break
      if (agent.state === 'gone' || agent.scale <= 0.001) continue
      const k = agent.scale * PIGEON_SCALE

      e.set(agent.pitch, agent.yaw, agent.bank, 'YXZ')
      q.setFromEuler(e)
      root.compose(v.set(agent.pos.x, agent.pos.y, agent.pos.z), q, s.setScalar(k))

      // Body: lowered when sitting, swollen when puffed up.
      const sink = agent.crouch * 0.09
      const p = agent.puff
      compose(local, 0, -sink, 0, 0, 0, 0, p, p, 1 + (p - 1) * 0.5)
      body.setMatrixAt(n, out.multiplyMatrices(root, local))

      // Head on its neck pivot: pitch to peck, roll to cock, push to bob; pulled in when asleep.
      compose(local, 0, NECK.y - sink - agent.crouch * 0.05, NECK.z + agent.headPush * 0.045 - agent.crouch * 0.04,
        agent.headPitch, 0, agent.headTilt, 1, 1, 1)
      head.setMatrixAt(n, out.multiplyMatrices(root, local))

      // Wings: folded along the back on the ground, spread and beating in the air.
      const spread = Math.max(agent.fly, agent.flick * 0.55)
      const beat = Math.sin(agent.flap)
      const flapAngle = agent.flapRate > 0.08 ? 0.15 + beat * 0.95 * Math.min(1, agent.flapRate) : 0.18
      const sweep = lerp(1.5, 0.1, spread)
      const roll = lerp(-0.32, flapAngle, spread)
      const twist = lerp(1.5, 0, spread)
      for (const [mesh, sign] of [[wingR, 1], [wingL, -1]]) {
        // T · Ry(sweep) · Rz(roll) · Rx(twist): twist about its own length, raise, then sweep back.
        local.makeRotationX(twist)
        out.makeRotationZ(sign * roll)
        local.premultiply(out)
        out.makeRotationY(sign * sweep)
        local.premultiply(out)
        local.setPosition(sign * SHOULDER.x * p, SHOULDER.y - sink, SHOULDER.z)
        mesh.setMatrixAt(n, out.multiplyMatrices(root, local))
      }

      // Legs hang from the hip; tucked back in flight, folded away when sitting.
      const tuck = agent.fly
      const legScale = Math.max(0.02, 1 - agent.crouch * 0.95)
      compose(local, 0, HIP.y - sink, -0.01 * tuck, -1.25 * tuck, 0, 0, 1, legScale * (1 - tuck * 0.35), 1)
      out.multiplyMatrices(root, local)
      legs.setMatrixAt(n, out)
      band.setMatrixAt(n, out)

      if (agent.pIndex !== n || agent.plumageDirty !== false) {
        agent.plumageDirty = false
        c.setHex(agent.plumage)
        body.setColorAt(n, c)
        head.setColorAt(n, c)
        wingR.setColorAt(n, c)
        wingL.setColorAt(n, c)
        this._colorsDirty = true
      }
      const pulse = agent.status === 'blocked'
        ? (Math.sin(elapsed * 9) > 0.2 ? 1 : 0.15)
        : 0.6 + 0.4 * Math.sin(elapsed * 2.6 + agent.phase)
      band.setColorAt(n, c.copy(agent.bandColor).multiplyScalar(0.55 + pulse * 0.9))

      agent.pIndex = n
      this.drawn.push(agent)
      n++
    }

    for (const [name, mesh] of Object.entries(this.parts)) {
      mesh.count = n
      mesh.instanceMatrix.needsUpdate = true
      if (name === 'band' || this._colorsDirty) mesh.instanceColor.needsUpdate = true
    }
    this._colorsDirty = false
    return n
  }

  /** Screen-space distance from the cursor to a pigeon's body and head, like the bots'. */
  hitDistance(agent, camera, ndcX, ndcY, aspect) {
    const k = agent.scale * PIGEON_SCALE
    const [bodyHit, headHit, feetHit] = this._hit
    const v = this._v
    const sy = Math.sin(agent.yaw)
    const cy = Math.cos(agent.yaw)
    // Generous radii: a pigeon is small, and it should not be harder to click than a bot.
    projectHitPoint(v.set(agent.pos.x, agent.pos.y + 0.22 * k, agent.pos.z), 0.24 * k, camera, aspect, bodyHit)
    projectHitPoint(v.set(agent.pos.x + sy * 0.14 * k, agent.pos.y + 0.42 * k, agent.pos.z + cy * 0.14 * k), 0.15 * k, camera, aspect, headHit)
    projectHitPoint(v.set(agent.pos.x, agent.pos.y + 0.02, agent.pos.z), 0.14 * k, camera, aspect, feetHit)
    if (!bodyHit.visible) return { d: Infinity, depth: Infinity }
    agent.screen.set(headHit.x / aspect, headHit.y, headHit.z)
    const d = Math.min(bodyHitDistance(ndcX * aspect, ndcY, bodyHit, headHit), bodyHitDistance(ndcX * aspect, ndcY, bodyHit, feetHit))
    return { d, depth: bodyHit.z }
  }

  dispose() {
    for (const mesh of Object.values(this.parts)) {
      this.group.remove(mesh)
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
  }
}

// ── geometry ──────────────────────────────────────────────────────────────────────────

function instanced(geo, mat, capacity) {
  const mesh = new THREE.InstancedMesh(geo, mat, capacity)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.count = 0
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.frustumCulled = false
  const white = new THREE.Color(1, 1, 1)
  for (let i = 0; i < capacity; i++) mesh.setColorAt(i, white)
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
  return mesh
}

/** An ellipsoid with its vertex colours chosen per vertex by `paintFn(position, normal)`. */
function ellipsoid(rx, ry, rz, x, y, z, paintFn, w = 14, h = 10) {
  const geo = new THREE.SphereGeometry(1, w, h)
  geo.scale(rx, ry, rz)
  geo.translate(x, y, z)
  geo.computeVertexNormals()
  paintBy(geo, paintFn)
  return geo
}

function paintBy(geo, fn) {
  const pos = geo.attributes.position
  const nor = geo.attributes.normal
  const colors = new Float32Array(pos.count * 3)
  const p = new THREE.Vector3()
  const nrm = new THREE.Vector3()
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i)
    nrm.fromBufferAttribute(nor, i)
    const hex = fn(p, nrm)
    if (hex instanceof THREE.Color) c.copy(hex)
    else c.setHex(hex)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geo
}

const flat = (hex) => () => hex

function merge(list) {
  // Sphere and cylinder geometries disagree about having an index; merge wants them alike.
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g))
  for (const g of parts) for (const key of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(key)) g.deleteAttribute(key)
  const merged = BufferGeometryUtils.mergeGeometries(parts, false)
  for (const g of list) g.dispose()
  return merged
}

const BACK = new THREE.Color(0x7f8a9e)
const BELLY = new THREE.Color(0xa6aebb)

function bodyGeometry() {
  // Plump, tipped forward a little, the breast fuller than the rump.
  const body = ellipsoid(0.125, 0.12, 0.2, 0, 0.22, 0, (p, n) => {
    const t = THREE.MathUtils.smoothstep(n.y, -0.6, 0.5)
    return new THREE.Color().lerpColors(BELLY, BACK, t)
  }, 18, 12)
  body.rotateX(-0.22)
  const breast = ellipsoid(0.11, 0.11, 0.11, 0, 0.24, 0.08, (p, n) => new THREE.Color().lerpColors(new THREE.Color(0x9ea6b6), BACK, Math.max(0, n.y)))
  // Tail: a flat fan off the rump with the dark bar across its tip.
  const tail = ellipsoid(0.07, 0.018, 0.13, 0, 0.21, -0.26, (p) => (p.z < -0.34 ? 0x2b2f38 : 0x737c8d), 10, 6)
  tail.rotateX(-0.12)
  return merge([body, breast, tail])
}

function headGeometry() {
  // Authored about the neck pivot. The neck carries the green-and-purple sheen.
  const neck = ellipsoid(0.072, 0.1, 0.075, 0, 0.04, 0.0, (p, n) => {
    const t = 0.5 + 0.5 * Math.sin(n.x * 2.4 + n.z * 1.7 + p.y * 30)
    return new THREE.Color().lerpColors(new THREE.Color(0x3f8c6a), new THREE.Color(0x7d5592), t)
  })
  const head = ellipsoid(0.066, 0.064, 0.074, 0, 0.13, 0.04, flat(0x6d7686))
  const beak = new THREE.ConeGeometry(0.016, 0.06, 8)
  beak.rotateX(Math.PI / 2)
  beak.translate(0, 0.12, 0.13)
  beak.computeVertexNormals()
  paintBy(beak, flat(0x3b3c42))
  const cere = ellipsoid(0.018, 0.012, 0.016, 0, 0.133, 0.105, flat(0xe9e6e0), 8, 6)
  const eyes = [1, -1].flatMap((s) => [
    ellipsoid(0.017, 0.017, 0.012, s * 0.05, 0.14, 0.075, flat(0xe0702a), 8, 6),
    ellipsoid(0.008, 0.008, 0.006, s * 0.062, 0.141, 0.08, flat(0x101010), 6, 4),
  ])
  return merge([neck, head, beak, cere, ...eyes])
}

/** One wing, spread along ±x from the shoulder, with the pigeon's two black bars. */
function wingGeometry(sign) {
  return ellipsoid(0.17, 0.014, 0.07, sign * 0.16, 0, -0.02, (p) => {
    const ax = Math.abs(p.x)
    if (ax > 0.25) return 0x474d59 // primaries
    if ((ax > 0.1 && ax < 0.125) || (ax > 0.155 && ax < 0.18)) return 0x2a2d34 // wing bars
    return 0xa0a9b8
  }, 16, 8)
}

/** Both legs hanging down from the hip pivot, with little three-toed feet. */
function legGeometry() {
  const parts = []
  for (const s of [1, -1]) {
    const leg = new THREE.CylinderGeometry(0.011, 0.013, HIP.y, 6)
    leg.translate(s * 0.045, -HIP.y / 2, 0)
    leg.computeVertexNormals()
    paintBy(leg, flat(0xc86a66))
    parts.push(leg)
    for (const a of [-0.45, 0, 0.45]) {
      const toe = new THREE.BoxGeometry(0.01, 0.008, 0.05)
      toe.translate(0, 0, 0.022)
      toe.rotateY(a)
      toe.translate(s * 0.045, -HIP.y + 0.004, 0)
      paintBy(toe, flat(0xc86a66))
      parts.push(toe)
    }
  }
  return merge(parts)
}

/** The message capsule on the right leg. */
function bandGeometry() {
  const geo = new THREE.CylinderGeometry(0.02, 0.02, 0.045, 10)
  geo.translate(0.045, -HIP.y * 0.45, 0)
  return geo
}

// ── helpers ───────────────────────────────────────────────────────────────────────────

const _ce = new THREE.Euler(0, 0, 0, 'YXZ')
const _cq = new THREE.Quaternion()
const _cv = new THREE.Vector3()
const _cs = new THREE.Vector3()

function compose(m, x, y, z, rx, ry, rz, sx, sy, sz) {
  _ce.set(rx, ry, rz, 'YXZ')
  _cq.setFromEuler(_ce)
  return m.compose(_cv.set(x, y, z), _cq, _cs.set(sx, sy, sz))
}

const lerp = (a, b, t) => a + (b - a) * t

function angleDamp(current, target, lambda, dt) {
  let delta = target - current
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return current + delta * (1 - Math.exp(-lambda * dt))
}

function hashPair(a, b) {
  let h = 2166136261
  const str = `${a}|${b}`
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
