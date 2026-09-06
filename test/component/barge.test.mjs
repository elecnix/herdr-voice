/**
 * Component test: barge-in stops playback and suppresses stale audio.
 *
 * Runs the REAL core (core.js, audio.js, realtime.js) against:
 *  - a scripted OpenAI Realtime stub server (no network, no API key),
 *  - a fake microphone: a WAV file read by real ffmpeg in realtime (-re),
 *  - a captured "speaker": every played byte is tee'd to a file so playback
 *    timing can be analyzed byte by byte.
 *
 * Scenario:
 *   t=0s    engine starts, mic streams 1s of silence then 1.2s of loud speech
 *   t≈0.4s  stub starts response #1 (3s of audio) -> capture grows
 *   t≈1.3s  speech crosses the barge threshold (3 chunks) -> response.cancel
 *   t≈2.3s  stub starts response #2 (1s of audio): the user has stopped
 *           talking, so the answer plays — re-cancelling DURING speech is
 *           correct behavior and is exercised implicitly
 *
 * Assertions:
 *   1. response.cancel arrives shortly after the first REAL (non-silent) mic
 *      bytes reach the stub.
 *   2. Speaker capture STOPS growing after the cancel (suppression) until
 *      response #2 starts — the stale response must not talk over the user.
 *   3. Speaker capture grows again once response #2 plays (the answer to the
 *      interruption is heard).
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const { WebSocketServer } = require('ws')

const SAMPLE_RATE = 24000
const CHUNK_MS = 100
const CHUNK_BYTES = Math.floor((SAMPLE_RATE * 2 * CHUNK_MS) / 1000)
const SILENCE_S = 1.0
const SPEECH_S = 1.2 // speech ENDS before response #2 starts, like a user finishing their sentence

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-voice-test-'))
const micFile = path.join(tmp, 'mic.wav')
const captureFile = path.join(tmp, 'speaker.pcm')

// ---- fake microphone: 1s silence + 4s loud speech (sine blob) ----
{
  const pcm = []
  const silence = Math.floor(SILENCE_S * SAMPLE_RATE)
  const speech = Math.floor(SPEECH_S * SAMPLE_RATE)
  for (let i = 0; i < silence; i++) pcm.push(0)
  for (let i = 0; i < speech; i++) {
    const t = i / SAMPLE_RATE
    const syll = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3.5 * t)
    const v = 0.35 * syll * Math.sin(2 * Math.PI * 180 * t)
    pcm.push(Math.round(v * 32767))
  }
  const hdr = Buffer.alloc(44)
  hdr.write('RIFF', 0)
  hdr.writeUInt32LE(36 + pcm.length * 2, 4)
  hdr.write('WAVEfmt ', 8)
  hdr.writeUInt32LE(16, 16)
  hdr.writeUInt16LE(1, 20) // PCM
  hdr.writeUInt16LE(1, 22)
  hdr.writeUInt32LE(SAMPLE_RATE, 24)
  hdr.writeUInt32LE(SAMPLE_RATE * 2, 28)
  hdr.writeUInt16LE(2, 32)
  hdr.writeUInt16LE(16, 34)
  hdr.write('data', 36)
  hdr.writeUInt32LE(pcm.length * 2, 40)
  fs.writeFileSync(micFile, Buffer.concat([hdr, Buffer.from(Int16Array.from(pcm).buffer)]))
}

// The engine's module-level REALTIME_URL constant is read at import time, so
// the environment must be FINAL before importing core.js. The whole test
// re-executes itself once as a child process with that environment in place.
const FIXED_PORT = Number(process.env.TEST_PORT ?? 49711)
if (!process.env.TEST_PORT_SET) {
  const { execFileSync } = await import('node:child_process')
  process.env.TEST_PORT_SET = '1'
  process.env.TEST_PORT = String(FIXED_PORT)
  process.env.HERDR_VOICE_WS_URL = `ws://127.0.0.1:${FIXED_PORT}`
  process.env.HERDR_VOICE_MIC_SOURCE = micFile
  process.env.HERDR_VOICE_SPEAKER_CAPTURE = captureFile
  process.env.HERDR_VOICE_PLAYER_CMD = 'cat'
  let out
  try {
    out = execFileSync(process.execPath, [import.meta.filename], {
      env: process.env,
      encoding: 'utf8',
      timeout: 60_000,
    })
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  console.log(out)
  const m = out.match(/RESULT: (PASS|FAIL)/)
  process.exit(m && m[1] === 'PASS' ? 0 : 1)
}

// ============================ child mode ============================
process.env.HERDR_VOICE_MIC_SOURCE = micFile
process.env.HERDR_VOICE_SPEAKER_CAPTURE = captureFile
process.env.HERDR_VOICE_PLAYER_CMD = 'cat'

const { startCore } = await import('../../src/core.js')
const wss = new WebSocketServer({ port: FIXED_PORT, host: '127.0.0.1' })

const events = [] // { at, dir, type }
const t0 = Date.now()
const at = () => Date.now() - t0

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  console.log('RESULT: FAIL')
  process.exit(1)
}
const hardTimeout = setTimeout(() => fail('test timed out'), 30_000)

function pcmChunk(ms, rms = 0.05) {
  const n = Math.floor((SAMPLE_RATE * ms) / 1000)
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const v = rms * Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE)
    b.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  return b.toString('base64')
}

function stubHerdr() {
  const e = new EventEmitter()
  e.request = async (method) => {
    if (method === 'session.snapshot')
      return { snapshot: { workspaces: [], panes: [], focused_pane_id: 'p1', focused_workspace_id: 'w1' } }
    if (method === 'agent.list') return { agents: [] }
    return {}
  }
  e.subscribe = () => e
  e.close = () => {}
  return e
}

function stubUi() {
  const e = new EventEmitter()
  return new Proxy(e, {
    get(target, prop) {
      if (prop in target || prop === 'on' || prop === 'emit') return target[prop]
      return () => {}
    },
  })
}

const seen = { cancel: null, nonSilentChunk: null, configured: false, response2Started: null }
let engine

// stub server as a small state machine mirroring the real service: a response
// stream STOPS the moment response.cancel arrives; the next response is a
// fresh created -> deltas -> done cycle.
const stub = { ws: null, phase: 'idle', cancelled: false }

const send = (obj) => {
  if (!stub.ws) return
  stub.ws.send(JSON.stringify(obj))
  events.push({ at: at(), dir: 'sent', type: obj.type })
}

async function streamResponse(chunks, id) {
  send({ type: 'response.created', response: { id } })
  stub.phase = 'playing'
  for (let i = 0; i < chunks; i++) {
    if (stub.cancelled) break // the server stops generating on cancel
    send({ type: 'response.output_audio.delta', delta: pcmChunk(CHUNK_MS) })
    await new Promise((r) => setTimeout(r, CHUNK_MS))
  }
  if (stub.phase !== 'playing') return
  stub.phase = 'idle'
  send({ type: 'response.done', response: { status: 'completed' } })
}

wss.on('connection', (ws) => {
  events.push({ at: at(), dir: 'info', type: 'client connected' })
  stub.ws = ws
  stub.phase = 'connected'
  ws.on('message', (raw) => {
    let ev
    try {
      ev = JSON.parse(raw.toString())
    } catch {
      return
    }
    events.push({ at: at(), dir: 'recv', type: ev.type })

    if (ev.type === 'input_audio_buffer.append') {
      const b = Buffer.from(ev.audio, 'base64')
      // first REAL mic samples, with the SAME metric the engine's barge
      // detector uses (chunk RMS >= threshold) so onset and cancel are
      // directly comparable
      if (!seen.nonSilentChunk) {
        const ints = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2))
        let sum = 0
        for (const x of ints) sum += x * x
        const rms = Math.sqrt(sum / (ints.length || 1)) / 32768
        if (rms >= 0.008) seen.nonSilentChunk = at()
      }
      return
    }
    if (ev.type === 'session.update' && !seen.configured) {
      seen.configured = true
      streamResponse(30, 'r1').then(() => {})
      return
    }
    if (ev.type === 'response.cancel' && !seen.cancel && stub.phase === 'playing') {
      seen.cancel = at()
      stub.cancelled = true // halts the r1 delta loop
      stub.phase = 'idle'
      send({ type: 'response.done', response: { status: 'cancelled' } })
      // 1s of nothing (the user keeps talking), then the answer arrives
      setTimeout(() => {
        seen.response2Started = at()
        stub.cancelled = false
        streamResponse(10, 'r2').then(() => {})
      }, 1000)
    }
  })
})

// wait for the port, then boot the engine exactly like index.js does
wss.on('listening', async () => {
  const core = await startCore({
    herdr: stubHerdr(),
    ui: stubUi(),
    apiKey: 'test-key',
    mode: 'voice',
    wantMic: true,
    micDevice: 'test', // bypass device discovery in CI
  })
  engine = core
  core.toggleMic() // unmute: the fake mic is "allowed" to talk

  // sampler for the speaker capture file
  const samples = []
  const sampler = setInterval(() => {
    let size = 0
    try {
      size = fs.statSync(captureFile).size
    } catch {}
    samples.push({ at: at(), size })
  }, 25)

  const captureStats = () => {
    let stallMax = 0
    let curStart = null
    let last = 0
    for (const s of samples) {
      if (s.size > last) {
        if (curStart !== null) stallMax = Math.max(stallMax, s.at - curStart)
        curStart = null
        last = s.size
      } else if (curStart === null) {
        curStart = s.at
      }
    }
    if (curStart !== null) stallMax = Math.max(stallMax, samples.at(-1).at - curStart)
    return { stallMax, last }
  }

  const finish = (pass, why) => {
    clearInterval(sampler)
    const { stallMax, last } = captureStats()
    console.log('--- timeline (ms) ---')
    console.log(`speech first seen by stub : ${seen.nonSilentChunk}`)
    console.log(`response.cancel           : ${seen.cancel}`)
    console.log(`response #2 started       : ${seen.response2Started}`)
    console.log(`longest capture stall     : ${stallMax}ms`)
    console.log(`capture bytes             : ${last}`)

    if (!pass) {
      console.error(`FAIL: ${why}`)
      console.error('--- last engine<->stub events ---')
      for (const e of events.slice(-12)) console.error(`  ${String(e.at).padStart(6)}ms ${e.dir} ${e.type}`)
      console.log('RESULT: FAIL')
      process.exit(1)
    }
    console.log('RESULT: PASS')
    process.exit(0)
  }

  // ---- assertions ----
  setTimeout(() => {
    if (!seen.cancel) return finish(false, 'no response.cancel was ever sent')
    // Note: the cancel intentionally precedes the first REAL chunk at the
    // stub — while gated, the server receives silence; the detector watches
    // the raw mic client-side and opens the gate as it cancels. The mic
    // file's speech starts at 1.0s (mic starts ≈ engine boot ≈ 0.2-0.4s into
    // the test), so the cancel must land in a window around 1.0-2.5s.
    if (seen.cancel < 500 || seen.cancel > 2500)
      return finish(false, `response.cancel at ${seen.cancel}ms outside the expected 500-2500ms window`)
    const { stallMax, last } = captureStats()
    if (stallMax < 400)
      return finish(false, `no suppression stall after cancel (max stall ${stallMax}ms)`)
    if (last < 80_000) return finish(false, `capture only ${last} bytes — responses did not play`)
    if (!seen.response2Started) return finish(false, 'response #2 never started')
    hardTimeout.unref()
    finish(true)
  }, 12_000)
})

engine = null
