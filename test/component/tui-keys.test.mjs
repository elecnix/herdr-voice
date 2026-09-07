/**
 * Component test: the input line and the single-letter shortcuts coexist.
 *
 * Barge-in has a keyboard shortcut, and a shortcut that fires while someone is
 * typing eats the character. 'b' is the one that matters here: taken
 * unconditionally, the word "barge" cannot be written into the text input at
 * all, and the letter simply vanishes from anything else typed.
 */
import { VoiceTUI } from '../../src/tui.js'

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const tui = () => {
  const t = new VoiceTUI({ sessionName: 'test' })
  t.render = () => {} // no terminal
  const events = []
  for (const e of ['barge', 'stop-audio', 'submit', 'toggle-mute', 'quit']) t.on(e, (a) => events.push([e, a]))
  return { t, events }
}

{
  const { t, events } = tui()
  for (const ch of 'abc') t._key(ch)
  check('every letter typed reaches the input line', t.input === 'abc', JSON.stringify(t.input))
  check('typing does not fire the barge shortcut', !events.some(([e]) => e === 'barge'), JSON.stringify(events))
}
{
  const { t, events } = tui()
  t._key('b')
  check('b on an empty line is the barge shortcut', events.some(([e]) => e === 'barge'))
  check('and is not inserted as text', t.input === '', JSON.stringify(t.input))
}
{
  // A whole line delivered at once, as send_text does it.
  const { t, events } = tui()
  t._key('rebuild the branch\r')
  check('a line delivered in one chunk is submitted intact', events.some(([e, a]) => e === 'submit' && a === 'rebuild the branch'), JSON.stringify(events))
}
{
  const { t, events } = tui()
  t._key('\x1b')
  check('a lone escape stops the audio', events.some(([e]) => e === 'stop-audio'))
  const b = tui()
  b.t._key('\x1b[A') // up arrow
  check('an arrow key is ignored, not typed', b.t.input === '' && b.events.length === 0, JSON.stringify(b.t.input))
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'}`)
process.exit(failed ? 1 : 0)
