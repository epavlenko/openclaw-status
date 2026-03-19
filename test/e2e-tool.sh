#!/usr/bin/env bash
#
# E2E tests for status_community tool.
# Sends messages to the OpenClaw agent and verifies side effects
# (community store state, gateway health, logs).
#
# Usage: ./test/e2e-tool.sh
# Requires: running gateway with openclaw-status plugin loaded, jq
#
set -euo pipefail

OPENCLAW="${OPENCLAW_BIN:-openclaw}"
SESSION="e2e-test-$$-$(date +%s)"
DATA_DIR="${HOME}/.openclaw/data/openclaw-status"
BACKEND_URL="${STATUS_BACKEND_URL:-http://127.0.0.1:12345}"
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
  if [ $? -eq 0 ]; then
    pass "$1"
  else
    fail "$1 (agent exited non-zero)"
  fi
}

# ---------------------------------------------------------------------------
# Health check helpers
# ---------------------------------------------------------------------------

check_gateway_active() {
  if systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

check_backend_health() {
  if curl -sf "${BACKEND_URL}/health" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Capture recent gateway log errors (since test start)
LOG_START_TS=""
mark_log_start() {
  LOG_START_TS=$(date "+%Y-%m-%d %H:%M:%S")
}

check_gateway_logs() {
  local label="$1"
  local errors
  errors=$(journalctl --user -u openclaw-gateway --since "$LOG_START_TS" --no-pager -p err 2>/dev/null | grep -v "^-- " | tail -20 || true)
  if [ -n "$errors" ]; then
    fail "$label — gateway log errors detected"
    echo "    --- recent errors ---"
    echo "$errors" | sed 's/^/    /'
    echo "    ---"
  else
    pass "$label"
  fi
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

echo "E2E: agent -> status_community tool"
echo "Session: $SESSION"
echo ""

echo "=== Pre-flight checks ==="
if check_gateway_active; then
  pass "gateway service is active"
else
  fail "gateway service is not active"
  echo "  Start it: systemctl --user start openclaw-gateway"
  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

if check_backend_health; then
  pass "status-backend is healthy"
else
  fail "status-backend is not reachable at $BACKEND_URL"
  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

mark_log_start
echo ""

# ===========================================================================
# SECTION 1: Tool functionality (join / leave / list)
# ===========================================================================

echo "=== Tool functionality ==="

# ---------- Test: join with hex ID ----------
TEST_ID="0xe2etest_hex_$(date +%s)"
echo "Test: join community by hex ID ($TEST_ID)"
ask "Присоединись к Status-коммьюнити $TEST_ID. Используй tool status_community с action join."
assert_in_store "$TEST_ID" "hex ID persisted to store"

# ---------- Test: join with status.app link ----------
# zQ3e2eTestKey decodes to 0x1f373d2e0d0512025a via parseCommunityId
echo "Test: join community by status.app link"
ask "Присоединись к Status-коммьюнити https://status.app/c#zQ3e2eTestKey. Используй tool status_community с action join."
assert_in_store "0x1f373d2e0d0512025a" "status.app link parsed and decoded to hex"

# ---------- Test: join with /cc link ----------
# zQ3e2eCcKey decodes to 0x026021e0c3665b2a via parseCommunityId
echo "Test: join community by /cc link"
ask "Присоединись к Status-каналу https://status.app/cc/G5kAAtest#zQ3e2eCcKey. Используй status_community join."
assert_in_store "0x026021e0c3665b2a" "/cc link parsed and decoded to hex"

# ---------- Test: duplicate join ----------
echo "Test: duplicate join returns gracefully"
ask "Присоединись к Status-коммьюнити $TEST_ID. Используй tool status_community с action join."
assert_in_store "$TEST_ID" "duplicate join did not break store"

# ---------- Test: leave ----------
echo "Test: leave community"
ask "Покинь Status-коммьюнити $TEST_ID. Используй status_community leave."
assert_not_in_store "$TEST_ID" "community removed from store"

# ---------- Test: leave non-existent (should not error) ----------
echo "Test: leave non-existent community"
ask "Покинь Status-коммьюнити 0xe2etest_nonexistent. Используй status_community leave."
assert_reply_ok "leave non-existent returned without error"

# ---------- Test: list ----------
echo "Test: list communities"
ask "Покажи список Status-коммьюнити. Используй tool status_community с action list."
assert_reply_ok "list returned without error"

echo ""

# ===========================================================================
# SECTION 2: Gateway stability
# ===========================================================================

echo "=== Gateway stability ==="

# Check that gateway didn't crash during tool tests
if check_gateway_active; then
  pass "gateway still active after tool tests"
else
  fail "gateway crashed during tool tests"
fi

if check_backend_health; then
  pass "backend still healthy after tool tests"
else
  fail "backend crashed during tool tests"
fi

check_gateway_logs "no gateway errors during tool tests"

echo ""

# ===========================================================================
# SECTION 3: Gateway restart resilience
# ===========================================================================

echo "=== Gateway restart resilience ==="

# Restart gateway and verify it comes back healthy
echo "Test: restart gateway"
systemctl --user restart openclaw-gateway 2>/dev/null
sleep 3

RESTART_WAIT=0
RESTART_TIMEOUT=30
while ! check_gateway_active && [ "$RESTART_WAIT" -lt "$RESTART_TIMEOUT" ]; do
  sleep 2
  RESTART_WAIT=$((RESTART_WAIT + 2))
done

if check_gateway_active; then
  pass "gateway restarted successfully"
else
  fail "gateway did not restart within ${RESTART_TIMEOUT}s"
  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

# Wait for backend to be healthy after restart
HEALTH_WAIT=0
HEALTH_TIMEOUT=30
while ! check_backend_health && [ "$HEALTH_WAIT" -lt "$HEALTH_TIMEOUT" ]; do
  sleep 2
  HEALTH_WAIT=$((HEALTH_WAIT + 2))
done

if check_backend_health; then
  pass "backend healthy after gateway restart"
else
  fail "backend not healthy ${HEALTH_TIMEOUT}s after restart"
fi

mark_log_start

# Tool call immediately after restart — tests race condition
# (RPC handlers may not be registered yet)
echo "Test: tool call immediately after restart"
RESTART_TEST_ID="0xe2etest_restart_$(date +%s)"
ask "Присоединись к Status-коммьюнити $RESTART_TEST_ID. Используй tool status_community с action join."
assert_in_store "$RESTART_TEST_ID" "join works after gateway restart"

# Clean up
ask "Покинь Status-коммьюнити $RESTART_TEST_ID. Используй status_community leave."

check_gateway_logs "no gateway errors after restart + join"

echo ""

# ===========================================================================
# SECTION 4: Final health check
# ===========================================================================

echo "=== Final health check ==="
if check_gateway_active; then
  pass "gateway active at end of all tests"
else
  fail "gateway not active at end of tests"
fi

if check_backend_health; then
  pass "backend healthy at end of all tests"
else
  fail "backend not healthy at end of tests"
fi

check_gateway_logs "no gateway errors during entire test run"

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
