/**
 * Component test: proactive session rotation must replace the session EXACTLY
 * ONCE per rotation, and must never cascade.
 *
 * Reproduces the "constantly reconnecting" report: the session rotation
 * closed the socket with intentionalClose=true, but reset that flag
 * SYNCHRONOUSLY — before the socket's async close event fired. The close
 * handler therefore scheduled a reconnect, reconnect() closed the LIVE
 * replacement socket, its close event scheduled another reconnect... every
 * ~2.3s, forever. With HERDR_VOICE_ROTATE_MS shortened, a healthy engine
 * opens one connection per rotation; the bug opens a storm.
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
  process.env.HERDR_VOICE_ROTATE_MS = '4000'
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
const closes = []
const wss = new WebSocketServer({ port: FIXED_PORT, host: '127.0.0.1' })
const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  console.log(`connections seen in 6s: ${connections.length}`)
  console.log('RESULT: FAIL')
  process.exit(1)
}

wss.on('connection', (ws) => {
  const t0 = Date.now()
  connections.push(t0)
  console.error(`  +conn @${t0 % 100000}`)
  ws.on('close', () => {
    closes.push(Date.now() - t0)
    console.error(`  -close @${Date.now() % 100000} (connection lived ${Date.now() - t0}ms)`)
  })
  ws.on('message', (raw) => {
    try {
      JSON.parse(raw.toString())
    } catch {}
  })
  ws.on('error', (e) => console.error(`  conn error: ${e.message}`))
})

wss.on('listening', async () => {
  await startCore({
    herdr: stubHerdr(),
    ui: stubUi(),
    apiKey: 'test-key',
    mode: 'voice',
    wantMic: false,
  })

  // 10s with a 4s rotation: a healthy engine opens ~3 connections and every
  // closed connection lived ~one rotation period. The cascade bug schedules a
  // reconnect 2s after each rotation's stray close event, which kills the
  // LIVE session early (~2s lifetime) and compounds: short-lived connections
  // piling up well beyond 3.
  setTimeout(() => {
    if (connections.length === 0) return fail('engine never connected')
    if (connections.length > 3)
      return fail(`rotation cascade: ${connections.length} connections in 10s (expected <= 3)`)
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] < 3500)
        return fail(`connection #${i} lived only ${closes[i]}ms — cascade signature (expected ~4000ms)`)
    }
    console.log(`connections: ${connections.length}, lifetimes: ${closes.map((c) => `${c}ms`).join(', ')} — clean rotation`)
    console.log('RESULT: PASS')
    process.exit(0)
  }, 10_000)
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
