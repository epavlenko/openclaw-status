#!/usr/bin/env bash
#
# E2E tests for status_community tool.
# Sends messages to the OpenClaw agent and verifies side effects
# (community store state).
#
# Usage: ./test/e2e-tool.sh
# Requires: running gateway with openclaw-status plugin loaded, jq
#
set -euo pipefail

OPENCLAW="${OPENCLAW_BIN:-openclaw}"
SESSION="e2e-test-$$-$(date +%s)"
DATA_DIR="${HOME}/.openclaw/data/openclaw-status"
PASS=0
FAIL=0

cleanup() {
  if [ -f "$DATA_DIR/communities.json" ]; then
    local tmp
    tmp=$(jq '{communityIds: [.communityIds[] | select(startswith("0xe2etest") or . == "0x1f373d2e0d0512025a" or . == "0x026021e0c3665b2a" | not)]}' \
      "$DATA_DIR/communities.json" 2>/dev/null || echo '{"communityIds":[]}')
    echo "$tmp" > "$DATA_DIR/communities.json"
  fi
}
trap cleanup EXIT

ask() {
  $OPENCLAW agent --agent main --session-id "$SESSION" --message "$1" --json --timeout 90 2>/dev/null >/dev/null
}

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

assert_in_store() {
  if [ -f "$DATA_DIR/communities.json" ] && jq -e ".communityIds | index(\"$1\")" "$DATA_DIR/communities.json" >/dev/null 2>&1; then
    pass "$2"
  else
    fail "$2 ($1 not in store)"
  fi
}

assert_not_in_store() {
  if [ ! -f "$DATA_DIR/communities.json" ] || ! jq -e ".communityIds | index(\"$1\")" "$DATA_DIR/communities.json" >/dev/null 2>&1; then
    pass "$2"
  else
    fail "$2 ($1 still in store)"
  fi
}

assert_reply_ok() {
  # Just check agent didn't error out (exit 0)
  if [ $? -eq 0 ]; then
    pass "$1"
  else
    fail "$1 (agent exited non-zero)"
  fi
}

echo "E2E: agent → status_community tool"
echo "Session: $SESSION"
echo ""

# ---------- Test 1: join with hex ID ----------
TEST_ID="0xe2etest_hex_$(date +%s)"
echo "Test 1: join community by hex ID ($TEST_ID)"
ask "Присоединись к Status-коммьюнити $TEST_ID. Используй tool status_community с action join."
assert_in_store "$TEST_ID" "community ID persisted to store"

# ---------- Test 2: join with status.app link ----------
# zQ3e2eTestKey decodes to 0x1f373d2e0d0512025a via parseCommunityId
echo "Test 2: join community by status.app link"
ask "Присоединись к Status-коммьюнити https://status.app/c#zQ3e2eTestKey. Используй tool status_community с action join."
assert_in_store "0x1f373d2e0d0512025a" "parsed community key persisted (decoded to hex)"

# ---------- Test 3: join with /cc link ----------
# zQ3e2eCcKey decodes to 0x026021e0c3665b2a via parseCommunityId
echo "Test 3: join community by /cc link"
ask "Присоединись к Status-каналу https://status.app/cc/G5kAAtest#zQ3e2eCcKey. Используй status_community join."
assert_in_store "0x026021e0c3665b2a" "parsed /cc community key persisted (decoded to hex)"

# ---------- Test 4: leave ----------
echo "Test 4: leave community"
ask "Покинь Status-коммьюнити $TEST_ID. Используй status_community leave."
assert_not_in_store "$TEST_ID" "community removed from store"

# ---------- Test 5: list (just check no error) ----------
echo "Test 5: list communities"
ask "Покажи список Status-коммьюнити. Используй tool status_community с action list."
assert_reply_ok "list returned without error"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
