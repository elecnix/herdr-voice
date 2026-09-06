import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { RealtimeSession } from './realtime.js'
import { MicCapture, AudioPlayer } from './audio.js'
import { createExecutor, readState } from './tools.js'
import { TranscriptStore, copyToClipboard } from './transcript.js'
import { dbg } from './debug.js'
import { SAMPLE_RATE } from './config.js'

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
  session.on('user_partial', ({ itemId, text }) => {
    ui.setPartial(text)
    ui.addOrUpdateUser?.(itemId, text, false)
  })
  session.on('user_transcript', ({ itemId, text, done }) => {
    if (!text) return
    ui.addOrUpdateUser?.(itemId, text, done)
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
  // so we watch the RAW mic level here (it bypasses the gate): sustained
  // speech lifts the gate, stops the response, and lets the server hear the
  // user live. The threshold adapts to the room's noise floor; set
  // HERDR_VOICE_BARGE_LEVEL to force an absolute level, or 0 to disable.
  const fullDuplex = process.env.HERDR_VOICE_FULL_DUPLEX === '1'
  // Barge-in speech level, calibrated for the echo-cancelled mic stream:
  // ambient sits around 0.002-0.005, a speaking voice around 0.011+. An
  // adaptive floor proved unreliable here (the AEC'd stream is near-digital
  // silence when quiet, so any adaptation collapsed the threshold). Override
  // with HERDR_VOICE_BARGE_LEVEL; 0 disables client-side barge-in.
  const bargeLevel = Number.isFinite(Number(process.env.HERDR_VOICE_BARGE_LEVEL))
    ? Number(process.env.HERDR_VOICE_BARGE_LEVEL)
    : 0.01
  const bargeMs = Number(process.env.HERDR_VOICE_BARGE_MS ?? 400)
  let agentAudioTail = 0
  let bargeWindow = false // gate lifted: user is talking over the agent
  let bargeRun = 0 // consecutive chunks above the speech threshold
  let echoPeak = 0 // recent peak of AI-voice leakage at the mic (envelope)
  const gateTimer = setInterval(
    () => mic?.setGate(fullDuplex ? false : !bargeWindow && Date.now() < agentAudioTail),
    200
  )
  gateTimer.unref?.()
  session.on('response_created', () => {
    suppressAudio = false
    bargeWindow = false
    bargeRun = 0
    // Re-base the playback schedule for the new response. The MONOTONIC
    // tail (agentAudioTail only extends) carries the previous response's
    // still-buffered audio: the old tail stays in force until the new
    // schedule overtakes it. (Rebasing is essential — without it the start
    // timestamp goes stale and the tail computes into the past, leaving the
    // gate permanently open: the AI hears itself.)
    playbackStart = 0
    queuedAudioSec = 0
  })

  // After any barge-in, the cancelled response's remaining audio keeps
  // arriving over the socket (the server takes a moment to process the
  // cancel). Every delta would re-arm the player, so the old answer kept
  // talking over the user even though the transcript showed the new reply.
  // Suppression drops those stale deltas and lifts only when the NEXT
  // response is created — i.e. when the answer to the interruption starts.
  let suppressAudio = false
  // Playback-position tracking: the model streams audio FASTER than realtime,
  // so a 6s answer can finish ARRIVING in ~1s while the speaker is still
  // playing it. The echo gate must follow the playback position (start time +
  // queued seconds), not the last byte's arrival — otherwise the mic reopens
  // mid-sentence and the server hears the AI talking to itself.
  let playbackStart = 0
  let queuedAudioSec = 0
  const bargeIn = () => {
    suppressAudio = true
    player.flush()
    session.cancelResponse()
    playbackStart = 0
    queuedAudioSec = 0
    agentAudioTail = Date.now() + 500
    ui.setSpeaking(false)
  }
  const stopAudio = () => {
    bargeIn()
    ui.notify('audio stopped')
  }
  session.on('audio', (b64) => {
    if (soundOn) {
      const secs = b64.length * 0.75 / 2 / SAMPLE_RATE // base64 -> bytes -> int16 samples -> seconds
      if (!playbackStart) playbackStart = Date.now()
      queuedAudioSec += secs
      // MONOTONIC: a new response starting while the previous one is still
      // playing must never pull the gate open early (tool calls chain
      // responses; the old audio is still in the speaker). The schedule may
      // only extend.
      const newTail = playbackStart + queuedAudioSec * 1000 + 500
      if (newTail > agentAudioTail) agentAudioTail = newTail
      dbg(`${new Date().toISOString()} PLAY +${secs.toFixed(2)}s tail=${Math.round(agentAudioTail - Date.now())}ms\n`)
    } else {
      playbackStart = 0
      queuedAudioSec = 0
      agentAudioTail = 0 // muted speakers: no echo to protect against
    }
    if (suppressAudio) return
    if (soundOn) player.play(b64)
  })
  session.on('response_done', () => {
    // The response finished normally: lift stale-audio suppression. The gate
    // tail stays until the buffered playback actually finishes.
    suppressAudio = false
  })
  session.on('interrupt', bargeIn)
  session.on('barge', bargeIn)

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
          const out = execFileSync('pactl', ['list', 'short', 'sources'], {
            encoding: 'utf8',
            env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
          })
          return out.split('\n').some((l) => l.trim() && l.split('\t')[1] === configured)
        } catch {
          return true // can't verify (no pactl) — assume fine rather than block
        }
      }
      if (!sourceExists()) {
        try {
          execFileSync(
            'pactl',
            [
              'load-module',
              'module-echo-cancel',
              'aec_method=webrtc',
              `source_name=${configured}`,
              'sink_name=echocancel_sink',
            ],
            { stdio: 'pipe' }
          )
        } catch {}
      }
      if (!sourceExists()) {
        ui.setMic({ available: false })
        ui.addSystem(
          `MIC SOURCE "${configured}" DOES NOT EXIST — the echo-cancel module is gone and ` +
            `libpulse would silently fall back to a device nobody calibrated (barge-in dead, ` +
            `AI hears itself). Restore it, e.g.: pactl load-module module-echo-cancel ` +
            `aec_method=webrtc source_name=echocancel_src sink_name=echocancel_sink ` +
            `source_master=<real mic> sink_master=<real sink>. Text input still works.`
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
      // Linux: capture the PulseAudio/PipeWire default source so the desktop's
      // own input selection is respected, instead of guessing among sources.
      const device = micDevice ?? (process.platform === 'darwin' ? `:${picked.index}` : 'default')
      mic = new MicCapture({ device }).start()
      ui.setMic({ available: true, muted: true })
      ui.addSystem(`mic: ${micDevice ?? picked.name} — unmute to talk`)
      mic.on('chunk', (b64) => session.sendAudio(b64))
      mic.on('level', (l) => {
        ui.setMic({ level: l })
        const gated = Date.now() < agentAudioTail
        // Muted means the user silenced the mic on purpose — never barge in
        // on their behalf.
        // State-dependent envelope dynamics. The envelope exists to ride
        // above CONTINUOUS noise (the AI's playback leak while gated, typing
        // between turns) — it must NOT chase the user's own barge speech,
        // which is also sustained: a fast attack pulls the threshold up
        // behind their voice and the barge never confirms (measured:
        // lvl 0.0172 vs thr 0.0161, run stuck at 3).
        if (gated) {
          // AI playing: the continuous signal is the playback leak (minutes).
          echoPeak = l > echoPeak ? echoPeak + (l - echoPeak) * 0.02 : echoPeak * 0.99
        } else {
          // Idle: the continuous signal is typing/room noise. Faster attack,
          // fast decay — when the user stops typing to speak, the envelope
          // falls back to ambient within ~0.5s.
          echoPeak = l > echoPeak ? echoPeak + (l - echoPeak) * 0.1 : echoPeak * 0.9
        }
        if (fullDuplex || mic?.muted || (!gated && !session.responseActive) || bargeLevel === 0) {
          bargeRun = 0
        } else {
          const thr = Math.max(bargeLevel, echoPeak * 1.6)
          bargeRun = l >= thr ? bargeRun + 1 : 0
          if (l >= thr || bargeRun > 0) {
            dbg(`${new Date().toISOString()} BARGE lvl=${l.toFixed(4)} thr=${thr.toFixed(4)} run=${bargeRun}\n`)
          }
          if (!bargeWindow && mic && bargeRun * mic.chunkMs >= bargeMs) {
            bargeWindow = true
            mic.setGate(false) // server starts hearing the user live
            bargeIn()
            ui.notify('listening — agent paused')
          }
        }
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
        player.flush()
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
