/**
 * Settings -> ChatGPT login (standalone settings section).
 *
 * Declared via package.json dsh.client. The button drives the host login over
 * the plugin loopback HTTP API; the host opens the browser, so the desktop
 * machine default browser is used even from a remote Web session. Plain ESM +
 * host React (no build step): react is a client external the host module
 * system resolves, same as first-party client bundles.
 *
 * @module dsh-subscription-usage/client
 */
import { createElement as h, useState, useEffect } from 'react'

const BASE = '/dsh-subscription-usage'

async function request(path, init) {
  const response = await fetch(BASE + path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init && init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  })
  const text = await response.text()
  const body = text.length === 0 ? {} : JSON.parse(text)
  return { status: response.status, body }
}

const styles = {
  card: { border: '1px solid var(--ds-border, #d9d9e3)', borderRadius: 8, padding: '14px 16px', margin: '8px 0' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  dim: { color: 'var(--ds-text-dim, #6b6b7b)', fontSize: 12 },
  para: { margin: '8px 0 0', fontSize: 13, lineHeight: 1.6 },
  err: { color: '#c0392b', fontSize: 13 },
  btn: { padding: '6px 14px', borderRadius: 6, border: '1px solid transparent', cursor: 'pointer' },
  primary: { background: '#1f6feb', color: '#fff' },
  ghost: { background: 'transparent', color: '#c0392b', border: '1px solid #c0392b' },
  input: { padding: '6px 8px', borderRadius: 6, border: '1px solid var(--ds-border, #d9d9e3)', minWidth: 260, fontSize: 13 },
}

function GptLoginSection() {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const load = async () => {
    try {
      const res = await request('/status')
      setStatus(res.body)
    } catch (e) {
      setError(String((e && e.message) || e).slice(0, 160))
    }
  }
  useEffect(() => { void load() }, [])
  const waiting = !!(status && status.login && status.login.status === 'waiting')
  useEffect(() => {
    if (!waiting) return undefined
    const timer = setInterval(() => { void load() }, 2500)
    return () => clearInterval(timer)
  }, [waiting])
  const startSignIn = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await request('/login', { method: 'POST' })
      setStatus(res.body)
      if (res.status >= 500) setError(String((res.body && (res.body.detail || res.body.error)) || 'login failed'))
    } catch (e) {
      setError(String((e && e.message) || e).slice(0, 160))
    } finally {
      setBusy(false)
    }
  }
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await request('/code', { method: 'POST', body: JSON.stringify({ value: code }) })
      if (!res.body || res.body.ok !== true) setError('当前没有等待粘贴的登录 / nothing is waiting')
      setCode('')
      await load()
    } catch (e) {
      setError(String((e && e.message) || e).slice(0, 160))
    } finally {
      setBusy(false)
    }
  }
  const cancel = async () => {
    setBusy(true)
    try {
      const res = await request('/cancel', { method: 'POST' })
      setStatus(res.body)
    } finally {
      setBusy(false)
    }
  }
  const login = status && status.login
  const loggedIn = !!(status && status.loggedIn)
  const blocks = []
  blocks.push(h('p', { style: styles.para },
    loggedIn
      ? '已登录：凭据存储于 llm-pi-ai/openai-codex，在模型选择器选择 Codex 模型即可使用。'
      : '未登录：点击下方按钮，浏览器将自动打开 ChatGPT 授权页；授权完成后由本机回调自动结束。'))
  if (waiting) {
    blocks.push(h('p', { key: 'w', style: styles.para }, '等待授权中…'))
    if (login.openUrl) {
      blocks.push(h('a', { key: 'u', href: login.openUrl, target: '_blank', rel: 'noreferrer', style: { fontSize: 13 } },
        '打开授权页 / Open authorization page'))
    }
    if (login.prompt) {
      blocks.push(h('div', { key: 'p', style: { ...styles.row, marginTop: 8 } },
        h('span', { style: { ...styles.dim, maxWidth: 420 } }, login.prompt.message + '（回调不可达时粘贴最终跳转地址）'),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
          h('input', {
            style: styles.input, value: code, placeholder: 'http://localhost:1455/auth/callback?...',
            onChange: e => setCode(e.target.value),
          }),
          h('button', {
            style: { ...styles.btn, ...styles.primary },
            disabled: busy || code.trim() === '',
            onClick: () => void submit(),
          }, '提交 / Submit'))))
    }
    blocks.push(h('button', {
      key: 'c', style: { ...styles.btn, ...styles.ghost, marginTop: 8 },
      disabled: busy, onClick: () => void cancel(),
    }, '取消登录 / Cancel'))
  } else {
    if (login && login.status === 'error') {
      blocks.push(h('p', { key: 'e', style: { ...styles.para, ...styles.err } }, '上次登录失败：' + (login.detail || 'unknown')))
    }
    if (!loggedIn) {
      blocks.push(h('button', {
        key: 'b', style: { ...styles.btn, ...styles.primary, marginTop: 8 },
        disabled: busy, onClick: () => void startSignIn(),
      }, busy ? '请稍候…' : '使用 ChatGPT 账号登录 / Sign in with ChatGPT'))
    }
  }
  if (error) blocks.push(h('p', { key: 'er', style: { ...styles.para, ...styles.err } }, error))
  blocks.push(h('p', { key: 'n', style: styles.dim }, '本页只做登录与状态；模型调用与刷新由宿主 Pi-AI 处理，本插件不注册任何 LLM 路由。'))
  return h('div', { style: styles.card },
    h('div', { style: styles.row },
      h('strong', null, 'ChatGPT 登录'),
      h('span', { style: styles.dim }, 'OpenAI Codex · 原生 Pi-AI OAuth')),
    blocks)
}

/** Required client services. */
export const inject = ['slots']

/**
 * Register the standalone login section next to Models / Plugins.
 * @param {any} ctx - browser Cordis context.
 */
export function apply(ctx) {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'gpt-login',
    order: 13,
    label: () => 'ChatGPT 登录',
  }, GptLoginSection))
}
