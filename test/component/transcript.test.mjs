/**
 * Component test: live user transcript deltas accumulate per item id,
 * not globally. Multiple concurrent dictations (e.g., from barge-in)
 * must not mix together.
 */
import { RealtimeSession } from '../../src/realtime.js'

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const session = new RealtimeSession({ apiKey: 'test-key' })

const emissions = []
session.on('user_partial', (ev) => emissions.push({ type: 'user_partial', ...ev }))
session.on('user_transcript', (ev) => emissions.push({ type: 'user_transcript', ...ev }))

// Simulate two delta events for item id "item1"
session._handle({
  type: 'conversation.item.input_audio_transcription.delta',
  item_id: 'item1',
  delta: 'hello ',
})
session._handle({
  type: 'conversation.item.input_audio_transcription.delta',
  item_id: 'item1',
  delta: 'world',
})

// Simulate one delta for a different item id "item2"
session._handle({
  type: 'conversation.item.input_audio_transcription.delta',
  item_id: 'item2',
  delta: 'goodbye',
})

check(
  'first delta for item1 emits user_partial with "hello "',
  emissions[0]?.type === 'user_partial' && emissions[0]?.itemId === 'item1' && emissions[0]?.text === 'hello ',
  `got: ${JSON.stringify(emissions[0])}`
)

check(
  'second delta for item1 accumulates to "hello world"',
  emissions[1]?.type === 'user_partial' && emissions[1]?.itemId === 'item1' && emissions[1]?.text === 'hello world',
  `got: ${JSON.stringify(emissions[1])}`
)

check(
  'delta for item2 is just "goodbye", not mixed with item1',
  emissions[2]?.type === 'user_partial' && emissions[2]?.itemId === 'item2' && emissions[2]?.text === 'goodbye',
  `got: ${JSON.stringify(emissions[2])}`
)

// Complete the first item
session._handle({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: 'item1',
  transcript: 'hello world',
})

check(
  'completed event for item1 emits user_transcript with done:true and correct text',
  emissions[3]?.type === 'user_transcript' && emissions[3]?.itemId === 'item1' && emissions[3]?.text === 'hello world' && emissions[3]?.done === true,
  `got: ${JSON.stringify(emissions[3])}`
)

// Complete the second item
session._handle({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: 'item2',
  transcript: 'goodbye',
})

check(
  'completed event for item2 has its own text, not mixed with item1',
  emissions[4]?.type === 'user_transcript' && emissions[4]?.itemId === 'item2' && emissions[4]?.text === 'goodbye' && emissions[4]?.done === true,
  `got: ${JSON.stringify(emissions[4])}`
)

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'}`)
process.exit(failed ? 1 : 0)
