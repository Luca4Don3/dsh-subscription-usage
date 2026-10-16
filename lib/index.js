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
  // Cancel every in-flight quota request on disable/unload/HMR disposal.
  ctx.effect(() => () => abort.abort(), 'subscription-usage.cancel-in-flight')
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
}
