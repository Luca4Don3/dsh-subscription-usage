/**
 * ChatGPT (openai-codex) sign-in as a plugin-owned entry point.
 *
 * The official client offers no sign-in surface for pi-ai provider flows
 * (only the DeepSeek account login calls authorization.begin), so this module
 * provides it: it drives the HOST authorization seam for
 * `llm-pi-ai/openai-codex` and never implements OAuth itself.
 *
 * Command execution only renders when the handler returns, so start() returns
 * as soon as pi-ai notifies the authorization URL while the flow continues in
 * the background; a manual-code prompt waits for submitCode().
 * @module dsh-subscription-usage/login
 */

const KEY = 'llm-pi-ai/openai-codex'

/** Active login sessions by credential key. @type {Map<string, {controller: AbortController, watch: any}>} */
const sessions = new Map()
/** Pending manual-code prompts by credential key. @type {Map<string, {resolve: (v: string) => void, reject: (e: Error) => void}>} */
const pendingPrompts = new Map()

/** Snapshot of the current login attempt; safe to render, no secrets. */
export function loginWatch() {
  for (const s of sessions.values()) {
    return { status: s.watch.status, openUrl: s.watch.openUrl, prompt: s.watch.prompt, detail: s.watch.detail }
  }
  return undefined
}

/** Cancel every in-flight login (explicit cancel or plugin disposal). */
export function cancelLogin(reason = 'login cancelled') {
  for (const s of sessions.values()) s.controller.abort(new Error(reason))
  for (const p of pendingPrompts.values()) p.reject(new Error(reason))
  pendingPrompts.clear()
}

/**
 * Answer pi-ai manual_code with a pasted final redirect URL or code.
 * @param value - the pasted value.
 * @returns whether a waiting prompt consumed it.
 */
export function submitCode(value) {
  const pending = pendingPrompts.get(KEY)
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (pending === undefined || trimmed === '') return false
  pendingPrompts.delete(KEY)
  const s = sessions.get(KEY)
  if (s && s.watch) delete s.watch.prompt
  pending.resolve(trimmed)
  return true
}

/** AbortSignal.any replacement: Node 18.0-18.16 lacks it while engines allows >=18. */
function anySignal(signals) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const sig of signals) {
    if (sig.aborted) { abort(); return controller.signal }
    sig.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

/**
 * Start (or report) the native sign-in. Resolves once the authorization URL
 * is available so the slash command can return it immediately.
 * @param {any} ctx - plugin context carrying the host authorization service.
 * @returns {Promise<{status: string, openUrl?: string, prompt?: any, detail?: string}>} watch snapshot.
 */
export async function startLogin(ctx) {
  const running = loginWatch()
  if (running) return running
  const authorization = ctx.get('authorization')
  const flow = authorization && authorization.describe(KEY)
  if (!flow || !flow.methods.some(m => m.id === 'oauth')) {
    return { status: 'error', detail: 'native openai-codex OAuth flow unavailable (is providers.openai-codex configured?)' }
  }
  const controller = new AbortController()
  const watch = { status: 'waiting', openUrl: undefined, prompt: undefined, detail: undefined }
  let resolveFirstUrl
  const firstUrl = new Promise(r => { resolveFirstUrl = r })
  sessions.set(KEY, { controller, watch })
  void (async () => {
    try {
      const outcome = await authorization.begin({
        key: KEY,
        method: 'oauth',
        signal: controller.signal,
        interaction: {
          notify(n) {
            if (n.url) {
              watch.openUrl = n.url
              resolveFirstUrl()
            }
          },
          async prompt(pr) {
            if (pr.kind === 'select' && Array.isArray(pr.options) && pr.options.some(o => o.id === 'browser')) return 'browser'
            if (pr.kind === 'text' || pr.kind === 'manual_code') {
              watch.prompt = { type: pr.kind, message: typeof pr.message === 'string' ? pr.message : 'waiting for code', placeholder: pr.placeholder }
              return await new Promise((resolve, reject) => {
                pendingPrompts.set(KEY, { resolve, reject })
                const sig = anySignal([controller.signal].concat(pr.signal ? [pr.signal] : []))
                const done = () => { pendingPrompts.delete(KEY); reject(new DOMException('login cancelled', 'AbortError')) }
                if (sig.aborted) done(); else sig.addEventListener('abort', done, { once: true })
              })
            }
            throw new Error('unsupported login prompt: ' + pr.kind)
          },
        },
      })
      watch.status = outcome && outcome.status === 'authorized' ? 'ok' : 'error'
      if (watch.status === 'error') watch.detail = 'authorization ended with ' + String(outcome && outcome.status)
    } catch (error) {
      watch.status = 'error'
      watch.detail = String(error && error.message ? error.message : error).slice(0, 200)
    } finally {
      sessions.delete(KEY)
      pendingPrompts.delete(KEY)
      resolveFirstUrl()
    }
  })().catch(() => {})
  await firstUrl
  return loginWatch() || { status: 'error', detail: 'login ended before a URL was produced' }
}
