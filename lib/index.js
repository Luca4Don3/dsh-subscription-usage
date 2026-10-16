/**
 * dsh-subscription-usage — read-only subscription quota monitoring for the
 * scoped providers approved in the P0-Q gate (OpenAI Codex, OpenCode Go).
 *
 * Design boundaries:
 * - Never registers or patches an LLM provider; quota reads are passive.
 * - Credentials come only from the host public services (ctx.credentials) and
 *   are sent only to each provider's official origin.
 * - Token refresh delegates to the host Pi-AI; no OAuth protocol is written here.
 * - Every in-flight quota request is cancelled when this plugin's fiber is
 *   disposed (disable, unload, HMR reload), satisfying the gate's cancellation
 *   requirement.
 * - Accounts without a verified non-empty identifier get no cache key
 *   (identity-unverified), so caches can never collide across accounts.
 *
 * @module dsh-subscription-usage
 */
import z from '@deepseek-ai/schemastery'
import { createQuotaEngine } from './engine.js'
import { createCodexAdapter } from './providers/codex.js'
import { createOpenCodeGoAdapter } from './providers/opencode-go.js'
import { startLogin, submitCode, cancelLogin, loginWatch } from './login.js'

export const name = 'subscription-usage'
export const inject = ['credentials']

export const Config = z.object({
  /** Freshness window for a cached snapshot, in milliseconds. */
  freshMs: z.number().min(1000).default(300000),
  /** Per-request timeout, in milliseconds. */
  timeoutMs: z.number().min(1000).default(15000),
  /** Credential reference name for the OpenCode Go API key. */
  goApiKeyRef: z.string().default('OPENCODE_GO_API_KEY'),
})

/**
 * Optional Pi-AI refresh for the native Codex OAuth credential. Loads lazily
 * so the plugin still starts when pi-ai is absent; without it an expired
 * credential is reported as auth-required instead of refreshed.
 * @param {any} credentials - host credentials service.
 * @returns {(opts: {signal?: AbortSignal}) => Promise<any>} refresh function or undefined.
 */
async function makeCodexRefresh(credentials) {
  try {
    const pi = await import('@earendil-works/pi-ai')
    const { openaiCodexProvider } = await import('@earendil-works/pi-ai/providers/openai-codex')
    return async () => {
      const models = pi.createModels({
        credentials: {
          async read() {
            const r = await credentials.readRecord('llm-pi-ai/openai-codex')
            return r?.payload
          },
          async list() { return [{ providerId: 'openai-codex', type: 'oauth' }] },
          async modify(id, mutate) {
            const r = await credentials.modifyRecord('llm-pi-ai/openai-codex', async (cur) => {
              const next = await mutate(cur?.payload)
              return next === undefined ? undefined : { kind: 'grant', payload: next }
            })
            return r?.payload
          },
          async delete() { throw new Error('delete not supported during quota refresh') },
        },
        authContext: { env: async () => undefined, fileExists: async () => false },
      })
      models.setProvider(openaiCodexProvider())
      await models.getAuth('openai-codex', { signal, minOAuthValidityMs: 1 })
      const after = await credentials.readRecord('llm-pi-ai/openai-codex')
      return after?.payload
    }
  } catch {
    return undefined
  }
}

export async function apply(ctx, config) {
  const abort = new AbortController()
  // Cancel every in-flight quota request and login on disable/unload/HMR.
  ctx.effect(() => () => { abort.abort(); cancelLogin('plugin disposed') }, 'subscription-usage.cancel-in-flight')
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    ctx.logger.warn('subscription-usage: no credentials service; quota queries will report auth-required')
  }
  const refresh = await makeCodexRefresh(credentials)
  const adapters = {
    'openai-codex': createCodexAdapter({ credentials, refresh, timeoutMs: config.timeoutMs }),
    'opencode-go': createOpenCodeGoAdapter({ credentials, refName: config.goApiKeyRef, timeoutMs: config.timeoutMs }),
  }
  const engine = createQuotaEngine({ adapters, freshMs: config.freshMs, abort })
  ctx.provide('subscriptionUsage', {
    providers: Object.keys(adapters),
    query: (providerId, opts) => engine.query(providerId, { ...opts, signal: opts?.signal ?? abort.signal }),
    invalidate: (providerId) => engine.invalidate(providerId),
  })

  // Plugin-owned sign-in entry: the official client starts no pi-ai provider
  // flow, so /gpt-login is the login surface for the native Codex route.
  const commands = ctx.get('commands')
  if (commands === undefined) {
    ctx.logger.debug('subscription-usage: no command surface; /gpt-login unavailable here')
  } else {
    let disposeCommand
    disposeCommand = commands.register({
      name: 'gpt-login',
      description: 'Sign in with ChatGPT for the native OpenAI Codex route',
      input: { hint: '[status|code <value>|cancel]' },
      handler: async ({ rawInput }) => commandHandler(ctx, String(rawInput ?? '')),
    })
    ctx.effect(() => () => { if (typeof disposeCommand === 'function') disposeCommand() }, 'subscription-usage.gpt-login-command')
  }
}

/**
 * /gpt-login grammar: start (empty), status, code <value>, cancel.
 * @param {any} ctx - plugin context.
 * @param {string} raw - the rawInput after the command name.
 * @returns {Promise<{kind: 'success'|'error', text: string}>} command result.
 */
async function commandHandler(ctx, raw) {
  const arg = raw.trim()
  if (arg === '') {
    const running = loginWatch()
    if (running && running.status === 'waiting') {
      return { kind: 'success', text: running.openUrl ? ('Sign-in already started. Open: ' + running.openUrl) : 'Sign-in starting…' }
    }
    const w = await startLogin(ctx)
    if (w.status === 'error') return { kind: 'error', text: 'ChatGPT sign-in failed: ' + (w.detail || 'unknown error') }
    if (w.openUrl) return { kind: 'success', text: 'Open to sign in: ' + w.openUrl + ' — the local callback finishes automatically. If the browser cannot reach the local callback, run /gpt-login status and submit the final redirect URL with: /gpt-login code <value>' }
    if (w.prompt) return { kind: 'success', text: w.prompt.message + ' — waiting for the authorization URL; re-run /gpt-login status shortly' }
    return { kind: 'error', text: 'ChatGPT sign-in produced no authorization URL' }
  }
  if (arg === 'status' || arg === 'stat') {
    const record = ctx.get('credentials') ? await ctx.get('credentials').describeRecord('llm-pi-ai/openai-codex') : undefined
    const w = loginWatch()
    const loggedIn = record && record.configured === true
    if (w && w.status === 'waiting') {
      return { kind: 'success', text: (w.openUrl ? ('waiting for callback — open: ' + w.openUrl) : 'waiting for the authorization URL') + (w.prompt ? (' / prompt: ' + w.prompt.message + ' (/gpt-login code <value>)') : '') }
    }
    const base = loggedIn ? 'signed in (credential stored at llm-pi-ai/openai-codex)' : 'not signed in'
    if (w && w.status === 'ok') return { kind: 'success', text: base + ' — last sign-in completed' }
    if (w && w.status === 'error') return { kind: 'success', text: base + ' — last sign-in failed: ' + (w.detail || 'unknown') }
    return { kind: 'success', text: base }
  }
  if (arg.startsWith('code ')) {
    const value = arg.slice(5)
    return submitCode(value)
      ? { kind: 'success', text: 'value accepted; sign-in continues in the background — check /gpt-login status' }
      : { kind: 'error', text: 'no sign-in is waiting for a value' }
  }
  if (arg === 'cancel') {
    cancelLogin('cancelled by user')
    return { kind: 'success', text: 'sign-in cancelled' }
  }
  return { kind: 'error', text: 'usage: /gpt-login [status|code <value>|cancel]' }
}
