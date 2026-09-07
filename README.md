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

### Linux

Requires `ffmpeg` (mic capture and fallback playback) and `pipewire-audio` (playback server):

```bash
# Debian/Ubuntu
sudo apt install ffmpeg pipewire-audio
```

- **Microphone**: sources are enumerated with `pactl list sources`. Monitors
  (loopback sources capturing outputs) are filtered out. Capture runs through
  `ffmpeg -f pulse`. The device name `default` follows the desktop's own input
  selection; `PULSE_SOURCE` env var selects a specific source.
- **Playback**: `pacat` streams raw PCM directly into PipeWire with minimal
  buffering (~120 ms), keeping latency low and playback in order.

## Barge-in

Talking over the agent stops it. On speakers that is harder than it sounds,
because the microphone hears the agent too, and how loud it hears it is decided
by the volume knob — so no fixed level can tell the two apart.

Instead the audio being played is kept as a reference and the microphone is
judged against the *predicted echo* of it: the coupling between speakers and
microphone is measured continuously as a ratio, so turning the speakers up
raises both sides of the comparison and the decision does not move. Your voice
is found in the gaps between the agent's words, where that prediction drops to
the room's noise floor however loud the speakers are.

It happens in two stages, because the two mistakes cost very different amounts:

- **Ducking.** When the microphone might be hearing a voice, the agent drops
  16 dB and holds it while that continues. Being wrong costs a third of a second
  of quiet that reverses itself, so it can afford to be sensitive — a detector
  that had to be *sure* would need a threshold near the top of a normal speaking
  voice. The duck is also what you perceive as the interruption, and it takes
  most of the agent's own voice out of the microphone so the server can hear you.
- **Stopping.** The server decides, by segmenting a real turn out of what it
  heard. A door slam or a keyboard never becomes one, so the volume simply comes
  back up.

Stopping means stopping the *playback*. The model streams an answer far faster
than it can be spoken, so it is finished generating long before you hear the end
of it, and for most of that time cancelling the response would achieve nothing.

Press `b` to interrupt without speaking, or `esc` to stop the audio dead.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HERDR_VOICE_BARGE_LEVEL` | `0.01` | Noise floor: a microphone level below this is never speech. `0` disables client-side barge-in entirely. |
| `HERDR_VOICE_BARGE_MS` | `300` | How much evidence is needed before ducking. Raise it if the volume dips more often than you like. |
| `HERDR_VOICE_FULL_DUPLEX` | unset | `1` leaves the microphone open while the agent speaks — correct when the system already cancels echo, or on headphones. |
| `HERDR_VOICE_ECHO_TRACE` | unset | Record a session for offline replay (see `docs/voice-testing.md`). |
