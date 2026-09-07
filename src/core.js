import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { RealtimeSession } from './realtime.js'
import { MicCapture, AudioPlayer } from './audio.js'
import { EchoGuard } from './echo.js'
import { createExecutor, readState } from './tools.js'
import { TranscriptStore, copyToClipboard } from './transcript.js'
import { dbg, echoTrace } from './debug.js'
import { SAMPLE_RATE } from './config.js'

// The microphone level is a true RMS, which is what barge-in reasons about. The
// on-screen meter wants something legible instead, so it is scaled here rather
// than by distorting the measurement everything else depends on.
const METER_SCALE = 4

// Nothing on the startup path may wait on the sound server indefinitely.
const PACTL_TIMEOUT_MS = 2000

// A voice session dying silently is the worst failure mode (the pane just
// vanishes with no trace). Surface anything that would otherwise be lost.
process.on('unhandledRejection', (e) => console.error('[voice] unhandled rejection:', e?.stack ?? e))
process.on('uncaughtException', (e) => console.error('[voice] uncaught exception:', e?.stack ?? e))

/**
 * Shared voice-core wiring used by both process shapes:
 *  - index.js  — UI and engine in one process (the standalone floating window)
 *  - engine.js — headless engine broadcasting to remote HUD clients
 *
 * `ui` is anything implementing the HUD surface (VoiceHUD, VoiceTUI, or the
 * engine's broadcaster): setStatus/setMic/setSound/setSpeaking/setPartial/
 * notify/addUser/updateAssistant/addSystem/addToolCall/updateToolCall/
 * setHerdrState. Returns handles the host wires to its input events.
 */
export async function startCore({ herdr, ui, apiKey, mode = 'voice', wantMic = true, micDevice }) {
  const transcript = new TranscriptStore()
  const player = new AudioPlayer().start()
  player.on('error', (e) => ui.addSystem(`audio out failed: ${e.message}`))
  let soundOn = true

  const refreshState = async () => {
    try {
      const state = await readState(herdr)
      ui.setHerdrState({
        spaces: (state.snapshot.workspaces ?? []).map((w) => ({
          name: w.label,
          number: w.number,
          current: w.workspace_id === state.snapshot.focused_workspace_id,
        })),
        agents: (state.agents ?? []).map((a) => ({ name: a.name, status: a.status })),
      })
    } catch {
      /* transient — the next refresh will catch up */
    }
  }
  await refreshState()
  herdr
    .subscribe([
      'workspace.created',
      'workspace.closed',
      'workspace.renamed',
      'workspace.focused',
      'workspace.updated',
      'tab.created',
      'tab.closed',
      'pane.created',
      'pane.closed',
      'pane.focused',
    ])
    .on('herdr-event', () => refreshState())
  const stateTimer = setInterval(refreshState, 4000)

  const execute = createExecutor(herdr, {
    onNotice: (m) => {
      ui.addSystem(m)
      transcript.system(m)
    },
  })
  const session = new RealtimeSession({ apiKey, mode })

  session.on('status', (s) => {
    ui.setStatus(s)
    if (s.state === 'error') {
      ui.addSystem(`error: ${s.message}`)
      transcript.system(`error: ${s.message}`)
    }
    if (s.state === 'ready') ui.addSystem('connected — say or type a command')
  })
  session.on('speech', ({ active }) => ui.setSpeaking(active))
  // Live dictation arrives BEFORE the response text (server transcribes its
  // own VAD commit asynchronously), so render the user's turn the moment
  // words are dictated — otherwise the assistant reply renders above the
  // question it answers.
  session.on('user_partial', ({ text }) => ui.setPartial(text))
  session.on('user_transcript', ({ text, done }) => {
    if (!text) return
    if (done) transcript.user(text)
  })
  session.on('assistant_delta', ({ text }) => ui.updateAssistant(text, false))
  session.on('assistant_done', ({ text }) => {
    ui.updateAssistant(text, true)
    if (text) transcript.assistant(text)
  })
  // Echo gate + client-side barge-in. While agent audio is streaming (plus a
  // short tail) the mic sends silence, so speaker leakage cannot trigger
  // server-side VAD. But that gate also deafens the server to real barge-in,
  // so we watch the RAW mic level here (it bypasses the gate): speech lifts
  // the gate, stops the response, and lets the server hear the user live.
  const fullDuplex = process.env.HERDR_VOICE_FULL_DUPLEX === '1'
  // Whether a mic level IS speech is decided by EchoGuard, which measures it
  // against the predicted echo of the audio we are playing right now
  // (src/echo.js). An absolute threshold cannot tell the user apart from the
  // agent's own voice, because the speaker volume decides what the agent's
  // voice measures at the mic — turn the speakers up and the leak alone clears
  // any fixed level. HERDR_VOICE_BARGE_LEVEL is now only the noise floor
  // beneath which nothing counts as speech; 0 disables client-side barge-in.
  const bargeLevel = Number.isFinite(Number(process.env.HERDR_VOICE_BARGE_LEVEL))
    ? Number(process.env.HERDR_VOICE_BARGE_LEVEL)
    : 0.01
  // Tuned for the DUCK, not for a cancellation. Being wrong here costs a
  // moment of quiet that reverses itself, so the bar sits far lower than a
  // detector that had to be sure — which is the whole point: the old one was
  // only safe at a threshold a normal voice could not clear over the agent's
  // loud syllables, so interrupting meant shouting until the evidence piled up.
  const bargeMs = Number(process.env.HERDR_VOICE_BARGE_MS ?? 300)
  const echoGuard = new EchoGuard({ floor: bargeLevel, bargeMs })
  let agentAudioTail = 0
  let bargeWindow = false // gate lifted: user is talking over the agent

  // BARGE-IN IS TWO STAGES, because the two mistakes cost wildly different
  // amounts. Interrupting the agent for a door slam is expensive and stopping
  // it late is infuriating, so a one-stage detector has to be certain, and
  // certainty here means a threshold a normal speaking voice does not clear
  // over the agent's loud syllables — measured at 0.037, about a shout, and it
  // had to be held for the length of the whole detection window. Hence: you had
  // to yell for several seconds.
  //
  // Stage one DUCKS instead. Being wrong costs a moment of quiet, so it can
  // fire on much less; and the duck immediately removes ~16dB of the agent's
  // own voice from the microphone, which is what lets the person interrupting
  // actually be heard. Perceptually the duck IS the interruption — the agent
  // goes quiet within a quarter second — while the decision to really cancel
  // waits for stage two.
  //
  // Stage two is the server transcribing actual words (realtime.js emits
  // 'interrupt' once live dictation from a NEW item reaches three characters).
  // Speech recognition is the best "was that a voice?" test available and it is
  // already running; a keyboard clatter transcribes to nothing, so the volume
  // simply comes back up.
  const DUCK_GAIN = 0.15
  // Held only while someone still seems to be talking, so being wrong is a dip
  // rather than a silence. The cap is a backstop against evidence that never
  // settles — NOT a limit on how long someone may talk: capped at two seconds
  // it let the agent surge back to full volume in the middle of an interruption
  // that was still going on.
  const DUCK_MIN_MS = 350
  const DUCK_MAX_MS = 15_000
  let duckUntil = 0
  let duckedAt = 0
  const duck = () => {
    if (!duckUntil) {
      player.setGain(DUCK_GAIN)
      ui.setSpeaking(false)
      ui.notify('listening…')
      // Hand the server the speech that arrived before the gate opened: while
      // gated it received silence, so without this the first words are lost and
      // there is nothing for stage two to recognise.
      if (mic && !mic.muted && !fullDuplex) {
        const onsetRms = Math.max(bargeLevel, echoGuard.echoLevel() * 1.2)
        for (const b64 of mic.drainRecentAudio(onsetRms)) session.sendAudio(b64)
      }
    }
    duckedAt ||= Date.now()
    duckUntil = Math.min(Date.now() + DUCK_MIN_MS, duckedAt + DUCK_MAX_MS)
    bargeWindow = true // holds the microphone gate open
    mic?.setGate(false)
  }
  const unduck = () => {
    if (!duckUntil) return
    duckUntil = 0
    duckedAt = 0
    bargeWindow = false
    player.setGain(1)
  }
  const gateTimer = setInterval(() => {
    if (duckUntil && Date.now() > duckUntil) unduck() // nobody spoke; carry on
    mic?.setGate(fullDuplex ? false : !bargeWindow && Date.now() < agentAudioTail)
  }, 100)
  gateTimer.unref?.()
  session.on('response_created', () => {
    suppressAudio = false
    unduck()
    bargeWindow = false
  })

  // After any barge-in, the cancelled response's remaining audio keeps
  // arriving over the socket (the server takes a moment to process the
  // cancel). Every delta would re-arm the player, so the old answer kept
  // talking over the user even though the transcript showed the new reply.
  // Suppression drops those stale deltas and lifts only when the NEXT
  // response is created — i.e. when the answer to the interruption starts.
  let suppressAudio = false
  // Playback was dropped on the floor: whatever was queued will never be heard,
  // so it must leave the guard's reference too — otherwise the guard keeps
  // predicting the echo of audio that no longer exists and stays deaf to the
  // user for its whole duration.
  const playbackDropped = () => echoGuard.dropScheduled()

  // The reference is taken from what the player ACTUALLY wrote, at the instant
  // it wrote it: that is the audio the room will hear, at the gain in force
  // then, timed by a play head that knows exactly how far ahead it has fed.
  // Computing a schedule here instead meant guessing at a pipe whose backlog
  // was invisible, and describing an unducked signal while the speaker played a
  // ducked one.
  player.on('played', ({ pcm, at }) => {
    echoGuard.pushReference(pcm, at)
    const secs = pcm.length / 2 / SAMPLE_RATE
    // MONOTONIC: a new response starting while the previous one is still
    // playing must never pull the gate open early.
    const ends = at + secs * 1000 + 500
    if (ends > agentAudioTail) agentAudioTail = ends
    dbg(
      `${new Date().toISOString()} PLAY +${secs.toFixed(2)}s ` +
        `tail=${Math.round(agentAudioTail - Date.now())}ms gain=${player.gain}\n`
    )
  })

  const bargeIn = () => {
    suppressAudio = true
    player.flush()
    // The gate is already open and the ring already drained if this came from a
    // duck; do it here too for the paths that skip stage one (the manual 'b'
    // key, and the server hearing the user in full-duplex).
    if (!duckUntil && mic && !mic.muted && !fullDuplex) {
      const onsetRms = Math.max(bargeLevel, echoGuard.echoLevel() * 1.2)
      for (const b64 of mic.drainRecentAudio(onsetRms)) session.sendAudio(b64)
    }
    duckUntil = 0
    duckedAt = 0
    player.setGain(1)
    session.cancelResponse()
    playbackDropped()
    agentAudioTail = Date.now() + 500
    ui.setSpeaking(false)
  }
  const stopAudio = () => {
    bargeIn()
    ui.notify('audio stopped')
  }
  session.on('audio', (b64) => {
    if (!soundOn) {
      agentAudioTail = 0 // muted speakers: no echo to protect against
      return
    }
    // Stale audio from a cancelled response is never played, so it never
    // becomes a reference either.
    if (suppressAudio) return
    player.play(b64)
  })
  session.on('response_done', () => {
    // The response finished normally: lift stale-audio suppression. The gate
    // tail stays until the buffered playback actually finishes.
    suppressAudio = false
  })
  // Only when there is actually something to stop: this fires on every
  // committed user turn, and the ordinary case (nobody talking over anything)
  // must not flush a player that is already idle.
  session.on('interrupt', () => {
    if (session.responseActive || duckUntil || Date.now() < agentAudioTail) bargeIn()
  })

  session.on('tool_call', async ({ name, callId, args }) => {
    ui.addToolCall({ callId, name, args })
    try {
      const result = await execute(name, args)
      ui.updateToolCall(callId, {
        result: summarizeResult(result),
        error: result?.ok === false && !result.confirmation_required ? result.error : undefined,
      })
      transcript.tool(name, args, result)
      session.sendToolResult(callId, result)
      refreshState()
    } catch (err) {
      ui.updateToolCall(callId, { error: err.message })
      transcript.tool(name, args, { ok: false, error: err.message })
      session.sendToolResult(callId, { ok: false, error: err.message })
    }
  })

  session.connect()

  // ---- mic ----
  let mic = null
  if (wantMic && mode === 'voice') {
    // Pre-flight: the configured PulseAudio source must exist. When the
    // echo-cancel module dies, libpulse SILENTLY falls back to the default
    // source — barge-in then dies with no error anywhere. Verify, self-heal
    // once, and if it still fails: refuse the mic loudly (text mode works).
    const configured = process.env.HERDR_VOICE_MIC_SOURCE ?? process.env.PULSE_SOURCE
    // HERDR_VOICE_MIC_SOURCE means test/file mode (audio.js reads it as an
    // ffmpeg input) — no PulseAudio source to verify, and the self-heal must
    // not load modules during component tests.
    if (configured && !process.env.HERDR_VOICE_MIC_SOURCE && !configured.startsWith('file:') && process.platform !== 'darwin') {
      const sourceExists = () => {
        try {
          // A wedged sound server answers nothing, forever. Every call to it on
          // the startup path is bounded, because an unbounded one is the
          // difference between "voice is unavailable" and a pane that hangs on
          // launch and hangs again on every restart, saying nothing.
          const out = execFileSync('pactl', ['list', 'short', 'sources'], {
            encoding: 'utf8',
            timeout: PACTL_TIMEOUT_MS,
            env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
          })
          return out.split('\n').some((l) => l.trim() && l.split('\t')[1] === configured)
        } catch {
          return true // can't verify (no pactl) — assume fine rather than block
        }
      }
      // No automatic module loading here. It used to load a canceller with no
      // source_master or sink_master and PulseAudio-style aec_args that
      // PipeWire's webrtc plugin ignores — which produces a canceller attached
      // to whatever it likes, and one attached to a device that later
      // disappears can take the whole sound server down with it (observed: every
      // pactl call timing out, every audio app stalled until pipewire was
      // restarted). Guessing at audio topology on someone's behalf is not worth
      // that; say exactly what to run instead.
      if (!sourceExists()) {
        ui.setMic({ available: false })
        ui.addSystem(
          `MIC SOURCE "${configured}" DOES NOT EXIST — the echo-cancel module is gone and ` +
            `libpulse would silently fall back to a device nobody calibrated (barge-in dead, ` +
            `AI hears itself). Restore it with BOTH masters naming the devices you ` +
            `actually use, and the aec_args quoted so the shell does not scatter them ` +
            `into arguments the module ignores:\n` +
            `  pactl load-module module-echo-cancel aec_method=webrtc \\\n` +
            `    source_name=echocancel_src sink_name=echocancel_sink \\\n` +
            `    source_master=<real mic> sink_master=<real sink> \\\n` +
            `    'aec_args="webrtc.gain_control=false webrtc.noise_suppression=false ` +
            `webrtc.extended_filter=true webrtc.delay_agnostic=true"'\n` +
            `Text input still works.`
        )
        ui.notify('mic source missing — see pane log')
      }
    }
    const devices = await MicCapture.listDevices()
    const picked = MicCapture.pickDevice(devices)
    if (!picked && !micDevice) {
      ui.setMic({ available: false })
      ui.addSystem(
        devices.length
          ? `only virtual audio devices found (${devices.map((d) => d.name).join(', ')}) — no real microphone. Text input works.`
          : 'no microphone available — grant mic permission (System Settings > Privacy & Security > Microphone). Text input still works.'
      )
    } else {
      // Linux: name the source EXPLICITLY when one is configured. Capturing
      // "default" leaves the choice to libpulse — and to module-stream-restore,
      // which remembers a per-application device and will happily pin ffmpeg to
      // a jack with nothing plugged into it, with no error anywhere. It also
      // matters for echo cancellation, where the source to capture is the
      // canceller's, not the microphone's.
      const device =
        micDevice ?? (process.platform === 'darwin' ? `:${picked.index}` : (process.env.PULSE_SOURCE ?? 'default'))
      mic = new MicCapture({ device }).start()
      ui.setMic({ available: true, muted: true })
      // Report what is actually being captured, not the prettiest name found
      // while enumerating: naming the wrong device is how an hour goes into
      // measuring a microphone that was never in the signal path.
      ui.addSystem(`mic: ${micDevice ?? MicCapture.describe(device, devices)} — unmute to talk`)
      mic.on('chunk', (b64) => session.sendAudio(b64))
      mic.on('level', (l) => {
        ui.setMic({ level: Math.min(1, l * METER_SCALE) })
        // Muted means the user silenced the mic on purpose — never barge in on
        // their behalf. Unarmed frames still feed the guard: the coupling
        // between speakers and mic is worth measuring whenever the agent is
        // audible, muted or not.
        const gated = Date.now() < agentAudioTail
        const armed =
          !fullDuplex && !mic.muted && bargeLevel !== 0 && (gated || session.responseActive)
        echoTrace({ mic: Date.now(), level: l, armed })
        const d = echoGuard.observe({ level: l, armed })
        if (d.speech || d.run) {
          dbg(
            `${new Date().toISOString()} BARGE lvl=${d.level.toFixed(4)} thr=${d.threshold.toFixed(4)} ` +
              `ref=${d.ref.toFixed(4)} echo=${d.predicted.toFixed(4)} gain=${d.gain.toFixed(2)} ` +
              `lag=${d.delayMs} run=${d.run}\n`
          )
        }
        // Stage one, and it keeps the duck alive as long as the guard still
        // hears something, so a real interruption is not cut off after 350ms.
        if (d.barge || (duckUntil && d.run > 0)) duck()
      })
      mic.on('error', (e) => {
        ui.setMic({ available: false })
        ui.addSystem(`mic error: ${e.message}`)
      })
    }
  } else {
    ui.setMic({ available: false })
  }

  return {
    session,
    transcript,
    bargeIn: () => bargeIn(),
    stopAudio,
    get micLive() {
      return Boolean(mic && !mic.muted)
    },
    muteMic() {
      if (!mic || mic.muted) return
      mic.setMuted(true)
      ui.setMic({ muted: true, level: 0 })
    },
    toggleMic() {
      if (!mic) return
      const next = !mic.muted
      mic.setMuted(next)
      ui.setMic({ muted: next, level: 0 })
    },
    toggleSound() {
      soundOn = !soundOn
      ui.setSound(soundOn)
      ui.notify(soundOn ? 'voice on' : 'voice off')
    },
    async copy(all = false) {
      const ok = await copyToClipboard(all ? transcript.asText() : transcript.lastExchangeText())
      ui.notify(ok ? (all ? 'copied full transcript' : 'copied last exchange') : 'copy failed')
    },
    submit(text) {
      transcript.user(text, { typed: true })
      // Typed input preempts a running response: stop the old answer and its
      // playback now, so the new answer starts speaking immediately.
      if (session.responseActive) {
        // Same cleanup a spoken barge does: the cancelled response keeps
        // sending audio for a moment, and without suppression it plays over
        // the answer the user just typed.
        suppressAudio = true
        player.flush()
        playbackDropped()
        session.cancelResponse()
      }
      session.sendText(text)
    },
    stop() {
      clearInterval(stateTimer)
      mic?.stop()
      player.stop()
      session.close()
    },
  }
}

/** Per-25ms RMS of played audio — everything the echo guard reads from it, and
 *  all a captured session needs in order to be replayed exactly. */
function referenceRms(pcm) {
  const step = (SAMPLE_RATE * 2 * 25) / 1000
  const out = []
  for (let off = 0; off + step <= pcm.length; off += step) {
    let sum = 0
    for (let i = 0; i < step / 2; i++) {
      const v = pcm.readInt16LE(off + i * 2)
      sum += v * v
    }
    out.push(Number((Math.sqrt(sum / (step / 2)) / 32768).toFixed(5)))
  }
  return out
}

export function summarizeResult(r) {
  if (!r || typeof r !== 'object') return String(r)
  if (r.confirmation_required) return 'needs confirmation'
  if (r.ok === false) return ''
  const keys = Object.keys(r).filter((k) => k !== 'ok' && r[k] !== undefined && r[k] !== null)
  if (!keys.length) return 'ok'
  return keys
    .slice(0, 4)
    .map((k) => {
      const v = r[k]
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
      return `${k}=${s.length > 60 ? s.slice(0, 60) + '…' : s}`
    })
    .join(' ')
}
