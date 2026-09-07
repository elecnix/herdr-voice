/**
 * Component test: unexpected disconnect must reconnect EXACTLY ONCE.
 *
 * Reproduces the "constantly reconnecting" report: the stub server accepts a
 * connection, completes the handshake, then drops the socket without warning
 * (network blip / server-side cap). The engine must open exactly one new
 * session. If the close-handling races itself (old socket's close event
 * scheduling a second reconnect), TWO connections arrive and this test fails.
 */
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)

/** Ask the OS for an unused port and hand it straight back. */
async function freePort() {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}
const { WebSocketServer } = require('ws')

// A free port, chosen now rather than hardcoded: these tests are run from
// several worktrees and several CI jobs at once, and a fixed port makes that a
// race that shows up as an unexplained failure in whichever lost.
const FIXED_PORT = Number(process.env.TEST_PORT ?? (await freePort()))
if (!process.env.TEST_PORT_SET) {
  const { execFileSync } = await import('node:child_process')
  process.env.TEST_PORT_SET = '1'
  process.env.TEST_PORT = String(FIXED_PORT)
  process.env.HERDR_VOICE_WS_URL = `ws://127.0.0.1:${FIXED_PORT}`
  let out
  try {
    out = execFileSync(process.execPath, [import.meta.filename], {
      env: process.env,
      encoding: 'utf8',
      timeout: 45_000,
    })
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  console.log(out)
  const m = out.match(/RESULT: (PASS|FAIL)/)
  process.exit(m && m[1] === 'PASS' ? 0 : 1)
}

// ============================ child mode ============================
const { startCore } = await import('../../src/core.js')

const connections = []
const wss = new WebSocketServer({ port: FIXED_PORT, host: '127.0.0.1' })
const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  console.log(`connections seen: ${connections.length}`)
  console.log('RESULT: FAIL')
  process.exit(1)
}

wss.on('connection', (ws) => {
  connections.push(Date.now())
  ws.send(JSON.stringify({ type: 'session.created' }))
  ws.on('message', (raw) => {
    try {
      const ev = JSON.parse(raw.toString())
      // the first session.update means the engine finished its handshake
      if (ev.type === 'session.update' && connections.length === 1) {
        // network blip: drop the socket WITHOUT a close handshake reason
        setTimeout(() => ws.close(), 300)
      }
    } catch {}
  })
  ws.on('error', () => {})
})

wss.on('listening', async () => {
  const core = await startCore({
    herdr: stubHerdr(),
    ui: stubUi(),
    apiKey: 'test-key',
    mode: 'voice',
    wantMic: false,
  })

  // Give the engine 6s to notice the drop and reconnect. A healthy engine
  // reconnects once; the reported bug reconnects continuously (and every
  // reconnect's old-socket close event schedules yet another one).
  setTimeout(() => {
    if (connections.length === 0) return fail('engine never connected')
    if (connections.length === 1) return fail('engine never reconnected after the drop')
    if (connections.length > 2)
      return fail(`reconnect storm: ${connections.length} connections (expected 2)`)
    console.log(`connections: ${connections.length} (initial + exactly one reconnect)`)
    console.log('RESULT: PASS')
    process.exit(0)
  }, 6000)
})

function stubHerdr() {
  const e = new EventEmitter()
  e.request = async (method) => {
    if (method === 'session.snapshot')
      return { snapshot: { workspaces: [], panes: [], focused_pane_id: 'p1', focused_workspace_id: 'w1' } }
    if (method === 'agent.list') return { agents: [] }
    return {}
  }
  e.subscribe = () => e
  e.close = () => {}
  return e
}

function stubUi() {
  const e = new EventEmitter()
  return new Proxy(e, {
    get(target, prop) {
      if (prop in target || prop === 'on' || prop === 'emit') return target[prop]
      return () => {}
    },
  })
}
