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
