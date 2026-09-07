/**
 * Component test: the echo guard must not mistake the agent's own voice for
 * the user, at ANY speaker volume.
 *
 * This is the regression test for "barge-in self-interrupts when I increase
 * the volume of my speakers". It drives the real EchoGuard (src/echo.js) from
 * a simulated room:
 *
 *   reference  the PCM we hand to the speaker (syllables + the gaps between
 *              words and sentences that real speech has)
 *   echo       coupling x reference, delayed by the speaker->mic path
 *   user       an independent voice with its own rhythm
 *   mic        sqrt(echo^2 + user^2 + ambient^2) — uncorrelated sources add in
 *              power, which is what the microphone actually integrates
 *
 * Every scenario also runs the OLD detector (fixed level floor + 400ms
 * consecutive run) so the numbers show what changed rather than asserting into
 * the void.
 *
 * Tuning aids, when this needs to be re-opened: TRACE=<scenario number> prints
 * every frame's level, threshold, predicted echo and gain over that scenario's
 * interesting window, and STATS=1 reports how tightly the prediction tracks the
 * real echo (level/reference deciles over echo-only frames) — the single number
 * that decides how small `margin` can safely be.
 */
import { EchoGuard, frameRms } from '../../src/echo.js'

const SAMPLE_RATE = 24000
const FRAME_MS = 100
const STEP_MS = 10 // fine grid the room is simulated on
const SUB = FRAME_MS / STEP_MS
const DELAY_MS = 250 // speaker -> air -> mic -> ffmpeg
const REVERB = 0.8 // per 10ms: a ~300ms RT60 room
// How far ahead of the play head the reference is scheduled. The model streams
// audio FAR faster than realtime — a fifteen-second answer arrives in about a
// second — so by mid-answer the newest scheduled frame sits fifteen seconds in
// the future while the mic is hearing something from long before it. Scheduling
// only a second ahead (which an earlier version of this test did) hides a whole
// class of bug: it never asks what the guard remembers about audio that is
// playing NOW while the timeline has run far ahead of it.
const LOOKAHEAD_MS = 16_000
// Real rooms do not couple by one clean number. Measured on live hardware, the
// mic/reference ratio ran p10=0.10 p50=0.20 p90=0.39 max=0.74 over a single
// answer — the speaker's and the mic's frequency responses disagree, and which
// sounds the agent happens to be making decide where in that spread a frame
// lands. A threshold has to clear the TOP of it, not the middle, so the
// scenarios below jitter the coupling by roughly that much.
const JITTER_SIGMA = 0.5
const AMBIENT = 0.004

/** PCM16 whose RMS follows `env` over `ms` starting at `from` on the fine grid.
 *  Real deltas carry the waveform at full resolution — quantizing the fixture
 *  to one level per 100ms would hand the guard a coarser reference than
 *  production ever sees. */
function pcm(env, from, ms) {
  const b = Buffer.alloc((SAMPLE_RATE * 2 * ms) / 1000)
  const perStep = (SAMPLE_RATE * STEP_MS) / 1000
  for (let i = 0; i < b.length / 2; i++) {
    const v = Math.round(Math.min(1, env(from + Math.floor(i / perStep))) * 32767)
    b.writeInt16LE(i % 2 ? v : -v, i * 2)
  }
  return b
}

/** Speech-shaped envelope: syllables, plus a pause between sentences. */
function voice({ t, peak, syllHz, sentenceS, pauseS, phase = 0 }) {
  const s = t / 1000
  if (s % sentenceS > sentenceS - pauseS) return 0
  const v = Math.max(0, Math.sin(2 * Math.PI * syllHz * s + phase))
  return peak * (0.12 + 0.88 * Math.pow(v, 0.7))
}

const agentVoice = (t) => voice({ t, peak: 0.12, syllHz: 3.5, sentenceS: 2.4, pauseS: 0.4 })
const userVoice = (t) => voice({ t, peak: 0.05, syllHz: 4.3, sentenceS: 3.1, pauseS: 0.5, phase: 1.1 })

/** Deterministic PRNG, so a failure is always the same failure. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Log-normal jitter: a multiplicative spread around 1, the way a room varies. */
function jitterSeries(steps, sigma, seed = 1) {
  const rand = rng(seed)
  const out = new Float64Array(steps)
  let held = 1
  for (let i = 0; i < steps; i++) {
    // Re-drawn per 100ms frame; within a frame the coupling is one number.
    if (i % SUB === 0) {
      const u = Math.max(1e-9, rand())
      const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
      held = Math.exp(sigma * g)
    }
    out[i] = held
  }
  return out
}

/** RMS over one 100ms frame of a signal sampled on the 10ms grid. */
const framePower = (get, i0) => {
  let sum = 0
  for (let i = 0; i < SUB; i++) {
    const v = get(i0 + i)
    sum += v * v
  }
  return Math.sqrt(sum / SUB)
}

/**
 * Run one scenario. `coupling(t)` is the speaker->mic gain (the volume knob),
 * `speaks(t)` whether the user is talking, `playing(t)` whether the agent is.
 *
 * The room is simulated on a 10ms grid and integrated into 100ms frames — the
 * same averaging a real microphone chunk does. Sampling the envelope once per
 * frame instead would alias 3.5Hz syllables into noise.
 */
function simulate({
  seconds,
  coupling,
  speaks = () => false,
  playing = () => true,
  noise = AMBIENT,
  jitter = 0,
  lagDrift = 0,
  trace,
}) {
  const guard = new EchoGuard({ floor: 0.01, bargeMs: 400 })
  const t0 = 1_000_000 // arbitrary epoch; the guard only ever sees deltas
  const steps = Math.ceil((seconds * 1000) / STEP_MS)

  // Reference on the fine grid, then the echo it produces at the mic: the
  // direct sound, delayed, plus a decaying reverb tail.
  const ref = new Float64Array(steps + SUB)
  for (let i = 0; i < ref.length; i++) {
    const t = i * STEP_MS
    ref[i] = playing(t) ? agentVoice(t) : 0
  }
  const echo = new Float64Array(steps + SUB)
  const wobble = jitterSeries(echo.length, jitter)
  // The play head models when audio SHOULD be heard, advancing by a nominal
  // 24000 samples per second. The sound card runs at its own rate, so the error
  // ACCUMULATES: `lagDrift` is that accumulation in ms per second of playback
  // (a 1% clock offset is 10). Measured on hardware as ~380ms of slip partway
  // into a single long answer.
  const lagAt = (i) => Math.round((DELAY_MS + (lagDrift * i * STEP_MS) / 1000) / STEP_MS)
  for (let i = 0; i < echo.length; i++) {
    const lag = lagAt(i)
    const direct = i >= lag ? coupling((i - lag) * STEP_MS) * wobble[i] * ref[i - lag] : 0
    echo[i] = Math.max(direct, i ? echo[i - 1] * REVERB : 0)
  }

  const barges = []
  const ratioStats = []
  // Frames where the mic is hearing the agent but the guard has no reference
  // for it — deaf, and left with nothing but the absolute floor.
  let blind = 0
  let pushedTo = 0 // reference already scheduled, in frames
  // Old detector, for comparison: fixed floor, 400ms of consecutive frames.
  let oldRun = 0
  const oldBarges = []

  for (let k = 0; k * SUB < steps; k++) {
    const t = t0 + k * FRAME_MS
    // Audio is scheduled well ahead of the play head, exactly as core.js
    // pushes it when the deltas arrive faster than they can be played.
    while (pushedTo * FRAME_MS < k * FRAME_MS + LOOKAHEAD_MS) {
      const at = t0 + pushedTo * FRAME_MS
      // core.js pushes whole audio deltas; the guard slices them itself.
      if (framePower((i) => ref[i] ?? 0, pushedTo * SUB) > 0) {
        guard.pushReference(pcm((i) => ref[i] ?? 0, pushedTo * SUB, FRAME_MS), at)
      }
      pushedTo++
    }
    // A mic chunk is emitted when it COMPLETES, so the level reported at t
    // covers [t-100ms, t) — the guard's alignment depends on getting this right.
    const level = framePower((i) => {
      if (i < 0) return noise
      const e = echo[i] ?? 0
      const u = speaks(i * STEP_MS) ? userVoice(i * STEP_MS) : 0
      return Math.sqrt(e * e + u * u + noise * noise)
    }, (k - 1) * SUB)

    const d = guard.observe({ level, now: t, armed: true })
    if (trace && (t - t0) / 1000 >= trace[0] && (t - t0) / 1000 <= trace[1]) {
      console.log(
        `  t=${((t - t0) / 1000).toFixed(1)} lvl=${d.level.toFixed(4)} thr=${d.threshold.toFixed(4)} ` +
          `ref=${d.ref.toFixed(4)} echo=${d.predicted.toFixed(4)} gain=${d.gain.toFixed(2)} run=${d.run}${d.speech ? ' SPEECH' : ''}${d.barge ? ' BARGE' : ''}`
      )
    }
    if (framePower((i) => echo[i] ?? 0, (k - 1) * SUB) >= 0.005 && d.ref === 0) blind++
    if (process.env.STATS && d.ref > 0.02 && !speaks(k * FRAME_MS)) ratioStats.push(d.level / d.ref)
    if (d.barge) barges.push(Math.round((t - t0) / 100) / 10)

    oldRun = level >= 0.01 ? oldRun + 1 : 0
    if (oldRun * FRAME_MS >= 400) {
      oldBarges.push(Math.round((t - t0) / 100) / 10)
      oldRun = 0
    }
  }
  if (process.env.STATS && ratioStats.length) {
    const q = (f) => ratioStats.slice().sort((a, b) => a - b)[Math.floor(f * (ratioStats.length - 1))]
    console.log(
      `  [stats] echo-only level/reference  p10=${q(0.1).toFixed(3)} p50=${q(0.5).toFixed(3)} ` +
        `p90=${q(0.9).toFixed(3)} spread=${(q(0.9) / q(0.1)).toFixed(2)}x`
    )
  }
  return { barges, oldBarges, blind, gain: guard.gain, delayMs: guard.delayMs }
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// A sanity check on the fixture itself: the simulated frames really do carry
// the RMS the envelope asks for.
check('pcm fixture is calibrated', Math.abs(frameRms(pcm(() => 0.12, 0, FRAME_MS)) - 0.12) < 1e-4)

// 1. Quiet room, nothing playing: never a barge.
{
  const r = simulate({ seconds: 10, coupling: () => 0, playing: () => false })
  check('silence never barges', r.barges.length === 0, `barges=[${r.barges}]`)
}

// 2. The agent talks over speakers at a moderate volume. No user, no barge.
{
  const r = simulate({ seconds: 15, coupling: () => 0.15 })
  check(
    'moderate speaker volume never self-barges',
    r.barges.length === 0,
    `barges=[${r.barges}] gain=${r.gain.toFixed(2)} delay=${r.delayMs}ms`
  )
  // The guard must still KNOW what is playing after the stream has run far
  // ahead of the play head. Retention measured from the newest scheduled frame
  // instead of from now deleted the audio currently being heard, and the guard
  // fell back to the bare floor mid-answer — the original bug, wearing a
  // different hat. (Seen in production as: ref=0.0000 with a 14s tail queued.)
  check('the reference survives while the stream runs ahead', r.blind === 0, `${r.blind} frames with no reference`)
}

// 3. THE BUG: the user turns the speakers up mid-answer (0.15 -> 0.6). The old
//    detector fires within 400ms; the guard must recognize a louder room.
{
  const r = simulate({ seconds: 20, coupling: (t) => (t < 8000 ? 0.15 : 0.6), trace: process.env.TRACE === '3' ? [7.8, 9.6] : null })
  check(
    'raising the speaker volume never self-barges',
    r.barges.length === 0,
    `barges=[${r.barges}] gain=${r.gain.toFixed(2)}`
  )
  check(
    'the old level detector DID self-barge here (bug reproduced)',
    r.oldBarges.length > 0,
    `old barges=[${r.oldBarges.slice(0, 6)}...]`
  )
}

// 4. Loud speakers AND the user speaks, at comparable levels at the mic.
{
  const r = simulate({
    seconds: 20,
    coupling: () => 0.45,
    speaks: (t) => t >= 12000,
    trace: process.env.TRACE === '4' ? [11.9, 15.5] : null,
  })
  const first = r.barges[0]
  check(
    'the user is heard when the echo is as loud as they are',
    first !== undefined && first >= 12 && first <= 14.5,
    `first barge=${first}s (user starts at 12s)`
  )
}

// 4b. Speakers louder than the user. No instantaneous comparison can separate
//     them here — the only evidence is in the agent's own gaps, so it can take
//     until a sentence boundary. Slower is the honest answer; interrupting
//     itself in the meantime is not.
{
  const r = simulate({ seconds: 24, coupling: () => 0.7, speaks: (t) => t >= 12000 })
  const first = r.barges[0]
  check(
    'the user is eventually heard over speakers louder than they are',
    first !== undefined && first >= 12 && first <= 18,
    `first barge=${first}s (user starts at 12s)`
  )
}

// 5. Same, at a normal volume: the user is louder than the echo, so the barge
//    lands about as fast as the evidence window allows.
{
  const r = simulate({
    seconds: 20,
    coupling: () => 0.15,
    speaks: (t) => t >= 12000,
    trace: process.env.TRACE === '5' ? [11.9, 13.6] : null,
  })
  const first = r.barges[0]
  check(
    'the user is heard promptly at a normal volume',
    first !== undefined && first >= 12 && first <= 13.5,
    `first barge=${first}s (user starts at 12s)`
  )
}

// 6. Nothing playing (the agent is thinking, or running a tool) and the user
//    speaks: no reference at all, so the absolute floor decides.
{
  const r = simulate({
    seconds: 10,
    coupling: () => 0,
    playing: () => false,
    speaks: (t) => t >= 4000,
  })
  const first = r.barges[0]
  check('speech with nothing playing barges', first !== undefined && first >= 4 && first <= 5.5, `first barge=${first}s`)
}

// 7. Deafening speakers (coupling 1.2 — the mic hears the agent louder than a
//    person). Still no self-barge: the decision is a ratio, not a level.
{
  const r = simulate({ seconds: 15, coupling: () => 1.2, trace: process.env.TRACE === '7' ? [0.3, 1.5] : null })
  check('extreme speaker volume never self-barges', r.barges.length === 0, `barges=[${r.barges}] gain=${r.gain.toFixed(2)}`)
}

// 8. Turning the speakers DOWN mid-answer. The coupling estimate is released
//    slowly on purpose, so this direction is the safe one — but it must not
//    leave the guard deaf: the user is still heard afterwards.
{
  const r = simulate({
    seconds: 20,
    coupling: (t) => (t < 8000 ? 0.6 : 0.15),
    speaks: (t) => t >= 12000,
  })
  const first = r.barges[0]
  check(
    'lowering the speaker volume neither barges nor deafens',
    first !== undefined && first >= 12 && first <= 15.5,
    `barges=[${r.barges.slice(0, 3)}] gain=${r.gain.toFixed(2)}`
  )
}

// 9. A room that couples unevenly — the real case. An estimate that tracks the
//    MIDDLE of that spread leaves one echo frame in ten above the line, and four
//    of those inside a second is a self-interruption. Observed exactly so on
//    real hardware, before the estimator targeted the top of the spread.
{
  const r = simulate({ seconds: 20, coupling: () => 0.3, jitter: JITTER_SIGMA })
  check('an unevenly coupled room never self-barges', r.barges.length === 0, `barges=[${r.barges}] gain=${r.gain.toFixed(2)}`)
}

// 9b. The same uneven room, with the volume raised half way through.
{
  const r = simulate({ seconds: 24, coupling: (t) => (t < 10000 ? 0.25 : 0.9), jitter: JITTER_SIGMA })
  check('an unevenly coupled room survives the volume knob', r.barges.length === 0, `barges=[${r.barges}] gain=${r.gain.toFixed(2)}`)
}

// 9c. Uneven room, and the user speaks over it at an ordinary level (their voice
//     louder at the mic than the leak, which is the everyday case).
{
  const r = simulate({ seconds: 22, coupling: () => 0.2, jitter: JITTER_SIGMA, speaks: (t) => t >= 12000 })
  const first = r.barges[0]
  check('the user is heard in an unevenly coupled room', first !== undefined && first >= 12 && first <= 14.5, `first barge=${first}s`)
}

// 9d. Several answers with pauses between them. The end of a response is where
//     the schedule and the speaker disagree — the sound server is still emitting
//     after the last scheduled sample was due — and the threshold must not fall
//     back to the bare floor there. On real hardware this showed up as ref
//     collapsing 0.043 -> 0.001 while the mic still heard 0.055.
{
  const r = simulate({
    seconds: 24,
    coupling: () => 0.5,
    jitter: JITTER_SIGMA,
    lagDrift: 10, // ms of slip per second of playback — a ~1% clock offset
    // Cut mid-syllable, at a peak of the envelope — a response that stops
    // while the speaker is at its loudest is where the disagreement shows.
    playing: (t) => t % 7000 < 4950,
  })
  check('the end of an answer never self-barges', r.barges.length === 0, `barges=[${r.barges}] gain=${r.gain.toFixed(2)}`)
}

// 10. A noisy room (a fan, or someone typing) throughout. The floor is measured
//     from what the echo does not explain, so steady noise raises it instead of
//     reading as a voice.
{
  const r = simulate({ seconds: 15, coupling: () => 0.3, noise: 0.013, trace: process.env.TRACE === '9' ? [2.0, 3.4] : null })
  check('steady room noise never barges', r.barges.length === 0, `barges=[${r.barges}]`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`RESULT: ${failed.length ? 'FAIL' : 'PASS'}`)
process.exit(failed.length ? 1 : 0)
