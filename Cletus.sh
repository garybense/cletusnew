#!/usr/bin/env bash
# ==============================================================================
# Cletus & Mission Control Unified Launcher
# Starts the sovereign agent loop alongside the real-time web dashboard.
# ==============================================================================

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

if [ -f ".env" ]; then
  set -a
  source .env
  set +a
fi

DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"
LOG_FILE="${CLETUS_LOG:-${CLETUS_LOG_DIR:-$HOME/.cletus}/cletus.log}"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Function to check if dashboard is running
check_dashboard() {
  local dashboard_pid=$(lsof -ti :"$DASHBOARD_PORT" 2>/dev/null || echo "")
  if [ -n "$dashboard_pid" ]; then
    echo "Dashboard: RUNNING (PID: $dashboard_pid, Port: $DASHBOARD_PORT)"
    return 0
  else
    echo "Dashboard: STOPPED"
    return 1
  fi
}

# Function to check if Cletus agent is running
check_cletus() {
  local agent_pid=$(pgrep -f "node scripts/with-app-env.mjs" 2>/dev/null || pgrep -f "vite dev" 2>/dev/null || echo "")
  if [ -n "$agent_pid" ]; then
    echo "Cletus Runtime: RUNNING (PID: $agent_pid)"
    return 0
  else
    echo "Cletus Runtime: STOPPED"
    return 1
  fi
}

# Function to stop all services
stop_services() {
  echo "Stopping Cletus and Dashboard..."
  
  # Stop dashboard by port
  local dashboard_pids=$(lsof -ti :"$DASHBOARD_PORT" 2>/dev/null || true)
  if [ -n "$dashboard_pids" ]; then
    echo "  Killing dashboard on port $DASHBOARD_PORT..."
    while read -r pid; do
      [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    done <<< "$dashboard_pids"
  fi
  
  # Stop Cletus agent and dev processes
  echo "  Killing Cletus agent and dev processes..."
  pkill -9 -f "node scripts/with-app-env.mjs" 2>/dev/null || true
  pkill -9 -f "node dist/index.js" 2>/dev/null || true
  pkill -9 -f "pnpm dev" 2>/dev/null || true
  pkill -9 -f "tsx src/index.ts" 2>/dev/null || true
  pkill -9 -f "vite dev" 2>/dev/null || true
  pkill -9 -f "npm run dev" 2>/dev/null || true
  
  echo "✅ All services terminated."
}

# Function to show status
show_status() {
  echo "========================================================================"
  echo " Cletus Service Status"
  echo "========================================================================"
  check_dashboard
  local dashboard_result=$?
  check_cletus
  local cletus_result=$?
  echo "========================================================================"
}

# Handle commands
case "${1:-}" in
  --stop|-s|stop)
    stop_services
    exit 0
    ;;
  --status|status)
    show_status
    exit 0
    ;;
  --help|-h)
    echo "Usage: $0 {start|stop|status} [options]"
    echo ""
    echo "Commands:"
    echo "  start    Start Cletus agent and dashboard (default)"
    echo "  --reset  Skip database wipe on startup"
    echo "  --kill   Stop all Cletus processes (alias for --stop)"
    echo "  --status Show status of Cletus and Dashboard"
    echo "  --stop   Stop Cletus and Dashboard"
    echo "  --help   Show this help message"
    exit 0
    ;;
  "")
    # Default behavior: start services
    ;;
  *)
    echo "Unknown option: $1"
    echo "Run '$0 --help' for usage information."
    exit 1
    ;;
esac

# Parse remaining arguments
RESET_STATE=false
NEW_ARGS=()
for arg in "${@:2}"; do
  if [ "$arg" == "--reset" ]; then
    RESET_STATE=true
  elif [ "$arg" == "--kill" ] || [ "$arg" == "--stop" ]; then
    # Handle embedded stop flag
    stop_services
    exit 0
  else
    NEW_ARGS+=("$arg")
  fi
done

if [ "$RESET_STATE" = true ]; then
  echo "⚠️ --reset flag detected. Skipping database wipe as requested."
fi

echo "========================================================================"
echo " 🤖 STARTING CLETUS MISSION CONTROL & AGENT RUNTIME"
echo " Workspace: $REPO_DIR"
echo " Dashboard: http://localhost:$DASHBOARD_PORT"
echo " Log file:  $LOG_FILE"
echo "========================================================================"

# Check and report current state
echo ""
echo "Pre-launch check:"
if check_dashboard; then
  echo "Port $DASHBOARD_PORT is occupied"
else
  echo "Port $DASHBOARD_PORT is available"
fi
if check_cletus; then
  :
else
  echo "Cletus runtime is not running"
fi
echo ""

# 1. Clean-up: Terminate existing Cletus/Dashboard processes
echo "Initiating clean-up of existing processes..."

# Kill dashboard by port
EXISTING_DASHBOARD_PIDS=$(lsof -ti :"$DASHBOARD_PORT" 2>/dev/null || true)
if [ -n "$EXISTING_DASHBOARD_PIDS" ]; then
  echo "  Killing dashboard listener(s) on port $DASHBOARD_PORT..."
  while read -r pid; do
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
  done <<EOF
$EXISTING_DASHBOARD_PIDS
EOF
fi

# Kill agent by process patterns
echo "  Killing Cletus agent instances..."
pkill -9 -f "node scripts/with-app-env.mjs" 2>/dev/null || true
pkill -9 -f "node dist/index.js" 2>/dev/null || true
pkill -9 -f "pnpm dev" 2>/dev/null || true
pkill -9 -f "tsx src/index.ts" 2>/dev/null || true
pkill -9 -f "vite dev" 2>/dev/null || true
pkill -9 -f "npm run dev" 2>/dev/null || true

# Give the OS a moment to release ports
sleep 1
echo "✅ Clean-up complete."

# 2. Launch Mission Control Dashboard & Agent Runtime
echo "Launching Cletus Mission Control on port $DASHBOARD_PORT..."
nohup npm run dev >> "$LOG_FILE" 2>&1 &
DASHBOARD_PID=$!

cleanup() {
  echo ""
  echo "Shutting down Cletus & Dashboard..."
  pkill -9 -f "vite dev" 2>/dev/null || true
  pkill -9 -f "node scripts/with-app-env.mjs" 2>/dev/null || true
  pkill -9 -f "dist/index.js" 2>/dev/null || true
  pkill -9 -f "npm run dev" 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "Checking dashboard health on http://localhost:$DASHBOARD_PORT..."
for i in {1..10}; do
  sleep 1
  if lsof -ti :"$DASHBOARD_PORT" >/dev/null 2>&1; then
    echo "✅ Dashboard is active on http://localhost:$DASHBOARD_PORT"
    break
  fi
done

echo "========================================================================"
echo " Cletus Mission Control is running!"
echo " URL:  http://localhost:$DASHBOARD_PORT"
echo " Logs: $LOG_FILE"
echo " Press Ctrl+C to stop."
echo "========================================================================"

wait $DASHBOARD_PID
