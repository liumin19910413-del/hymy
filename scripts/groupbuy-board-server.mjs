#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
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
const maxDateRangeDays = Number(env.MAX_QUERY_RANGE_DAYS || 61);
const sessions = new Map();
const bindingMgTokenCache = { token: "", expiresAt: 0 };
const bindingLiteTokenCache = { token: "", expiresAt: 0 };
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

function extractQueryParam(input, name) {
  const text = String(input || "").trim();
  if (!text) return "";
  try {
    return new URL(text).searchParams.get(name) || "";
  } catch {
    const match = text.match(new RegExp(`(?:^|[?&\\s])${name}=([^&\\s]+)`));
    return match ? decodeURIComponent(match[1]) : "";
  }
}

function cleanEnvValue(value) {
  return String(value || "").replace(/\r?\n/g, "").trim();
}

async function updateDotEnv(updates) {
  const filePath = path.join(projectRoot, ".env");
  let text = "";
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const lines = text ? text.split(/\r?\n/) : [];
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !(match[1] in updates)) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) nextLines.push(`${key}=${value}`);
  }

  await writeFile(filePath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

async function saveGroupbuyCredentials(input) {
  const { token, sessionToken } = parseGroupbuyCredentialInput(input);
  if (!sessionToken || sessionToken.length < 8) {
    throw new AppError("没有识别到有效的 session_token。", 400);
  }

  const updates = { GROUPBUY_SESSION_TOKEN: sessionToken };
  if (token) updates.GROUPBUY_TOKEN = token;
  Object.assign(process.env, updates);
  await updateDotEnv(updates);
  return {
    hasToken: Boolean(token),
    sessionTokenLength: sessionToken.length
  };
}

function parseGroupbuyCredentialInput(input) {
  let raw = input;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (/^\{[\s\S]*\}$/.test(text)) {
      try {
        raw = JSON.parse(text);
      } catch {
        raw = text;
      }
    }
  }

  if (raw && typeof raw === "object") {
    const url = raw.url || raw.requestUrl || raw.href || "";
    return {
      token: cleanEnvValue(raw.token || raw.GROUPBUY_TOKEN || extractQueryParam(url, "token")),
      sessionToken: cleanEnvValue(
        raw.session_token ||
          raw.sessionToken ||
          raw.GROUPBUY_SESSION_TOKEN ||
          extractQueryParam(url, "session_token")
      )
    };
  }

  const text = String(raw || "").trim();
  return {
    token: cleanEnvValue(extractQueryParam(text, "token")),
    sessionToken: cleanEnvValue(extractQueryParam(text, "session_token") || text)
  };
}

async function persistRefreshedGroupbuyCredentials(credentials) {
  const updates = {};
  if (credentials?.token) updates.GROUPBUY_TOKEN = cleanEnvValue(credentials.token);
  if (credentials?.sessionToken) updates.GROUPBUY_SESSION_TOKEN = cleanEnvValue(credentials.sessionToken);
  if (Object.keys(updates).length === 0) return false;
  Object.assign(process.env, updates);
  await updateDotEnv(updates);
  return true;
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

function offsetDateKey(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return formatDateKey(date);
}

function monthStartKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    "01"
  ].join("-");
}

function dateRangeFromSearch(searchParams = new URLSearchParams()) {
  const beginDate = formatDateKey(searchParams.get("begin_date") || searchParams.get("start") || env.GROUPBUY_BEGIN_DATE || monthStartKey());
  const endDate = formatDateKey(searchParams.get("end_date") || searchParams.get("end") || env.GROUPBUY_END_DATE || todayKey());
  const keyword = String(searchParams.get("keyword") || searchParams.get("q") || env.GROUPBUY_DEFAULT_KEYWORD || "").trim();
  return normalizeDateRange({
    beginDate,
    endDate,
    keyword
  });
}

function bindingDateRangeFromSearch(searchParams = new URLSearchParams()) {
  const fallbackDate = todayKey();
  const beginDate = formatDateKey(
    searchParams.get("begin_date") || searchParams.get("start") || env.BINDING_BEGIN_DATE || fallbackDate
  );
  const endDate = formatDateKey(
    searchParams.get("end_date") || searchParams.get("end") || env.BINDING_END_DATE || fallbackDate
  );
  return normalizeDateRange({
    beginDate: beginDate || fallbackDate,
    endDate: endDate || beginDate || fallbackDate
  });
}

function dateKeyToUtcMs(value) {
  const dateKey = formatDateKey(value);
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return 0;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function dateRangeDays(beginDate, endDate) {
  const beginMs = dateKeyToUtcMs(beginDate);
  const endMs = dateKeyToUtcMs(endDate);
  if (!beginMs || !endMs) return 0;
  return Math.floor((endMs - beginMs) / 86400000) + 1;
}

function normalizeDateRange(filters = {}) {
  let beginDate = formatDateKey(filters.beginDate);
  let endDate = formatDateKey(filters.endDate);
  if (!beginDate && endDate) beginDate = endDate;
  if (!endDate && beginDate) endDate = beginDate;
  if (beginDate && endDate && beginDate > endDate) {
    [beginDate, endDate] = [endDate, beginDate];
  }
  if (beginDate && endDate && dateRangeDays(beginDate, endDate) > maxDateRangeDays) {
    throw new AppError(`查询时间跨度最多只能 ${maxDateRangeDays} 天，请缩小日期范围。`, 400);
  }
  return {
    ...filters,
    beginDate,
    endDate
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

function customerNameFromOrder(order) {
  const member = order.member || {};
  const contact = order.contact || {};
  return String(
    firstValue(order, fieldList("GROUPBUY_CUSTOMER_NAME_FIELD", [
      "customer_name",
      "buyer_name",
      "member_name",
      "nickname",
      "user_name",
      "name"
    ])) ||
      member.name ||
      member.nickname ||
      contact.name ||
      "未命名客户"
  ).trim();
}

function customerPhoneFromOrder(order) {
  const member = order.member || {};
  const contact = order.contact || {};
  return String(
    firstValue(order, fieldList("GROUPBUY_CUSTOMER_PHONE_FIELD", [
      "customer_phone",
      "buyer_phone",
      "member_phone",
      "mobile",
      "phone",
      "handset",
      "tel"
    ])) ||
      member.handset ||
      member.mobile ||
      member.phone ||
      contact.handset ||
      contact.mobile ||
      contact.phone ||
      ""
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
    latestOrderAt: String(createdAt).trim(),
    targetCount,
    joinedCount,
    remaining,
    isSuccess,
    amount: amountFromOrder(order),
    orderDetails: [],
    rawStatus: statusValue(order)
  };
}

function flatOrderDetail(order, normalized) {
  const isOpenGroupOrder = Boolean(order.is_groupbuy_leader || order.is_leader || order.is_group_leader);
  const customerPhone = isOpenGroupOrder ? normalized.leaderPhone : customerPhoneFromOrder(order);
  return {
    orderId: String(
      firstValue(order, fieldList("GROUPBUY_ORDER_ID_FIELD", [
        "order_id",
        "id",
        "trade_no",
        "order_sn",
        "out_trade_no"
      ])) || `${normalized.groupId}-${normalized.paidOrders || 1}-${normalized.createdAt}`
    ),
    groupId: normalized.groupId,
    leaderName: normalized.leaderName,
    leaderPhone: normalized.leaderPhone,
    leaderPhoneMasked: normalized.leaderPhoneMasked,
    title: normalized.title,
    groupStatus: normalized.isSuccess ? "已成团" : "未成团",
    customerName: isOpenGroupOrder ? normalized.leaderName : customerNameFromOrder(order),
    customerPhone,
    customerPhoneMasked: maskPhone(customerPhone),
    payTime: formatDateTime(normalized.latestOrderAt || normalized.createdAt),
    amount: normalized.amount,
    orderStatus: normalized.rawStatus || "有效",
    isOpenGroupOrder
  };
}

function groupOrders(rows) {
  const groups = new Map();
  for (const row of rows) {
    const order = normalizeOrder(row);
    const detail = flatOrderDetail(row, order);
    const current =
      groups.get(order.groupId) || {
        groupId: order.groupId,
        leaderName: order.leaderName,
        leaderPhone: order.leaderPhone,
        leaderPhoneMasked: order.leaderPhoneMasked,
        title: order.title,
        createdAt: order.createdAt,
        latestOrderAt: order.latestOrderAt,
        targetCount: order.targetCount,
        joinedCount: 0,
        paidOrders: 0,
        amount: 0,
        remaining: order.remaining,
        isSuccess: false,
        orderDetails: [],
        rawStatus: order.rawStatus
      };
    current.joinedCount = Math.max(current.joinedCount, order.joinedCount);
    current.targetCount = Math.max(current.targetCount, order.targetCount);
    current.remaining = Math.min(current.remaining, order.remaining);
    current.isSuccess = current.isSuccess || order.isSuccess;
    current.paidOrders += 1;
    current.amount += order.amount;
    current.orderDetails.push(detail);
    if (dateTimeMs(order.latestOrderAt || order.createdAt) >= dateTimeMs(current.latestOrderAt || current.createdAt)) {
      current.latestOrderAt = order.latestOrderAt || order.createdAt;
      current.leaderName = order.leaderName || current.leaderName;
    }
    groups.set(order.groupId, current);
  }

  return [...groups.values()].map((group) => {
    const computedRemaining =
      group.targetCount > 0 ? Math.max(group.targetCount - group.paidOrders, 0) : group.remaining;
    return {
      ...group,
      joinedCount: Math.max(group.joinedCount, group.paidOrders),
      orderDetails: group.orderDetails
        .map((detail) => ({
          ...detail,
          groupStatus: group.isSuccess ? "已成团" : "未成团"
        }))
        .sort((a, b) => dateTimeMs(b.payTime) - dateTimeMs(a.payTime)),
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

function dateTimeMs(value) {
  if (!value) return 0;
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    const number = Number(value);
    const date = new Date(String(value).length === 13 ? number : number * 1000);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
  }
  const text = String(value).trim();
  const normalized = text.replace(/^(\d{4})-(\d{1,2})-(\d{1,2})/, "$1/$2/$3");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function buildLeaderRankings(groups) {
  const rankingMap = new Map();
  for (const group of groups) {
    const phone = String(group.leaderPhone || "").trim();
    const key = phone || `name:${String(group.leaderName || "未命名团长").trim()}`;
    const current =
      rankingMap.get(key) || {
        leaderName: group.leaderName || "未命名团长",
        leaderPhone: phone,
        leaderPhoneMasked: group.leaderPhoneMasked || maskPhone(phone),
        paidOrders: 0,
        amount: 0,
        totalGroups: 0,
        successGroups: 0,
        pendingGroups: 0,
        latestOrderAt: "",
        latestOrderAtMs: 0,
        orderDetails: []
      };
    const candidateTime = dateTimeMs(group.latestOrderAt || group.createdAt);
    current.paidOrders += group.paidOrders;
    current.amount += group.amount;
    current.totalGroups += 1;
    current.successGroups += group.isSuccess ? 1 : 0;
    current.pendingGroups += group.isSuccess ? 0 : 1;
    current.orderDetails.push(...(group.orderDetails || []));
    if (candidateTime >= current.latestOrderAtMs) {
      current.leaderName = group.leaderName || current.leaderName;
      current.latestOrderAt = group.latestOrderAt || group.createdAt || current.latestOrderAt;
      current.latestOrderAtMs = candidateTime;
    }
    rankingMap.set(key, current);
  }

  return [...rankingMap.values()]
    .map(({ latestOrderAtMs, ...item }) => ({
      ...item,
      orderDetails: item.orderDetails.sort((a, b) => dateTimeMs(b.payTime) - dateTimeMs(a.payTime)),
      successRate: item.totalGroups > 0 ? item.successGroups / item.totalGroups : 0
    }))
    .sort((a, b) => b.paidOrders - a.paidOrders || b.amount - a.amount || b.totalGroups - a.totalGroups);
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
    leaderRankings: buildLeaderRankings(groups),
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

function nestedOrderDetail(order, group) {
  const isOpenGroupOrder = Boolean(order.is_groupbuy_leader || order.is_leader || order.is_group_leader);
  const customerPhone = isOpenGroupOrder ? group.leaderPhone : customerPhoneFromOrder(order);
  return {
    orderId: String(order.order_id || order.id || order.trade_no || order.order_sn || `${group.groupId}-${nestedOrderDate(order)}`),
    groupId: group.groupId,
    leaderName: group.leaderName,
    leaderPhone: group.leaderPhone,
    leaderPhoneMasked: group.leaderPhoneMasked,
    title: group.title,
    groupStatus: group.isSuccess ? "已成团" : "未成团",
    customerName: isOpenGroupOrder ? group.leaderName : customerNameFromOrder(order),
    customerPhone,
    customerPhoneMasked: maskPhone(customerPhone),
    payTime: formatDateTime(nestedOrderDate(order)),
    amount: nestedOrderAmount(order),
    orderStatus: String(order.status_text || order.order_status_text || order.status || "有效"),
    isOpenGroupOrder
  };
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
    const latestOrderAt = effectiveOrders
      .map((order) => nestedOrderDate(order))
      .filter(Boolean)
      .sort((a, b) => dateTimeMs(b) - dateTimeMs(a))[0];

    const group = {
      groupId: String(record.id || row.id || `${leader.name}-${leader.phone}-${title}`),
      leaderName: String(leader.name || "未命名团长").trim(),
      leaderPhone: leader.phone,
      leaderPhoneMasked: maskPhone(leader.phone),
      title,
      createdAt: formatDateTime(createdAt),
      latestOrderAt: formatDateTime(latestOrderAt),
      targetCount,
      joinedCount,
      paidOrders: effectiveOrders.length,
      amount,
      remaining,
      isSuccess,
      rawStatus: String(record.status ?? "")
    };
    group.orderDetails = effectiveOrders
      .map((order) => nestedOrderDetail(order, group))
      .sort((a, b) => dateTimeMs(b.payTime) - dateTimeMs(a.payTime));
    groups.push(group);
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
    leaderRankings: buildLeaderRankings(groups),
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

async function loginByMgCli() {
  if (!env.MG_CENTER_ACCOUNT || !env.MG_CENTER_PASSWORD) {
    throw new AppError("缺少 MG_CENTER_ACCOUNT 或 MG_CENTER_PASSWORD，无法登录绑定数据源。", 500);
  }
  if (bindingMgTokenCache.token && bindingMgTokenCache.expiresAt > Date.now()) {
    return bindingMgTokenCache.token;
  }

  const { stdout } = await execFileAsync(
    "npx",
    ["-y", "yz-mg-cli@latest", "login", "--field", "all"],
    {
      env: {
        ...process.env,
        MG_CENTER_BASE_URL: env.MG_CENTER_BASE_URL || "https://mg-cli.meimeifa.com"
      },
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 5
    }
  );
  const login = parseJson(stdout, "MG CLI 登录返回不是 JSON。");
  const tokenField = env.MG_LOGIN_TOKEN_FIELD || "token";
  const token = loginValue(login, [
    tokenField,
    `data.${tokenField}`,
    `response.${tokenField}`,
    "token",
    "data.token",
    "response.token",
    "access_token",
    "data.access_token",
    "response.access_token"
  ]);
  if (!token) throw new AppError(`MG CLI 登录成功，但未找到 ${tokenField}。`, 502);

  bindingMgTokenCache.token = token;
  bindingMgTokenCache.expiresAt = Date.now() + Number(env.BINDING_MG_TOKEN_TTL_MS || 10 * 60 * 1000);
  return token;
}

async function fetchLiteJson(pathname, body) {
  const timeout = withTimeout({
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
      origin: "https://sy-z1.meimeifa.com",
      referer: "https://sy-z1.meimeifa.com/"
    },
    body: JSON.stringify({
      ...body,
      _yz_version: env.GROUPBUY_YZ_VERSION || "lite:4.73.3"
    })
  });
  let response;
  let payload;
  try {
    response = await fetch(`https://api-sy-z1.meimeifa.com${pathname}`, timeout.options);
    const text = await response.text();
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
  } finally {
    timeout.done();
  }
  if (!response.ok || (payload?.code && Number(payload.code) !== 1)) {
    const message = upstreamMessage(payload, `HTTP ${response.status}`);
    throw new AppError(`拼团后台自动登录失败：${message}`, 502, { upstreamCode: payload?.code });
  }
  return payload;
}

async function loginByLiteBackend() {
  if (!env.MG_SALON_ACCOUNT || !env.MG_SALON_PASSWORD) {
    throw new Error("缺少 MG_SALON_ACCOUNT 或 MG_SALON_PASSWORD，无法自动登录拼团后台。");
  }

  const dataUrl = env.GROUPBUY_DATA_URL || defaultDataUrl;
  const salonId = searchParamFromUrl(dataUrl, "salon_id") || env.GROUPBUY_SALON_ID || "";
  const brandId = searchParamFromUrl(dataUrl, "brand_id") || env.GROUPBUY_BRAND_ID || "";
  const login = await fetchLiteJson("/common/loginCenter", {
    account: env.MG_SALON_ACCOUNT,
    password: env.MG_SALON_PASSWORD
  });
  const loginToken = loginValue(login, ["response.token", "token"]);
  if (!loginToken) throw new AppError("拼团后台自动登录未返回 token。", 502);

  let token = loginToken;
  if (salonId && brandId) {
    const toggled = await fetchLiteJson("/common/toggle", {
      token: loginToken,
      salon_id: salonId,
      brand_id: brandId,
      dest_salon_id: salonId,
      dest_brand_id: brandId
    });
    token = loginValue(toggled, ["response.token", "token"]) || loginToken;
  }

  return {
    token,
    sessionToken: randomUUID(),
    source: "lite-login"
  };
}

async function loginByBindingLiteBackend() {
  if (!env.MG_SALON_ACCOUNT || !env.MG_SALON_PASSWORD) {
    throw new AppError("缺少 MG_SALON_ACCOUNT 或 MG_SALON_PASSWORD，无法登录绑定数据源。", 500);
  }
  if (bindingLiteTokenCache.token && bindingLiteTokenCache.expiresAt > Date.now()) {
    return bindingLiteTokenCache.token;
  }

  const dataUrl = env.BINDING_DATA_URL || "";
  const salonId = searchParamFromUrl(dataUrl, "salon_id") || env.BINDING_SALON_ID || "";
  const brandId = searchParamFromUrl(dataUrl, "brand_id") || env.BINDING_BRAND_ID || "";
  const login = await fetchLiteJson("/common/loginCenter", {
    account: env.MG_SALON_ACCOUNT,
    password: env.MG_SALON_PASSWORD
  });
  const loginToken = loginValue(login, ["response.token", "token"]);
  if (!loginToken) throw new AppError("绑定数据源自动登录未返回 token。", 502);

  let token = loginToken;
  if (salonId && brandId) {
    const toggled = await fetchLiteJson("/common/toggle", {
      token: loginToken,
      salon_id: salonId,
      brand_id: brandId,
      dest_salon_id: salonId,
      dest_brand_id: brandId
    });
    token = loginValue(toggled, ["response.token", "token"]) || loginToken;
  }

  bindingLiteTokenCache.token = token;
  bindingLiteTokenCache.expiresAt = Date.now() + Number(env.BINDING_LITE_TOKEN_TTL_MS || 10 * 60 * 1000);
  return token;
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

function groupbuyCredentials(login = {}, session = {}, overrides = {}) {
  const loginToken = loginValue(login, ["token", "access_token"]);
  const loginSessionToken = loginValue(login, ["session_token", "sessionToken"]);
  return {
    token:
      overrides.token ||
      env.GROUPBUY_TOKEN ||
      searchParamFromUrl(env.GROUPBUY_DATA_URL || "", "token") ||
      searchParamFromUrl(env.BINDING_DATA_URL || "", "token") ||
      session.token ||
      session.accessToken ||
      loginToken,
    sessionToken:
      overrides.sessionToken ||
      env.GROUPBUY_SESSION_TOKEN ||
      searchParamFromUrl(env.GROUPBUY_DATA_URL || "", "session_token") ||
      searchParamFromUrl(env.BINDING_DATA_URL || "", "session_token") ||
      session.sessionToken ||
      loginSessionToken
  };
}

function withPage(urlText, page, pageSize, login, session = {}, credentialOverrides = {}) {
  const url = new URL(urlText);
  url.searchParams.set(env.GROUPBUY_PAGE_PARAM || "page", String(page));
  url.searchParams.set(env.GROUPBUY_PAGE_SIZE_PARAM || "page_size", String(pageSize));
  if ((env.GROUPBUY_DATA_LOGIN || "salon") === "salon") {
    const { token, sessionToken } = groupbuyCredentials(login, session, credentialOverrides);
    if (!token) throw new AppError("拼团接口授权未配置，请联系管理员处理。", 500);
    if (!sessionToken) {
      throw new AppError("拼团接口授权未配置，请联系管理员处理。", 428);
    }
    if (token) url.searchParams.set("token", token);
    url.searchParams.set("session_token", sessionToken);
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
      const authExpired = isAuthExpiredMessage(message);
      const hint = authExpired
        ? "拼团接口授权已过期，请联系管理员处理。"
        : "拼团接口返回业务错误，请检查门店、品牌、日期范围和接口参数。";
      throw new AppError(`${hint} 原始提示：${message}`, 502, { upstreamCode: payload.code, authExpired });
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

function isGroupbuyAuthError(error) {
  return Boolean(error?.details?.authExpired) || isAuthExpiredMessage(error?.message || error);
}

async function runGroupbuyRefreshCommand() {
  const command = String(env.GROUPBUY_REFRESH_COMMAND || "").trim();
  if (!command) return null;
  const { stdout } = await execFileAsync("sh", ["-lc", command], {
    env: process.env,
    timeout: Number(env.GROUPBUY_REFRESH_TIMEOUT_MS || 30000),
    maxBuffer: 1024 * 1024 * 5
  });
  return parseGroupbuyCredentialInput(stdout);
}

async function refreshGroupbuyCredentials(session = {}) {
  const commandCredentials = await runGroupbuyRefreshCommand();
  if (commandCredentials?.token || commandCredentials?.sessionToken) {
    return { ...commandCredentials, source: "command" };
  }

  try {
    return await loginByLiteBackend();
  } catch (error) {
    console.warn(`[${new Date().toISOString()}] 拼团后台自动登录失败，尝试门店 CLI 兜底:`, error.message || error);
  }

  const login = await loginBySalonCli();
  return {
    token: loginValue(login, ["token", "access_token"]) || session.token || session.accessToken,
    sessionToken: loginValue(login, ["session_token", "sessionToken"]) || session.sessionToken,
    login,
    source: "salon-login"
  };
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

async function fetchPayloadOnce(filters, session = {}, credentialOverrides = {}) {
  if (env.GROUPBUY_DATA_FILE) {
    return JSON.parse(await readFile(path.resolve(projectRoot, env.GROUPBUY_DATA_FILE), "utf8"));
  }

  let login = {
    token: session.token || session.accessToken,
    access_token: session.accessToken || session.token,
    session_token: session.sessionToken,
    sessionToken: session.sessionToken
  };
  const currentCredentials = groupbuyCredentials(login, session, credentialOverrides);
  if (!currentCredentials.token || !currentCredentials.sessionToken) {
    login = {
      ...(await loginBySalonCli()),
      ...login
    };
  }
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
        withPage(withOrderStatus(dataUrl, orderStatus), page, pageSize, login, session, credentialOverrides),
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

async function fetchPayload(filters = dateRangeFromSearch(), session = {}) {
  try {
    return await fetchPayloadOnce(filters, session);
  } catch (error) {
    if ((env.GROUPBUY_AUTO_REFRESH || "true") !== "true" || !isGroupbuyAuthError(error)) {
      throw error;
    }

    console.warn(`[${new Date().toISOString()}] 拼团接口授权失效，正在自动重新登录并重试。`);
    let refreshed;
    try {
      refreshed = await refreshGroupbuyCredentials(session);
    } catch (refreshError) {
      console.error(`[${new Date().toISOString()}] 拼团接口自动刷新失败:`, refreshError.message || refreshError);
      throw error;
    }

    const credentialOverrides = {
      token: refreshed.token,
      sessionToken: refreshed.sessionToken
    };

    try {
      const payload = await fetchPayloadOnce(filters, session, credentialOverrides);
      await persistRefreshedGroupbuyCredentials(credentialOverrides);
      console.log(`[${new Date().toISOString()}] 拼团接口自动刷新成功，来源：${refreshed.source || "unknown"}。`);
      return payload;
    } catch (retryError) {
      console.error(`[${new Date().toISOString()}] 拼团接口自动刷新后仍失败:`, retryError.message || retryError);
      throw error;
    }
  }
}

function bindingRows(payload) {
  return asArray(getByPath(payload, env.BINDING_LIST_PATH || "response.data"));
}

function validBindingStatusValues() {
  return String(env.BINDING_VALID_STATUS_VALUES || "1")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function isValidBindingRow(row) {
  const statusField = env.BINDING_STATUS_FIELD || "status";
  const status = getByPath(row, statusField);
  return validBindingStatusValues().includes(String(status ?? "").trim().toLowerCase());
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

function bindingDateValue(row, preferredField) {
  const candidates = [
    preferredField,
    "created_at",
    "create_time",
    "created_time",
    "create_at",
    "bind_time",
    "binding_time",
    "bound_at",
    "register_time",
    "registered_at",
    "updated_at",
    "time",
    "date"
  ].filter(Boolean);
  for (const field of candidates) {
    const value = getByPath(row, field);
    if (formatDateKey(value)) return value;
  }
  return "";
}

function buildBindingBoard(payload, filters = bindingDateRangeFromSearch()) {
  const rawRows = bindingRows(payload);
  const rows = rawRows.filter(isValidBindingRow);
  const phoneFields = String(env.BINDING_PHONE_FIELD || "phone,mobile,handset,tel")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const reportDate = env.REPORT_DATE || todayKey();
  const yesterdayDate = env.REPORT_YESTERDAY_DATE || offsetDateKey(-1);
  const rangeLabel =
    filters.beginDate === filters.endDate
      ? (filters.beginDate === reportDate ? "今天" : filters.beginDate)
      : `${filters.beginDate} 至 ${filters.endDate}`;
  const dateField = env.BINDING_DATE_FIELD || "created_at";
  const dateKeyForRow = (row) => formatDateKey(bindingDateValue(row, dateField));
  const todayRows = rows.filter((row) => dateKeyForRow(row) === reportDate);
  const yesterdayRows = rows.filter((row) => dateKeyForRow(row) === yesterdayDate);
  const rangeRows = rows.filter((row) => isDateInRange(bindingDateValue(row, dateField), filters.beginDate, filters.endDate));
  const partnerNameField = env.PARTNER_NAME_FIELD || "retail_store_name";
  const partnerIdField = env.PARTNER_ID_FIELD || "retail_store_id";
  const partnerMap = new Map();

  for (const row of rows) {
    const id = getByPath(row, partnerIdField) || getByPath(row, partnerNameField) || "unknown";
    const name = String(getByPath(row, partnerNameField) || "未命名合伙人").trim();
    const current = partnerMap.get(id) || { id, name, rows: [] };
    current.rows.push(row);
    partnerMap.set(id, current);
  }

  const partners = [...partnerMap.values()]
    .map((partner) => {
      const partnerTodayRows = partner.rows.filter((row) => dateKeyForRow(row) === reportDate);
      const partnerYesterdayRows = partner.rows.filter((row) => dateKeyForRow(row) === yesterdayDate);
      const partnerRangeRows = partner.rows.filter((row) =>
        isDateInRange(bindingDateValue(row, dateField), filters.beginDate, filters.endDate)
      );
      return {
        id: partner.id,
        name: partner.name,
        cumulative: countBindingRows(partner.rows, phoneFields),
        today: countBindingRows(partnerTodayRows, phoneFields),
        yesterday: countBindingRows(partnerYesterdayRows, phoneFields),
        range: countBindingRows(partnerRangeRows, phoneFields)
      };
    })
    .sort((a, b) =>
      b.cumulative.totalBindings - a.cumulative.totalBindings ||
      b.today.totalBindings - a.today.totalBindings ||
      b.cumulative.phoneObtained - a.cumulative.phoneObtained
    );

  return {
    generatedAt: new Date().toISOString(),
    generatedAtText: new Date().toLocaleString("zh-CN", { hour12: false }),
    reportDate,
    yesterdayDate,
    rangeLabel,
    filters: {
      beginDate: filters.beginDate,
      endDate: filters.endDate
    },
    cumulative: countBindingRows(rows, phoneFields),
    today: countBindingRows(todayRows, phoneFields),
    yesterday: countBindingRows(yesterdayRows, phoneFields),
    range: countBindingRows(rangeRows, phoneFields),
    partners,
    topPartners: partners.slice(0, Number(env.TOP_PARTNER_LIMIT || 20)).map((partner) => ({
      id: partner.id,
      name: partner.name,
      ...partner.today
    })),
    sourceRows: rows.length,
    rawSourceRows: rawRows.length,
    invalidSourceRows: Math.max(rawRows.length - rows.length, 0)
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
    session.token ||
    session.accessToken ||
    searchParamFromUrl(env.BINDING_DATA_URL || "", "token");
  const sessionToken =
    env.BINDING_SESSION_TOKEN ||
    session.sessionToken ||
    searchParamFromUrl(env.BINDING_DATA_URL || "", "session_token");
  const salonId =
    env.BINDING_SALON_ID ||
    session.salonId ||
    searchParamFromUrl(env.BINDING_DATA_URL || "", "salon_id");
  const brandId =
    env.BINDING_BRAND_ID ||
    session.brandId ||
    searchParamFromUrl(env.BINDING_DATA_URL || "", "brand_id");
  const zoneId =
    session.zoneId ||
    env.BINDING_ZONE_ID ||
    searchParamFromUrl(env.BINDING_DATA_URL || "", "zone_id") ||
    "1";

  return { token, sessionToken, salonId, brandId, zoneId };
}

function bindingAuthHeaders(token) {
  const headers = {
    accept: "application/json",
    origin: "https://sy-z1.meimeifa.com",
    referer: "https://sy-z1.meimeifa.com/"
  };
  if (!token) return headers;

  const headerMode = env.BINDING_DATA_AUTH_HEADER || "authorization-bearer";
  if (headerMode === "authorization-bearer") headers.authorization = `Bearer ${token}`;
  if (headerMode === "mmf-token") headers["mmf-token"] = token;
  if (headerMode === "token") headers.token = token;
  return headers;
}

function withBindingPage(urlText, page, pageSize, session = {}, bindingToken = "", filters = {}) {
  const url = new URL(urlText);
  const { token, sessionToken, salonId, brandId, zoneId } = bindingAuthContext(session);
  url.searchParams.set(env.BINDING_PAGE_PARAM || "page", String(page));
  url.searchParams.set(env.BINDING_PAGE_SIZE_PARAM || "page_size", String(pageSize));
  if (filters.beginDate) url.searchParams.set(env.BINDING_BEGIN_DATE_PARAM || "begin_date", filters.beginDate);
  if (filters.endDate) url.searchParams.set(env.BINDING_END_DATE_PARAM || "end_date", filters.endDate);
  if (!url.searchParams.get("search_type")) url.searchParams.set("search_type", env.BINDING_SEARCH_TYPE || "1");
  if (!url.searchParams.has("keyword")) url.searchParams.set("keyword", env.BINDING_KEYWORD || "");
  if ((env.BINDING_DATA_LOGIN || "none") === "mg") {
    url.searchParams.delete("token");
    url.searchParams.delete("session_token");
  } else if ((env.BINDING_DATA_LOGIN || "none") === "lite") {
    url.searchParams.delete("session_token");
    if (bindingToken) url.searchParams.set("token", bindingToken);
  } else {
    if (token) url.searchParams.set("token", token);
    if (sessionToken) url.searchParams.set("session_token", sessionToken);
  }
  if (salonId) url.searchParams.set("salon_id", salonId);
  if (brandId) url.searchParams.set("brand_id", brandId);
  if (zoneId) url.searchParams.set("zone_id", zoneId);
  return url.toString();
}

async function fetchBindingJson(url, headers = bindingAuthHeaders()) {
  const method = env.BINDING_DATA_METHOD || "GET";
  const timeout = withTimeout({
    method,
    headers: {
      ...headers,
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

async function fetchBindingJsonWithAuth(url, headers, retryAuth = true) {
  try {
    return await fetchBindingJson(url, headers);
  } catch (error) {
    if (
      retryAuth &&
      (env.BINDING_DATA_LOGIN || "none") === "mg" &&
      (error.details?.upstreamCode || error.status === 401 || isAuthExpiredMessage(error.message))
    ) {
      bindingMgTokenCache.token = "";
      bindingMgTokenCache.expiresAt = 0;
      const token = await loginByMgCli();
      return fetchBindingJson(url, bindingAuthHeaders(token));
    }
    throw error;
  }
}

async function fetchBindingPayload(session = {}, filters = bindingDateRangeFromSearch()) {
  const defaultDataFile = "./data/binding-sample.json";
  if (env.BINDING_DATA_FILE || !env.BINDING_DATA_URL) {
    return JSON.parse(await readFile(path.resolve(projectRoot, env.BINDING_DATA_FILE || defaultDataFile), "utf8"));
  }

  const loginMode = env.BINDING_DATA_LOGIN || "none";
  const bindingToken =
    loginMode === "mg" ? await loginByMgCli() : loginMode === "lite" ? await loginByBindingLiteBackend() : "";
  const headers = loginMode === "mg" ? bindingAuthHeaders(bindingToken) : bindingAuthHeaders();

  if ((env.BINDING_PAGINATE || "true") !== "true") {
    return fetchBindingJsonWithAuth(
      withBindingPage(env.BINDING_DATA_URL, 1, Number(env.BINDING_PAGE_SIZE || 100), session, bindingToken, filters),
      headers
    );
  }

  const pageSize = Number(env.BINDING_PAGE_SIZE || 100);
  const maxPage = Number(env.BINDING_MAX_PAGE || 200);
  const rows = [];
  let total;

  for (let page = 1; page <= maxPage; page += 1) {
    const payload = await fetchBindingJsonWithAuth(
      withBindingPage(env.BINDING_DATA_URL, page, pageSize, session, bindingToken, filters),
      headers
    );
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

    if (url.pathname === "/api/groupbuy/session" && req.method === "POST") {
      if ((env.GROUPBUY_ALLOW_BROWSER_SESSION_UPDATE || "false") !== "true") {
        await jsonResponse(res, 404, { error: "Not found" });
        return;
      }
      const body = await readJsonBody(req);
      const result = await saveGroupbuyCredentials(body.sessionToken || body.url || body.value);
      await jsonResponse(res, 200, { ok: true, ...result });
      return;
    }

    if (url.pathname === "/api/groupbuy") {
      const filters = dateRangeFromSearch(url.searchParams);
      try {
        const payload = await fetchPayload(filters, session);
        const board = buildBoard(payload, filters);
        await jsonResponse(res, 200, board);
      } catch (error) {
        throw error;
      }
      return;
    }

    if (url.pathname === "/api/binding") {
      try {
        const filters = bindingDateRangeFromSearch(url.searchParams);
        const payload = await fetchBindingPayload(session, filters);
        const board = buildBindingBoard(payload, filters);
        await jsonResponse(res, 200, board);
      } catch (error) {
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
