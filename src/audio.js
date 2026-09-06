import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { SAMPLE_RATE } from './config.js'

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
    // silence so server-side VAD cannot hear the agent's own voice leaking
    // through the speakers and truncate its response. Half-duplex by design;
    // press 'b' in the TUI to barge in manually.
    this.gate = false
  }

  setGate(on) {
    this.gate = on
  }

  static async listDevices() {
    return new Promise((resolve) => {
      if (process.platform !== 'darwin') {
        // Linux: PulseAudio/PipeWire capture sources via pactl. Monitors are
        // loopbacks of output sinks — virtual devices, filtered like BlackHole.
        const p = spawn('pactl', ['list', 'sources'], {
          env: { ...process.env, LANG: 'C', LC_ALL: 'C' }, // pactl output is localized
        })
        let buf = ''
        p.stdout.on('data', (d) => (buf += d.toString()))
        p.on('close', () => {
          const audio = []
          let cur = null
          for (const line of buf.split('\n')) {
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
          resolve(audio)
        })
        p.on('error', () => resolve([]))
        return
      }
      const p = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''])
      let buf = ''
      p.stderr.on('data', (d) => (buf += d.toString()))
      p.on('close', () => {
        const audio = []
        const section = buf.split('AVFoundation audio devices:')[1] ?? ''
        for (const line of section.split('\n')) {
          const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/)
          if (m) audio.push({ index: Number(m[1]), name: m[2] })
        }
        resolve(audio)
      })
      p.on('error', () => resolve([]))
    })
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
    // Test/CI hook: capture the mic from a file (any ffmpeg-probeable input)
    // instead of a device. -re paces the read at realtime so chunk timing
    // matches a live microphone exactly.
    const micSource = process.env.HERDR_VOICE_MIC_SOURCE
    const fromFile = Boolean(micSource)
    const inputArg = fromFile ? micSource : input
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...(fromFile ? ['-re'] : []),
      ...(fromFile ? [] : ['-f', isDarwin ? 'avfoundation' : 'pulse']),
      '-i', inputArg,
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-f', 's16le',
      '-',
    ]
    const proc = spawn('ffmpeg', args)
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
        if (this.muted || this.gate) {
          // Zero-filled chunks keep the stream (and VAD turn state) alive
          // without letting leakage/echo reach the server.
          this.emit('chunk', Buffer.alloc(chunkBytes).toString('base64'))
        } else {
          this.emit('chunk', chunk.toString('base64'))
        }
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
 * NOTE: ffplay rejects `-ac` (that silently killed audio out for days — every
 * play exited code 1 unseen). Channel count must be `-ch_layout mono`, and any
 * player death is surfaced via 'error' and recovered by respawning on next play.
 */
/**
 * Playback of assistant PCM16 audio through a long-lived pacat stream.
 * pacat writes straight into PipeWire with a small fixed server-side buffer,
 * so audio starts within ~100 ms, never reorders, and never sits in a
 * multi-second internal queue the way ffplay's demuxer did (which caused
 * missing beginnings, half words, and out-of-order playback).
 * PULSE_SINK routing (echo-cancel sink) is inherited from the environment.
 */
export class AudioPlayer extends EventEmitter {
  constructor() {
    super()
    this.proc = null
    this.failed = false
  }

  _spawn() {
    // Platform backends: ffplay on macOS (unchanged from upstream), pacat on
    // Linux (low-latency raw streaming into PipeWire/PulseAudio).
    // Test/CI hook: HERDR_VOICE_PLAYER_CMD forces a stand-in command when no
    // real player exists (e.g. `cat` just drains the stream).
    const isDarwin = process.platform === 'darwin'
    const cmd = process.env.HERDR_VOICE_PLAYER_CMD ?? (isDarwin ? 'ffplay' : 'pacat')
    const args =
      cmd === 'ffplay'
        ? [
            '-hide_banner', '-loglevel', 'error',
            '-nodisp', '-autoexit',
            '-fflags', 'nobuffer', '-flags', 'low_delay',
            '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ch_layout', 'mono',
            '-i', 'pipe:0',
          ]
        : cmd === 'pacat'
          ? [
              '--raw',
              '--format=s16le',
              `--rate=${SAMPLE_RATE}`,
              '--channels=1',
              '--latency-msec=120',
              '--client-name=herdr-voice',
            ]
          : []
    const proc = spawn(cmd, args)
    proc.stderr.on('data', () => {})
    proc.on('error', (e) => {
      this.failed = true
      this.emit('error', new Error(`${cmd} unavailable: ${e.message}`))
    })
    proc.on('close', () => {
      if (this.proc === proc) this.proc = null
    })
    proc.stdin.on('error', () => {})
    return proc
  }

  start() {
    this.proc = this._spawn()
    return this
  }

  play(base64) {
    if (this.failed) return
    const buf = Buffer.from(base64, 'base64')
    // Test/CI hook: tee everything "spoken" to a file so tests can analyze
    // exact playback timing byte by byte.
    const capture = process.env.HERDR_VOICE_SPEAKER_CAPTURE
    if (capture) {
      try {
        fs.appendFileSync(capture, buf)
      } catch {}
    }
    if (!this.proc?.stdin.writable) this.proc = this._spawn()
    this.proc.stdin.write(buf)
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

  /** Barge-in: drop everything queued. The server-side buffer holds at most
   *  ~120 ms, so stopping loses only a blip of audio — then the next play()
   *  call respawns a fresh stream. */
  flush() {
    try {
      if (this.proc) {
        this.proc.kill('SIGKILL')
        this.proc = null
      }
    } catch {
      /* already gone */
    }
  }
}

/** Root-mean-square level of a PCM16 mono chunk, normalized to 0..1. */
function rms(buffer) {
  let sum = 0
  const n = Math.floor(buffer.length / 2)
  for (let i = 0; i < n; i++) {
    const sample = buffer.readInt16LE(i * 2)
    sum += sample * sample
  }
  return Math.sqrt(sum / n) / 32768
}
