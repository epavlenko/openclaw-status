#!/usr/bin/env bash
#
# Smoke test — full verification pipeline for openclaw-status.
#
# Runs: unit tests → restart gateway → wait ready → E2E → verify health + logs.
# Use after any code change to catch integration issues before they reach the user.
#
# Usage: npm run test:smoke
#        bash test/smoke.sh
#
# Exit codes: 0 = all green, 1 = failures detected
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_URL="${STATUS_BACKEND_URL:-http://127.0.0.1:12345}"

PASS=0
FAIL=0
STEP=0

pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); }

step() {
  STEP=$((STEP + 1))
  echo ""
  echo "================================================================"
  echo "  Step $STEP: $1"
  echo "================================================================"
}

# ---------------------------------------------------------------------------
# Step 1: Build
# ---------------------------------------------------------------------------
step "TypeScript build"
cd "$PROJECT_DIR"
if npm run build 2>&1; then
  echo "  OK: build succeeded"
  pass
else
  echo "  FAIL: build failed"
  fail
  echo ""
  echo "Smoke test aborted at build step."
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 2: Unit tests
# ---------------------------------------------------------------------------
step "Unit tests (vitest)"

# Kill any stray status-backend on test ports to avoid flaky setup.test.ts
# Port 61777 is used by setup.test.ts to test "unreachable URL"
STRAY_PID=$(ss -tlnp 2>/dev/null | grep ":61777 " | grep -oP 'pid=\K[0-9]+' || true)
if [ -n "$STRAY_PID" ]; then
  echo "  Killing stray process on :61777 (pid $STRAY_PID) to avoid test flakiness"
  kill "$STRAY_PID" 2>/dev/null || true
  sleep 1
fi

if npm test 2>&1; then
  echo "  OK: all unit tests passed"
  pass
else
  echo "  FAIL: unit tests failed"
  fail
  echo ""
  echo "Smoke test aborted at unit test step."
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 3: Gateway restart
# ---------------------------------------------------------------------------
step "Gateway restart"

# Record log timestamp before restart
LOG_TS=$(date "+%Y-%m-%d %H:%M:%S")

if ! systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then
  echo "  Gateway not running, starting..."
  systemctl --user start openclaw-gateway 2>/dev/null
else
  echo "  Restarting gateway..."
  systemctl --user restart openclaw-gateway 2>/dev/null
fi

# Wait for gateway service to be active
echo "  Waiting for gateway service..."
WAIT=0
TIMEOUT=30
while ! systemctl --user is-active openclaw-gateway >/dev/null 2>&1 && [ "$WAIT" -lt "$TIMEOUT" ]; do
  sleep 2
  WAIT=$((WAIT + 2))
done

if systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then
  echo "  OK: gateway active"
  pass
else
  echo "  FAIL: gateway did not start within ${TIMEOUT}s"
  fail
  echo ""
  journalctl --user -u openclaw-gateway --since "$LOG_TS" --no-pager | tail -20
  echo ""
  echo "Smoke test aborted — gateway failed to start."
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

# Wait for backend health
echo "  Waiting for status-backend health..."
WAIT=0
TIMEOUT=30
while ! curl -sf "${BACKEND_URL}/health" >/dev/null 2>&1 && [ "$WAIT" -lt "$TIMEOUT" ]; do
  sleep 2
  WAIT=$((WAIT + 2))
done

if curl -sf "${BACKEND_URL}/health" >/dev/null 2>&1; then
  echo "  OK: backend healthy"
  pass
else
  echo "  FAIL: backend not healthy ${TIMEOUT}s after restart"
  fail
  echo ""
  echo "Smoke test aborted — backend unhealthy."
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 4: RPC readiness (backend logged in)
# ---------------------------------------------------------------------------
step "RPC readiness (backend logged in)"

echo "  Waiting for backend login (public-key in settings)..."
RPC_WAIT=0
RPC_TIMEOUT=60
RPC_READY=false
while [ "$RPC_WAIT" -lt "$RPC_TIMEOUT" ]; do
  PK=$(curl -sf -X POST "${BACKEND_URL}/statusgo/CallRPC" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"settings_getSettings","params":[]}' 2>/dev/null \
    | jq -r '.result["public-key"] // empty' 2>/dev/null || true)
  if [ -n "$PK" ]; then
    RPC_READY=true
    break
  fi
  sleep 2
  RPC_WAIT=$((RPC_WAIT + 2))
done

if [ "$RPC_READY" = true ]; then
  echo "  OK: backend logged in (public-key present)"
  pass
else
  echo "  FAIL: backend not logged in after ${RPC_TIMEOUT}s"
  fail
  echo ""
  echo "Smoke test aborted — backend not logged in."
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 5: E2E tests
# ---------------------------------------------------------------------------
step "E2E tests"
if bash "$SCRIPT_DIR/e2e-tool.sh" 2>&1; then
  echo ""
  echo "  OK: all E2E tests passed"
  pass
else
  echo ""
  echo "  FAIL: E2E tests had failures"
  fail
fi

# ---------------------------------------------------------------------------
# Step 6: Post-E2E health + log check
# ---------------------------------------------------------------------------
step "Post-E2E health verification"

if systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then
  echo "  OK: gateway still active"
  pass
else
  echo "  FAIL: gateway crashed during E2E tests"
  fail
fi

if curl -sf "${BACKEND_URL}/health" >/dev/null 2>&1; then
  echo "  OK: backend still healthy"
  pass
else
  echo "  FAIL: backend not healthy after E2E"
  fail
fi

# Check gateway logs for errors since restart
ERRORS=$(journalctl --user -u openclaw-gateway --since "$LOG_TS" --no-pager -p err 2>/dev/null | grep -v "^-- " | tail -20 || true)
if [ -z "$ERRORS" ]; then
  echo "  OK: no errors in gateway logs"
  pass
else
  echo "  WARN: gateway log errors detected"
  echo "$ERRORS" | sed 's/^/    /'
  fail
fi

# Kill any stray status-backend spawned on test ports during E2E
STRAY_PID=$(ss -tlnp 2>/dev/null | grep ":61777 " | grep -oP 'pid=\K[0-9]+' || true)
if [ -n "$STRAY_PID" ]; then
  echo "  Cleaning up stray process on :61777 (pid $STRAY_PID)"
  kill "$STRAY_PID" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "================================================================"
echo "  SMOKE TEST COMPLETE"
echo "  Results: $PASS passed, $FAIL failed"
echo "================================================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
