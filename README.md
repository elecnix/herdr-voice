# herdr-voice

Voice control for [herdr](https://herdr.dev) using the OpenAI Realtime API.

Speak (or type) natural language; it drives herdr's socket API to create spaces, split
panes, apply layouts, and start/prompt coding agents — with a TUI showing the live
transcript, every tool call, and the resulting workspace state.

```
┌─ herdr voice ───────────────────── ● ready · gpt-realtime-2.1 · voicelab ─┐
│ TRANSCRIPT                              │ TOOL CALLS                      │
│ you create a space called voice demo    │ ✓ create_space                  │
│     and split it to the right           │   {"label":"voice demo"}        │
│ ai  Created the "voice demo" space and  │   created=voice demo number=3   │
│     split the current pane to the right.│ ✓ split_pane                    │
│                                         │   direction=right pane=w8:p2    │
├─────────────────────────────────────────┴─────────────────────────────────┤
│ SPACES  1 aneyman · 2 voice-ui · 3 voice demo*                            │
│ AGENTS  reviewer working · codex-2 idle                                   │
├───────────────────────────────────────────────────────────────────────────┤
│ mic live █████▁▁▁▁▁ ◉ hearing you   [tab] mute [enter] send [ctrl-c] quit │
│ › _                                                                       │
└───────────────────────────────────────────────────────────────────────────┘
```

## Invoke

**`alt+p` then `m` — from inside herdr (including remote).** The binding runs
`bin/herdr-voice-summon` on the studio, which SSHes to the MacBook and opens the
floating HUD there. The HUD's tunnel dials back to the studio's herdr socket — so one
keystroke inside remote herdr gets you voice with a **real microphone on the machine
you're sitting at**. If the MacBook is unreachable, a herdr notification says so.

**Directly on the MacBook: `herdr-voice-mac`** (also Raycast-able). Same HUD.

### The HUD

A small (58×12) Ghostty window, top-right, floating above everything (title `voice`
misses the AeroSpace "herdr" tiling rule and hits the float catch-all; position is
computed per-launch into `~/.cache/herdr-voice/position.conf` since Ghostty can't
anchor top-right itself). Focus doesn't matter for voice — the app owns the mic
regardless of which window is focused.

```
 ◉ listening  ▁▃▆▅▂▆▂▄▁▁  remote
 » create a space called scratch and start…   ← live dictation
 you what agents are running?
 ✓ get_state
 ai  Reviewer is working; codex-2 is idle.
 ● mic · ● voice · ● text · ○ copy            ← clickable
 › type here…
```

Toggles — click them, or keys (keys work when the input line is empty):

| Control | Key | Meaning |
| --- | --- | --- |
| `● mic` | `tab` | capture your audio on/off |
| `● voice` | `s` | play the agent's spoken replies on/off |
| `● text` | `t` | show/hide transcript + tool calls |
| `○ copy` | `c` / `C` | copy last exchange / whole session to clipboard |

Copying: `c`/`C` use `pbcopy` (works because the HUD runs locally). Mouse reporting is
on for the buttons, so plain drag-select is captured — hold **shift** to drag-select
natively, or just use `c`/`C`.

### Transcripts

Every session is persisted as JSONL to `~/.local/state/herdr-voice/transcripts/`
(`latest.jsonl` symlinks the current one) on whichever machine the app runs on:
user/assistant/tool/system entries with timestamps — reference them to tune prompts
and tool descriptions.

### Fallbacks

Full-screen TUI (spaces/agents panel): `node src/index.js --full`. Text-only on the
studio itself: `node src/index.js --no-mic`. Apply herdr config changes with
`herdr server reload-config`; undo key customization with `herdr config reset-keys`.

## Run manually

```bash
node src/index.js                      # current herdr session, mic on
node src/index.js --session voicelab   # a specific (e.g. sandbox) session
node src/index.js --no-mic             # text input only
node src/index.js --text               # text-only model output (no spoken replies)
```

`OPENAI_API_KEY` is read from the environment, else `./.env`, else
`~/repos/personal/homebase/.env.local`.

## Voice verbs

Fifteen curated tools rather than herdr's raw 89 API methods — realtime models pick far
more reliably from a small, well-named set.

| Tool | Says |
| --- | --- |
| `get_state` | "what's running?" |
| `create_space` | "new space called billing fix" / "…in the iris repo with claude" |
| `focus_space` / `rename_space` | "switch to payments", "rename this to auth" |
| `close_space` | "close payments" — **two-step, requires spoken confirmation** |
| `new_tab`, `split_pane`, `focus_pane`, `zoom_pane` | "split right", "zoom this" |
| `apply_layout` | "give me the agent and logs layout" |
| `start_agent` | "start a claude agent called reviewer in iris" |
| `prompt_agent` / `read_agent` | "tell reviewer to run the tests", "what is it doing?" |
| `run_command` | "run npm test here" |
| `notify` | "ping me when that's done" |

Spoken names are fuzzy-resolved to workspaces/agents, and project names resolve against
`~/repos` (so "the iris repo" becomes a real `cwd`).

## Safety

Reversible actions run immediately. Anything that kills running work (`close_space`)
requires a spoken confirmation first: the model asks, and the tool itself refuses
without `confirm=true`, so a misheard phrase cannot destroy a workspace.

## Testing against a sandbox

Never test against your live session. `scripts/sandbox.py` boots an isolated herdr
session with its own socket:

```bash
python3 scripts/sandbox.py voicelab      # separate session + socket
node test/e2e.mjs                        # 9 assertions against real herdr state
TCOLS=140 node test/tui-render.mjs       # TUI frame snapshot
```

The sandbox needs a properly-sized pty — herdr fails pane spawns with `ghostty error -2`
when the controlling terminal reports `rows=0/cols=0` (which `script -q /dev/null` does).

## Protocol notes (herdr 0.7.5, protocols 17–18)

- The socket API does not version requests. `ping` advertises the server protocol;
  protocol 18 retains the protocol 17 request shapes used here.
- Requests are **one-per-connection**: the server closes the socket right after
  responding. `events.subscribe` is the exception and streams until you disconnect.
- Read payloads nest under `read` (`res.read.text`), and `source: 'recent'` returns only
  output since the last read — use `visible` to see what's on screen now.
- Nested herdr is blocked unless `HERDR_ENV` is cleared.

## Realtime API notes

Verified live against `gpt-realtime-2.1`:

- `output_modalities` must be exactly `['audio']` **or** `['text']` — both is rejected.
  Audio mode still yields text for the TUI via `response.output_audio_transcript.*`.
- Function calls arrive **twice** (`response.function_call_arguments.done` and inside
  `response.done.output`) — dedupe by `call_id`.
- Sending `response.create` while a response is active errors with "conversation already
  has an active response in progress" — all response requests go through a gate.

## Testing

Component tests run the real core against a scripted Realtime stub server, a
file-backed fake microphone, and a byte-captured fake speaker — no audio
hardware, no API key:

```bash
npm run test:component
```

The barge-in component test asserts the full loop: speech crossing the
threshold cancels the running response within ~300ms, stale audio from the
cancelled response stays suppressed, and the answer plays once the user stops.
Two more component tests cover reconnection (exactly one reconnect after an
unexpected drop) and session rotation (one clean replacement per rotation —
no cascade). The same hooks (fake mic / captured speakers) enable a
cost-capped end-to-end run against the real API
(`.github/workflows/e2e-voice.yml`, manual dispatch).

On a machine with real audio, `npm run test:live` additionally verifies the
actual audio chain: the configured mic source exists (no silent libpulse
fallback when the echo-cancel module dies), a bypass signal played to the
master sink reaches the mic (acoustic path alive), and playback through the
canceller's sink arrives strongly attenuated (the AI does not hear itself).

## Microphone

The app filters **virtual audio devices** (Microsoft Teams Audio, BlackHole, loopback,
aggregate) and picks a real mic by preference (built-in MacBook mic, USB, AirPods,
Studio Display). If only virtual devices exist — the studio's situation — it reports
that honestly instead of silently capturing a dead input.

macOS gates mic access per-application: the first unmute (`tab`) in the floating window
triggers the system mic prompt for Ghostty — click Allow once. If no devices enumerate
at all, grant access in System Settings → Privacy & Security → Microphone and relaunch.

Check what's visible with:

```bash
ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep -A5 "audio devices"
```

## Linux support

Linux works through PulseAudio/PipeWire and needs the same two binaries the
macOS path already uses:

```bash
# Debian/Ubuntu: ffmpeg (mic capture + fallback playback) and pipewire-audio
sudo apt install ffmpeg pipewire-audio
```

- **Microphone**: capture sources are enumerated with `pactl list sources`
  (monitors/loopbacks are filtered like macOS virtual devices), and capture
  runs through `ffmpeg -f pulse`. The special device name `default` follows
  the desktop's own input selection.
- **Playback**: `pacat` streams the assistant's PCM straight into the sound
  server with a small fixed buffer (~120 ms), which keeps barge-in latency low
  and playback in order. `--latency-msec` can be tuned if your setup needs it.
- **Echo cancellation (speakers instead of headphones) is OPTIONAL.** The
  plugin by default uses the RAW microphone and does not require a system
  canceller: the agent's playback is gated to silence server-side (half
  duplex), and the barge-in threshold adapts above any measured playback
  leakage. If you want true full-duplex with speakers, you can add PipeWire's
  canceller — but VERIFY it before relying on it (`npm run test:live`):
  webrtc's processing on some distros crushes quiet audio even with
  `noise_suppression=0` (aec_args silently ignored), which kills the mic
  path while module listings still look healthy. Always set BOTH
  `source_master`/`sink_master` to the devices your voice and speakers
  actually use — a mismatch falls back to the default source silently.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HERDR_VOICE_MODEL` | `gpt-realtime-2.1` | Realtime model; `gpt-realtime-2.1-mini` is ~3x cheaper audio with weaker tool orchestration |
| `HERDR_VOICE_FULL_DUPLEX` | unset | Set to `1` to disable the echo gate (headphones: the mic stays open while the agent speaks, for true full-duplex barge-in) |
| `HERDR_VOICE_BARGE_LEVEL` | `0.008` | Mic RMS level (on the echo-cancelled stream) that counts as barge-in speech; ambient sits ~0.002-0.005, a speaking voice ~0.011+. `0` disables client-side barge-in. |
| `HERDR_VOICE_MIC_SOURCE` | device | Test/CI hook: read the mic from any ffmpeg input (e.g. a WAV file, paced at realtime with `-re`) instead of a capture device |
| `HERDR_VOICE_SPEAKER_CAPTURE` | unset | Test/CI hook: tee every played audio byte to this file so playback timing can be analyzed |
| `HERDR_VOICE_PLAYER_CMD` | `pacat` | Test/CI hook: stand-in player command when no sound server exists (e.g. `cat`) |
| `HERDR_VOICE_WS_URL` | OpenAI | Test/CI hook: Realtime WebSocket endpoint (scripted stub server in component tests) |
| `HERDR_VOICE_ROTATE_MS` | `3300000` | Session rotation interval (55 min; OpenAI caps sessions at 60) |
| `HERDR_VOICE_BARGE_MS` | `300` | How long the mic must stay above the barge-in level before the agent pauses for you |
| `HERDR_VOICE_SOCKET` / `--socket` | auto | Drive a specific herdr session socket |
| `HERDR_VOICE_CTL` | `~/.cache/herdr-voice/ctl.sock` | Control socket for the split engine/HUD topology |
| `HERDR_VOICE_HANDS_HOST` | — | SSH host of the mic machine for the remote topology |

## Sessions, rotation, and barge-in behavior

- OpenAI ends Realtime sessions server-side after **60 minutes**. The session
  is proactively rotated at 55 minutes and unexpected closes auto-reconnect
  after 2 seconds, so long-running voice sessions survive; conversation
  context resets at each rotation (herdr state is re-read live by the tools).
- While the agent is speaking, the microphone is **echo-gated** to silence
  (half-duplex) unless `HERDR_VOICE_FULL_DUPLEX=1` — speaker leakage otherwise
  looks like an interruption to server-side VAD and truncates the reply.
  Because the gate deafens the server, barge-in is detected **client-side**:
  the raw mic level (which bypasses the gate) is watched against a fixed
  threshold calibrated for the echo-cancelled stream, and sustained speech
  opens the gate, cancels the response, and flushes playback so the server
  hears you live. Tune with `HERDR_VOICE_BARGE_LEVEL` /
  `HERDR_VOICE_BARGE_MS`, press `b` for an unconditional manual barge-in,
  or press `esc` to stop the audio dead.
- When the agent is *not* playing audio, barge-in is **evidence-gated**: a
  running response is interrupted only when live dictation from a *new*
  conversation item has transcribed real words (≥3 characters). The
  transcription of the sentence being answered arrives late and never counts;
  stray noise cannot cancel a response.
- Turn-taking uses `semantic_vad` with `eagerness: 'medium'`: the server
  commits your turn promptly when you finish speaking, so answers start
  without a long dead wait.
