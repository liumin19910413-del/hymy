#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

await loadDotEnv(path.join(projectRoot, ".env"));

const env = process.env;
const port = Number(env.GROUPBUY_BOARD_PORT || 8787);
const host = env.GROUPBUY_BOARD_HOST || "127.0.0.1";
const sessionCookieName = "hy_board_session";
const sessionTtlMs = Number(env.BOARD_SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;
const requestTimeoutMs = Number(env.UPSTREAM_TIMEOUT_MS || 25000);
const staleCacheTtlMs = Number(env.BOARD_STALE_CACHE_TTL_MINUTES || 12 * 60) * 60 * 1000;
const sessions = new Map();
const boardCache = new Map();
const defaultDataUrl =
  "https://api-sy-z1.meimeifa.com/salon/order/mall/groupbuy/get?page=1&page_size=100&begin_date=&end_date=&order_status=&order_by=order&salon_id=18695&query_type=1&query=&brand_id=1637";

class AppError extends Error {
  constructor(message, status = 500, details = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.details = details;
  }
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

function getByPath(input, dottedPath) {
  if (!dottedPath) return undefined;
  return dottedPath.split(".").reduce((current, key) => {
    if (current == null) return undefined;
    if (/^\d+$/.test(key)) return current[Number(key)];
    return current[key];
  }, input);
}

function firstValue(input, paths) {
  for (const field of paths) {
    const value = getByPath(input, field);
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}

function fieldList(envName, defaults) {
  return String(env[envName] || defaults.join(","))
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const candidate of ["list", "records", "data", "items", "rows"]) {
      if (Array.isArray(value[candidate])) return value[candidate];
    }
  }
  return [];
}

function getRows(payload) {
  return asArray(
    getByPath(payload, env.GROUPBUY_LIST_PATH || "response.data") ||
      getByPath(payload, "data.list")
  );
}

function parseNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const number = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : fallback;
}

function withTimeout(options = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    options: {
      ...options,
      signal: controller.signal
    },
    done: () => clearTimeout(timeout)
  };
}

function upstreamMessage(payload, fallback = "接口返回异常") {
  return String(payload?.msg || payload?.message || payload?.error || fallback);
}

function isAuthExpiredMessage(text) {
  return /session_token|token|登录|授权|过期|失效|invalid|unauthor/i.test(String(text || ""));
}

function cacheKey(name, input = {}) {
  return `${name}:${JSON.stringify(input)}`;
}

function setCachedBoard(key, board) {
  boardCache.set(key, {
    board,
    cachedAt: Date.now()
  });
}

function cachedBoardOnFailure(key, error) {
  const item = boardCache.get(key);
  if (!item) return null;
  if (Date.now() - item.cachedAt > staleCacheTtlMs) return null;
  return {
    ...item.board,
    stale: true,
    staleReason: error.message || String(error),
    cachedAt: new Date(item.cachedAt).toISOString(),
    cachedAtText: new Date(item.cachedAt).toLocaleString("zh-CN", { hour12: false })
  };
}

function formatDateKey(value) {
  if (!value) return "";
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    const number = Number(value);
    const date = new Date(String(value).length === 13 ? number : number * 1000);
    if (Number.isNaN(date.getTime())) return "";
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }
  const text = String(value).trim();
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function todayKey() {
  return formatDateKey(new Date());
}

function monthStartKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    "01"
  ].join("-");
}

function dateRangeFromSearch(searchParams = new URLSearchParams()) {
  const beginDate = String(searchParams.get("begin_date") || searchParams.get("start") || env.GROUPBUY_BEGIN_DATE || monthStartKey()).trim();
  const endDate = String(searchParams.get("end_date") || searchParams.get("end") || env.GROUPBUY_END_DATE || todayKey()).trim();
  const keyword = String(searchParams.get("keyword") || searchParams.get("q") || env.GROUPBUY_DEFAULT_KEYWORD || "").trim();
  return {
    beginDate,
    endDate,
    keyword
  };
}

function isDateInRange(value, beginDate, endDate) {
  const dateKey = formatDateKey(value);
  if (!dateKey) return false;
  return (!beginDate || dateKey >= beginDate) && (!endDate || dateKey <= endDate);
}

function maskPhone(value) {
  const text = String(value || "").trim();
  if (!text) return "未知";
  return text.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function amountFromOrder(order) {
  const value = firstValue(order, fieldList("GROUPBUY_AMOUNT_FIELD", [
    "pay_amount",
    "paid_amount",
    "order_amount",
    "amount",
    "total_amount",
    "price"
  ]));
  const amount = parseNumber(value, 0);
  return (env.GROUPBUY_AMOUNT_UNIT || "yuan") === "cent" ? amount / 100 : amount;
}

function groupbuyTitle(order) {
  return String(
    firstValue(order, fieldList("GROUPBUY_TITLE_FIELD", [
      "title",
      "activity_title",
      "groupbuy_title",
      "goods_title",
      "goods_name",
      "product_name",
      "item_name"
    ])) || ""
  );
}

function matchesKeyword(title, keyword) {
  if (!keyword) return true;
  return String(title || "").toLowerCase().includes(String(keyword).toLowerCase());
}

function containsKeyword(order, keyword) {
  const title = String(
    firstValue(order, fieldList("GROUPBUY_TITLE_FIELD", [
      "title",
      "activity_title",
      "groupbuy_title",
      "goods_title",
      "goods_name",
      "product_name",
      "item_name"
    ])) || ""
  );
  return matchesKeyword(title, keyword);
}

function isTodayOrder(order, reportDate) {
  const value = firstValue(order, fieldList("GROUPBUY_DATE_FIELD", [
    "pay_time",
    "paid_at",
    "created_at",
    "create_time",
    "createdAt",
    "order_time"
  ]));
  return formatDateKey(value) === reportDate;
}

function statusValue(order) {
  return String(
    firstValue(order, fieldList("GROUPBUY_STATUS_FIELD", [
      "order_status_text",
      "status_text",
      "pay_status_text",
      "refund_status_text",
      "after_sale_status_text",
      "order_status",
      "status",
      "pay_status",
      "refund_status",
      "after_sale_status"
    ])) || ""
  ).trim();
}

function isClosedOrder(order) {
  const value = statusValue(order);
  const closedValues = String(
    env.GROUPBUY_CLOSED_STATUS_VALUES ||
      "交易关闭,退款完成,退款成功,已退款,退款关闭,已关闭,关闭,closed,cancel,canceled,refunded,refund_success,refund_finished,0,-1"
  )
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return (
    closedValues.includes(value.toLowerCase()) ||
    value.includes("交易关闭") ||
    value.includes("退款完成") ||
    value.includes("退款成功") ||
    value.includes("已退款") ||
    value.includes("退款关闭")
  );
}

function isPaidOrder(order) {
  if (isClosedOrder(order)) return false;
  const value = statusValue(order);
  const paidValues = String(env.GROUPBUY_PAID_STATUS_VALUES || "1,2,paid,paid_success,success,支付成功,已支付")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return paidValues.includes(value.toLowerCase()) || value.includes("支付成功") || value.includes("已支付");
}

function normalizeOrder(order) {
  const leaderName =
    firstValue(order, fieldList("GROUPBUY_LEADER_NAME_FIELD", [
      "leader_name",
      "head_name",
      "captain_name",
      "nickname",
      "user_name",
      "name",
      "customer_name"
    ])) || "未命名团长";
  const leaderPhone =
    firstValue(order, fieldList("GROUPBUY_LEADER_PHONE_FIELD", [
      "leader_phone",
      "head_phone",
      "mobile",
      "phone",
      "handset",
      "tel",
      "customer_phone"
    ])) || "";
  const groupId =
    firstValue(order, fieldList("GROUPBUY_GROUP_ID_FIELD", [
      "group_id",
      "groupbuy_id",
      "team_id",
      "activity_order_id",
      "id",
      "order_id"
    ])) || `${leaderName}-${leaderPhone}`;
  const title = groupbuyTitle(order);
  const createdAt =
    firstValue(order, fieldList("GROUPBUY_DATE_FIELD", [
      "pay_time",
      "paid_at",
      "created_at",
      "create_time",
      "createdAt",
      "order_time"
    ])) || "";
  const targetCount = parseNumber(
    firstValue(order, fieldList("GROUPBUY_TARGET_COUNT_FIELD", [
      "group_num",
      "group_count",
      "target_count",
      "need_num",
      "team_num",
      "success_num"
    ])),
    Number(env.GROUPBUY_DEFAULT_TARGET_COUNT || 0)
  );
  const joinedCount = parseNumber(
    firstValue(order, fieldList("GROUPBUY_JOINED_COUNT_FIELD", [
      "join_num",
      "joined_count",
      "current_count",
      "paid_count",
      "buy_num",
      "order_count"
    ])),
    1
  );
  const remaining = Math.max(
    parseNumber(
      firstValue(order, fieldList("GROUPBUY_REMAINING_COUNT_FIELD", [
        "remain_num",
        "remaining_count",
        "lack_num",
        "diff_num"
      ])),
      targetCount > 0 ? targetCount - joinedCount : 0
    ),
    0
  );
  const groupStatus = String(
    firstValue(order, fieldList("GROUPBUY_GROUP_STATUS_FIELD", [
      "group_status_text",
      "group_status",
      "is_success",
      "is_group_success",
      "status_text"
    ])) || ""
  );
  const isSuccess =
    remaining === 0 ||
    groupStatus.includes("已成团") ||
    groupStatus.includes("成团成功") ||
    ["1", "success", "succeeded", "true"].includes(groupStatus.toLowerCase());

  return {
    groupId: String(groupId),
    leaderName: String(leaderName).trim(),
    leaderPhone: String(leaderPhone).trim(),
    leaderPhoneMasked: maskPhone(leaderPhone),
    title: String(title).trim(),
    createdAt: String(createdAt).trim(),
    targetCount,
    joinedCount,
    remaining,
    isSuccess,
    amount: amountFromOrder(order),
    rawStatus: statusValue(order)
  };
}

function groupOrders(rows) {
  const groups = new Map();
  for (const row of rows) {
    const order = normalizeOrder(row);
    const current =
      groups.get(order.groupId) || {
        groupId: order.groupId,
        leaderName: order.leaderName,
        leaderPhone: order.leaderPhone,
        leaderPhoneMasked: order.leaderPhoneMasked,
        title: order.title,
        createdAt: order.createdAt,
        targetCount: order.targetCount,
        joinedCount: 0,
        paidOrders: 0,
        amount: 0,
        remaining: order.remaining,
        isSuccess: false,
        rawStatus: order.rawStatus
      };
    current.joinedCount = Math.max(current.joinedCount, order.joinedCount);
    current.targetCount = Math.max(current.targetCount, order.targetCount);
    current.remaining = Math.min(current.remaining, order.remaining);
    current.isSuccess = current.isSuccess || order.isSuccess;
    current.paidOrders += 1;
    current.amount += order.amount;
    groups.set(order.groupId, current);
  }

  return [...groups.values()].map((group) => {
    const computedRemaining =
      group.targetCount > 0 ? Math.max(group.targetCount - group.paidOrders, 0) : group.remaining;
    return {
      ...group,
      joinedCount: Math.max(group.joinedCount, group.paidOrders),
      remaining: group.isSuccess ? 0 : Math.max(group.remaining || computedRemaining, 0)
    };
  });
}

function buildSpuGroups(groups) {
  const spuMap = new Map();
  for (const group of groups) {
    const title = group.title || "未命名拼团商品";
    const current =
      spuMap.get(title) || {
        spuId: title,
        title,
        totalGroups: 0,
        successGroups: 0,
        pendingGroups: 0,
        totalOrders: 0,
        totalAmount: 0,
        pendingRemaining: 0
      };
    current.totalGroups += 1;
    current.successGroups += group.isSuccess ? 1 : 0;
    current.pendingGroups += group.isSuccess ? 0 : 1;
    current.totalOrders += group.paidOrders;
    current.totalAmount += group.amount;
    current.pendingRemaining += group.isSuccess ? 0 : group.remaining;
    spuMap.set(title, current);
  }

  return [...spuMap.values()]
    .map((item) => ({
      ...item,
      successRate: item.totalGroups > 0 ? item.successGroups / item.totalGroups : 0
    }))
    .sort((a, b) => b.totalOrders - a.totalOrders || b.totalAmount - a.totalAmount);
}

function boardBase(filters) {
  const beginDate = filters.beginDate || monthStartKey();
  const endDate = filters.endDate || todayKey();
  return {
    generatedAt: new Date().toISOString(),
    generatedAtText: new Date().toLocaleString("zh-CN", { hour12: false }),
    reportDate: beginDate === endDate ? beginDate : `${beginDate} 至 ${endDate}`,
    beginDate,
    endDate,
    keyword: filters.keyword || "",
    filters: {
      beginDate,
      endDate,
      keyword: filters.keyword || ""
    }
  };
}

function buildBoard(payload, filters = dateRangeFromSearch()) {
  const allRows = getRows(payload);
  if (allRows.some((row) => row?.groupbuy_record && Array.isArray(row?.orders))) {
    return buildNestedGroupbuyBoard(allRows, filters);
  }
  const rows = allRows.filter(
    (row) =>
      isDateInRange(
        firstValue(row, fieldList("GROUPBUY_DATE_FIELD", [
          "pay_time",
          "paid_at",
          "created_at",
          "create_time",
          "createdAt",
          "order_time"
        ])),
        filters.beginDate,
        filters.endDate
      ) &&
      containsKeyword(row, filters.keyword) &&
      isPaidOrder(row)
  );
  const groups = groupOrders(rows);
  const succeeded = groups
    .filter((group) => group.isSuccess)
    .sort((a, b) => b.paidOrders - a.paidOrders || b.amount - a.amount);
  const pending = groups
    .filter((group) => !group.isSuccess)
    .sort((a, b) => a.remaining - b.remaining || b.paidOrders - a.paidOrders || b.amount - a.amount);
  const totalAmount = groups.reduce((sum, group) => sum + group.amount, 0);
  const successAmount = succeeded.reduce((sum, group) => sum + group.amount, 0);
  const totalOrders = groups.reduce((sum, group) => sum + group.paidOrders, 0);
  const successOrders = succeeded.reduce((sum, group) => sum + group.paidOrders, 0);
  const pendingRemaining = pending.reduce((sum, group) => sum + group.remaining, 0);

  return {
    ...boardBase(filters),
    sourceRows: allRows.length,
    matchedRows: rows.length,
    summary: {
      totalGroups: groups.length,
      successGroups: succeeded.length,
      pendingGroups: pending.length,
      totalOrders,
      successOrders,
      totalAmount,
      successAmount,
      pendingRemaining,
      successRate: groups.length > 0 ? succeeded.length / groups.length : 0,
      successLeaderNames: succeeded.map((group) => group.leaderName)
    },
    spuGroups: buildSpuGroups(groups),
    pendingTop10: pending.slice(0, Number(env.GROUPBUY_PENDING_PUSH_LIMIT || 10)),
    pending,
    succeeded,
    all: [...pending, ...succeeded]
  };
}

function nestedOrderDate(order) {
  return order.pay_time || order.paid_at || order.created_at || order.create_time || "";
}

function isRefundedNestedOrder(order) {
  return (
    Boolean(order.refund_time) ||
    parseNumber(order.refund_amount, 0) > 0 ||
    String(order.status_text || "").includes("退款") ||
    String(order.refund_status_text || "").includes("退款")
  );
}

function isEffectiveNestedOrder(order) {
  if (isRefundedNestedOrder(order)) return false;
  const effectiveValues = String(env.GROUPBUY_EFFECTIVE_ORDER_STATUS_VALUES || "7,200")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (effectiveValues.length > 0) {
    return effectiveValues.includes(String(order.status).toLowerCase());
  }
  const invalidValues = String(
    env.GROUPBUY_INVALID_ORDER_STATUS_VALUES ||
      "0,-1,closed,cancel,canceled,交易关闭,退款完成,退款成功,已退款,退款关闭"
  )
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return !invalidValues.includes(String(order.status).toLowerCase());
}

function nestedOrderAmount(order) {
  const value = order.pay_price ?? order.paid_amount ?? order.order_amount ?? order.total_price ?? 0;
  const amount = parseNumber(value, 0);
  return (env.GROUPBUY_AMOUNT_UNIT || "cent") === "yuan" ? amount : amount / 100;
}

function nestedLeaderInfo(orders) {
  const leader = orders.find((order) => Boolean(order.is_groupbuy_leader)) || orders[0] || {};
  const member = leader.member || {};
  const contact = leader.contact || {};
  const phone = member.handset || member.mobile || member.phone || contact.handset || contact.mobile || contact.phone || "";
  return {
    name: member.name || member.nickname || contact.name || "未命名团长",
    phone: String(phone || "")
  };
}

function buildNestedGroupbuyBoard(allRows, filters) {
  const keyword = filters.keyword || "";
  const groups = [];

  for (const row of allRows) {
    const record = row.groupbuy_record || {};
    const title = String(record.title || "");
    if (!matchesKeyword(title, keyword)) continue;

    const effectiveOrders = (row.orders || []).filter(
      (order) =>
        isDateInRange(nestedOrderDate(order), filters.beginDate, filters.endDate) &&
        isEffectiveNestedOrder(order)
    );
    if (effectiveOrders.length === 0) continue;

    const leader = nestedLeaderInfo(row.orders || []);
    const targetCount = parseNumber(record.join_num, 0);
    const joinedCount = effectiveOrders.length;
    const amount = effectiveOrders.reduce((sum, order) => sum + nestedOrderAmount(order), 0);
    const isSuccess =
      isSuccessQueryRow(row) ||
      Boolean(record.completed_at) ||
      Number(record.status) === 100 ||
      Number(record.status) === 1 ||
      (targetCount > 0 && parseNumber(record.join_count, joinedCount) >= targetCount);
    const remaining = isSuccess ? 0 : Math.max(targetCount - joinedCount, 0);
    const createdAt = effectiveOrders
      .map((order) => nestedOrderDate(order))
      .filter(Boolean)
      .sort((a, b) => Number(a) - Number(b))[0];

    groups.push({
      groupId: String(record.id || row.id || `${leader.name}-${leader.phone}-${title}`),
      leaderName: String(leader.name || "未命名团长").trim(),
      leaderPhone: leader.phone,
      leaderPhoneMasked: maskPhone(leader.phone),
      title,
      createdAt: formatDateTime(createdAt),
      targetCount,
      joinedCount,
      paidOrders: effectiveOrders.length,
      amount,
      remaining,
      isSuccess,
      rawStatus: String(record.status ?? "")
    });
  }

  const succeeded = groups
    .filter((group) => group.isSuccess)
    .sort((a, b) => b.paidOrders - a.paidOrders || b.amount - a.amount);
  const pending = groups
    .filter((group) => !group.isSuccess)
    .sort((a, b) => a.remaining - b.remaining || b.paidOrders - a.paidOrders || b.amount - a.amount);
  const totalAmount = groups.reduce((sum, group) => sum + group.amount, 0);
  const successAmount = succeeded.reduce((sum, group) => sum + group.amount, 0);
  const totalOrders = groups.reduce((sum, group) => sum + group.paidOrders, 0);
  const successOrders = succeeded.reduce((sum, group) => sum + group.paidOrders, 0);
  const pendingRemaining = pending.reduce((sum, group) => sum + group.remaining, 0);

  return {
    ...boardBase(filters),
    sourceRows: allRows.length,
    matchedRows: groups.length,
    summary: {
      totalGroups: groups.length,
      successGroups: succeeded.length,
      pendingGroups: pending.length,
      totalOrders,
      successOrders,
      totalAmount,
      successAmount,
      pendingRemaining,
      successRate: groups.length > 0 ? succeeded.length / groups.length : 0,
      successLeaderNames: succeeded.map((group) => group.leaderName)
    },
    spuGroups: buildSpuGroups(groups),
    pendingTop10: pending.slice(0, Number(env.GROUPBUY_PENDING_PUSH_LIMIT || 10)),
    pending,
    succeeded,
    all: [...pending, ...succeeded]
  };
}

function isSuccessQueryRow(row) {
  const queryStatuses = Array.isArray(row.__queryOrderStatuses)
    ? row.__queryOrderStatuses
    : [row.__queryOrderStatus];
  const successValues = String(env.GROUPBUY_SUCCESS_ORDER_STATUS_VALUES || "100,success,completed,已成团")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return queryStatuses.some((status) => successValues.includes(String(status || "").toLowerCase()));
}

function formatDateTime(value) {
  if (!value) return "";
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    const number = Number(value);
    const date = new Date(String(value).length === 13 ? number : number * 1000);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("zh-CN", { hour12: false });
  }
  return String(value);
}

function groupbuyApiDateTime(dateKey, endOfDay = false) {
  const normalized = formatDateKey(dateKey);
  if (!normalized) return "";
  return `${normalized} ${endOfDay ? "23:59:59" : "00:00:00"}`;
}

function parseJson(text, message) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error(message);
  }
}

async function loginBySalonCli() {
  if ((env.GROUPBUY_DATA_LOGIN || "salon") !== "salon") return {};
  if (!env.MG_SALON_ACCOUNT || !env.MG_SALON_PASSWORD) {
    throw new Error("缺少绑定推送同一套 MG_SALON_ACCOUNT 或 MG_SALON_PASSWORD，无法登录拼团数据源。");
  }
  const { stdout } = await execFileAsync(
    "npx",
    ["-y", "yz-mg-cli@latest", "salon-login", "--field", "all"],
    {
      env: process.env,
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 5
    }
  );
  return parseJson(stdout, "salon-login 返回不是 JSON。");
}

async function verifySalonAccount(account, password) {
  if (!account || !password) {
    throw new Error("请输入门店系统账号和密码。");
  }
  const { stdout } = await execFileAsync(
    "npx",
    ["-y", "yz-mg-cli@latest", "salon-login", "--field", "all"],
    {
      env: {
        ...process.env,
        MG_SALON_ACCOUNT: account,
        MG_SALON_PASSWORD: password
      },
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 5
    }
  );
  const login = parseJson(stdout, "门店系统登录返回不是 JSON。");
  const token = loginValue(login, ["token", "access_token", "accessToken", "response.token"]);
  const sessionToken = loginValue(login, ["session_token", "sessionToken", "response.session_token", "response.sessionToken"]);
  const message = String(login?.msg || login?.message || login?.error || "");
  if (!token && !sessionToken && /失败|错误|无效|密码|账号|error|invalid/i.test(message)) {
    throw new Error(message || "门店系统账号或密码校验失败。");
  }
  return {
    account,
    token,
    accessToken: token,
    sessionToken,
    salonId: loginValue(login, [
      "salon_id",
      "salonId",
      "response.user.last_login_salon_id",
      "response.staff.salon_id",
      "response.salons.0.salon_id"
    ]),
    brandId: loginValue(login, [
      "brand_id",
      "brandId",
      "response.user.brand_id",
      "response.staff.brand_id",
      "response.brands.0.brand_id"
    ]),
    zoneId: loginValue(login, ["zone_id", "zoneId", "response.zone_id", "response.zoneId"])
  };
}

function loginValue(login, names) {
  for (const name of names) {
    const value =
      getByPath(login, name) ||
      login?.[name] ||
      login?.response?.[name] ||
      login?.data?.[name];
    if (value) return value;
  }
  return "";
}

function searchParamFromUrl(urlText, name) {
  try {
    return new URL(urlText).searchParams.get(name) || "";
  } catch {
    return "";
  }
}

function withPage(urlText, page, pageSize, login) {
  const url = new URL(urlText);
  url.searchParams.set(env.GROUPBUY_PAGE_PARAM || "page", String(page));
  url.searchParams.set(env.GROUPBUY_PAGE_SIZE_PARAM || "page_size", String(pageSize));
  if ((env.GROUPBUY_DATA_LOGIN || "salon") === "salon") {
    const token =
      env.GROUPBUY_TOKEN ||
      searchParamFromUrl(env.GROUPBUY_DATA_URL || "", "token") ||
      searchParamFromUrl(env.BINDING_DATA_URL || "", "token") ||
      loginValue(login, ["token", "access_token"]);
    const sessionToken =
      env.GROUPBUY_SESSION_TOKEN ||
      loginValue(login, ["session_token", "sessionToken"]) ||
      searchParamFromUrl(env.GROUPBUY_DATA_URL || "", "session_token") ||
      searchParamFromUrl(env.BINDING_DATA_URL || "", "session_token") ||
      "";
    if (!token) throw new AppError("拼团接口缺少 token，请配置 GROUPBUY_TOKEN 或 BINDING_DATA_URL。", 500);
    if (token) url.searchParams.set("token", token);
    if (sessionToken) url.searchParams.set("session_token", sessionToken);
    url.searchParams.set("_yz_version", env.GROUPBUY_YZ_VERSION || "lite:4.73.3");
  }
  return url.toString();
}

function withOrderStatus(urlText, orderStatus) {
  const url = new URL(urlText);
  url.searchParams.set("order_status", orderStatus);
  return url.toString();
}

function withGroupbuyFilters(urlText, filters) {
  const url = new URL(urlText);
  const beginDate = groupbuyApiDateTime(filters.beginDate, false);
  const endDate = groupbuyApiDateTime(filters.endDate, true);
  if (beginDate) url.searchParams.set("begin_date", beginDate);
  if (endDate) url.searchParams.set("end_date", endDate);
  if ((env.GROUPBUY_PASS_KEYWORD_TO_UPSTREAM || "false") === "true" && filters.keyword) {
    url.searchParams.set("query", filters.keyword);
  }
  return url.toString();
}

async function fetchJson(url, headers) {
  const timeout = withTimeout({
    method: env.GROUPBUY_DATA_METHOD || "GET",
    headers
  });
  try {
    const response = await fetch(url, timeout.options);
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new AppError(`拼团数据源请求失败：HTTP ${response.status} ${text.slice(0, 180)}`, 502);
    }
    if (payload?.code && Number(payload.code) !== 1) {
      const message = upstreamMessage(payload, `code ${payload.code}`);
      const hint = isAuthExpiredMessage(message)
        ? "拼团接口授权可能已过期，请更新 GROUPBUY_SESSION_TOKEN 或重新登录后再试。"
        : "拼团接口返回业务错误，请检查门店、品牌、日期范围和接口参数。";
      throw new AppError(`${hint} 原始提示：${message}`, 502, { upstreamCode: payload.code });
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AppError(`拼团数据源请求超时（${requestTimeoutMs}ms），请稍后重试或检查服务器出网。`, 504);
    }
    throw error;
  } finally {
    timeout.done();
  }
}

function getTotal(payload) {
  for (const candidate of [
    "response.total",
    "data.total",
    "data.total_count",
    "data.count",
    "total",
    "total_count",
    "count"
  ]) {
    const total = parseNumber(getByPath(payload, candidate), undefined);
    if (total !== undefined) return total;
  }
  return undefined;
}

async function fetchPayload(filters = dateRangeFromSearch(), session = {}) {
  if (env.GROUPBUY_DATA_FILE) {
    return JSON.parse(await readFile(path.resolve(projectRoot, env.GROUPBUY_DATA_FILE), "utf8"));
  }

  const login = {
    ...(await loginBySalonCli()),
    token: session.token || session.accessToken,
    access_token: session.accessToken || session.token,
    session_token: session.sessionToken,
    sessionToken: session.sessionToken
  };
  const dataUrl = withGroupbuyFilters(env.GROUPBUY_DATA_URL || defaultDataUrl, filters);
  const headers = {
    accept: "application/json, text/plain, */*",
    origin: "https://sy-z1.meimeifa.com",
    referer: "https://sy-z1.meimeifa.com/"
  };
  const pageSize = Number(env.GROUPBUY_PAGE_SIZE || 100);
  const maxPage = Number(env.GROUPBUY_MAX_PAGE || 100);
  const statusValues = String(env.GROUPBUY_ORDER_STATUS_VALUES || ",100")
    .split(",")
    .map((item) => item.trim())
    .filter((item, index, list) => list.indexOf(item) === index);
  const rowsById = new Map();
  let total = 0;

  for (const orderStatus of statusValues) {
    let statusTotal;
    for (let page = 1; page <= maxPage; page += 1) {
      const payload = await fetchJson(
        withPage(withOrderStatus(dataUrl, orderStatus), page, pageSize, login),
        headers
      );
      const pageRows = getRows(payload).map((row) => ({ ...row, __queryOrderStatus: orderStatus }));
      if (statusTotal === undefined) statusTotal = getTotal(payload);
      for (const row of pageRows) {
        const key = String(row.groupbuy_record?.id || row.id || JSON.stringify(row.groupbuy_record || row));
        const current = rowsById.get(key);
        if (current) {
          current.__queryOrderStatuses = [
            ...new Set([...(current.__queryOrderStatuses || [current.__queryOrderStatus]), orderStatus])
          ];
        } else {
          row.__queryOrderStatuses = [orderStatus];
          rowsById.set(key, row);
        }
      }
      if (pageRows.length === 0) break;
      if (statusTotal !== undefined && page * pageSize >= statusTotal) break;
      if (pageRows.length < pageSize) break;
    }
    total += statusTotal || 0;
  }

  const rows = [...rowsById.values()];
  return { data: { list: rows, total: total || rows.length } };
}

function bindingRows(payload) {
  return asArray(getByPath(payload, env.BINDING_LIST_PATH || "response.data"));
}

function hasPhone(row, phoneFields) {
  return phoneFields.some((field) => {
    const value = getByPath(row, field);
    return value != null && String(value).trim() !== "";
  });
}

function countBindingRows(rows, phoneFields) {
  const phoneObtained = rows.filter((row) => hasPhone(row, phoneFields)).length;
  const totalBindings = rows.length;
  return {
    totalBindings,
    phoneObtained,
    phoneMissing: Math.max(totalBindings - phoneObtained, 0),
    phoneRate: totalBindings > 0 ? phoneObtained / totalBindings : 0
  };
}

function buildBindingBoard(payload) {
  const rows = bindingRows(payload);
  const phoneFields = String(env.BINDING_PHONE_FIELD || "phone,mobile,handset,tel")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const reportDate = env.REPORT_DATE || todayKey();
  const dateField = env.BINDING_DATE_FIELD || "created_at";
  const todayRows = rows.filter((row) => formatDateKey(getByPath(row, dateField)) === reportDate);
  const partnerNameField = env.PARTNER_NAME_FIELD || "retail_store_name";
  const partnerIdField = env.PARTNER_ID_FIELD || "retail_store_id";
  const partnerMap = new Map();

  for (const row of todayRows) {
    const id = getByPath(row, partnerIdField) || getByPath(row, partnerNameField) || "unknown";
    const name = String(getByPath(row, partnerNameField) || "未命名合伙人").trim();
    const current = partnerMap.get(id) || { id, name, rows: [] };
    current.rows.push(row);
    partnerMap.set(id, current);
  }

  const topPartners = [...partnerMap.values()]
    .map((partner) => ({
      id: partner.id,
      name: partner.name,
      ...countBindingRows(partner.rows, phoneFields)
    }))
    .sort((a, b) => b.totalBindings - a.totalBindings || b.phoneObtained - a.phoneObtained)
    .slice(0, Number(env.TOP_PARTNER_LIMIT || 20));

  return {
    generatedAt: new Date().toISOString(),
    generatedAtText: new Date().toLocaleString("zh-CN", { hour12: false }),
    reportDate,
    cumulative: countBindingRows(rows, phoneFields),
    today: countBindingRows(todayRows, phoneFields),
    topPartners,
    sourceRows: rows.length
  };
}

function bindingPayloadRows(payload) {
  return asArray(getByPath(payload, env.BINDING_LIST_PATH || "response.data"));
}

function bindingTotal(payload) {
  for (const candidate of [
    env.BINDING_TOTAL_PATH,
    "response.total",
    "data.total",
    "data.total_count",
    "data.count",
    "total",
    "total_count",
    "count"
  ]) {
    const total = parseNumber(getByPath(payload, candidate), undefined);
    if (total !== undefined) return total;
  }
  return undefined;
}

function bindingAuthContext(session = {}) {
  const token =
    env.BINDING_TOKEN ||
    searchParamFromUrl(env.BINDING_DATA_URL || "", "token") ||
    session.token ||
    session.accessToken;
  const sessionToken =
    env.BINDING_SESSION_TOKEN ||
    searchParamFromUrl(env.BINDING_DATA_URL || "", "session_token") ||
    session.sessionToken;
  const salonId =
    env.BINDING_SALON_ID ||
    searchParamFromUrl(env.BINDING_DATA_URL || "", "salon_id") ||
    session.salonId;
  const brandId =
    env.BINDING_BRAND_ID ||
    searchParamFromUrl(env.BINDING_DATA_URL || "", "brand_id") ||
    session.brandId;
  const zoneId =
    session.zoneId ||
    env.BINDING_ZONE_ID ||
    searchParamFromUrl(env.BINDING_DATA_URL || "", "zone_id") ||
    "1";

  return { token, sessionToken, salonId, brandId, zoneId };
}

function withBindingPage(urlText, page, pageSize, session = {}) {
  const url = new URL(urlText);
  const { token, sessionToken, salonId, brandId, zoneId } = bindingAuthContext(session);
  url.searchParams.set(env.BINDING_PAGE_PARAM || "page", String(page));
  url.searchParams.set(env.BINDING_PAGE_SIZE_PARAM || "page_size", String(pageSize));
  if (!url.searchParams.get("search_type")) url.searchParams.set("search_type", env.BINDING_SEARCH_TYPE || "1");
  if (!url.searchParams.has("keyword")) url.searchParams.set("keyword", env.BINDING_KEYWORD || "");
  if (token) url.searchParams.set("token", token);
  if (sessionToken) url.searchParams.set("session_token", sessionToken);
  if (salonId) url.searchParams.set("salon_id", salonId);
  if (brandId) url.searchParams.set("brand_id", brandId);
  if (zoneId) url.searchParams.set("zone_id", zoneId);
  return url.toString();
}

async function fetchBindingJson(url, session = {}) {
  const method = env.BINDING_DATA_METHOD || "GET";
  const timeout = withTimeout({
    method,
    headers: {
      accept: "application/json",
      origin: "https://sy-z1.meimeifa.com",
      referer: "https://sy-z1.meimeifa.com/",
      ...(env.BINDING_DATA_BODY ? { "content-type": "application/json" } : {})
    },
    body: env.BINDING_DATA_BODY || undefined
  });
  try {
    const response = await fetch(url, timeout.options);
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new AppError(`绑定数据源请求失败：HTTP ${response.status} ${text.slice(0, 180)}`, 502);
    }
    if (payload?.code && Number(payload.code) !== 1) {
      const message = upstreamMessage(payload, `code ${payload.code}`);
      const hint = isAuthExpiredMessage(message)
        ? "绑定数据接口授权可能已过期，请重新登录或更新服务端 token。"
        : "绑定数据接口返回业务错误，请检查门店、品牌和接口参数。";
      throw new AppError(`${hint} 原始提示：${message}`, 502, { upstreamCode: payload.code });
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AppError(`绑定数据源请求超时（${requestTimeoutMs}ms），请稍后重试或检查服务器出网。`, 504);
    }
    throw error;
  } finally {
    timeout.done();
  }
}

async function fetchBindingPayload(session = {}) {
  const defaultDataFile = "./data/binding-sample.json";
  if (env.BINDING_DATA_FILE || !env.BINDING_DATA_URL) {
    return JSON.parse(await readFile(path.resolve(projectRoot, env.BINDING_DATA_FILE || defaultDataFile), "utf8"));
  }

  if ((env.BINDING_PAGINATE || "false") !== "true") {
    return fetchBindingJson(withBindingPage(env.BINDING_DATA_URL, 1, Number(env.BINDING_PAGE_SIZE || 100), session), session);
  }

  const pageSize = Number(env.BINDING_PAGE_SIZE || 100);
  const maxPage = Number(env.BINDING_MAX_PAGE || 200);
  const rows = [];
  let total;

  for (let page = 1; page <= maxPage; page += 1) {
    const payload = await fetchBindingJson(withBindingPage(env.BINDING_DATA_URL, page, pageSize, session), session);
    const pageRows = bindingPayloadRows(payload);
    if (total === undefined) total = bindingTotal(payload);
    rows.push(...pageRows);
    if (pageRows.length === 0) break;
    if (total !== undefined && rows.length >= total) break;
    if (pageRows.length < pageSize) break;
  }

  return { response: { data: rows, total: total ?? rows.length } };
}

async function textResponse(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(text);
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const index = item.indexOf("=");
      if (index === -1) return cookies;
      cookies[decodeURIComponent(item.slice(0, index))] = decodeURIComponent(item.slice(index + 1));
      return cookies;
    }, {});
}

function currentSession(req) {
  const id = parseCookies(req)[sessionCookieName];
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + sessionTtlMs;
  return { id, ...session };
}

function setSessionCookie(res, id) {
  const maxAge = Math.floor(sessionTtlMs / 1000);
  res.setHeader(
    "set-cookie",
    `${sessionCookieName}=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "set-cookie",
    `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

function redirectResponse(res, location) {
  res.writeHead(302, { location });
  res.end();
}

async function jsonResponse(res, status, payload) {
  await textResponse(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 64) throw new Error("请求内容过大。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req) {
  const text = await readBody(req);
  if (!text) return {};
  return JSON.parse(text);
}

function loginPage() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>登录｜恒奕美源数据后台</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #151a20;
        --muted: #6b7280;
        --line: #dfe6ee;
        --brand: #0f766e;
        --brand-strong: #0b5f59;
        --soft: #f4f7f5;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        color: var(--ink);
        background:
          radial-gradient(circle at 20% 10%, rgba(212, 249, 224, 0.9), transparent 28%),
          linear-gradient(135deg, #f9fbf8, #eef4f1);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .login-card {
        width: min(420px, 100%);
        padding: 28px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 24px 70px rgba(21, 26, 32, 0.12);
        backdrop-filter: blur(18px);
      }
      .brand {
        display: flex;
        gap: 12px;
        align-items: center;
        margin-bottom: 24px;
      }
      .mark {
        display: grid;
        place-items: center;
        width: 42px;
        height: 42px;
        border-radius: 10px;
        background: #d4f9e0;
        color: #10201f;
        font-weight: 850;
      }
      h1 {
        margin: 0;
        font-size: 22px;
        line-height: 1.25;
      }
      .sub {
        margin-top: 5px;
        color: var(--muted);
        font-size: 13px;
      }
      label {
        display: block;
        margin: 14px 0 6px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }
      input, button {
        width: 100%;
        height: 42px;
        border-radius: 8px;
        font: inherit;
      }
      input {
        border: 1px solid var(--line);
        padding: 0 12px;
        background: #fff;
        color: var(--ink);
      }
      input:focus {
        outline: 0;
        border-color: #83b5a7;
        box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.12);
      }
      button {
        margin-top: 18px;
        border: 1px solid var(--brand);
        background: linear-gradient(180deg, #128278, var(--brand-strong));
        color: #fff;
        cursor: pointer;
        font-weight: 800;
        box-shadow: 0 10px 22px rgba(15, 118, 110, 0.2);
      }
      button:disabled {
        opacity: 0.7;
        cursor: wait;
      }
      .message {
        min-height: 18px;
        margin-top: 12px;
        color: #b42318;
        font-size: 13px;
      }
      .note {
        margin-top: 18px;
        padding-top: 16px;
        border-top: 1px solid var(--line);
        color: var(--muted);
        font-size: 12px;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <form class="login-card" id="loginForm">
      <div class="brand">
        <div class="mark">HY</div>
        <div>
          <h1>恒奕美源数据后台</h1>
          <div class="sub">请使用门店系统账号登录</div>
        </div>
      </div>
      <label for="account">门店系统账号</label>
      <input id="account" autocomplete="username" required />
      <label for="password">密码</label>
      <input id="password" type="password" autocomplete="current-password" required />
      <button id="submitBtn" type="submit">登录后台</button>
      <div class="message" id="message"></div>
      <div class="note">登录会由本地服务调用门店系统校验；账号密码不会写入浏览器页面或看板接口。</div>
    </form>
    <script>
      const form = document.getElementById("loginForm");
      const button = document.getElementById("submitBtn");
      const message = document.getElementById("message");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        message.textContent = "";
        button.disabled = true;
        button.textContent = "正在校验";
        try {
          const response = await fetch("/api/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              account: document.getElementById("account").value.trim(),
              password: document.getElementById("password").value
            })
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "登录失败");
          location.href = "/groupbuy";
        } catch (error) {
          message.textContent = error.message || "登录失败，请重试";
        } finally {
          button.disabled = false;
          button.textContent = "登录后台";
        }
      });
    </script>
  </body>
</html>`;
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  try {
    if (url.pathname === "/healthz") {
      await jsonResponse(res, 200, {
        ok: true,
        uptimeSeconds: Math.round(process.uptime()),
        cacheKeys: boardCache.size,
        time: new Date().toISOString()
      });
      return;
    }

    if (url.pathname === "/login") {
      if (currentSession(req)) {
        redirectResponse(res, "/groupbuy");
        return;
      }
      await textResponse(res, 200, loginPage(), "text/html; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readJsonBody(req);
      const account = String(body.account || "").trim();
      const password = String(body.password || "");
      const user = await verifySalonAccount(account, password);
      const id = randomBytes(24).toString("hex");
      sessions.set(id, {
        account: user.account,
        token: user.token,
        accessToken: user.accessToken,
        sessionToken: user.sessionToken,
        salonId: user.salonId,
        brandId: user.brandId,
        zoneId: user.zoneId,
        createdAt: Date.now(),
        expiresAt: Date.now() + sessionTtlMs
      });
      setSessionCookie(res, id);
      await jsonResponse(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/logout") {
      const session = currentSession(req);
      if (session?.id) sessions.delete(session.id);
      clearSessionCookie(res);
      redirectResponse(res, "/login");
      return;
    }

    const session = currentSession(req);
    if (!session) {
      if (url.pathname.startsWith("/api/")) {
        await jsonResponse(res, 401, { error: "请先使用门店系统账号登录。" });
        return;
      }
      redirectResponse(res, "/login");
      return;
    }

    if (url.pathname === "/" || url.pathname === "/groupbuy") {
      const html = await readFile(path.join(projectRoot, "web", "groupbuy-board.html"), "utf8");
      await textResponse(res, 200, html, "text/html; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/groupbuy") {
      const filters = dateRangeFromSearch(url.searchParams);
      const key = cacheKey("groupbuy", filters);
      try {
        const payload = await fetchPayload(filters, session);
        const board = buildBoard(payload, filters);
        setCachedBoard(key, board);
        await jsonResponse(res, 200, board);
      } catch (error) {
        const cached = cachedBoardOnFailure(key, error);
        if (cached) {
          await jsonResponse(res, 200, cached);
          return;
        }
        throw error;
      }
      return;
    }

    if (url.pathname === "/api/binding") {
      const key = cacheKey("binding", { reportDate: env.REPORT_DATE || todayKey() });
      try {
        const payload = await fetchBindingPayload(session);
        const board = buildBindingBoard(payload);
        setCachedBoard(key, board);
        await jsonResponse(res, 200, board);
      } catch (error) {
        const cached = cachedBoardOnFailure(key, error);
        if (cached) {
          await jsonResponse(res, 200, cached);
          return;
        }
        throw error;
      }
      return;
    }

    await textResponse(res, 404, "Not found");
  } catch (error) {
    const status = error.status || 500;
    console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname} failed:`, error.message || error);
    await jsonResponse(res, status, {
      error: error.message || String(error),
      status,
      retryable: status >= 500
    });
  }
}

const server = createServer(handleRequest);
server.on("error", (error) => {
  console.error(`服务启动失败：${error.message || error}`);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log(`拼团数据看板已启动：http://${displayHost}:${port}/groupbuy`);
});
