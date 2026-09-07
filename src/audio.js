import { spawn, execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { SAMPLE_RATE } from './config.js'

const DEVICE_LIST_TIMEOUT_MS = 2000

// How far ahead of realtime the player is fed: small enough that a change to
// what is queued reaches the speaker promptly, large enough to absorb
// scheduling jitter without leaving a gap.
const LEAD_MS = 150
const PUMP_MS = 25
const PUMP_CHUNK_MS = 50

/**
 * Parse the audio devices out of `ffmpeg -f avfoundation -list_devices true`.
 * Split out from the capture class so it can be tested against recorded output:
 * this runs only on macOS, and the shape of that output is the sort of thing
 * that changes under you with an ffmpeg upgrade.
 */
export function parseAvfoundationDevices(stderr) {
  const devices = []
  // The video devices are listed first, under their own heading, and are not
  // microphones however plausible their names look.
  const section = String(stderr).split('AVFoundation audio devices:')[1] ?? ''
  for (const line of section.split('\n')) {
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/)
    if (m) devices.push({ index: Number(m[1]), name: m[2] })
  }
  return devices
}

/**
 * Parse the audio sources out of `pactl list sources`.
 * Monitors (loopback sources) are filtered out because they capture the output
 * sink, not the microphone, giving silence (or wrong input).
 */
export function parsePactlSources(pactl) {
  const audio = []
  let cur = null
  for (const line of String(pactl).split('\n')) {
    const name = line.match(/^\s*Name:\s*(\S+)/)
    const desc = line.match(/^\s*Description:\s*(.+?)\s*$/)
    if (name) {
      cur = { index: name[1], name: name[1] }
    } else if (desc && cur) {
      cur.name = desc[1]
      if (!cur.index.endsWith('.monitor')) audio.push(cur)
      cur = null
    }
  }
  return audio
}

/** ffmpeg arguments for capturing a microphone as PCM16 mono. */
export function captureArgs({ device, sampleRate = SAMPLE_RATE, platform = process.platform, fromFile = false }) {
  const isDarwin = platform === 'darwin'
  return [
    '-hide_banner', '-loglevel', 'error',
    // A file is paced at realtime so chunk timing matches a live microphone;
    // a capture device needs the platform's input format instead.
    ...(fromFile ? ['-re'] : ['-f', isDarwin ? 'avfoundation' : 'pulse']),
    '-i', device,
    '-ar', String(sampleRate),
    '-ac', '1',
    '-f', 's16le',
    '-',
  ]
}

/**
 * Player arguments for raw PCM16 mono playback.
 *
 * macOS: ffplay with `-ch_layout mono` instead of `-ac` (ffplay rejects `-ac`
 * and exits 1 silently).
 * Linux: pacat streams directly into PipeWire with minimal buffering.
 */
export function playerArgs({ sampleRate = SAMPLE_RATE, platform = process.platform } = {}) {
  const isDarwin = platform === 'darwin'
  const cmd = process.env.HERDR_VOICE_PLAYER_CMD ?? (isDarwin ? 'ffplay' : 'pacat')
  if (cmd === 'ffplay') {
    return [
      '-hide_banner', '-loglevel', 'error',
      '-nodisp', '-autoexit',
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-f', 's16le', '-ar', String(sampleRate), '-ch_layout', 'mono',
      '-i', 'pipe:0',
    ]
  }
  if (cmd === 'pacat') {
    return [
      '--raw',
      '--format=s16le',
      `--rate=${sampleRate}`,
      '--channels=1',
      '--latency-msec=120',
      '--client-name=herdr-voice',
    ]
  }
  return []
}

/**
 * Mic capture via ffmpeg/avfoundation -> PCM16 mono @24k -> base64 chunks.
 *
 * macOS gates microphone access per-application (TCC). A terminal that has never
 * been granted mic access sees no input devices at all, so we surface that as a
 * clear, actionable error instead of silently sending empty audio.
 */
export class MicCapture extends EventEmitter {
  constructor({ device = ':0', chunkMs = 100 } = {}) {
    super()
    this.device = device
    this.chunkMs = chunkMs
    this.proc = null
    this.muted = true
    this.stderr = ''
    // Echo gate: while the agent is speaking, mic audio is replaced with
    // silence so the server's turn detection cannot hear the agent's own voice
    // coming back through the speakers and treat it as the user interrupting.
    this.gate = false
    // Rolling window of RAW (pre-gate) chunks. While the gate is closed the
    // user's first words exist only here, so on a barge the window is drained
    // to the server and transcription starts at the true beginning of the
    // sentence rather than mid-word.
    this.ring = []
  }

  setGate(on) {
    this.gate = on
  }

  /**
   * Return (and clear) the recent raw audio, from the speech onset onward:
   * walking backwards, the first run of about 600ms quieter than `onsetRms` is
   * the gap before the user started talking.
   */
  drainRecentAudio(onsetRms) {
    const ring = this.ring
    this.ring = []
    const QUIET_RUN = 6
    let start = 0
    for (let i = ring.length - 1; i >= QUIET_RUN; i--) {
      let quiet = true
      for (let j = i - QUIET_RUN + 1; j <= i; j++) {
        if (ring[j].rms >= onsetRms) {
          quiet = false
          break
        }
      }
      if (quiet) {
        start = i + 1
        break
      }
    }
    // Nothing quiet found at all: send at most the last second, a bounded guess
    // being better than dropping the words entirely.
    if (start === 0 && ring.length && ring[ring.length - 1].rms >= onsetRms) {
      start = Math.max(0, ring.length - 10)
    }
    return ring.slice(start).map((c) => c.b64)
  }

  static async listDevices() {
    return new Promise((resolve) => {
      // Bound by timeout: a wedged sound server never closes the pipe, and this
      // is awaited during startup. The hung process is killed so it doesn't hold
      // the event loop open.
      let child = null
      const bail = setTimeout(() => {
        child?.kill()
        resolve([])
      }, DEVICE_LIST_TIMEOUT_MS)
      const done = (list) => {
        clearTimeout(bail)
        resolve(list)
      }

      if (process.platform !== 'darwin') {
        // Linux: PulseAudio/PipeWire sources via pactl.
        const p = spawn('pactl', ['list', 'sources'], {
          env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
        })
        child = p
        let buf = ''
        p.stdout.on('data', (d) => (buf += d.toString()))
        p.on('close', () => done(parsePactlSources(buf)))
        p.on('error', () => done([]))
        return
      }

      // macOS: ffmpeg AVFoundation.
      const p = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''])
      child = p
      let buf = ''
      p.stderr.on('data', (d) => (buf += d.toString()))
      p.on('close', () => done(parseAvfoundationDevices(buf)))
      p.on('error', () => done([]))
    })
  }

  /**
   * Human-readable name for the source actually being captured. "default"
   * is resolved through the sound server on Linux so the UI says which device
   * that turned out to be rather than repeating the word back.
   */
  static describe(device, devices = []) {
    let name = device
    if (device === 'default' && process.platform !== 'darwin') {
      try {
        const out = execFileSync('pactl', ['info'], {
          encoding: 'utf8',
          timeout: DEVICE_LIST_TIMEOUT_MS,
          env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
        })
        name = out.match(/^Default Source:\s*(\S+)/m)?.[1] ?? device
      } catch {
        /* no pactl or timeout: the raw name is the best we have */
      }
    }
    const known = devices.find((d) => d.index === name)
    return known && known.name !== name ? `${known.name} (${name})` : name
  }

  /**
   * Pick a real microphone, never a virtual loopback. "Microsoft Teams Audio",
   * BlackHole, etc. enumerate as audio devices but capture silence (or the wrong
   * thing) — picking one is exactly the "mic connected but hears nothing" trap.
   * Returns null when only virtual devices exist so the UI can say so honestly.
   */
  static pickDevice(devices) {
    const VIRTUAL = /teams|virtual|blackhole|loopback|soundflower|aggregate|zoomaudio|multi-output/i
    const PREFERRED = /macbook.*microphone|built-in|external microphone|usb|airpods|studio display/i
    const real = devices.filter((d) => !VIRTUAL.test(d.name))
    if (real.length === 0) return null
    return real.find((d) => PREFERRED.test(d.name)) ?? real[0]
  }

  start() {
    const isDarwin = process.platform === 'darwin'
    // Test hook: read the microphone from any ffmpeg-probeable input (a WAV
    // file, paced at realtime with -re) instead of a capture device, so the
    // whole pipeline can be exercised with no hardware.
    const fromFile = process.env.HERDR_VOICE_MIC_SOURCE
    // On Linux, a legacy avfoundation-style index (":0") means "just use default".
    const input = !isDarwin && /^:\d+$/.test(this.device) ? 'default' : this.device
    const proc = spawn('ffmpeg', captureArgs({
      device: fromFile || input,
      platform: process.platform,
      fromFile: Boolean(fromFile),
    }))
    this.proc = proc

    // bytes per chunk: 2 bytes/sample * rate * ms/1000
    const chunkBytes = Math.floor((SAMPLE_RATE * 2 * this.chunkMs) / 1000)
    let pending = Buffer.alloc(0)

    proc.stdout.on('data', (data) => {
      pending = Buffer.concat([pending, data])
      while (pending.length >= chunkBytes) {
        const chunk = pending.subarray(0, chunkBytes)
        pending = pending.subarray(chunkBytes)
        const level = rms(chunk)
        this.ring.push({ b64: chunk.toString('base64'), rms: level })
        if (this.ring.length > 40) this.ring.shift() // ~4s
        if (this.muted || this.gate) {
          // Zero-filled chunks keep the stream and the server's turn state
          // alive without letting the agent's own voice reach it.
          this.emit('chunk', Buffer.alloc(chunkBytes).toString('base64'))
        } else {
          this.emit('chunk', chunk.toString('base64'))
        }
        // The level is always the RAW one: it is what barge-in is detected
        // from, and it has to bypass the gate to be of any use.
        this.emit('level', level)
      }
    })
    proc.stderr.on('data', (d) => {
      this.stderr += d.toString()
      const msg = this.stderr.toLowerCase()
      if (msg.includes('permission') || msg.includes('input/output error')) {
        this.emit('error', new Error('microphone unavailable (grant Terminal mic permission)'))
      }
    })
    proc.on('error', (e) => this.emit('error', e))
    proc.on('close', (code) => this.emit('closed', { code, stderr: this.stderr.slice(-400) }))
    return this
  }

  setMuted(m) {
    this.muted = m
    this.emit('muted', m)
  }

  stop() {
    this.proc?.kill('SIGTERM')
    this.proc = null
  }
}

/**
 * Playback of assistant PCM16 audio through a long-lived ffplay stdin pipe.
 * Any player death is surfaced via 'error' and recovered by respawning on the
 * next play. The argument list, and the trap in it, are in playerArgs above.
 */
export class AudioPlayer extends EventEmitter {
  constructor() {
    super()
    this.proc = null
    this.failed = false
    this.gain = 1
    // Audio not yet handed to the player, and the wall-clock time at which the
    // next sample handed over will be HEARD.
    this.pending = Buffer.alloc(0)
    this.playHead = 0
    this.timer = null
  }

  /**
   * Playback volume, applied to samples on their way out rather than to the
   * queue behind them — so it takes effect on audio that has not been handed
   * over yet, which is the point.
   */
  setGain(gain) {
    this.gain = gain
  }

  /** Apply the gain to PCM16. Returns the buffer itself at unity. */
  scale(pcm) {
    if (this.gain === 1) return pcm
    const out = Buffer.alloc(pcm.length)
    for (let i = 0; i < pcm.length / 2; i++) {
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i * 2) * this.gain))), i * 2)
    }
    return out
  }

  _spawn() {
    const isDarwin = process.platform === 'darwin'
    const cmd = process.env.HERDR_VOICE_PLAYER_CMD ?? (isDarwin ? 'ffplay' : 'pacat')
    const args = playerArgs({ platform: process.platform })
    const proc = spawn(cmd, args)
    let err = ''
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', (e) => {
      this.failed = true
      this.emit('error', new Error(`${cmd} unavailable: ${e.message}`))
    })
    proc.on('close', (code) => {
      if (this.proc === proc) this.proc = null
      if (code !== 0 && code !== null && !this.failed) {
        this.failed = true
        this.emit('error', new Error(`${cmd} exited ${code}: ${err.slice(0, 160)}`))
      }
    })
    proc.stdin.on('error', () => {})
    return proc
  }

  start() {
    this.proc = this._spawn()
    return this
  }

  /**
   * Queue audio for playback, handed to the player a little at a time rather
   * than all at once.
   *
   * The model streams an answer far faster than it can be spoken — a minute of
   * speech can arrive in a few seconds. Written straight through, all of it sits
   * in a pipe the app no longer controls: it cannot be quietened, it cannot be
   * dropped without killing the player, and there is no way to know which part
   * of it the room is hearing at any moment. Feeding the player just ahead of
   * realtime keeps all three.
   */
  play(base64) {
    if (this.failed) return
    const buf = Buffer.from(base64, 'base64')
    this.pending = this.pending.length ? Buffer.concat([this.pending, buf]) : buf
    this._pump()
    if (!this.timer) {
      this.timer = setInterval(() => this._pump(), PUMP_MS)
      this.timer.unref?.()
    }
  }

  /** Hand over whatever is due, at the gain in force at this moment. */
  _pump() {
    const now = Date.now()
    if (this.playHead < now) this.playHead = now // the queue ran dry; start now
    const bytesPerMs = (SAMPLE_RATE * 2) / 1000
    while (this.pending.length && this.playHead - now < LEAD_MS) {
      const n = Math.min(this.pending.length, Math.floor(bytesPerMs * PUMP_CHUNK_MS))
      const chunk = this.scale(this.pending.subarray(0, n))
      this.pending = this.pending.subarray(n)
      if (!this.proc?.stdin.writable) {
        if (this.failed) return
        this.proc = this._spawn() // respawn after a clean autoexit
      }
      this.proc.stdin.write(chunk)
      // Test hook: tee everything "spoken" to a file, so a test can analyse the
      // timing and the level of what actually reached the speaker.
      const capture = process.env.HERDR_VOICE_SPEAKER_CAPTURE
      if (capture) {
        try {
          fs.appendFileSync(capture, chunk)
        } catch {
          /* never let logging break playback */
        }
      }
      // Says exactly when this audio reaches the room, for anything that needs
      // to know what the microphone is about to hear.
      this.emit('played', { pcm: chunk, at: this.playHead })
      this.playHead += n / bytesPerMs
    }
    if (!this.pending.length && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Drop everything queued, played and unplayed. */
  flush() {
    clearInterval(this.timer)
    this.timer = null
    this.pending = Buffer.alloc(0)
    this.playHead = 0
    try {
      this.proc?.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    this.proc = null
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
    this.pending = Buffer.alloc(0)
    try {
      this.proc?.stdin.end()
      this.proc?.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    this.proc = null
  }
}

/**
 * True root-mean-square of a PCM16 mono chunk, 0..1.
 *
 * This used to return the level already multiplied up for the on-screen meter.
 * That is fine for drawing a bar and useless for deciding anything: barge-in
 * compares this against the level the agent's own voice arrives at, and a
 * quantity scaled for legibility makes every one of those thresholds wrong by
 * the scaling factor. The meter applies its own scaling where it draws.
 */
function rms(buf) {
  let sum = 0
  const n = Math.floor(buf.length / 2)
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2)
    sum += s * s
  }
  return Math.sqrt(sum / Math.max(1, n)) / 32768
}
