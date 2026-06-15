# 恒奕美源数据本地推送任务

这个任务用于定时生成绑定数据播报，并通过私域宝推送。默认推送内容为：

- 当天门店总数据：总绑定数、已获手机号、未获取手机号
- 截止当前累计数据：总绑定数、有手机号、无手机号
- TOP20 合伙人绑定数据：按当天绑定数排序

推送会分 3 条发送。

第一条：

```text
恒奕美源绑定数据播报
日期：2026-06-14
生成时间：2026/6/14 21:35:29

【截止当前累计】
总绑定：3526
有手机号：1676
无手机号：1850
手机号获取率：47.5%

【今日新增】
总绑定：108
有手机号：29
无手机号：79
手机号获取率：26.9%
```

第二条：

```text
今日合伙人绑定 TOP1-10

1. 合伙人A
绑定 100｜有号 80｜无号 20

2. 合伙人B
绑定 90｜有号 60｜无号 30
```

第三条：

```text
今日合伙人绑定 TOP11-20

11. 合伙人K
绑定 20｜有号 12｜无号 8
```

## 1. 配置本地环境

```bash
cp .env.example .env
```

把真实账号、密码、私域宝手机号、机器人 ID、好友 ID 填到 `.env`。不要提交 `.env`。

私域宝相关配置：

```bash
MG_SALON_ACCOUNT=门店账号
MG_SALON_PASSWORD=门店密码
MG_SYB_HANDSET=私域宝登录手机号
MG_SYB_ROBOT_ID=机器人ID
MG_SYB_SENDER_IDS=好友ID1,好友ID2
```

如果只推一个好友，也可以继续使用旧字段 `MG_SYB_SENDER_ID`。如果推群，使用 `MG_SYB_GROUP_ID`，并留空 `MG_SYB_SENDER_IDS` / `MG_SYB_SENDER_ID`。

## 2. 配置数据源

当前脚本支持两种输入。

文件模式：

```bash
BINDING_DATA_FILE=./data/binding-sample.json
BINDING_LIST_PATH=data.list
BINDING_PHONE_FIELD=phone,mobile,handset,tel
BINDING_DATE_FIELD=created_at
PARTNER_NAME_FIELD=retail_store_name
PARTNER_ID_FIELD=retail_store_id
TOP_PARTNER_LIMIT=20
```

接口模式：

```bash
BINDING_DATA_FILE=
BINDING_DATA_URL=https://example.com/api/bindings
BINDING_DATA_METHOD=GET
BINDING_DATA_LOGIN=mg
MG_CENTER_ACCOUNT=后台账号
MG_CENTER_PASSWORD=后台密码
```

如果接口直接返回汇总字段，可以改用：

```bash
TOTAL_BINDINGS_PATH=data.total
PHONE_OBTAINED_PATH=data.withPhone
PHONE_MISSING_PATH=data.withoutPhone
```

## 3. 本地测试

只生成消息，不发送：

```bash
npm run push:binding:dry
```

正式发送：

```bash
npm run push:binding
```

正式发送时脚本会按顺序执行：

```text
salon-login -> salon-syb-list -> salon-syb-send
```

## 4. 安装本地定时任务

这一节只适用于 Mac 本机。如果部署到阿里云 ECS，请使用后面的「阿里云定时推送」。

默认每天 09:00 执行：

```bash
bash scripts/install-launchd.sh
```

自定义时间，例如每天 20:00，并且只推总览 + TOP10：

```bash
SCHEDULE_HOUR=20 SCHEDULE_MINUTE=0 PUSH_MODE=top10 bash scripts/install-launchd.sh
```

查看日志：

```bash
tail -f logs/binding-push.log
tail -f logs/binding-push.error.log
```

卸载：

```bash
launchctl unload ~/Library/LaunchAgents/com.local.hengyi-meiyuan.binding-push.plist
rm ~/Library/LaunchAgents/com.local.hengyi-meiyuan.binding-push.plist
```

## 5. 拼团订单看板网页

新增一个本地榜单网页，用来查看「本月截止当前」的全部拼团订单，并支持按拼团商品名和时间范围筛选。

门店口径：

- 门店账号沿用前面绑定数据推送的同一套 `MG_SALON_ACCOUNT` / `MG_SALON_PASSWORD`
- 拼团榜单不单独配置第二套门店账号
- `GROUPBUY_DATA_URL` 中的 `salon_id` / `brand_id` 要和这个门店保持一致
- 由于拼团接口额外需要 `session_token`，只需要从浏览器 Network 的拼团接口 curl 中补 `GROUPBUY_SESSION_TOKEN`

统计口径：

- 默认看本月 1 日至今天
- 默认看全部拼团商品；页面顶部可按拼团商品名搜索
- 页面顶部可筛选开始日期 / 结束日期
- 只统计系统有效订单：订单 `status=7` 或 `status=200`，且无退款
- 交易关闭、退款完成、退款成功、已退款、退款关闭、未支付订单不统计
- 未成团榜单按「还差单数」从少到多排序
- SPU 汇总按拼团商品名聚合展示开团数、订单数、金额、已成团、未成团、成团率

启动：

```bash
npm run groupbuy:board
```

健康检查：

```bash
npm run health
```

打开：

```text
http://127.0.0.1:8787/groupbuy
```

页面包含：

- 本月默认汇总：有效订单、有效金额、开团数、已成团数、未成团数、成团率
- SPU 汇总：默认按拼团商品名展示全部拼团订单
- 未成团 TOP10：按还差单数排序，优先看到最容易成团的团长
- 全部明细：支持按团长、手机号、标题搜索，并可筛选未成团 / 已成团

可选配置：

```bash
GROUPBUY_BOARD_PORT=8787
GROUPBUY_BOARD_HOST=127.0.0.1
GROUPBUY_DEFAULT_KEYWORD=
GROUPBUY_DATA_URL=https://api-sy-z1.meimeifa.com/salon/order/mall/groupbuy/get?page=1&page_size=100&begin_date=&end_date=&order_status=&order_by=order&salon_id=18695&query_type=1&query=&brand_id=1637
GROUPBUY_PAGE_SIZE=100
GROUPBUY_MAX_PAGE=100
GROUPBUY_SESSION_TOKEN=从浏览器拼团接口 curl 中复制 session_token
GROUPBUY_ORDER_STATUS_VALUES=,100
GROUPBUY_SUCCESS_ORDER_STATUS_VALUES=100
GROUPBUY_EFFECTIVE_ORDER_STATUS_VALUES=7,200
```

如果接口字段和默认识别字段不一致，可以在 `.env` 中覆盖字段映射，例如：

```bash
GROUPBUY_LIST_PATH=response.data
GROUPBUY_TITLE_FIELD=groupbuy_record.title,title,goods_name,activity_title
GROUPBUY_STATUS_FIELD=order_status_text,status_text,pay_status_text,refund_status_text,after_sale_status_text,pay_status,refund_status,after_sale_status
GROUPBUY_INVALID_ORDER_STATUS_VALUES=0,-1,closed,cancel,canceled,交易关闭,退款完成,退款成功,已退款,退款关闭
GROUPBUY_EFFECTIVE_ORDER_STATUS_VALUES=7,200
GROUPBUY_CLOSED_STATUS_VALUES=交易关闭,退款完成,退款成功,已退款,退款关闭,已关闭,0,-1
GROUPBUY_AMOUNT_UNIT=cent
```

### 独立部署

这个榜单可以独立部署成一个 Node.js Web 服务。

刷新机制：

- 进入页面时，浏览器会请求 `/api/groupbuy` 拉一次最新数据
- 点击页面右上角「刷新数据」时，会再次请求 `/api/groupbuy`
- 后端每次请求都会实时调用拼团接口，不读旧缓存

部署时不能只部署 `web/groupbuy-board.html` 静态文件，因为真实 `token` / `session_token` 不能暴露给浏览器，必须通过 `scripts/groupbuy-board-server.mjs` 这个后端代理拉数据。

服务器环境变量示例：

```bash
MG_SALON_ACCOUNT=绑定推送同一套门店账号
MG_SALON_PASSWORD=绑定推送同一套门店密码
GROUPBUY_SESSION_TOKEN=从浏览器拼团接口 curl 中复制 session_token
GROUPBUY_BOARD_HOST=0.0.0.0
GROUPBUY_BOARD_PORT=8787
```

启动：

```bash
npm run groupbuy:board
```

部署后访问：

```text
http://服务器IP或域名:8787/groupbuy
```

如果 `session_token` 过期，页面会提示需要更新 `GROUPBUY_SESSION_TOKEN`。重新从浏览器 Network 复制最新拼团接口 curl 里的 `session_token`，更新服务器环境变量后重启服务即可。

### 稳定性策略

为了避免客户使用时遇到“早上有数据，下午突然空白”，服务端做了几件保护：

- 上游接口请求默认 25 秒超时，可用 `UPSTREAM_TIMEOUT_MS` 调整
- 拼团和绑定接口最近一次成功结果会缓存在内存中
- 如果上游接口临时失败或 `session_token` 过期，页面会展示最近一次成功缓存，并明确提示“当前为缓存数据”
- `/healthz` 可用于 Nginx、systemd 或人工巡检确认 Node 服务还活着
- 接口业务错误会区分授权过期、上游错误、请求超时，不再只显示泛泛的 500

建议生产环境配置：

```bash
BOARD_SESSION_TTL_HOURS=12
UPSTREAM_TIMEOUT_MS=25000
BOARD_STALE_CACHE_TTL_MINUTES=720
GROUPBUY_BOARD_HOST=127.0.0.1
GROUPBUY_BOARD_PORT=8787
```

如果页面提示 `GROUPBUY_SESSION_TOKEN` 可能过期：

1. 用门店后台浏览器重新打开拼团订单接口
2. 从 Network 的请求 URL 里复制最新 `session_token`
3. 更新服务器 `/opt/hengyi-meiyuan-data/.env`
4. 重启服务：

```bash
sudo systemctl restart hengyi-groupbuy-board
```

### 阿里云 ECS 部署建议

推荐部署形态：

```text
用户浏览器 -> Nginx 80/443 -> Node 127.0.0.1:8787
```

项目内已提供四个模板：

- `deploy/hengyi-groupbuy-board.service`：systemd 服务，负责开机自启、异常重启、写日志
- `deploy/hengyi-binding-push.service`：systemd 单次推送任务，负责执行每日绑定数据播报
- `deploy/hengyi-binding-push.timer`：systemd 定时器，默认每天 20:00 触发推送
- `deploy/nginx-hengyi-groupbuy-board.conf`：Nginx 反向代理配置

服务器目录示例：

```bash
sudo mkdir -p /opt/hengyi-meiyuan-data
sudo cp -R . /opt/hengyi-meiyuan-data
cd /opt/hengyi-meiyuan-data
sudo cp .env.example .env
sudo vim .env
```

`.env` 填好后安装看板服务和定时推送：

```bash
sudo bash scripts/install-systemd.sh
```

如果不用安装脚本，也可以手动执行：

```bash
sudo cp deploy/hengyi-groupbuy-board.service /etc/systemd/system/hengyi-groupbuy-board.service
sudo cp deploy/hengyi-binding-push.service /etc/systemd/system/hengyi-binding-push.service
sudo cp deploy/hengyi-binding-push.timer /etc/systemd/system/hengyi-binding-push.timer
sudo systemctl daemon-reload
sudo systemctl enable --now hengyi-groupbuy-board
sudo systemctl enable --now hengyi-binding-push.timer
sudo systemctl status hengyi-groupbuy-board
sudo systemctl list-timers --all hengyi-binding-push.timer
```

查看服务日志：

```bash
sudo journalctl -u hengyi-groupbuy-board -f
sudo tail -f /var/log/hengyi-groupbuy-board.log
sudo tail -f /var/log/hengyi-groupbuy-board.error.log
```

### 阿里云定时推送

部署到阿里云后，绑定数据推送不再依赖你本机开机。只要 ECS 正常运行，`hengyi-binding-push.timer` 会每天触发 `hengyi-binding-push.service`。

默认推送时间是服务器时间每天 20:00。建议先把服务器时区设为上海：

```bash
timedatectl
sudo timedatectl set-timezone Asia/Shanghai
```

手动试跑一次正式推送：

```bash
sudo systemctl start hengyi-binding-push.service
```

只看最近一次推送结果：

```bash
sudo journalctl -u hengyi-binding-push.service -n 100 --no-pager
sudo tail -n 100 /var/log/hengyi-binding-push.log
sudo tail -n 100 /var/log/hengyi-binding-push.error.log
```

查看下一次什么时候推送：

```bash
sudo systemctl list-timers --all hengyi-binding-push.timer
```

修改推送时间：

```bash
sudo vim /etc/systemd/system/hengyi-binding-push.timer
sudo systemctl daemon-reload
sudo systemctl restart hengyi-binding-push.timer
```

如果只想推总览 + TOP10，把 `/etc/systemd/system/hengyi-binding-push.service` 里的 `ExecStart` 改成：

```text
ExecStart=/usr/bin/node /opt/hengyi-meiyuan-data/scripts/push-binding-stats.mjs --top10-only
```

然后执行：

```bash
sudo systemctl daemon-reload
```

部署 Nginx 后检查：

```bash
curl http://127.0.0.1:8787/healthz
curl http://服务器IP/healthz
```
