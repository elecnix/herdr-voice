import { spawn, execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { SAMPLE_RATE } from './config.js'

const DEVICE_LIST_TIMEOUT_MS = 2000

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
export function captureArgs({ device, sampleRate = SAMPLE_RATE, platform = process.platform }) {
  const isDarwin = platform === 'darwin'
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', isDarwin ? 'avfoundation' : 'pulse',
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
    // On Linux, a legacy avfoundation-style index (":0") means "just use default".
    const input = !isDarwin && /^:\d+$/.test(this.device) ? 'default' : this.device
    const proc = spawn('ffmpeg', captureArgs({ device: input, platform: process.platform }))
    this.proc = proc

    // bytes per chunk: 2 bytes/sample * rate * ms/1000
    const chunkBytes = Math.floor((SAMPLE_RATE * 2 * this.chunkMs) / 1000)
    let pending = Buffer.alloc(0)

    proc.stdout.on('data', (data) => {
      pending = Buffer.concat([pending, data])
      while (pending.length >= chunkBytes) {
        const chunk = pending.subarray(0, chunkBytes)
        pending = pending.subarray(chunkBytes)
        if (!this.muted) {
          this.emit('chunk', chunk.toString('base64'))
          this.emit('level', rms(chunk))
        }
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

  play(base64) {
    if (!this.proc?.stdin.writable) {
      if (this.failed) return
      this.proc = this._spawn() // respawn after a clean autoexit
    }
    this.proc.stdin.write(Buffer.from(base64, 'base64'))
  }

  stop() {
    try {
      this.proc?.stdin.end()
      this.proc?.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    this.proc = null
  }
}

function rms(buf) {
  let sum = 0
  const n = Math.floor(buf.length / 2)
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768
    sum += s * s
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, n)) * 4)
}
