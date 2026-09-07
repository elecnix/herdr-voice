import fs from 'node:fs'

/**
 * Optional debug tap. Disabled unless HERDR_VOICE_DEBUG_LOG is set ('1' for
 * the default /tmp path, or a file path). The previous firehose wrote a
 * synchronous fs.appendFileSync per event AND per audio chunk on the audio
 * loop, unconditionally — measurable blocking I/O in the hottest path.
 */
export function dbg(line) {
  const dest = process.env.HERDR_VOICE_DEBUG_LOG
  if (!dest) return
  try {
    fs.appendFileSync(dest === '1' ? '/tmp/herdr-voice-ws.log' : dest, line)
  } catch {
    /* logging must never break the audio loop */
  }
}

/**
 * Optional echo-guard capture: one JSON line per microphone frame and per
 * played audio chunk, enough to replay a whole session through EchoGuard
 * offline and change nothing but the detector. Enabled with
 * HERDR_VOICE_ECHO_TRACE=<file>. Barge-in failures are rare and depend on the
 * room, so reproducing one live costs minutes and never repeats exactly; a
 * recording of the real thing turns that into a test that runs in a second.
 */
export function echoTrace(entry) {
  const dest = process.env.HERDR_VOICE_ECHO_TRACE
  if (!dest) return
  try {
    fs.appendFileSync(dest, JSON.stringify(entry) + '\n')
  } catch {
    /* logging must never break the audio loop */
  }
}
