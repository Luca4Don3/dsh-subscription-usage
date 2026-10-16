import { QuotaError } from './errors.js'

/**
 * The quota engine: per-provider cache with in-flight coalescing, account-key
 * invalidation, stale fallback and plugin-lifetime cancellation.
 *
 * - One in-flight query per provider; concurrent callers join it only when
 *   they resolve to the same account key as the in-flight fetch, so a switch
 *   can never be answered with the previous account's snapshot.
 * - A cached snapshot is served only while fresh AND owned by the caller's
 *   resolved account key (account switch invalidates).
 * - On transient failure a previous snapshot is returned marked 'stale' with
 *   its original capturedAt rather than invented numbers.
 * - The plugin AbortSignal (fired on disable/unload/HMR dispose) owns the
 *   actual request cancellation; a caller signal only stops that caller from
 *   joining.
 *
 * @param {object} options - adapters registry, freshMs and plugin abort signal.
 * @returns {{query: Function, invalidate: Function, hasCache: Function}} engine API.
 */
export function createQuotaEngine({ adapters, freshMs = 300000, abort }) {
  const cache = new Map()    // providerId -> { accountKey, snapshot, fetchedAt }
  const inflight = new Map() // providerId -> { accountKey, promise }

  async function run(adapter, providerId) {
    const auth = await adapter.resolveAuth({ signal: abort?.signal })
    const payload = await adapter.fetchUsage(auth, { signal: abort?.signal })
    const snapshot = adapter.normalize(payload, { ...auth, capturedAt: Date.now() })
    cache.set(providerId, { accountKey: snapshot.accountKey, snapshot, fetchedAt: Date.now() })
    return snapshot
  }

  async function query(providerId, { signal } = {}) {
    if (signal?.aborted) throw new QuotaError('timeout', 'caller aborted before the query started')
    const adapter = adapters[providerId]
    if (adapter === undefined) throw new QuotaError('unsupported', `no quota adapter for provider ${providerId}`)
    // Resolve the account first so a cached snapshot from another account is
    // never returned for this one.
    const auth = await adapter.resolveAuth({ signal })
    const entry = cache.get(providerId)
    if (entry && entry.accountKey === auth.accountKey && Date.now() - entry.fetchedAt < freshMs) {
      return entry.snapshot
    }
    if (entry && entry.accountKey !== auth.accountKey) cache.delete(providerId) // account switch
    const existing = inflight.get(providerId)
    if (existing) {
      if (existing.accountKey === auth.accountKey) return existing.promise
      return run(adapter, providerId) // different account: never join across accounts
    }
    const task = (async () => {
      try {
        return await run(adapter, providerId)
      } catch (error) {
        const previous = cache.get(providerId)
        // Stale-with-timestamp beats invented numbers: keep the last truth.
        if (previous && error instanceof QuotaError && error.code !== 'auth-required') {
          return { ...previous.snapshot, status: 'stale', staleReason: error.code }
        }
        throw error
      } finally {
        const current = inflight.get(providerId)
        if (current && current.promise === task) inflight.delete(providerId)
      }
    })()
    inflight.set(providerId, { accountKey: auth.accountKey, promise: task })
    return task
  }

  return {
    query,
    invalidate(providerId) { if (providerId === undefined) cache.clear(); else cache.delete(providerId) },
    hasCache(providerId) { return cache.has(providerId) },
  }
}
