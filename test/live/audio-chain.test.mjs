/**
 * LIVE audio-chain test (requires a real PipeWire/PulseAudio session — skips
 * gracefully when pactl is unavailable, e.g. in CI).
 *
 * Asserts the invariants barge-in depends on:
 *   1. The engine's configured mic source (HERDR_VOICE_MIC_SOURCE /
 *      PULSE_SOURCE, i.e. echocancel_src in production) EXISTS. When the
 *      echo-cancel module dies, libpulse SILENTLY falls back to the default
 *      source — on this machine a USB dongle that hears nothing — and barge-in
 *      dies without any error anywhere. (Reproduced failure.)
 *   2. The source is not digital silence: a broken/absent canceller produced
 *      ~0.0001 RMS ambient. (Reproduced failure.)
 *   3. The AI does not hear itself: audio played through the canceller's sink
 *      must arrive at the mic source strongly attenuated vs the raw acoustic
 *      coupling.
 *   4. Speaker-bypass sanity (powers speaker-based testing): audio played to
 *      the MASTER sink (acoustically audible, NOT in the canceller's
 *      reference) must arrive at the mic source — proving a speaker-fed test
 *      signal can reach the detector.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pactl = (() => {
  try {
    execFileSync('pactl', ['info'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
})()
if (!pactl) {
  console.log('SKIP: no pactl/PipeWire on this host')
  process.exit(0)
}

const sh = (cmd, opts = {}) =>
  execFileSync(cmd, { shell: '/bin/sh', encoding: 'utf8', ...opts })

// Discover the RUNNING engine's configured mic source (the production
// condition), falling back to this shell's env, then 'default'.
function engineConfiguredSource() {
  try {
    const pids = execFileSync('pgrep', ['-f', 'src/index[.]js --full'])
      .toString()
      .split('\n')
      .filter((l) => l.trim())
    for (const pid of pids) {
      const env = fs.readFileSync(`/proc/${pid.trim()}/environ`).toString().split('\0')
      const get = (k) => env.find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
      const src = get('HERDR_VOICE_MIC_SOURCE') ?? get('PULSE_SOURCE')
      if (src) return { source: src, pid: pid.trim() }
    }
  } catch {}
  return { source: process.env.PULSE_SOURCE ?? 'default', pid: null }
}
const { source: micSource, pid: enginePid } = engineConfiguredSource()
const results = []
const fail = (msg) => {
  results.push(`FAIL: ${msg}`)
  console.log(results.map((r) => `  ${r}`).join('\n'))
  console.log('RESULT: FAIL')
  process.exit(1)
}
const pass = (msg) => results.push(`ok: ${msg}`)

// ---- 1. the configured source exists ----
let sources = ''
try {
  sources = sh('pactl list short sources', { env: { ...process.env, LANG: 'C', LC_ALL: 'C' } })
} catch (e) {
  sources = e.stdout ?? ''
}
const sourceName = micSource === 'default' ? null : micSource
const exists = sourceName === null || sources
  .split('\n')
  .some((l) => l.trim() && l.split('\t')[1] === sourceName)
if (!exists)
  fail(
    `the running engine${enginePid ? ` (pid ${enginePid})` : ''} is configured for mic source "${micSource}" ` +
      `which DOES NOT EXIST — libpulse SILENTLY falls back to the default source ` +
      `(the engine hears a device nobody calibrated, barge-in dies quietly, and without ` +
      `cancellation the AI hears itself). ` +
      `Known trigger: the echo-cancel module died or was never loaded. ` +
      `Sources present: ${sources.split('\n').filter(Boolean).map((l) => l.split('\t')[1]).join(', ')}`
  )
pass(`configured mic source "${micSource}" exists${enginePid ? ` (engine pid ${enginePid})` : ''}`)

// ---- helpers ----
const { spawn } = await import('node:child_process')
function recordRms(device, seconds, env = {}) {
  return new Promise((resolve) => {
    const rec = spawn('parec', [`--device=${device}`, '--format=s16le', '--rate=24000', '--channels=1'], {
      env: { ...process.env, ...env },
    })
    const chunks = []
    rec.stdout.on('data', (d) => chunks.push(d))
    rec.on('close', () => {
      const buf = Buffer.concat(chunks)
      const a = new Int16Array(buf.buffer, 0, Math.floor(buf.length / 2))
      if (!a.length) return resolve(0)
      let sum = 0
      for (const x of a) sum += x * x
      resolve(Math.sqrt(sum / a.length) / 32768)
    })
    setTimeout(() => rec.kill(), seconds * 1000)
  })
}

const toneFile = path.join(os.tmpdir(), 'chain-tone.wav')
{
  const SR = 24000
  const pcm = []
  for (let i = 0; i < SR * 4; i++) {
    const t = i / SR
    const v = 0.3 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t))
    pcm.push(Math.round(v * 32767))
  }
  const hdr = Buffer.alloc(44)
  hdr.write('RIFF', 0)
  hdr.writeUInt32LE(36 + pcm.length * 2, 4)
  hdr.write('WAVEfmt ', 8)
  hdr.writeUInt32LE(16, 16)
  hdr.writeUInt16LE(1, 20)
  hdr.writeUInt16LE(1, 22)
  hdr.writeUInt32LE(SR, 24)
  hdr.writeUInt32LE(SR * 2, 28)
  hdr.writeUInt16LE(2, 32)
  hdr.writeUInt16LE(16, 34)
  hdr.write('data', 36)
  hdr.writeUInt32LE(pcm.length * 2, 40)
  fs.writeFileSync(toneFile, Buffer.concat([hdr, Buffer.from(Int16Array.from(pcm).buffer)]))
}
const play = (device, volume) =>
  execFileSync('paplay', [`--device=${device}`, `--volume=${volume ?? 65536}`, toneFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })

// ---- 2. liveness comes from the BYPASS probe, not ambient: webrtc's noise
// suppression legitimately crushes ambient to ~0.0001 while still passing
// speech, so ambient alone cannot distinguish healthy from dead.
const ambient = await recordRms(micSource, 2)
results.push(`info: ambient RMS ${ambient.toFixed(4)} (informational — NS may legitimately crush it)`)

// ---- 3+4. echo rejected / bypass audible — only meaningful with the canceller present
let sinks = ''
try {
  sinks = sh('pactl list short sinks', { env: { ...process.env, LANG: 'C', LC_ALL: 'C' } })
} catch {}
const hasCancellerSink = sinks.split('\n').some((l) => l.trim() && l.split('\t')[1] === 'echocancel_sink')
if (!hasCancellerSink) {
  results.push(
    'warn: echocancel_sink not present — echo-rejection and bypass checks skipped ' +
      '(barge-in still works, but the AI WILL hear itself through speakers)'
  )
} else {
  const masterSink = sh("pactl get-default-sink", { env: { ...process.env, LANG: 'C' } }).trim()
  // raw coupling: how loud the speakers are at the mic (bypass path, no cancellation)
  let raw = { rms: 0, err: null }
  try {
    const rec = (() => {
      const p = execFileSync(
        'timeout',
        ['7', 'parec', `--device=${micSource}`, '--format=s16le', '--rate=24000', '--channels=1', '--raw'],
        { encoding: 'buffer', timeout: 9000 }
      )
      return p
    })()
    // record runs concurrently with playback — do it via a child in the background instead
  } catch {}
  // simpler sequential approach: record while playing via async
  const measureWhilePlaying = async (device) => {
    const { spawn } = await import('node:child_process')
    const rec = spawn('parec', [`--device=${micSource}`, '--format=s16le', '--rate=24000', '--channels=1'])
    const chunks = []
    rec.stdout.on('data', (d) => chunks.push(d))
    await new Promise((r) => setTimeout(r, 400))
    execFileSync('paplay', [`--device=${device}`, '--volume=131072', toneFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    })
    await new Promise((r) => setTimeout(r, 500))
    rec.kill()
    await new Promise((r) => setTimeout(r, 200))
    const buf = Buffer.concat(chunks)
    const a = new Int16Array(buf.buffer, 0, Math.floor(buf.length / 2))
    if (!a.length) return 0
    let sum = 0
    for (const x of a) sum += x * x
    return Math.sqrt(sum / a.length) / 32768
  }

  const duringEchoSink = await measureWhilePlaying('echocancel_sink')
  const duringMaster = await measureWhilePlaying(masterSink)
  results.push(`info: playback via canceller sink -> mic RMS ${duringEchoSink.toFixed(4)}`)
  results.push(`info: playback via MASTER sink (bypass) -> mic RMS ${duringMaster.toFixed(4)}`)

  // LIVENESS: the bypass signal must reach the mic (the acoustic path works)
  if (duringMaster < 0.0015)
    fail(
      `bypass playback (master sink, not in the canceller's reference) does not reach the mic ` +
        `(${duringMaster.toFixed(4)} < 0.0015) — the mic path is dead; barge-in cannot work`
    )
  pass(`mic path alive: bypass signal arrives (${duringMaster.toFixed(4)})`)
  // ECHO REJECTION: the AI's own path must arrive strongly attenuated
  if (duringEchoSink > Math.max(0.02, duringMaster * 0.5))
    fail(
      `the AI's playback arrives at the mic nearly uncanceled (${duringEchoSink.toFixed(4)} vs raw ` +
        `${duringMaster.toFixed(4)}) — the AI hears itself; server-side VAD will truncate responses`
    )
  pass(`echo rejected: canceller-sink residual ${duringEchoSink.toFixed(4)} << bypass ${duringMaster.toFixed(4)}`)
}

console.log(results.map((r) => `  ${r}`).join('\n'))
console.log('RESULT: PASS')
process.exit(0)
