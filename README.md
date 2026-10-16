# dsh-subscription-usage

[English] | 中文见下

Read-only subscription quota monitoring for DeepSeek Harness (DSH): OpenAI
Codex and OpenCode Go, delivered as an independent plugin under the
**approved scoped gate** in `dsh-opencode-live-models/docs/p0-scope-gate.md`.

- **DSH zero modification.** No host source, provider, or dependency changes.
- **Provider-neutral engine.** Per-provider adapters normalize into one
  `UsageSnapshot`; caches are per account key and single-flight.
- **Official endpoints only.** Credentials never leave each vendor's official
  origin (guard runs before any request).
- **OAuth delegated to host Pi-AI.** Codex refresh reuses the native Pi-AI
  credential path; this plugin never writes OAuth protocol code.
- **Cancellation on lifecycle events.** Disable, unload, and HMR reload abort
  all in-flight quota requests.

## Install

```sh
dsh plugin --profile desktop add github:Luca4Don3/dsh-subscription-usage
```

Requires DSH >= 0.1.5-rc.1 and Node >= 18.

## Usage

After install the plugin provides the `subscriptionUsage` service:

```js
const quota = ctx.get('subscriptionUsage')
const snapshot = await quota.query('openai-codex') // or 'opencode-go'
quota.invalidate('openai-codex')
```

A `UsageSnapshot` carries `status` (`ready | exhausted | stale |
auth-required | rate-limited | unknown | unsupported`), `windows` with
`usedPercent/remainingPercent/windowMinutes/resetsAt`, and `capturedAt`.
Missing data is reported as `unknown` — never as 0%.

## Verification status (scoped gate)

| Item | Status |
|---|---|
| Codex OAuth compatibility (reuses Pi-AI) | PASS (P0 E2E) |
| **Phase 1: native ChatGPT login + GPT call with no dsh-llm-openai-codex installed** | **PASS** (\`scripts/native-login-probe\`, evidence in docs/validation/native-login/) |
| Codex quota endpoint /wham/usage | PASS (200, real account) |
| OpenCode Go quota endpoint | PASS (200) |
| Parsing rules pinned by regression suite | PASS (fixtures + tests) |
| DSH unchanged / provider untouched | PASS |
| Real DSH Desktop UI integration | NOT STARTED (P2) |
| Real multi-account switch (two live accounts) | NOT STARTED (synthetic covered) |

The openai ChatGPT OAuth provider remains INCOMPATIBLE (host Pi-AI 0.87.1)
and is **out of scope** for this plugin; see the gate document.

## License

MIT

---

## 中文

面向 DeepSeek Harness 的只读订阅额度监控插件（OpenAI Codex +
OpenCode Go），按已批准的限定门禁范围开发。DSH 零修改、官方端点限定、
OAuth 刷新复用宿主 Pi-AI、卸载/禁用/HMR 时取消在途查询。账号键无有效
标识时返回 `identity-unverified`，不同账号缓存永不串用；缺失数据显示
为 unknown，绝不推算成 0%。
