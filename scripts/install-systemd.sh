#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/hengyi-meiyuan-data}"
APP_SERVICE="${APP_SERVICE:-hengyi-groupbuy-board.service}"
PUSH_SERVICE="${PUSH_SERVICE:-hengyi-binding-push.service}"
PUSH_TIMER="${PUSH_TIMER:-hengyi-binding-push.timer}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请在阿里云服务器上用 root 或 sudo 执行：sudo bash scripts/install-systemd.sh" >&2
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "缺少 $PROJECT_DIR/.env，请先复制 .env.example 并填写真实配置。" >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR/.npm-cache"
cp "$PROJECT_DIR/deploy/$APP_SERVICE" "/etc/systemd/system/$APP_SERVICE"
cp "$PROJECT_DIR/deploy/$PUSH_SERVICE" "/etc/systemd/system/$PUSH_SERVICE"
cp "$PROJECT_DIR/deploy/$PUSH_TIMER" "/etc/systemd/system/$PUSH_TIMER"

systemctl daemon-reload
systemctl enable --now "$APP_SERVICE"
systemctl enable --now "$PUSH_TIMER"

echo "已启用看板服务：$APP_SERVICE"
echo "已启用定时推送：$PUSH_TIMER"
echo
systemctl --no-pager status "$APP_SERVICE" || true
echo
systemctl list-timers --all "$PUSH_TIMER" || true
