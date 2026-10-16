/**
 * Loopback HTTP API behind the Settings login page, mounted only when the
 * host webServer exists (prefix /dsh-subscription-usage, never the /api RPC).
 * @module dsh-subscription-usage/login-http
 */
import { loginWatch, startLogin, submitCode, cancelLogin } from './login.js'

const PREFIX = '/dsh-subscription-usage'

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    const total = chunks.reduce((sum, p) => sum + p.length, 0)
    if (total > 64_000) throw new Error('request body too large')
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  const parsed = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('JSON body must be an object')
  return parsed
}

async function statusOf(ctx) {
  const record = ctx.get('credentials') ? await ctx.get('credentials').describeRecord('llm-pi-ai/openai-codex') : undefined
  const w = loginWatch()
  return {
    loggedIn: record && record.configured === true,
    login: w === undefined ? null : { status: w.status, openUrl: w.openUrl, prompt: w.prompt, detail: w.detail },
  }
}

/**
 * Handle one request under /dsh-subscription-usage.
 * @param {any} ctx - plugin context.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {{openBrowser?: boolean}} options - test seam; production passes true.
 * @returns {Promise<void>} resolves when the response is sent.
 */
export async function handleLoginHttp(ctx, req, res, options = {}) {
  const method = (req.method ?? 'GET').toUpperCase()
  const host = req.headers.host ?? '127.0.0.1'
  const url = new URL(req.url ?? '/', 'http://' + host)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  try {
    if (method === 'GET' && path === PREFIX + '/status') {
      sendJson(res, 200, await statusOf(ctx))
      return
    }
    if (method === 'POST' && path === PREFIX + '/login') {
      const w = await startLogin(ctx, { openBrowser: options.openBrowser !== false })
      sendJson(res, w.status === 'error' ? 500 : 200, { ...w, ...(await statusOf(ctx)) })
      return
    }
    if (method === 'POST' && path === PREFIX + '/code') {
      const body = await readJson(req)
      const value = typeof body.value === 'string' ? body.value : ''
      if (value.trim() === '') { sendJson(res, 400, { error: 'missing value' }); return }
      const accepted = submitCode(value)
      sendJson(res, accepted ? 200 : 409, { ok: accepted })
      return
    }
    if (method === 'POST' && path === PREFIX + '/cancel') {
      cancelLogin('cancelled from settings')
      sendJson(res, 200, await statusOf(ctx))
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    sendJson(res, 500, { error: String(error && error.message ? error.message : error).slice(0, 200) })
  }
}
