#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="${LABEL:-com.local.hengyi-meiyuan.binding-push}"
HOUR="${SCHEDULE_HOUR:-9}"
MINUTE="${SCHEDULE_MINUTE:-0}"
MODE="${PUSH_MODE:-all}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
PATH_VALUE="${PATH:-/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin}"

EXTRA_ARG_XML=""
if [[ "$MODE" == "top10" ]]; then
  EXTRA_ARG_XML="    <string>--top10-only</string>"
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/logs"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/scripts/push-binding-stats.mjs</string>
$EXTRA_ARG_XML
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$PATH_VALUE</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$HOUR</integer>
    <key>Minute</key>
    <integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/logs/binding-push.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/logs/binding-push.error.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"

echo "已安装本地定时任务：$LABEL"
printf "执行时间：每天 %02d:%02d\n" "$HOUR" "$MINUTE"
echo "推送模式：$MODE"
echo "配置文件：$PLIST"
