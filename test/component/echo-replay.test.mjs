/**
 * Component test: REAL recorded sessions, replayed through the real detector.
 *
 * Each fixture is a capture of an actual voice session on a real machine — every
 * microphone frame it measured and every chunk of audio it played, with the
 * timings it saw (HERDR_VOICE_ECHO_TRACE writes them). In all of them the agent
 * talks for about four minutes through speakers its microphone can hear, with
 * typed interruptions in between, and nobody speaks.
 *
 * What the detector produces is a DUCK, not a cancellation — the agent drops its
 * volume and listens harder, and only the server transcribing actual words stops
 * it (see core.js). So the bar here is a rate, not zero: a spurious duck is a
 * third of a second of quiet that reverses itself, and refusing to spend any of
 * them is what forced the threshold so high that interrupting meant shouting.
 * Budget below; the measured rate is printed either way, so drift shows up even
 * while passing.
 *
 * Every barge-in bug so far has been a detail of the real thing that no
 * simulation had thought to include, and each fixture is one of them caught in
 * the act:
 *
 *   blind-schedule  The play head is reset whenever playback is dropped, so the
 *                   schedule jumps backwards — by 56 seconds here. Appended in
 *                   that order the reference timeline stops being sorted, the
 *                   binary search that reads it lands in the wrong place, and
 *                   the guard sees silence while the speakers are at full
 *                   volume. It then interrupted itself and answered its own
 *                   words back ("Oh, thank you! That's really kind of you").
 *   cold-start      The first alignment is fitted on the two seconds of history
 *                   that are the minimum to fit at all. This one landed a
 *                   syllable out, and the guard armed on it immediately and
 *                   barged five seconds into the session.
 *
 * Reproducing either live took six minutes and never repeated exactly. Here it
 * takes a second, and it repeats exactly.
 *
 * Re-record with:
 *   HERDR_VOICE_ECHO_TRACE=/tmp/session.jsonl node src/index.js --full
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { EchoGuard } from '../../src/echo.js'
import { SAMPLE_RATE } from '../../src/config.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, '../fixtures')
const SUB_MS = 25

/** Rebuild audio whose 25ms RMS values are exactly the ones recorded — all the
 *  guard ever reads from the reference, so the replay is exact. */
function pcmFrom(rms) {
  const step = (SAMPLE_RATE * 2 * SUB_MS) / 1000
  const buf = Buffer.alloc(rms.length * step)
  rms.forEach((v, k) => {
    const amp = Math.round(Math.min(1, v) * 32767)
    for (let i = 0; i < step / 2; i++) buf.writeInt16LE(i % 2 ? amp : -amp, k * step + i * 2)
  })
  return buf
}

function replay(file) {
  const lines = zlib
    .gunzipSync(fs.readFileSync(path.join(FIXTURES, file)))
    .toString()
    .split('\n')
    .filter(Boolean)
  const guard = new EchoGuard()
  const barges = []
  let lastDuck = -Infinity
  const headroom = []
  let t0 = null
  let frames = 0
  for (const line of lines) {
    const e = JSON.parse(line)
    if (e.ref !== undefined) {
      guard.pushReference(pcmFrom(e.rms), e.ref)
      continue
    }
    t0 ??= e.mic
    frames++
    const d = guard.observe({ level: e.level, now: e.mic, armed: e.armed })
    // One duck lasts several frames; count the events, not the frames.
    if (d.barge && e.mic - lastDuck > 1500) {
      barges.push(((e.mic - t0) / 1000).toFixed(1))
      lastDuck = e.mic
    }
    if (d.ref > 0.02) headroom.push(d.level / d.threshold)
  }
  headroom.sort((a, b) => a - b)
  return { frames, seconds: (frames * 100) / 1000, barges, headroom }
}

// A spurious duck costs ~350ms of reduced volume. About one every two minutes
// is the most that should go unnoticed; more than that and the detector is
// jumping at the agent's own voice again.
const DUCK_BUDGET_PER_MIN = 1.0

let failed = 0
for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.jsonl.gz')).sort()) {
  const { frames, seconds, barges, headroom } = replay(file)
  const q = (p) => headroom[Math.floor(p * (headroom.length - 1))]
  const name = file.replace(/^echo-session-|\.jsonl\.gz$/g, '')
  const perMin = barges.length / (seconds / 60)
  if (perMin > DUCK_BUDGET_PER_MIN) {
    console.error(
      `FAIL ${name}: ducked ${barges.length}x in ${seconds.toFixed(0)}s (${perMin.toFixed(2)}/min, ` +
        `budget ${DUCK_BUDGET_PER_MIN}) at [${barges}]s — nobody was speaking`
    )
    failed++
    continue
  }
  // It must not have gone deaf either: a detector that never fires would also
  // pass the check above.
  if (!headroom.length || q(0.5) < 0.05) {
    console.error(`FAIL ${name}: thresholds are ${(1 / q(0.5)).toFixed(0)}x the observed level — deaf, not correct`)
    failed++
    continue
  }
  console.log(
    `ok   ${name}: ${seconds.toFixed(0)}s, ${barges.length} spurious duck(s) = ${perMin.toFixed(2)}/min ` +
      `(budget ${DUCK_BUDGET_PER_MIN}); level/threshold while audible ` +
      `p50=${q(0.5).toFixed(2)} p90=${q(0.9).toFixed(2)} p99=${q(0.99).toFixed(2)}`
  )
}
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'}`)
if (failed) process.exit(1)
