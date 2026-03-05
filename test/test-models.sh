#!/usr/bin/env bash
# Test core capabilities across models.

CLI="bun run $(dirname "$0")/../src/index.ts"

CLAUDE="anthropic:anthropic/claude-sonnet-4.6"
GPT_CODEX="openai:openai/gpt-5.3-codex"
GEMINI="google-ai-studio:google/gemini-2.5-flash"

ALL_MODELS=("$CLAUDE" "$GEMINI")
SHELL_ONLY=("$GPT_CODEX")

run() {
  local model="$1"; local prompt="$2"
  echo "=== model: $model ==="
  $CLI -p -y -m "$model" "$prompt"
  echo
}

# ── basic response
for m in "${ALL_MODELS[@]}"; do run "$m" "say hello in one sentence"; done

# ── shell tool
for m in "${ALL_MODELS[@]}" "${SHELL_ONLY[@]}"; do run "$m" "run: echo 'shell works' and tell me what it printed"; done

# ── file read
for m in "${ALL_MODELS[@]}"; do run "$m" "read the file src/index.ts and tell me in one sentence what it does"; done
