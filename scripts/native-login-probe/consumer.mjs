/**
 * Phase-1 acceptance probe: native Pi-AI ChatGPT (openai-codex) OAuth login
 * and one marker model call, WITHOUT dsh-llm-openai-codex anywhere.
 * Read-only for credentials: tokens are never printed or archived.
 */
import z from '@deepseek-ai/schemastery'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
export const name = 'dsh-native-login-probe'
export const inject = ['llm', 'credentials', 'authorization']
export const Config = z.object({ runDir: z.string().required(), modelId: z.string().required(), timeoutMs: z.number().min(1).required(), requestTimeoutMs: z.number().min(1).required() })
const KEY = recordKeyFor('openai-codex')
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
function emit(v){ process.stdout.write('NATIVE_PROBE ' + JSON.stringify(v) + '\n') }
function stop(code){ const e = new Error(code); e.code = code; throw e }
function hangUntilAbort(pr, signal){ const s = pr.signal ? AbortSignal.any([signal, pr.signal]) : signal
  return new Promise((_, reject) => {
    const done = () => { s.removeEventListener('abort', done); reject(new DOMException('cancelled', 'AbortError')) }
    if (s.aborted) done(); else s.addEventListener('abort', done, { once: true }) }) }
async function grantOf(ctx){ const r = await ctx.credentials.readRecord(KEY)
  if (r?.kind !== 'grant' || r.payload?.type !== 'oauth') stop('NO_OAUTH_GRANT')
  return r.payload }
export function apply(ctx, config){
  const args = ctx.get('cmdlineArgs')?.get() ?? []
  const action = args[0] ?? 'preflight'
  if (!['preflight','login-call','call'].includes(action)) stop('INVALID_ACTION')
  const ready = ctx.get('appReady'), exit = ctx.get('appExit')
  if (!ready || !exit) stop('REQUIRES_DSH_PROFILE')
  const controller = new AbortController()
  let task = Promise.resolve()
  ctx.effect(() => async () => { controller.abort(); await task })
  ctx.effect(() => ready.onReady(() => { task = run(ctx, config, action, controller, exit) }))
}
async function run(ctx, config, action, controller, exit){
  let code = 0, result
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutMs)])
    const providers = ctx.llm.listProviders().map(p => p.id)
    if (!providers.includes('openai-codex')) stop('NATIVE_ROUTE_MISSING')
    const flow = ctx.get('authorization')?.describe(KEY)
    if (!flow?.methods.some(m => m.id === 'oauth')) stop('NATIVE_OAUTH_FLOW_MISSING')
    const evidence = { providerRoute: 'native-llm-pi-ai', flowMethods: flow.methods.map(m => m.id) }
    if (action === 'preflight'){
      const configured = (await ctx.credentials.describeRecord(KEY)).configured
      result = { stage: 'P1-NATIVE', action, gates: { nativeLogin: 'TOPOLOGY_OK' }, evidence: { ...evidence, credentialConfigured: configured } }
      emit({ event: 'preflight', result })
    } else {
      if (action === 'login-call'){
        if ((await ctx.credentials.describeRecord(KEY)).configured) stop('ALREADY_CONFIGURED')
        emit({ event: 'login-starting' })
        const outcome = await ctx.authorization.begin({ key: KEY, method: 'oauth', signal, interaction: {
          notify(n){ if (n.url){ const u = new URL(n.url); if (u.origin !== 'https://auth.openai.com') stop('UNEXPECTED_AUTH_URL'); emit({ event: 'authorization-required', authorizationUrl: u.href }) } },
          async prompt(pr){
            if (pr.kind === 'select' && Array.isArray(pr.options) && pr.options.some(o => o.id === 'browser')) return 'browser'
            if (pr.kind === 'text' || pr.kind === 'manual_code') return await hangUntilAbort(pr, signal)
            stop('UNSUPPORTED_PROMPT') } } })
        if (outcome.status !== 'authorized') stop('AUTHORIZATION_NOT_COMPLETED')
        emit({ event: 'oauth-login-completed' })
      }
      const grant = await grantOf(ctx)
      const originalFetch = globalThis.fetch
      const observer = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        if (url.href === ENDPOINT){
          if (headers.get('authorization') !== 'Bearer ' + grant.access) stop('STOP_NON_OAUTH_AUTHENTICATION')
          if (headers.get('chatgpt-account-id') !== grant.accountId) stop('STOP_ACCOUNT_MISMATCH')
          const response = await originalFetch(input, init)
          emit({ event: 'model-http', status: response.status, authentication: 'stored-oauth-exact-match', sameAccount: true })
          return response
        }
        stop('STOP_UNEXPECTED_NETWORK_TARGET')
      }
      globalThis.fetch = observer
      try {
        const marker = 'NATIVE_OK_' + randomUUID().replaceAll('-', '')
        let text = '', finish, usage = false, chunks = 0
        const callSignal = AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)])
        for await (const c of ctx.llm.stream({ provider: 'openai-codex', model: config.modelId,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly this marker and nothing else: ' + marker }] }],
          maxTokens: 512, signal: callSignal })){
          chunks += 1
          if (c.type === 'text-delta') text += c.text
          if (c.type === 'usage') usage = true
          if (c.type === 'finish'){ finish = c.reason; if (finish.kind === 'error' && typeof finish.failure?.code === 'string') stop('MODEL_' + finish.failure.code) }
        }
        const observed = evidence.modelHttpStatus = globalThis.__lastStatus
        if (finish?.kind !== 'stop') stop('STREAM_NOT_COMPLETED')
        if (text.trim() !== marker) stop('MARKER_MISMATCH')
        result = { stage: 'P1-NATIVE', action, gates: { nativeLogin: 'PASS', nativeModelCall: 'PASS' },
          evidence: { ...evidence, model: config.modelId, markerMatched: true, responseCharacters: text.length,
            responseSha256: createHash('sha256').update(text).digest('hex'), usageReceived: usage, streamChunks: chunks },
          redaction: { tokenOmitted: true, markerBodyOmitted: true } }
        emit({ event: 'native-call-result', result })
      } finally {
        if (globalThis.fetch !== observer) stop('FETCH_OBSERVER_OWNERSHIP_LOST')
        globalThis.fetch = originalFetch
      }
    }
  } catch (error){
    code = 1
    result = { stage: 'P1-NATIVE', action, gates: { nativeLogin: 'BLOCKED' }, failure: { code: typeof error?.code === 'string' ? error.code : 'PROBE_FAILED' } }
    emit({ event: 'probe-failure', failure: result.failure })
  }
  try {
    const dir = join(resolve(config.runDir), 'evidence')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, action + '-' + Date.now() + '-' + randomUUID() + '.json')
    await writeFile(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    emit({ event: 'evidence-written', evidenceFile: file })
  } catch { code = 1; emit({ event: 'evidence-write-failed' }) }
  exit(code)
}
