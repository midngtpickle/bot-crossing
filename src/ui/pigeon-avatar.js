/**
 * The card portrait for a carrier pigeon — a Google Tasks list or one of its open tasks.
 *
 * A bot's card shows its screen-face straight out of the atlas; a pigeon has no screen, so it
 * gets a little head-and-shoulders portrait drawn in 2D instead, in the same colours as the
 * bird in the world: blue-grey back, the green-and-purple neck, orange eye. It acts out its
 * status the way the bird does — pecks while working, cocks its head while waiting, puffs up
 * when blocked, bobs when celebrating, tucks in to sleep — and blinks on its own clock.
 *
 * Drawn by hand rather than rendered from the 3D model because the card is 54px across and
 * a portrait reads there where a scaled-down render of a whole bird would not.
 */

const BACK = '#7f8a9e'
const BELLY = '#a6aebb'
const HEAD = '#6d7686'

/** How the portrait poses for each status: head tilt and dip, body puff, eyes. */
const POSE = {
  working: { tilt: 0, dip: 1, puff: 1 },
  waiting: { tilt: -0.32, dip: 0, puff: 1 },
  blocked: { tilt: 0.08, dip: 0, puff: 1.12, cross: true },
  celebrating: { tilt: -0.12, dip: 0, puff: 1, bounce: true, sparkle: true },
  idle: { tilt: 0, dip: 0, puff: 1 },
  sleeping: { tilt: 0.2, dip: 0.5, puff: 1.08, asleep: true },
  spawning: { tilt: -0.1, dip: 0, puff: 1 },
  leaving: { tilt: 0, dip: 0, puff: 1 },
}

/**
 * The state the portrait depends on right now, as a string — so the card only redraws when
 * something visible has changed rather than every frame.
 */
export function pigeonAvatarKey(status, band, now) {
  const pose = POSE[status] || POSE.idle
  const blink = !pose.asleep && now % 3800 < 140
  // Pecking and bouncing move on a coarse clock: a few distinct frames are all a 54px
  // portrait can show, and it keeps the redraws to a handful a second.
  const beat = pose.dip === 1 || pose.bounce ? Math.floor(now / 110) % 8 : 0
  return `${status}|${band}|${blink ? 1 : 0}|${beat}`
}

/** Draw the portrait into `ctx`, filling a `size` square. `band` is the capsule's CSS colour. */
export function drawPigeonAvatar(ctx, size, status, band, now) {
  const pose = POSE[status] || POSE.idle
  const s = size / 108
  const blink = !pose.asleep && now % 3800 < 140
  const beat = Math.floor(now / 110) % 8
  // A peck is a quick jab down on two beats out of eight; a celebration is a little hop.
  const peck = pose.dip === 1 ? (beat === 2 ? 0.8 : beat === 3 ? 1 : beat === 4 ? 0.4 : 0) : pose.dip
  const hop = pose.bounce ? Math.sin((beat / 8) * Math.PI * 2) * 4 : 0

  ctx.save()
  ctx.clearRect(0, 0, size, size)
  const bg = ctx.createRadialGradient(54 * s, 40 * s, 6 * s, 54 * s, 54 * s, 76 * s)
  bg.addColorStop(0, '#1b2233')
  bg.addColorStop(1, '#090b12')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, size, size)
  ctx.scale(s, s)
  ctx.translate(0, -hop)

  // Shoulders and breast.
  ctx.save()
  ctx.translate(50, 96)
  ctx.scale(pose.puff, pose.puff)
  const body = ctx.createLinearGradient(0, -40, 0, 20)
  body.addColorStop(0, BACK)
  body.addColorStop(1, BELLY)
  ctx.fillStyle = body
  ellipse(ctx, 0, 0, 40, 34)
  // The folded wing across the near side, with the two black bars.
  ctx.fillStyle = '#8f99ab'
  ellipse(ctx, -14, 2, 26, 18, -0.25)
  ctx.strokeStyle = '#2a2d34'
  ctx.lineWidth = 3.2
  ctx.lineCap = 'round'
  for (const dx of [-20, -9]) {
    ctx.beginPath()
    ctx.moveTo(dx - 3, -6)
    ctx.quadraticCurveTo(dx + 1, 4, dx - 2, 14)
    ctx.stroke()
  }
  ctx.restore()

  // The capsule on its leg, peeking out at the bottom and glowing the status colour.
  ctx.save()
  ctx.shadowColor = band
  ctx.shadowBlur = 10
  ctx.fillStyle = band
  roundRect(ctx, 66, 92 + hop, 9, 16, 4)
  ctx.restore()

  // Neck and head pivot together: tilt to cock it, dip to peck.
  ctx.save()
  ctx.translate(56, 64)
  ctx.rotate(pose.tilt + peck * 0.55)
  ctx.translate(peck * 4, peck * 6)

  // The iridescent neck.
  const neck = ctx.createLinearGradient(-18, -10, 18, 14)
  neck.addColorStop(0, '#3f8c6a')
  neck.addColorStop(0.5, '#5d7f86')
  neck.addColorStop(1, '#7d5592')
  ctx.fillStyle = neck
  ellipse(ctx, 0, 0, 20, 18)

  // Head.
  ctx.fillStyle = HEAD
  ellipse(ctx, 4, -22, 19, 17)

  // Beak, with the pale cere at its base.
  ctx.fillStyle = '#3b3c42'
  ctx.beginPath()
  ctx.moveTo(19, -26)
  ctx.lineTo(34, -19)
  ctx.lineTo(19, -15)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#e9e6e0'
  ellipse(ctx, 19, -24, 4.5, 3.2)

  // Eye: an orange ring and a black pupil, or a closed lid.
  if (pose.asleep || blink) {
    ctx.strokeStyle = '#1a1c22'
    ctx.lineWidth = 2.4
    ctx.beginPath()
    ctx.arc(9, -25, 5, 0.15 * Math.PI, 0.85 * Math.PI)
    ctx.stroke()
  } else {
    ctx.fillStyle = '#e0702a'
    ellipse(ctx, 9, -25, 6, 6)
    ctx.fillStyle = '#101010'
    ellipse(ctx, 10, -25, 3, 3)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ellipse(ctx, 11.3, -26.6, 1.1, 1.1)
  }
  // A cross brow when it is stuck.
  if (pose.cross) {
    ctx.strokeStyle = '#1a1c22'
    ctx.lineWidth = 2.6
    ctx.beginPath()
    ctx.moveTo(2, -35)
    ctx.lineTo(15, -30)
    ctx.stroke()
  }
  ctx.restore()

  if (pose.asleep) {
    ctx.fillStyle = 'rgba(200,210,255,0.85)'
    ctx.font = 'bold 14px system-ui, sans-serif'
    ctx.fillText('z', 80, 30)
    ctx.font = 'bold 10px system-ui, sans-serif'
    ctx.fillText('z', 90, 20)
  }
  if (pose.sparkle) {
    ctx.fillStyle = '#ffd36a'
    for (const [x, y, r] of [[18, 22, 3], [88, 34, 2.4], [84, 14, 1.8]]) star(ctx, x, y + hop * (beat % 2 ? 0.5 : -0.5), r)
  }
  ctx.restore()

  // The same scanlines as a bot's card, so the two kinds read as one family.
  ctx.globalAlpha = 0.12
  ctx.fillStyle = '#000'
  for (let y = 0; y < size; y += 3) ctx.fillRect(0, y, size, 1)
  ctx.globalAlpha = 1
}

function ellipse(ctx, x, y, rx, ry, rot = 0) {
  ctx.beginPath()
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2)
  ctx.fill()
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fill()
}

function star(ctx, x, y, r) {
  ctx.beginPath()
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const d = i % 2 ? r * 0.4 : r * 2
    ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d)
  }
  ctx.closePath()
  ctx.fill()
}
