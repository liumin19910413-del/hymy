#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const top10Only = args.has("--top10-only");

await loadDotEnv(path.join(projectRoot, ".env"));

const env = process.env;

function timestamp() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
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

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const candidate of ["list", "records", "data", "items", "rows"]) {
      if (Array.isArray(value[candidate])) return value[candidate];
    }
  }
  return [];
}

function parseNumber(value) {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function hasPhone(row, phoneFields) {
  return phoneFields.some((field) => {
    const value = getByPath(row, field);
    return value != null && String(value).trim() !== "";
  });
}

function dateKey(value) {
  if (!value) return "";
  const text = String(value).trim();
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayKey() {
  return dateKey(new Date());
}

function bindingRows(payload) {
  const listPath = env.BINDING_LIST_PATH || "data.list";
  return asArray(getByPath(payload, listPath));
}

function countRows(rows, phoneFields) {
  const phoneObtained = rows.filter((row) => hasPhone(row, phoneFields)).length;
  const totalBindings = rows.length;
  return {
    totalBindings,
    phoneObtained,
    phoneMissing: Math.max(totalBindings - phoneObtained, 0),
    phoneRate: totalBindings > 0 ? phoneObtained / totalBindings : 0
  };
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function buildStats(payload) {
  const rows = bindingRows(payload);
  const phoneFields = String(env.BINDING_PHONE_FIELD || "phone,mobile,handset,tel")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const dateField = env.BINDING_DATE_FIELD || "created_at";
  const reportDate = env.REPORT_DATE || todayKey();
  const todayRows = rows.filter((row) => dateKey(getByPath(row, dateField)) === reportDate);
  const partnerNameField = env.PARTNER_NAME_FIELD || "retail_store_name";
  const partnerIdField = env.PARTNER_ID_FIELD || "retail_store_id";
  const partnerMap = new Map();

  for (const row of todayRows) {
    const id = getByPath(row, partnerIdField) || getByPath(row, partnerNameField) || "unknown";
    const name = String(getByPath(row, partnerNameField) || "未命名合伙人").trim();
    const current =
      partnerMap.get(id) || {
        id,
        name,
        rows: []
      };
    current.rows.push(row);
    partnerMap.set(id, current);
  }

  const topPartners = [...partnerMap.values()]
    .map((partner) => ({
      id: partner.id,
      name: partner.name,
      ...countRows(partner.rows, phoneFields)
    }))
    .sort((a, b) => b.totalBindings - a.totalBindings || b.phoneObtained - a.phoneObtained)
    .slice(0, Number(env.TOP_PARTNER_LIMIT || 20));

  return {
    reportDate,
    cumulative: countRows(rows, phoneFields),
    store: countRows(todayRows, phoneFields),
    topPartners
  };
}

function formatSummaryReport(stats) {
  const title = env.REPORT_TITLE || "恒奕美源绑定数据播报";
  return [
    `${title}`,
    `日期：${stats.reportDate}`,
    `生成时间：${timestamp()}`,
    "",
    "【截止当前累计】",
    `总绑定：${stats.cumulative.totalBindings}`,
    `有手机号：${stats.cumulative.phoneObtained}`,
    `无手机号：${stats.cumulative.phoneMissing}`,
    `手机号获取率：${percent(stats.cumulative.phoneRate)}`,
    "",
    "【今日新增】",
    `总绑定：${stats.store.totalBindings}`,
    `有手机号：${stats.store.phoneObtained}`,
    `无手机号：${stats.store.phoneMissing}`,
    `手机号获取率：${percent(stats.store.phoneRate)}`
  ].join("\n");
}

function formatPartnerLines(partners, startIndex) {
  const lines = [];

  for (const [index, partner] of partners.entries()) {
    lines.push(`${startIndex + index}. ${partner.name}`);
    lines.push(
      `绑定 ${partner.totalBindings}｜有号 ${partner.phoneObtained}｜无号 ${partner.phoneMissing}`
    );
    if (index < partners.length - 1) lines.push("");
  }

  return lines;
}

function formatTopPartnerReport(stats, start, end) {
  const partners = stats.topPartners.slice(start - 1, end);
  const lines = [`今日合伙人绑定 TOP${start}-${end}`];

  if (partners.length === 0) {
    lines.push("今日暂无合伙人绑定数据");
  } else {
    lines.push(...formatPartnerLines(partners, start));
  }

  return lines.join("\n");
}

function formatReports(stats) {
  const reports = [
    formatSummaryReport(stats),
    formatTopPartnerReport(stats, 1, 10)
  ];
  if (!top10Only) reports.push(formatTopPartnerReport(stats, 11, 20));
  return reports;
}

async function loginByMgCli() {
  if (!env.MG_CENTER_ACCOUNT || !env.MG_CENTER_PASSWORD) {
    throw new Error("缺少 MG_CENTER_ACCOUNT 或 MG_CENTER_PASSWORD，无法登录数据源。");
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

  return parseJson(stdout, "MG CLI 登录返回不是 JSON。");
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

function getTotal(payload) {
  for (const candidate of [
    env.BINDING_TOTAL_PATH,
    "data.total",
    "data.total_count",
    "data.count",
    "total",
    "total_count",
    "count"
  ]) {
    const total = parseNumber(getByPath(payload, candidate));
    if (total !== undefined) return total;
  }
  return undefined;
}

function getRows(payload) {
  return asArray(getByPath(payload, env.BINDING_LIST_PATH || "data.list"));
}

function withPage(urlText, page, pageSize) {
  const url = new URL(urlText);
  url.searchParams.set(env.BINDING_PAGE_PARAM || "page", String(page));
  url.searchParams.set(env.BINDING_PAGE_SIZE_PARAM || "page_size", String(pageSize));
  return url.toString();
}

async function fetchJson(url, headers) {
  const method = env.BINDING_DATA_METHOD || "GET";
  const response = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(env.BINDING_DATA_BODY ? { "content-type": "application/json" } : {})
    },
    body: env.BINDING_DATA_BODY || undefined
  });

  if (!response.ok) {
    throw new Error(`数据源请求失败：HTTP ${response.status}`);
  }

  return response.json();
}

async function fetchHttpPayload() {
  if (!env.BINDING_DATA_URL) {
    throw new Error("缺少 BINDING_DATA_FILE 或 BINDING_DATA_URL。");
  }

  const headers = { accept: "application/json" };

  if ((env.BINDING_DATA_LOGIN || "none") === "mg") {
    const login = await loginByMgCli();
    const tokenField = env.MG_LOGIN_TOKEN_FIELD || "token";
    const token = login[tokenField] || login?.data?.[tokenField];
    if (!token) throw new Error(`MG CLI 登录成功，但未找到 ${tokenField}。`);
    const headerMode = env.BINDING_DATA_AUTH_HEADER || "authorization-bearer";
    if (headerMode === "authorization-bearer") headers.authorization = `Bearer ${token}`;
    if (headerMode === "mmf-token") headers["mmf-token"] = token;
    if (headerMode === "token") headers.token = token;
  }

  if ((env.BINDING_PAGINATE || "false") !== "true") {
    return fetchJson(env.BINDING_DATA_URL, headers);
  }

  const pageSize = Number(env.BINDING_PAGE_SIZE || 100);
  const maxPage = Number(env.BINDING_MAX_PAGE || 200);
  const rows = [];
  let total;

  for (let page = 1; page <= maxPage; page += 1) {
    const payload = await fetchJson(withPage(env.BINDING_DATA_URL, page, pageSize), headers);
    const pageRows = getRows(payload);
    if (total === undefined) total = getTotal(payload);
    rows.push(...pageRows);
    if (pageRows.length === 0) break;
    if (total !== undefined && rows.length >= total) break;
    if (pageRows.length < pageSize) break;
  }

  return {
    response: {
      data: rows,
      total: total ?? rows.length
    }
  };
}

async function loadPayload() {
  const defaultDataFile = "./data/binding-sample.json";
  if (env.BINDING_DATA_FILE || !env.BINDING_DATA_URL) {
    const filePath = path.resolve(projectRoot, env.BINDING_DATA_FILE || defaultDataFile);
    return JSON.parse(await readFile(filePath, "utf8"));
  }

  return fetchHttpPayload();
}

async function refreshSybCache() {
  if ((env.SYB_REFRESH_CACHE || "true") !== "true") return;
  if (!env.MG_SALON_ACCOUNT || !env.MG_SALON_PASSWORD) {
    throw new Error("缺少 MG_SALON_ACCOUNT 或 MG_SALON_PASSWORD，无法刷新私域宝授权缓存。");
  }

  await execFileAsync("npx", ["-y", "yz-mg-cli@latest", "salon-login", "--field", "token"], {
    env: process.env,
    timeout: 30000,
    maxBuffer: 1024 * 1024 * 2
  });

  const sybArgs = ["-y", "yz-mg-cli@latest", "salon-syb-list", "--field", "all"];
  if (env.MG_SYB_HANDSET) sybArgs.push("--handset", env.MG_SYB_HANDSET);
  await execFileAsync("npx", sybArgs, {
    env: process.env,
    timeout: 30000,
    maxBuffer: 1024 * 1024 * 5
  });
}

async function sendBySyb(text) {
  if (!env.MG_SYB_ROBOT_ID) {
    throw new Error("缺少 MG_SYB_ROBOT_ID，无法发送私域宝消息。");
  }
  const senderIds = String(env.MG_SYB_SENDER_IDS || env.MG_SYB_SENDER_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (senderIds.length === 0 && !env.MG_SYB_GROUP_ID) {
    throw new Error("缺少 MG_SYB_SENDER_IDS、MG_SYB_SENDER_ID 或 MG_SYB_GROUP_ID，无法发送私域宝消息。");
  }

  await refreshSybCache();

  const targets =
    senderIds.length > 0
      ? senderIds.map((id) => ["--sender-id", id])
      : [["--group-id", env.MG_SYB_GROUP_ID]];

  for (const targetArgs of targets) {
    const sendArgs = [
      "-y",
      "yz-mg-cli@latest",
      "salon-syb-send",
      "--robot-id",
      env.MG_SYB_ROBOT_ID,
      ...targetArgs,
      "--text",
      text
    ];

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await execFileAsync("npx", sendArgs, {
          env: process.env,
          timeout: 30000,
          maxBuffer: 1024 * 1024 * 2
        });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }

    if (lastError) throw lastError;
  }
}

async function main() {
  const payload = await loadPayload();
  const stats = buildStats(payload);
  const reports = formatReports(stats);

  console.log(
    reports
      .map((report, index) => (index === 0 ? report : `--- 第${index + 1}条推送 ---\n\n${report}`))
      .join("\n\n")
  );

  if (dryRun) {
    console.log("\nDRY_RUN：已生成消息，未发送私域宝。");
    return;
  }

  try {
    for (const report of reports) {
      await sendBySyb(report);
    }
    console.log("\n私域宝推送成功。");
  } catch (error) {
    console.error("\n数据已生成，但私域宝推送失败，请检查门店账号、私域宝账号、robotId、senderId/groupId 配置。");
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
