# Native Codex login & model access — design boundaries

Acceptance target (scoped gate phase 1): **log in a ChatGPT subscription
account through DSH built-in Pi-AI and call a subscription GPT model, with
`dsh-llm-openai-codex` not installed anywhere.**

## Route ownership (never grab a provider)

The native route is enabled by **profile configuration only**:

```yaml
# cordis.patch.yml of the isolated/production profile
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      openai-codex:
        transport: sse
```

- The **host** `llm-pi-ai` adapter owns the `openai-codex` id; this plugin
  never calls `ctx.llm.registerAdapter` or `registerConfigurableProviders`
  for any LLM route.
- If a composition already owns the same route id, do not register it twice
  (DUPLICATE_ADAPTER); the login acceptance runs in an isolated profile so the
  production desktop composition is untouched.

## Login & credential flow (host services, Pi-AI protocol)

1. Login is triggered through the host authorization service:
   `ctx.authorization.begin({ key: 'llm-pi-ai/openai-codex', method: 'oauth' })`.
   The host flow runs Pi-AI's own OAuth (browser + `127.0.0.1:1455` callback;
   manual paste fallback). This plugin writes no OAuth protocol code.
2. The credential is persisted by the host credential service at the key
   `llm-pi-ai/openai-codex` — the same key the native adapter reads.
3. Refresh is Pi-AI's own (quota reads reuse it via `models.getAuth`,
   see `lib/providers/codex.js`).

## Model call

`ctx.llm.stream({ provider: 'openai-codex', model, messages, ... })` —
the native adapter + transport, no wrapper, no request rewriting.

## Known environment constraint

The desktop CLI does not inherit the GUI proxy. Reaching
`auth.openai.com` / `chatgpt.com` from China requires explicit proxy env
(see `scaffold.sh`); without it the OAuth exchange fails with
`unsupported_country_region_territory` (observed in P0).

## Acceptance procedure (integration entry)

```sh
scripts/native-login-probe/scaffold.sh preflight   # no credential: proves topology
scripts/native-login-probe/scaffold.sh login-call   # prints authorizationUrl; open it in browser
scripts/native-login-probe/scaffold.sh call         # one marker GPT call, expects HTTP 200 + echo
```

All state lives under `.probe-run/` (git-ignored): isolated DSH_HOME, its
own credentials file, env -i, proxy enabled. Evidence JSON (token-free) lands
in `.probe-run/evidence/`. The desktop profile and its credentials are never
touched.
