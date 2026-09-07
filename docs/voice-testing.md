# Testing voice, and how to debug barge-in

Barge-in was the hardest part of this work by a wide margin. Every bug in it was
a detail of the real world that no simulation had thought to include, and each
one cost hours to reproduce live and never reproduced identically. This is the
apparatus that eventually made it tractable, in the order you should reach for
it.

## The layers

| Layer | Command | Needs | Runs in |
| --- | --- | --- | --- |
| Simulated room | `npm run test:component` | nothing | ~40 s |
| Recorded sessions | (part of the above) | nothing | ~1 s |

Both rows run in CI: no audio hardware, no microphone permission, no API key.

## Capture and replay — start here

The single most useful tool. `HERDR_VOICE_ECHO_TRACE` records every microphone
frame and every chunk of played audio, with the timings the app saw:

```bash
HERDR_VOICE_ECHO_TRACE=/tmp/session.jsonl node src/index.js --full
# ...reproduce the misbehaviour, then:
node scripts/replay-echo-trace.mjs /tmp/session.jsonl --context
```

The replay drives the real detector, so the detector is the only variable. A
six-minute live reproduction that never repeated exactly becomes a one-second
one that repeats perfectly, and `--context` prints what the detector saw around
each decision — level, threshold, predicted echo, coupling, alignment.

Recordings worth keeping go in `test/fixtures/` and `echo-replay.test.mjs` picks
them up automatically. Two are committed, each pinning a bug that no simulation
had caught:

- `blind-schedule` — the play head is reset whenever playback is dropped, so the
  schedule jumped backwards (by 56 seconds), the reference timeline stopped
  being sorted, and the guard read silence while the speakers were at full
  volume.
- `cold-start` — the first alignment, fitted on the two seconds that are the
  minimum to fit at all, landed a syllable out and the guard armed on it.

**A trace contains no audio.** One loudness number per 100 ms of microphone and
per 25 ms of playback, and timestamps. Speech cannot be reconstructed from it,
which is what makes these safe to commit — keep it that way if you extend the
format.

## What the simulated room is for

`test/component/echo.test.mjs` builds a room from a speech-shaped reference, its
echo at a chosen coupling and delay, reverb, noise, an uneven coupling, a
drifting playback clock, and an independent second voice. It is good at
*parameter* questions — how sensitive can the detector be before it trips on
the agent's own voice — and it is where to add a scenario once a recording has
shown you a new failure mode.

It is bad at anything it was not told about, which was every real bug. Do not
trust it alone.

Two habits worth keeping, both of which caught mistakes here:

- Assert that the OLD behaviour fails the new test. A test that passes before
  and after the fix is measuring nothing, and several did until checked.
- Assert the detector is not merely deaf. "Never interrupts" is trivially
  satisfied by a threshold nothing can reach, so the replay test also asserts
  the level/threshold ratio stays in a sane band.

## Live checks

`scripts/replay-echo-trace.mjs` is the only tool here that needs nothing: point
it at a capture and it replays that session through the detector offline.

Anything that talks to the real API needs a key, holds the microphone and makes
noise for as long as it runs, so keep those runs short and never put them in CI.
