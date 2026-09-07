/**
 * Replays a captured voice session through the echo guard, offline.
 *
 *   HERDR_VOICE_ECHO_TRACE=/tmp/session.jsonl node src/index.js --full   # capture
 *   node scripts/replay-echo-trace.mjs /tmp/session.jsonl --context      # replay
 *
 * Same input every time, so the detector is the only thing that varies. This is
 * the tool to reach for when barge-in misbehaves: capture it once, then iterate
 * in a second instead of six minutes, against the exact room that broke it.
 * `--context` prints every frame around each decision — level, threshold,
 * reference, coupling, alignment — which is what makes a wrong answer legible.
 */
import fs from 'node:fs'
import { EchoGuard } from '../src/echo.js'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/replay-echo-trace.mjs <trace.jsonl> [--context]')
  process.exit(2)
}
const showContext = process.argv.includes('--context')
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)

/** Rebuild PCM whose 25ms RMS values are exactly those captured. */
function pcmFrom(rms) {
  const step = (24000 * 2 * 25) / 1000
  const b = Buffer.alloc(rms.length * step)
  rms.forEach((v, k) => {
    const amp = Math.round(Math.min(1, v) * 32767)
    for (let i = 0; i < step / 2; i++) b.writeInt16LE(i % 2 ? amp : -amp, k * step + i * 2)
  })
  return b
}

const guard = new EchoGuard()
const barges = []
const frames = []
let t0 = null
for (const line of lines) {
  const e = JSON.parse(line)
  if (e.ref !== undefined) {
    guard.pushReference(pcmFrom(e.rms), e.ref)
    continue
  }
  t0 ??= e.mic
  const d = guard.observe({ level: e.level, now: e.mic, armed: e.armed })
  frames.push({ t: (e.mic - t0) / 1000, ...d })
  if (d.barge) barges.push(frames.length - 1)
}

const secs = frames.length ? frames[frames.length - 1].t : 0
console.log(`${frames.length} mic frames over ${secs.toFixed(0)}s — ${barges.length} self-barge(s)`)
if (showContext) {
  for (const i of barges) {
    console.log(`\n--- barge at ${frames[i].t.toFixed(1)}s ---`)
    for (const f of frames.slice(Math.max(0, i - 10), i + 3)) {
      console.log(
        `  t=${f.t.toFixed(1)} lvl=${f.level.toFixed(4)} thr=${f.threshold.toFixed(4)} ` +
          `ref=${f.ref.toFixed(4)} gain=${f.gain.toFixed(2)} amb=${f.ambient.toFixed(4)} ` +
          `lag=${f.delayMs} run=${f.run}${f.speech ? ' SPEECH' : ''}${f.barge ? ' BARGE' : ''}`
      )
    }
  }
}
// How much headroom the guard had: the distribution of level/threshold on
// frames where the agent was audible and nobody was talking.
const armed = frames.filter((f) => f.ref > 0.02)
if (armed.length) {
  const r = armed.map((f) => f.level / f.threshold).sort((a, b) => a - b)
  const q = (p) => r[Math.floor(p * (r.length - 1))]
  console.log(
    `level/threshold while the agent is audible: p50=${q(0.5).toFixed(2)} p90=${q(0.9).toFixed(2)} ` +
      `p99=${q(0.99).toFixed(2)} max=${r[r.length - 1].toFixed(2)}  (>=1 is "speech")`
  )
}
process.exit(barges.length ? 1 : 0)
