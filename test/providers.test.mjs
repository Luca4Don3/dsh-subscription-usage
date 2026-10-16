import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCodexAdapter } from '../lib/providers/codex.js'
import { createOpenCodeGoAdapter } from '../lib/providers/opencode-go.js'

const grant = (expires = Date.now() + 3600000) => ({ kind: 'grant', payload: { type: 'oauth', access: 'tok', refresh: 'r', expires, accountId: 'acct-1' } })
const creds = record => ({ readRecord: async () => record, resolve: async () => undefined })

test('codex resolveAuth refuses without a grant', async () => {
  const a = createCodexAdapter({ credentials: creds(undefined) })
  await assert.rejects(a.resolveAuth(), e => e.code === 'auth-required')
})

test('codex expired credential invokes injected refresh (delegated to Pi-AI)', async () => {
  let refreshed = 0
  const a = createCodexAdapter({
    credentials: creds(grant(Date.now() - 1000)),
    refresh: async () => { refreshed += 1; return { access: 'new', expires: Date.now() + 3600000, accountId: 'acct-1' } },
  })
  const auth = await a.resolveAuth()
  assert.equal(refreshed, 1)
  assert.equal(auth.authorization, 'Bearer new')
})

test('codex expired without refresh is auth-required, never a stale token', async () => {
  const a = createCodexAdapter({ credentials: creds(grant(Date.now() - 1000)) })
  await assert.rejects(a.resolveAuth(), e => e.code === 'auth-required')
})

test('codex fetch sends credentials only to the official chatgpt origin', async () => {
  const seen = []
  const fetchImpl = async url => { seen.push(String(url)); return new Response(JSON.stringify({ rate_limit: { allowed: true } }), { status: 200 }) }
  const a = createCodexAdapter({ credentials: creds(grant()), fetchImpl, timeoutMs: 1000 })
  const auth = await a.resolveAuth()
  await a.fetchUsage(auth, {})
  assert.deepEqual(seen, [
    'https://chatgpt.com/backend-api/wham/usage',
    'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
  ])
})

test('go resolveAuth requires the configured key reference', async () => {
  const missing = createOpenCodeGoAdapter({ credentials: { resolve: async () => undefined } })
  await assert.rejects(missing.resolveAuth(), e => e.code === 'auth-required')
  const present = createOpenCodeGoAdapter({ credentials: { resolve: async () => ({ value: 'k' }) } })
  assert.equal((await present.resolveAuth()).authorization, 'Bearer k')
})
