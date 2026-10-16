#!/bin/sh
# Phase-1 native login acceptance scaffold: isolated DSH_HOME, env -i, proxy,
# native llm-pi-ai openai-codex route, no dsh-llm-openai-codex anywhere.
set -eu
umask 077
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
RUN="$REPO/.probe-run"
ACTION="${1:-preflight}"
mkdir -p "$RUN/consumer" "$RUN/home/profiles/native-login/node_modules" "$RUN/os-home" "$RUN/cwd" "$RUN/tmp" "$RUN/xdg-config" "$RUN/xdg-cache" "$RUN/xdg-data" "$RUN/xdg-state" "$RUN/xdg-runtime" "$RUN/evidence"
# consumer bundle copied in so the profile link is self-contained
cp "$REPO/scripts/native-login-probe/consumer.mjs" "$RUN/consumer/index.mjs"
cp "$REPO/scripts/native-login-probe/package.json" "$RUN/consumer/package.json"
{
  echo '- insert:'
  echo '    - id: native-login-probe'
  echo '      name: dsh-native-login-probe'
  echo '      config:'
  echo "        runDir: $RUN"
  echo '        modelId: gpt-6-sol'
  echo '        timeoutMs: 600000'
  echo '        requestTimeoutMs: 120000'
} > "$RUN/consumer/cordis.patch.yml"
{
  echo '{"name":"dsh-profile-native-login","private":true,"dependencies":{"dsh-native-login-probe":"link:../../../consumer"},"dsh":{"profile":{"bundles":["dsh-native-login-probe"]}}}'
} > "$RUN/home/profiles/native-login/package.json"
{
  echo '- insert:'
  echo '    - id: llm'
  echo "      name: '@deepseek-ai/dsh-llm'"
  echo '    - id: credentials-local'
  echo "      name: '@deepseek-ai/dsh-credentials-local'"
  echo '      config:'
  echo "        path: $RUN/home/.credentials.yaml"
  echo '        watch: false'
  echo '    - id: authorization'
  echo "      name: '@deepseek-ai/dsh-authorization'"
  echo '    - id: llm-pi-ai'
  echo "      name: '@deepseek-ai/dsh-llm-pi-ai'"
  echo '      config:'
  echo '        providers:'
  echo '          openai-codex:'
  echo '            transport: sse'
} > "$RUN/home/profiles/native-login/cordis.patch.yml"
ln -sfn "$RUN/consumer" "$RUN/home/profiles/native-login/node_modules/dsh-native-login-probe"
{
  echo '#!/bin/sh'
  echo 'set -eu'
  echo 'umask 077'
  echo "RUN='$RUN'"
  echo 'cd "$RUN/cwd"'
  echo 'exec env -i HOME="$RUN/os-home" PATH=/usr/bin:/bin:/usr/sbin:/sbin \'
  echo '  DSH_HOME="$RUN/home" TMPDIR="$RUN/tmp" \'
  echo '  XDG_CONFIG_HOME="$RUN/xdg-config" XDG_CACHE_HOME="$RUN/xdg-cache" \'
  echo '  XDG_DATA_HOME="$RUN/xdg-data" XDG_STATE_HOME="$RUN/xdg-state" \'
  echo '  XDG_RUNTIME_DIR="$RUN/xdg-runtime" DSH_TELEMETRY_DISABLED=1 \'
  echo '  HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 \'
  echo '  ALL_PROXY=http://127.0.0.1:7897 NO_PROXY=127.0.0.1,localhost \'
  echo '  /usr/local/bin/dsh --profile native-login "$@"'
} > "$RUN/launch.sh"
chmod +x "$RUN/launch.sh"
sh -n "$RUN/launch.sh"
exec sh "$RUN/launch.sh" "$ACTION"
