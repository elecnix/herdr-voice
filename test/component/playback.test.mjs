/**
 * Component test: playback is paced, so what has been queued can still be changed.
 *
 * The model streams an answer far faster than it can be spoken. Written straight
 * through to the player, a minute of speech sits in a pipe the app no longer
 * controls — it cannot be quietened, and nothing can say which part of it the
 * room is hearing. Both matter as soon as anything wants to react to the person
 * listening.
 *
 * Uses a stand-in player, so it needs no sound server and makes no noise.
 */
import { AudioPlayer } from '../../src/audio.js'
import { SAMPLE_RATE } from '../../src/config.js'

// A stand-in for the real player: no sound server, and no noise.
process.env.HERDR_VOICE_PLAYER_CMD = 'cat'

const SECONDS = 10
const tone = Buffer.alloc(SECONDS * SAMPLE_RATE * 2)
for (let i = 0; i < tone.length / 2; i++) {
  tone.writeInt16LE(Math.round(0.5 * Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE) * 32767), i * 2)
}

const rmsOf = (buf) => {
  let sum = 0
  for (let i = 0; i < buf.length / 2; i++) {
    const v = buf.readInt16LE(i * 2)
    sum += v * v
  }
  return Math.sqrt(sum / (buf.length / 2)) / 32768
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const player = new AudioPlayer().start()
const played = []
player.on('played', (e) => played.push(e))
player.play(tone.toString('base64')) // the whole answer at once, as the API delivers it

await wait(600)
const early = played.reduce((n, e) => n + e.pcm.length, 0)
player.setGain(0.15)
await wait(900)
const late = played.reduce((n, e) => n + e.pcm.length, 0)
player.stop()

const bytesPerSec = SAMPLE_RATE * 2
check(
  'the player is fed just ahead of realtime, not all at once',
  late < bytesPerSec * 3,
  `${(late / bytesPerSec).toFixed(1)}s handed over after 1.5s (all at once would be ${SECONDS}s)`
)
check('playback still progresses', early > bytesPerSec * 0.2, `${(early / bytesPerSec).toFixed(2)}s in the first 0.6s`)

// A change applies to audio that was queued long before it — which is the
// difference between being able to react to the listener and not.
const before = rmsOf(Buffer.concat(played.filter((e) => e.pcm.length).slice(0, 4).map((e) => e.pcm)))
const after = rmsOf(Buffer.concat(played.slice(-4).map((e) => e.pcm)))
check(
  'a volume change reaches audio that was already queued',
  after < before / 3,
  `${before.toFixed(4)} before, ${after.toFixed(4)} after (${(20 * Math.log10(after / before)).toFixed(1)} dB)`
)

// Every chunk is announced with the moment it will be heard, in order.
const ordered = played.every((e, i) => i === 0 || e.at >= played[i - 1].at)
check('each chunk is announced with when it will be heard, in order', ordered && played.length > 5, `${played.length} chunks`)
const span = played.at(-1).at - played[0].at
check(
  'those times advance at the rate the audio actually plays',
  Math.abs(span - (late - played.at(-1).pcm.length) / bytesPerSec * 1000) < 400,
  `${(span / 1000).toFixed(2)}s of schedule for ${(late / bytesPerSec).toFixed(2)}s of audio`
)

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'}`)
process.exit(failed ? 1 : 0)
