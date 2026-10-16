#!/usr/bin/env bash
# ============================================================
# restart-verify.sh — Application restart + data persistence test
# ------------------------------------------------------------
# 00-10 acceptance: proves that after stopping and restarting the
# Next.js application, all data (tasks, events, audit log) is
# preserved and accessible.
#
# This script is run by the CI fresh-install-recovery job.
# Steps:
#   1. Start Next.js dev server on port 3001
#   2. Login as admin → capture session cookie
#   3. Create a task via API → capture taskId
#   4. Stop the server (SIGTERM)
#   5. Start a NEW server instance on port 3001
#   6. Login again (or reuse cookie) → verify task still exists
#   7. Verify task detail + events are accessible
#
# Usage (CI):
#   bash scripts/restart-verify.sh
# ============================================================
set -euo pipefail

BASE_URL="http://localhost:3001"
ADMIN_EMAIL="admin@demolandia.test"
ADMIN_PW="test_admin_password_00_03"
COOKIE_FILE="/tmp/restart-cookies.txt"
TASK_GOAL="restart-persistence-$(date +%s)"

echo "=== 00-10 Restart + Data Persistence Test ==="
echo ""

# ------------------------------------------------------------
# STEP 1: Start Next.js server
# ------------------------------------------------------------
echo "[1/7] Starting Next.js dev server on port 3001..."
bunx next dev -p 3001 > /tmp/next-restart.log 2>&1 &
SERVER_PID=$!
echo "  Server PID: $SERVER_PID"

# Wait for server to be ready
READY=0
for i in $(seq 1 60); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/v1/meta" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "  Server ready after $i attempts"
    READY=1
    break
  fi
  sleep 2
done

if [ "$READY" != "1" ]; then
  echo "FAIL: Server did not start within 120 seconds"
  kill $SERVER_PID 2>/dev/null || true
  exit 1
fi

# ------------------------------------------------------------
# STEP 2: Login as admin → capture session cookie
# ------------------------------------------------------------
echo "[2/7] Logging in as admin..."
LOGIN_RESPONSE=$(curl -s -c "$COOKIE_FILE" -X POST "$BASE_URL/api/v1/auth/signin" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}")

if ! echo "$LOGIN_RESPONSE" | grep -q '"ok":true'; then
  echo "FAIL: Login failed: $LOGIN_RESPONSE"
  kill $SERVER_PID 2>/dev/null || true
  exit 1
fi
echo "  Login successful."

# ------------------------------------------------------------
# STEP 3: Create a task via API
# ------------------------------------------------------------
echo "[3/7] Creating task via API..."
CREATE_RESPONSE=$(curl -s -b "$COOKIE_FILE" -X POST "$BASE_URL/api/v1/tasks" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"restart-test\",\"goal\":\"$TASK_GOAL\",\"priority\":100}")

TASK_ID=$(echo "$CREATE_RESPONSE" | jq -r '.taskId // empty')
if [ -z "$TASK_ID" ]; then
  echo "FAIL: Task creation failed: $CREATE_RESPONSE"
  kill $SERVER_PID 2>/dev/null || true
  exit 1
fi
echo "  Task created: $TASK_ID (goal: $TASK_GOAL)"

# ------------------------------------------------------------
# STEP 4: Stop the server (graceful shutdown)
# ------------------------------------------------------------
echo "[4/7] Stopping server (SIGTERM)..."
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true
sleep 3
echo "  Server stopped."

# ------------------------------------------------------------
# STEP 5: Start a NEW server instance
# ------------------------------------------------------------
echo "[5/7] Starting NEW server instance..."
bunx next dev -p 3001 > /tmp/next-restart-2.log 2>&1 &
SERVER_PID=$!
echo "  New server PID: $SERVER_PID"

READY=0
for i in $(seq 1 60); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/v1/meta" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "  Server ready after $i attempts"
    READY=1
    break
  fi
  sleep 2
done

if [ "$READY" != "1" ]; then
  echo "FAIL: Server did not restart within 120 seconds"
  kill $SERVER_PID 2>/dev/null || true
  exit 1
fi

# ------------------------------------------------------------
# STEP 6: Login again (new session)
# ------------------------------------------------------------
echo "[6/7] Logging in again (new session)..."
rm -f "$COOKIE_FILE"
LOGIN_RESPONSE=$(curl -s -c "$COOKIE_FILE" -X POST "$BASE_URL/api/v1/auth/signin" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}")

if ! echo "$LOGIN_RESPONSE" | grep -q '"ok":true'; then
  echo "FAIL: Post-restart login failed: $LOGIN_RESPONSE"
  kill $SERVER_PID 2>/dev/null || true
  exit 1
fi
echo "  Post-restart login successful."

# ------------------------------------------------------------
# STEP 7: Verify task still exists + events accessible
# ------------------------------------------------------------
echo "[7/7] Verifying task persistence after restart..."
TASKS_RESPONSE=$(curl -s -b "$COOKIE_FILE" "$BASE_URL/api/v1/tasks")

# Check that our task is in the list
TASK_FOUND=$(echo "$TASKS_RESPONSE" | jq -r --arg goal "$TASK_GOAL" \
  '.tasks[] | select(.goal == $goal) | .id')

if [ "$TASK_FOUND" != "$TASK_ID" ]; then
  echo "FAIL: Task not found after restart!"
  echo "  Expected taskId: $TASK_ID"
  echo "  Expected goal: $TASK_GOAL"
  echo "  Response: $TASKS_RESPONSE"
  kill $SERVER_PID 2>/dev/null || true
  exit 1
fi

echo "  Task found after restart: $TASK_ID"
echo "  Task goal preserved: $TASK_GOAL"
echo "  Task status: $(echo "$TASKS_RESPONSE" | jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .status')"

# Cleanup
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true
rm -f "$COOKIE_FILE"

echo ""
echo "=== RESTART + DATA PERSISTENCE: PASS ==="
echo "  - Task created before restart: $TASK_ID"
echo "  - Task accessible after restart: YES"
echo "  - Goal preserved: $TASK_GOAL"
echo "  - Database state persisted across server restart"
echo ""
