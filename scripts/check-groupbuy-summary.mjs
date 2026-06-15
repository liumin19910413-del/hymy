#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

await loadDotEnv(path.join(projectRoot, ".env"));

const env = process.env;
const dataUrl =
  env.GROUPBUY_DATA_URL ||
  "https://api-sy-z1.meimeifa.com/salon/order/mall/groupbuy/get?page=1&page_size=100&begin_date=&end_date=&order_status=&order_by=order&salon_id=18695&query_type=1&query=&brand_id=1637";

if (!env.GROUPBUY_TOKEN || !env.GROUPBUY_SESSION_TOKEN) {
  throw new Error("缺少 GROUPBUY_TOKEN 或 GROUPBUY_SESSION_TOKEN。");
}

function dateKey(value) {
  if (!value) return "";
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    const number = Number(value);
    const date = new Date(String(value).length === 13 ? number : number * 1000);
    return date.toLocaleDateString("en-CA");
  }
  const match = String(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return match
    ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`
    : "";
}

function maskPhone(value) {
  return String(value || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function isEffectiveOrder(order) {
  const effectiveValues = String(env.GROUPBUY_EFFECTIVE_ORDER_STATUS_VALUES || "7,200")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const invalidValues = new Set(
    String(
      env.GROUPBUY_INVALID_ORDER_STATUS_VALUES ||
        "0,-1,closed,cancel,canceled,交易关闭,退款完成,退款成功,已退款,退款关闭"
    )
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
  const statusText = `${order.status_text || ""}${order.refund_status_text || ""}`;
  return (
    !order.refund_time &&
    Number(order.refund_amount || 0) === 0 &&
    (effectiveValues.length === 0 || effectiveValues.includes(String(order.status).toLowerCase())) &&
    !invalidValues.has(String(order.status).toLowerCase()) &&
    !statusText.includes("退款") &&
    !statusText.includes("关闭")
  );
}

function orderDate(order) {
  return order.pay_time || order.paid_at || order.created_at || order.create_time || "";
}

function orderAmount(order) {
  return Number(order.pay_price ?? order.paid_amount ?? order.order_amount ?? order.total_price ?? 0) / 100;
}

async function loadDotEnv(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function fetchRows(orderStatus) {
  const rows = [];
  const pageSize = Number(env.GROUPBUY_PAGE_SIZE || 100);
  const maxPage = Number(env.GROUPBUY_MAX_PAGE || 100);

  for (let page = 1; page <= maxPage; page += 1) {
    const url = new URL(dataUrl);
    url.searchParams.set("order_status", orderStatus);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(pageSize));
    url.searchParams.set("token", env.GROUPBUY_TOKEN);
    url.searchParams.set("session_token", env.GROUPBUY_SESSION_TOKEN);

    const response = await fetch(url, {
      headers: {
        accept: "application/json, text/plain, */*",
        origin: "https://sy-z1.meimeifa.com",
        referer: "https://sy-z1.meimeifa.com/"
      }
    });
    const data = await response.json();
    if (!response.ok || data.code !== 1) {
      throw new Error(`拼团接口失败：HTTP ${response.status} ${data.msg || ""}`.trim());
    }
    const payload = data.response || {};
    for (const row of payload.data || []) rows.push({ ...row, __queryOrderStatus: orderStatus });
    if (rows.length >= payload.total || page >= payload.last_page) break;
  }

  return rows;
}

const reportDate = env.REPORT_DATE || new Date().toLocaleDateString("en-CA");
const keyword = env.GROUPBUY_TITLE_KEYWORD || "牙膏";
const rowsById = new Map();

for (const orderStatus of String(env.GROUPBUY_ORDER_STATUS_VALUES || ",100").split(",")) {
  for (const row of await fetchRows(orderStatus.trim())) {
    const key = String(row.groupbuy_record?.id || row.id || JSON.stringify(row.groupbuy_record || row));
    const current = rowsById.get(key);
    if (current) {
      current.__queryOrderStatuses = [
        ...new Set([...(current.__queryOrderStatuses || [current.__queryOrderStatus]), row.__queryOrderStatus])
      ];
    } else {
      row.__queryOrderStatuses = [row.__queryOrderStatus];
      rowsById.set(key, row);
    }
  }
}

const groups = [];
const statusBreakdown = {};

for (const row of rowsById.values()) {
  const record = row.groupbuy_record || {};
  if (!String(record.title || "").includes(keyword)) continue;

  const effectiveOrders = (row.orders || []).filter(
    (order) => dateKey(orderDate(order)) === reportDate && isEffectiveOrder(order)
  );
  for (const order of row.orders || []) {
    if (dateKey(orderDate(order)) !== reportDate) continue;
    const key = String(order.status ?? "unknown");
    const item =
      statusBreakdown[key] || {
        count: 0,
        noRefundCount: 0,
        amount: 0
      };
    item.count += 1;
    if (!order.refund_time && Number(order.refund_amount || 0) === 0) {
      item.noRefundCount += 1;
      item.amount += orderAmount(order);
    }
    statusBreakdown[key] = item;
  }
  if (effectiveOrders.length === 0) continue;

  const leaderOrder = (row.orders || []).find((order) => order.is_groupbuy_leader) || (row.orders || [])[0] || {};
  const member = leaderOrder.member || {};
  const contact = leaderOrder.contact || {};
  const leaderName = member.name || member.nickname || contact.name || "未命名团长";
  const leaderPhone =
    member.handset || member.mobile || member.phone || contact.handset || contact.mobile || contact.phone || "";
  const targetCount = Number(record.join_num || 0);
  const isSuccess =
    Number(record.status) === 100 || (row.__queryOrderStatuses || []).includes("100") || Boolean(record.completed_at);

  groups.push({
    leaderName,
    leaderPhoneMasked: maskPhone(leaderPhone),
    title: record.title,
    effectiveOrders: effectiveOrders.length,
    amount: effectiveOrders.reduce((sum, order) => sum + orderAmount(order), 0),
    targetCount,
    remaining: isSuccess ? 0 : Math.max(targetCount - effectiveOrders.length, 0),
    isSuccess
  });
}

const succeeded = groups
  .filter((group) => group.isSuccess)
  .sort((a, b) => b.effectiveOrders - a.effectiveOrders || b.amount - a.amount);
const pending = groups
  .filter((group) => !group.isSuccess)
  .sort((a, b) => a.remaining - b.remaining || b.effectiveOrders - a.effectiveOrders || b.amount - a.amount);

console.log(
  JSON.stringify(
    {
      date: reportDate,
      keyword,
      totalGroups: groups.length,
      successGroups: succeeded.length,
      pendingGroups: pending.length,
      effectiveOrders: groups.reduce((sum, group) => sum + group.effectiveOrders, 0),
      effectiveAmount: Number(groups.reduce((sum, group) => sum + group.amount, 0).toFixed(2)),
      successOrders: succeeded.reduce((sum, group) => sum + group.effectiveOrders, 0),
      successAmount: Number(succeeded.reduce((sum, group) => sum + group.amount, 0).toFixed(2)),
      pendingRemaining: pending.reduce((sum, group) => sum + group.remaining, 0),
      statusBreakdown: Object.fromEntries(
        Object.entries(statusBreakdown).map(([status, item]) => [
          status,
          {
            count: item.count,
            noRefundCount: item.noRefundCount,
            amount: Number(item.amount.toFixed(2))
          }
        ])
      ),
      successLeaders: succeeded.map((group) => group.leaderName),
      pendingTop10: pending.slice(0, 10).map((group) => ({
        name: group.leaderName,
        phone: group.leaderPhoneMasked,
        effectiveOrders: group.effectiveOrders,
        amount: Number(group.amount.toFixed(2)),
        remain: group.remaining
      }))
    },
    null,
    2
  )
);
