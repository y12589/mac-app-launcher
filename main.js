const { Plugin, ItemView, Notice, PluginSettingTab, Setting, Menu, Modal, TFile, TFolder, requestUrl } = require("obsidian");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
// 打开外部网页：仅允许 http/https，避免把 file:/javascript:/data: 等协议交给系统打开。
let electronShell = null;
try { electronShell = require("electron").shell; } catch (e) { /* 非 Electron 环境回退到 window.open */ }

function normalizeExternalHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  // 兼容用户只填写域名的旧配置；未写协议时默认补 https://。
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch (e) {
    return null;
  }
}

function openExternalUrl(url) {
  const safeUrl = normalizeExternalHttpUrl(url);
  if (!safeUrl) {
    if (url) new Notice("链接无效或协议不受支持，仅允许 http:// 和 https:// 地址");
    return false;
  }
  try {
    if (electronShell && typeof electronShell.openExternal === "function") {
      const pending = electronShell.openExternal(safeUrl);
      if (pending && typeof pending.catch === "function") {
        pending.catch(error => {
          console.error("[Mac App Launcher] Open external URL failed", error);
          new Notice("无法打开网页，请检查链接或系统浏览器设置");
        });
      }
      return true;
    }
  } catch (e) {
    console.warn("[Mac App Launcher] Electron openExternal failed", e);
  }
  try {
    const opened = window.open(safeUrl, "_blank");
    if (!opened) {
      new Notice("浏览器未能打开网页，请检查弹窗设置");
      return false;
    }
    return true;
  } catch (e) {
    console.error("[Mac App Launcher] window.open failed", e);
    new Notice("无法打开网页");
    return false;
  }
}

// 福利卡片优先通过稳定 appId 关联本地应用；旧版 appMatch 关键词仅作兼容回退。
// 关键词必须唯一命中，避免相似应用名称导致启动错误客户端。
function resolveComputeCardApp(card, apps) {
  if (!card || !Array.isArray(apps) || !apps.length) return null;
  if (card.appId) {
    // 已有稳定 ID 但本机找不到对应应用时，不再猜测其他同名/相似应用。
    return apps.find(app => String(app.id || "") === String(card.appId)) || null;
  }
  const raw = String(card.appMatch || "");
  const tokens = raw
    .split(/[·・|/,，、\s]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const exact = apps.filter(app => String(app.name || "").toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    const partial = apps.filter(app => String(app.name || "").toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) return null;
  }
  return null;
}

function migrateComputeCardAppLinks(cards, apps) {
  let changed = false;
  if (!Array.isArray(cards)) return false;
  for (const card of cards) {
    if (!card || card.appId) continue;
    const app = resolveComputeCardApp(card, apps);
    if (!app || !app.id) continue;
    card.appId = app.id;
    changed = true;
  }
  return changed;
}

function isValidDateKey(value) {
  const key = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const parsed = new Date(`${key}T12:00:00`);
  return Number.isFinite(parsed.getTime()) && dateKey(parsed) === key;
}

function normalizeComputeCard(card, index = 0) {
  const source = card && typeof card === "object" ? card : {};
  const amount = Number(source.amount);
  const cycle = ["once", "daily", "monthly"].includes(source.cycle) ? source.cycle : "daily";
  return {
    ...source,
    id: String(source.id || `compute-${crypto.createHash("sha1").update(`${source.name || "福利"}|${source.group || "自定义"}|${index}`).digest("hex").slice(0, 12)}`),
    name: String(source.name || "未命名福利"),
    group: String(source.group || "自定义"),
    cycle,
    value: String(source.value || ""),
    amount: Number.isFinite(amount) && amount >= 0 ? amount : 0,
    currency: String(source.currency || "CNY"),
    url: String(source.url || ""),
    appId: String(source.appId || ""),
    appMatch: String(source.appMatch || ""),
    desc: String(source.desc || ""),
    emoji: String(source.emoji || "⚡"),
    color: /^#[0-9a-f]{6}$/i.test(String(source.color || "")) ? source.color : "#0ea5e9",
    validFrom: isValidDateKey(source.validFrom) ? source.validFrom : "",
    validUntil: isValidDateKey(source.validUntil) ? source.validUntil : "",
    enabled: source.enabled !== false
  };
}

function hasOwnField(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function isSystemAppPath(value) {
  const appPath = String(value && typeof value === "object" ? value.path || "" : value || "");
  return appPath.includes("/System/");
}

function isWebOnlyApp(app) {
  return !!app && !String(app.path || "") && !!app.webOnly && !isSystemAppPath(app.path);
}

function normalizeClaimRecord(record, index = 0) {
  const source = record && typeof record === "object" ? record : {};
  // 保留旧记录的所有扩展字段；只规范已有字段，不用当前时间/卡片 ID 猜测缺失历史。
  const result = { ...source };
  if (!hasOwnField(source, "id") || source.id === undefined || source.id === null || source.id === "") {
    const stableCardId = String(source.cardId || "orphan");
    const stablePeriod = String(source.periodKey || index);
    result.id = `claim-${stableCardId}-${stablePeriod}-${index}`;
  } else {
    result.id = String(source.id);
  }
  if (hasOwnField(source, "cardId") && source.cardId !== undefined && source.cardId !== null) {
    result.cardId = String(source.cardId);
  }
  if (hasOwnField(source, "periodKey") && source.periodKey !== undefined && source.periodKey !== null) {
    result.periodKey = String(source.periodKey);
  }
  if (hasOwnField(source, "claimedAt") && source.claimedAt !== undefined && source.claimedAt !== null && source.claimedAt !== "") {
    const claimedAt = Number(source.claimedAt);
    result.claimedAt = Number.isFinite(claimedAt) && claimedAt > 0 ? claimedAt : source.claimedAt;
  }
  if (hasOwnField(source, "amountSnapshot") && source.amountSnapshot !== undefined && source.amountSnapshot !== null) {
    const amount = Number(source.amountSnapshot);
    if (Number.isFinite(amount) && amount >= 0) result.amountSnapshot = amount;
  }
  if (hasOwnField(source, "valueSnapshot") && source.valueSnapshot !== undefined && source.valueSnapshot !== null) {
    result.valueSnapshot = String(source.valueSnapshot);
  }
  if (hasOwnField(source, "currency") && source.currency !== undefined && source.currency !== null) {
    result.currency = String(source.currency);
  }
  if (hasOwnField(source, "source") && source.source !== undefined && source.source !== null) {
    result.source = String(source.source);
  }
  return result;
}

function claimTimestamp(record) {
  const numeric = Number(record && record.claimedAt);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(record && record.claimedAt || ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function canonicalClaimPeriod(record, card) {
  const cycle = card && card.cycle || "daily";
  if (cycle === "once") return "once";
  const raw = String(record && record.periodKey || "");
  if (cycle === "monthly") {
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    if (isValidDateKey(raw)) return raw.slice(0, 7);
    const timestamp = claimTimestamp(record);
    return timestamp ? dateKey(new Date(timestamp)).slice(0, 7) : "";
  }
  if (isValidDateKey(raw)) return raw;
  const timestamp = claimTimestamp(record);
  return timestamp ? dateKey(new Date(timestamp)) : "";
}

function migrateLegacyComputeClaims(legacyMap, cards) {
  const byId = new Map((Array.isArray(cards) ? cards : []).map(card => [String(card.id), card]));
  const records = [];
  const seen = new Set();
  for (const [day, ids] of Object.entries(legacyMap && typeof legacyMap === "object" ? legacyMap : {})) {
    if (!isValidDateKey(day) || !Array.isArray(ids)) continue;
    for (const rawCardId of ids) {
      const cardId = String(rawCardId || "");
      const card = byId.get(cardId);
      // 已删除卡片的旧 ID 是孤儿记录：跳过迁移，不删除旧 computeCheckins。
      if (!card) continue;
      const cycle = card.cycle || "daily";
      const periodKey = cycle === "once" ? "once" : cycle === "monthly" ? day.slice(0, 7) : day;
      const uniqueKey = `${cardId}::${periodKey}`;
      if (seen.has(uniqueKey)) continue;
      seen.add(uniqueKey);
      const parsed = Date.parse(`${day}T12:00:00`);
      records.push(normalizeClaimRecord({
        id: `legacy-${day}-${cardId}`,
        cardId,
        periodKey,
        claimedAt: Number.isFinite(parsed) ? parsed : 0,
        amountSnapshot: Number(card.amount) || 0,
        valueSnapshot: card.value || "",
        currency: card.currency || "CNY",
        source: "legacy-migration"
      }, records.length));
    }
  }
  return records;
}

// 合并新旧领取记录。旧映射始终保留；现有记录优先，旧映射只补缺失周期。
// 孤儿记录原样保留在数组中，但不参与周期去重和统计。
function mergeComputeClaimRecords(existingRecords, legacyMap, cards, rawExistingRecords) {
  const byId = new Map((Array.isArray(cards) ? cards : []).map(card => [String(card.id), card]));
  const result = [];
  const seen = new Map();
  const rawList = Array.isArray(rawExistingRecords) ? rawExistingRecords : [];
  const input = Array.isArray(existingRecords) ? existingRecords : [];

  const mergeMissingFields = (target, source) => {
    for (const [key, value] of Object.entries(source || {})) {
      if (!hasOwnField(target, key) || target[key] === undefined) target[key] = value;
    }
  };

  const addRecord = (rawRecord, index, rawSource, isLegacy = false) => {
    const record = normalizeClaimRecord(rawRecord, index);
    const card = byId.get(String(record.cardId || ""));
    if (!card) {
      result.push(record);
      return;
    }

    // periodKey 缺失时仅从该记录自身的时间戳推导；已有空字符串等值不覆盖。
    if (rawSource && (!hasOwnField(rawSource, "periodKey") || rawSource.periodKey === undefined)) {
      const derived = canonicalClaimPeriod(record, card);
      if (derived) record.periodKey = derived;
    }
    if (isLegacy && !hasOwnField(rawRecord, "source")) record.source = "legacy-migration";

    const period = canonicalClaimPeriod(record, card);
    if (!period) {
      result.push(record);
      return;
    }
    const uniqueKey = `${card.id}::${period}`;
    if (seen.has(uniqueKey)) {
      mergeMissingFields(result[seen.get(uniqueKey)], record);
      return;
    }
    seen.set(uniqueKey, result.length);
    result.push(record);
  };

  input.forEach((record, index) => addRecord(record, index, rawList[index] || record, false));
  const legacyRecords = migrateLegacyComputeClaims(legacyMap, cards);
  legacyRecords.forEach((record, index) => addRecord(record, input.length + index, record, true));

  // 去重合并后才回填快照：若重复记录中已有历史快照，优先保留它而不是用当前卡片估值覆盖。
  for (const record of result) {
    const card = byId.get(String(record.cardId || ""));
    if (!card) continue; // 孤儿记录不补字段、不计入统计。
    if (!hasOwnField(record, "amountSnapshot") || record.amountSnapshot === undefined) {
      record.amountSnapshot = Number(card.amount) || 0;
    }
    if (!hasOwnField(record, "valueSnapshot") || record.valueSnapshot === undefined) {
      record.valueSnapshot = String(card.value || "");
    }
    if (!hasOwnField(record, "currency") || record.currency === undefined) {
      record.currency = String(card.currency || "CNY");
    }
    if (!hasOwnField(record, "periodKey") || record.periodKey === undefined) {
      const derived = canonicalClaimPeriod(record, card);
      if (derived) record.periodKey = derived;
    }
  }
  return result;
}

function isAppBundleInstalled(app) {
  const appPath = String(app?.path || "");
  if (!appPath || !fs.existsSync(appPath)) return false;
  return fs.existsSync(path.join(appPath, "Contents", "Info.plist"));
}

function isComputeCardInValidity(card, todayKey = dateKey(new Date())) {
  if (!card || card.enabled === false) return false;
  if (card.validFrom && todayKey < card.validFrom) return false;
  if (card.validUntil && todayKey > card.validUntil) return false;
  return true;
}

const VIEW_TYPE = "mac-app-launcher-view";
const SCHEMA_VERSION = 4; // 配置结构版本：4 = 安全迁移、应用关联回填与周期领取记录合并

// 关于页内置更新日志（发版时同步精简版，完整版见 GitHub CHANGELOG）
const ABOUT_CHANGELOG = [
  { version: "1.30.0", changes: ["首页重构：顶部仅显示最多 8 个常用应用，算力福利卡册成为首页主体", "首页搜索同时匹配应用与福利卡片", "移除应用笔记、关联知识、反向链接与应用资料 Bases 入口；不删除既有笔记文件及 notePath 历史字段", "不新增或删除持久化字段，保留旧首页布局配置与全部领取记录", "打开客户端/网页仍不自动打卡，领取必须人工确认"] },
  { version: "1.29.0", changes: ["安全迁移：备份失败时中止，不推进 schemaVersion；保留未知设置与全部历史字段", "应用资源回填：仅对原始数据缺少 bundleId 的本地应用读取 Info.plist；appMatch 唯一匹配时回填稳定 appId", "领取记录合并：合并 computeClaimRecords 与旧 computeCheckins，按 once / monthly / daily 周期去重并回填缺失快照", "孤儿领取记录保留在原始数据中但不计入统计；删除自定义应用时保留福利卡片原 appId", "系统应用路径含 /System/ 时不提供应用官网入口，网页应用统计与公开 API 排除系统应用", "应用重扫优先保留用户已有 bundleId、websiteUrl、pinnedOrder、hotkey、notePath、launchMode、category 等资料"] },
  { version: "1.28.0", changes: ["统一应用资源：应用资料新增官方网站入口并支持纯网页应用，首页启动与福利卡册共享同一应用记录", "Smart 启动：优先打开本地客户端，客户端缺失或启动失败时回退到网页；支持主动切换网页", "领取记录升级为独立周期记录，保存领取时估值快照，修改卡片估值不再改写历史累计价值", "福利卡片增加有效期与启停状态；统计只计入当前有效且可领取的福利", "修复旧版 computeSchema 不匹配时可能重置自定义卡片的问题；迁移旧领取记录并保留历史", "应用重扫时尽量保留原应用 ID，减少福利关联、场景和文件规则失效"] },
  { version: "1.27.1", changes: ["修复：打开客户端或网页不再自动记为已领取，必须由用户手动确认", "卡片列表增加「标记已收」独立操作，详情页打开入口后保留确认按钮", "福利卡片支持关联稳定应用 ID；旧版关键词仅在唯一匹配时迁移，避免误启动相似应用", "外部链接仅允许 http/https，校验福利链接并拒绝不安全协议", "优化卡册福利列表的响应式网格布局"] },
  { version: "1.27.0", changes: ["算力卡册增加客户端 / 网页双向启动入口，客户端优先并可手动切换", "算力卡册活跃月历迁移到卡册页顶部，首页保留三栏工作区"] },
  { version: "1.26.0", changes: ["首页改为桌面启动器风格：大时钟、日期农历一行、居中搜索框，仪表盘与分类去卡片底", "应用磁贴支持 1×1 / 2×1 / 1×2 / 2×2 四种布局，右键「布局」切换，图标等比放大", "图标右键菜单：编辑 / 更换自定义图标、恢复默认图标、编辑应用主页", "首页各模块（含分类）可自由拖拽换位、拖拽调整宽高，模块高度自适应内容并持久化", "移除「最近启动」模块与卡片右上角置顶星标，分类导航去掉「全部」并整体居中", "细节打磨：分类标题竖条与分隔线、芯片条柔和选中态、悬停浮起与图标投影"] },
  { version: "1.25.1", changes: ["万年历、今日天气、活跃月历改为同一行三列展示，卡片宽度收窄，窗口变窄时自动折行"] },
  { version: "1.25.0", changes: ["首页新增万年历：公历、星期、农历干支生肖、节日，并显示今日上班/休息（按法定节假日与调休安排）", "新增今日天气：简单显示温度与天气，位置可留空自动定位或指定城市，缓存 30 分钟", "新增活跃月历：按天统计应用启动次数的热力图，可前后翻月查看"] },
  { version: "1.24.11", changes: ["手动添加应用改为原生选择器：点「选择应用…」在 Finder 里挑 .app，选完自动填路径，不必手动输入"] },
  { version: "1.24.10", changes: ["紧急修复：自动更新误判导致「下载→覆盖→重载」死循环，版本比较改读磁盘 manifest（1.24.9 打包时被循环覆盖，已作废）"] },
  { version: "1.24.8", changes: ["最近启动条隐藏置顶星标，图标条更干净"] },
  { version: "1.24.7", changes: ["最近启动条只显示图标（隐藏名称，固定小方格）", "头部新增 ↻ 重载插件按钮，一键禁用再启用，不必重启 Obsidian"] },
  { version: "1.24.6", changes: ["最近启动条改为紧凑小图标样式，与下方分类网格视觉区分"] },
  { version: "1.24.5", changes: ["修复：自定义分类未登记进分类表导致拖拽排序静默失效，启动时自动补登", "分类芯片拖到导航空白处可排到末尾；新设分类自动进入分类管理面板"] },
  { version: "1.24.4", changes: ["分类拖拽排序：首页分类芯片按住拖动即可换位，插到目标分类之前", "排序全局生效：首页分区、管理列表、分类管理面板同一套顺序"] },
  { version: "1.24.3", changes: ["管理列表按「分类管理」的排序规则分组排列，同分类内按名称排序", "批量选择默认收起：点工具条「批量操作」才出现勾选框与操作条"] },
  { version: "1.24.2", changes: ["管理应用：点应用名称或图标即可切换展示，两个勾选框各有用途提示", "完成按钮回报已选数量，未选时给出操作指引；管理列表勾选框错位修复"] },
  { version: "1.24.1", changes: ["修复：重扫应用后关联笔记、置顶顺序、单应用快捷键丢失", "修复：配置迁移备份与调试日志因目录方法缺失静默失效（schemaVersion 卡住）", "关联笔记自愈：按名称兜底命中后自动回写绑定"] },
  { version: "1.24.0", changes: ["开发者 API v2：search / getApp / scenes / isRunning 查询接口", "启动事件订阅：on(\"app-launched\" / \"scene-launched\")，第三方插件可联动", "新增 DEV-API.md 开发者文档"] },
  { version: "1.23.0", changes: ["非 macOS 平台明确提示并自动停用，不再静默失效", "下载镜像强制 https:// 协议白名单，非法镜像自动回退直连并提示"] },
  { version: "1.22.0", changes: ["性能包：应用网格分批渲染，几百个应用也不卡", "图标懒加载：滚动进视口才读取图标，管理页同样生效", "扫描与场景执行写入调试日志，方便观察耗时"] },
  { version: "1.21.0", changes: ["配置版本化：旧配置自动备份后迁移，升级可回滚", "调试日志（可开关、可清除），一键清除使用统计与图标缓存"] },
  { version: "1.20.0", changes: ["自定义文件关联规则：扩展名绑定指定应用，右键菜单优先显示", "使用统计视图：Top 10 排行、最近启动、最近 7 天趋势"] },
  { version: "1.19.0", changes: ["画布自动执行支持命令与文件夹节点：场景导出的画布可以整条工作流一键执行"] },
  { version: "1.18.0", changes: ["场景升级为混合工作流：应用、笔记、文件夹、Obsidian 命令四种步骤有序执行", "命令白名单：只能执行亲手挑进场景的已注册命令，失效自动跳过并提示"] },
  { version: "1.17.1", changes: ["文档补齐：README 与 Agent 接入说明覆盖 1.8–1.17 全部新功能"] },
  { version: "1.17.0", changes: ["Canvas 工作流自动执行：按连线顺序启动应用、打开笔记，循环连线自动拦截"] },
  { version: "1.16.0", changes: ["场景启动感知运行状态：已在运行的应用自动跳过，不重复拉起"] },
  { version: "1.15.0", changes: ["场景一键导出 Canvas 工作流：应用节点可点击启动，连线串联执行顺序"] },
  { version: "1.14.0", changes: ["一键生成 Bases 数据库视图，应用资料卡接入 Obsidian 原生数据库"] },
  { version: "1.13.0", changes: ["开放 window.MacAppLauncher API，QuickAdd / Templater 可直接启动应用与场景", "配置导入导出：应用、场景、分类一键跨 Vault 迁移"] },
  { version: "1.12.0", changes: ["编辑器类应用可直接打开当前 Vault，终端类应用可进入当前笔记目录"] },
  { version: "1.11.0", changes: ["启动日志可自动写入每日笔记（默认关闭，设置页开启）"] },
  { version: "1.10.0", changes: ["应用知识库：一键为应用创建资料卡笔记，详情弹窗展示反向链接"] },
  { version: "1.9.0", changes: ["Frontmatter 应用绑定：笔记用 apps / app-scene 声明工作环境", "文件列表右键菜单：按文件类型推荐应用打开、启动绑定场景"] },
  { version: "1.8.0", changes: ["当前笔记智能推荐相关应用", "笔记内嵌 app-launcher 启动卡片", "场景注册到命令面板，一键启动"] },
  { version: "1.7.6", changes: ["设置页新增关于弹窗，内置更新日志"] },
  { version: "1.7.5", changes: ["关闭场景改为 bundle ID 匹配，中文名应用也能准确退出"] },
  { version: "1.7.4", changes: ["更新下载失败自动重试，支持自定义加速镜像", "启动 Obsidian 可自动拉起指定场景", "场景错峰启动，新增一键关闭场景"] },
  { version: "1.7.3", changes: ["作者名改为阎大大，插件介绍改为中文"] },
  { version: "1.7.2", changes: ["设置页 UI 重构：版本徽章、服务状态行、分组优化"] },
  { version: "1.7.1", changes: ["应用详情改回居中弹窗，设置页新增关于区"] },
  { version: "1.7.0", changes: ["自定义分类与批量分类、归类学习", "拼音搜索（首字母/全拼）", "场景模式、最近启动、单应用快捷键", "Agent API 增强：搜索、模糊启动、批量启动"] }
];
const DEFAULT_CATEGORY_META = [
  { name: "AI助手", icon: "🤖" }, { name: "AI智能体", icon: "🦾" },
  { name: "办公工具", icon: "📝" }, { name: "开发工具", icon: "🛠" },
  { name: "设计工具", icon: "🎨" }, { name: "浏览器", icon: "🌐" },
  { name: "影音工具", icon: "🎬" }, { name: "系统工具", icon: "⚙️" },
  { name: "其他", icon: "📦" }, { name: "未分类", icon: "❓" }
];
const DEFAULT_CATEGORIES = DEFAULT_CATEGORY_META.map(c => c.name);

// 算力打卡卡册：默认卡面（参考 aibotone.com/compute 的福利清单，可在卡册里增删改）
// cycle: once 一次性 / daily 每日 / monthly 每月；amount 为估值元，仅用于统计
const DEFAULT_COMPUTE_CARDS = [
  // 新人礼包（一次性）
  { id: "aliyun-token", group: "新人礼包", cycle: "once", name: "阿里云 · 1.3 亿 Token", value: "1.3 亿 Token", amount: 450, emoji: "☁️", color: "#fb7185", desc: "通义千问、DeepSeek、GLM、Kimi 等模型 API，适合聊天、推理和代码助手。", url: "https://opc.aliyun.com/products" },
  { id: "glm-token", group: "新人礼包", cycle: "once", name: "GLM-5.3-Flash · 1 亿 Token", value: "1 亿 Token", amount: 300, emoji: "🧠", color: "#60a5fa", desc: "AI 编程：代码生成、排错和推理，ZCode 邀请权益以活动页为准。", url: "https://zcode.z.ai/", appMatch: "ZCode,智谱" },
  { id: "workbuddy-2000", group: "新人礼包", cycle: "once", name: "WorkBuddy · 新人 2000 积分", value: "2000 积分", amount: 49, emoji: "🟢", color: "#34d399", desc: "AI 办公：文档、表格与工作流自动化，注册登录后核对新人积分。", url: "https://www.workbuddy.cn/", appMatch: "WorkBuddy" },
  { id: "workbuddy-intl", group: "新人礼包", cycle: "once", name: "WorkBuddy 国际版 · 350 积分", value: "350 积分", amount: 8, emoji: "🌐", color: "#22d3ee", desc: "AI 办公：文档和浏览器自动化，可选模型以国际版客户端为准。", url: "https://workbuddy.ai/", appMatch: "WorkBuddy" },
  { id: "siliconflow-16", group: "新人礼包", cycle: "once", name: "硅基流动 · 16 元代金券", value: "16 元通用代金券", amount: 16, emoji: "⚡", color: "#2dd4bf", desc: "模型推理与微调，邀请注册并完成实名认证后双方各得 16 元。", url: "https://cloud.siliconflow.cn/" },
  { id: "hw-codedao-new", group: "新人礼包", cycle: "once", name: "华为云码道 · 新人礼包", value: "5000 积分", amount: 50, emoji: "☁️", color: "#f59e0b", desc: "AI 编程：代码补全与排错，符合条件的新用户开通个人版可叠加积分。", url: "https://devcloud.cn-north-4.huaweicloud.com/chat" },
  // 服务器 GPU（一次性）
  { id: "kaggle-gpu", group: "服务器 GPU", cycle: "once", name: "Kaggle · 免费 GPU 笔记本", value: "双 T4 GPU · 按账号配额", amount: 0, emoji: "🖥️", color: "#6366f1", desc: "模型训练、推理与视频实验，T4 每张 16 GB，GPU 按周限额。", url: "https://www.kaggle.com/code" },
  { id: "aws-100", group: "服务器 GPU", cycle: "once", name: "AWS · 新用户 100 美元赠金", value: "100 美元赠金", amount: 720, emoji: "🟠", color: "#fb923c", desc: "云服务器：部署网站、数据库和后台任务，GPU 可用性取决于账户权限与配额。", url: "https://aws.amazon.com/free/" },
  { id: "scnet-trial", group: "服务器 GPU", cycle: "once", name: "国家超算互联网 · 免费算力试用", value: "部分规格可试用", amount: 0, emoji: "🏛️", color: "#94a3b8", desc: "模型训练与 Notebook 推理，算力市场按资源显示试用卡时与库存。", url: "https://www.scnet.cn/ui/mall/" },
  // 每日福利
  { id: "workbuddy-daily", group: "每日福利", cycle: "daily", name: "WorkBuddy · Buddy 加油站", value: "每日登录福利", amount: 5, emoji: "🟢", color: "#34d399", desc: "文档、表格和自动化，登录客户端领取当日福利。", url: "https://www.workbuddy.cn/", appMatch: "WorkBuddy" },
  { id: "trae-daily", group: "每日福利", cycle: "daily", name: "TRAE 每日签到", value: "免费版每日 100 积分", amount: 1, emoji: "🧩", color: "#0ea5e9", desc: "登录 TRAE 后从头像菜单签到，积分有效期 31 个自然日。", url: "https://www.trae.cn/", appMatch: "TRAE" },
  { id: "qoder-daily", group: "每日福利", cycle: "daily", name: "Qoder CN · 每日领取", value: "每日 100 通用 Credits", amount: 1, emoji: "💻", color: "#a78bfa", desc: "AI 编程、代码库问答，需手动领取。", url: "https://qoder.cn/", appMatch: "Qoder" },
  { id: "hw-codedao-daily", group: "每日福利", cycle: "daily", name: "华为云码道 · 每日签到", value: "体验版每日 100 积分", amount: 1, emoji: "☁️", color: "#f59e0b", desc: "个人体验版进入「活动福利」领取，当日有效。", url: "https://devcloud.cn-north-4.huaweicloud.com/chat", appMatch: "CodeArts,码道" },
  { id: "xiaohuanxiong-daily", group: "每日福利", cycle: "daily", name: "商汤小浣熊 · 每日赠送", value: "免费版每日 300 积分", amount: 3, emoji: "🦝", color: "#fb923c", desc: "PPT、数据分析，每天 0 点自动发放，登录后积分有效期延至 7 天。", url: "https://www.xiaohuanxiong.com/", appMatch: "小浣熊" },
  { id: "qiniu-daily", group: "每日福利", cycle: "daily", name: "七牛云 Conatus · 每日额度", value: "实名用户每日 1 亿 Token", amount: 10, emoji: "🐟", color: "#22d3ee", desc: "图像理解、代码辅助、Agent 工具调用，免费额度仅限 conatus-free。", url: "https://www.qiniu.com/ai/free-models/conatus-2026", appMatch: "七牛" },
  // 每月福利
  { id: "trae-monthly", group: "每月福利", cycle: "monthly", name: "TRAE CN · 每月登录赠送", value: "每月 500 积分", amount: 5, emoji: "🧩", color: "#0ea5e9", desc: "代码生成、调试和智能体，按自然月发放。", url: "https://www.trae.cn/" },
  { id: "workbuddy-monthly", group: "每月福利", cycle: "monthly", name: "WorkBuddy · 体验版月度积分", value: "每月 500 积分", amount: 5, emoji: "🟢", color: "#34d399", desc: "文档、表格和工作流，按套餐周期发放。", url: "https://www.workbuddy.cn/" },
  { id: "antling-monthly", group: "每月福利", cycle: "monthly", name: "蚂蚁百灵 · 月度抵扣券", value: "每月 10 元 Token 抵扣券", amount: 10, emoji: "🐜", color: "#f472b6", desc: "Ling、Ming 模型 API，每月 1 日发放。", url: "https://www.ant-ling.com/" },
  { id: "edgeone-monthly", group: "每月福利", cycle: "monthly", name: "EdgeOne Makers · 免费模型额度", value: "每月 50 万 Token", amount: 5, emoji: "🌐", color: "#38bdf8", desc: "模型 API、原型与技术验证，免费版账号共享。", url: "https://pages.edgeone.ai/" },
  { id: "tencent-adp", group: "每月福利", cycle: "monthly", name: "腾讯云 ADP · 体验版", value: "每月 15,000 PU", amount: 10, emoji: "☁️", color: "#60a5fa", desc: "智能体、知识库与工作流，按平台用量发放。", url: "https://cloud.tencent.com/product/adp" },
  { id: "elevenlabs-monthly", group: "每月福利", cycle: "monthly", name: "ElevenLabs · 免费语音额度", value: "每月 10,000 Credits", amount: 10, emoji: "🎙️", color: "#a78bfa", desc: "配音、语音转写与音效，按订阅周期发放。", url: "https://elevenlabs.io/app/" }
];

// 文件右键菜单：扩展名 → 推荐应用分类
const EXT_CATEGORY_RULES = [
  { exts: ["md", "markdown", "txt"], cats: ["开发工具", "办公工具"] },
  { exts: ["png", "jpg", "jpeg", "gif", "webp", "svg", "psd", "ai", "sketch", "fig", "heic", "tif", "tiff"], cats: ["设计工具"] },
  { exts: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv"], cats: ["办公工具", "浏览器"] },
  { exts: ["mp4", "mov", "m4v", "avi", "mkv", "flv", "mp3", "wav", "flac", "aac", "m4a"], cats: ["影音工具"] },
  { exts: ["py", "js", "ts", "tsx", "jsx", "json", "html", "css", "java", "go", "rs", "rb", "php", "cpp", "c", "h", "sh", "yml", "yaml", "sql", "vue"], cats: ["开发工具"] }
];

// 归类学习：用户手动改过的分类按应用名记住，扫描时优先命中
function learnedCategory(name, rules) {
  if (!rules || !name) return "";
  const lower = String(name).toLowerCase();
  if (rules[lower]) return rules[lower];
  for (const [key, category] of Object.entries(rules)) {
    if (key.length >= 2 && lower.includes(key)) return category;
  }
  return "";
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(String(stdout || "").trim());
      }
    });
  });
}

function appId(appPath) {
  return crypto.createHash("sha1").update(appPath).digest("hex").slice(0, 16);
}

// ---- 性能工具：图标内存缓存 ----
class IconCache {
  constructor(maxSize = 200) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.pending = new Map(); // 正在读取中的 Promise，避免重复读
  }

  get(appId) {
    const entry = this.cache.get(appId);
    if (!entry) return null;
    entry.atime = Date.now();
    return entry.dataUrl;
  }

  set(appId, dataUrl) {
    if (this.cache.size >= this.maxSize) {
      // 淘汰最久未使用的
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [key, val] of this.cache) {
        if (val.atime < oldestTime) {
          oldestTime = val.atime;
          oldestKey = key;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(appId, { dataUrl, atime: Date.now() });
  }

  invalidate(appId) {
    this.cache.delete(appId);
    this.pending.delete(appId);
  }

  clear() {
    this.cache.clear();
    this.pending.clear();
  }

  async load(appId, iconPath, fs) {
    const cached = this.get(appId);
    if (cached) return cached;
    if (this.pending.has(appId)) return this.pending.get(appId);
    const promise = (async () => {
      try {
        const data = fs.readFileSync(iconPath).toString("base64");
        const dataUrl = `data:image/png;base64,${data}`;
        this.set(appId, dataUrl);
        return dataUrl;
      } catch (err) {
        return null;
      } finally {
        this.pending.delete(appId);
      }
    })();
    this.pending.set(appId, promise);
    return promise;
  }
}

// ---- 性能工具：防抖 ----
function debounce(fn, wait = 150) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

// ---- 搜索工具：模糊匹配 ----
function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) {
    // 连续匹配得分更高，前缀匹配最高
    const idx = t.indexOf(q);
    return 2 + (idx === 0 ? 1 : 0) + q.length / t.length;
  }
  // 子序列匹配
  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += lastMatch === -1 || i - lastMatch <= 2 ? 1 : 0.3;
      lastMatch = i;
      qi++;
    }
  }
  return qi === q.length ? score / q.length : 0;
}

function fuzzySearchApps(apps, query) {
  if (!query.trim()) return apps.map(app => ({ app, score: 1 }));
  const q = query.trim();
  const results = [];
  for (const app of apps) {
    const nameScore = fuzzyScore(q, app.name) * 3;
    const catScore = fuzzyScore(q, app.category || "") * 1.2;
    const descScore = fuzzyScore(q, app.description || "") * 0.8;
    const usageScore = fuzzyScore(q, app.usage || "") * 0.6;
    // 拼音维度：首字母（wx→微信）权重高于全拼
    const pinyinScore = Math.max(
      fuzzyScore(q, app.pinyinAbbr || "") * 2.4,
      fuzzyScore(q, app.pinyinFull || "") * 1.6
    );
    const score = nameScore + catScore + descScore + usageScore + pinyinScore;
    if (score > 0.2) results.push({ app, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---- 首页仪表条：万年历（公历 + 农历 + 节日 + 节气） ----
const LUNAR_MONTH_NAMES = { "正月": 1, "一月": 1, "二月": 2, "三月": 3, "四月": 4, "五月": 5, "六月": 6, "七月": 7, "八月": 8, "九月": 9, "十月": 10, "十一月": 11, "冬月": 11, "十二月": 12, "腊月": 12 };
const LUNAR_DAY_NAMES = ["初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"];
const ZODIAC_BY_BRANCH = { "子": "鼠", "丑": "牛", "寅": "虎", "卯": "兔", "辰": "龙", "巳": "蛇", "午": "马", "未": "羊", "申": "猴", "酉": "鸡", "戌": "狗", "亥": "猪" };
const WEEKDAY_NAMES = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
// 首页左上角「今日职场语录」：按日期轮换，同一天固定同一条
const WORK_QUOTES = [
  "「把注意力放在能改变的事上，其余的交给时间。」",
  "「先把最难的那件事做完，一天就顺了。」",
  "「工作的体面，来自把话说明白、把事做完整。」",
  "「不必证明自己很努力，交付结果就够了。」",
  "「能拒绝的人，才守得住自己的节奏。」",
  "「慢一点想清楚，快一点做到位。」",
  "「把情绪留在门外，把专业带进会议室。」",
  "「今天多做一件小事，明天就少一件麻烦。」",
  "「别用忙碌掩盖犹豫，先问自己在解决什么问题。」",
  "「边界不是冷漠，是让合作可持续。」",
  "「能被复述的方案，才是好方案。」",
  "「先完成，再完美；先对齐，再发力。」",
  "「不为难自己，也不为难别人。」",
  "「你的时间值钱，别人的时间也值钱。」",
  "「把功劳说清楚，把责任接得住。」",
  "「会休息的人，才跑得远。」",
  "「别急着表态，先听完再回答。」",
  "「把复杂留给自己，把简单交给对方。」",
  "「长期主义不是熬，是每天都在往前挪一点。」",
  "「专业，就是把重复的事越做越稳。」",
  "「不和烂事纠缠，是一种能力。」",
  "「先照顾好自己的状态，再谈效率。」",
  "「把每一次交付，当成下一次的信用。」",
  "「走得稳，比走得快重要。」"
];

function dailyWorkQuote(date = new Date()) {
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  return WORK_QUOTES[dayOfYear % WORK_QUOTES.length];
}
const SOLAR_FESTIVALS = { "1-1": "元旦", "2-14": "情人节", "3-8": "妇女节", "4-1": "愚人节", "5-1": "劳动节", "5-4": "青年节", "6-1": "儿童节", "9-10": "教师节", "10-1": "国庆节", "12-25": "圣诞节" };
const LUNAR_FESTIVALS = { "1-1": "春节", "1-15": "元宵节", "2-2": "龙抬头", "5-5": "端午节", "7-7": "七夕", "8-15": "中秋节", "9-9": "重阳节", "12-8": "腊八节", "12-23": "小年" };

function lunarMonthNumber(monthName) {
  if (!monthName) return 0;
  const clean = String(monthName).replace(/^闰/, "");
  return LUNAR_MONTH_NAMES[clean] || 0;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getCalendarInfo(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const info = {
    solar: `${year}年${month}月${day}日`,
    week: WEEKDAY_NAMES[date.getDay()],
    lunar: "",
    festival: SOLAR_FESTIVALS[`${month}-${day}`] || ""
  };
  try {
    const parts = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", { year: "numeric", month: "long", day: "numeric" })
      .formatToParts(date);
    const get = type => (parts.find(p => p.type === type) || {}).value || "";
    const yearName = get("yearName"); // 干支，如 丙午
    const monthName = get("month"); // 农历月，如 九月 / 闰九月
    const dayValue = Number(get("day")) || 0;
    const zodiac = ZODIAC_BY_BRANCH[yearName ? yearName.charAt(1) : ""] || "";
    const lunarMonth = lunarMonthNumber(monthName);
    const dayLabel = LUNAR_DAY_NAMES[dayValue - 1] || String(dayValue);
    const prefix = yearName ? `${yearName}年${zodiac ? "（" + zodiac + "）" : ""}` : "";
    info.lunar = `${prefix}${monthName}${dayLabel}`;
    if (!monthName.startsWith("闰")) {
      const lunarFestival = LUNAR_FESTIVALS[`${lunarMonth}-${dayValue}`];
      if (lunarFestival) info.festival = info.festival ? `${info.festival} · ${lunarFestival}` : lunarFestival;
    }
  } catch (error) {
    info.lunar = "";
  }
  return info;
}

// ---- 今日天气：Open-Meteo（免密钥、仅用坐标，不传任何本地数据） ----
const WMO_WEATHER = {
  0: { text: "晴", icon: "☀️" }, 1: { text: "大部晴朗", icon: "🌤" }, 2: { text: "多云", icon: "⛅" }, 3: { text: "阴", icon: "☁️" },
  45: { text: "雾", icon: "🌫" }, 48: { text: "雾凇", icon: "🌫" },
  51: { text: "毛毛雨", icon: "🌦" }, 53: { text: "小雨", icon: "🌦" }, 55: { text: "中雨", icon: "🌧" },
  56: { text: "冻雨", icon: "🌧" }, 57: { text: "冻雨", icon: "🌧" },
  61: { text: "小雨", icon: "🌧" }, 63: { text: "中雨", icon: "🌧" }, 65: { text: "大雨", icon: "🌧" },
  66: { text: "冻雨", icon: "🌧" }, 67: { text: "冻雨", icon: "🌧" },
  71: { text: "小雪", icon: "🌨" }, 73: { text: "中雪", icon: "🌨" }, 75: { text: "大雪", icon: "❄️" }, 77: { text: "雪粒", icon: "🌨" },
  80: { text: "阵雨", icon: "🌦" }, 81: { text: "阵雨", icon: "🌦" }, 82: { text: "强阵雨", icon: "⛈" },
  85: { text: "阵雪", icon: "🌨" }, 86: { text: "强阵雪", icon: "❄️" },
  95: { text: "雷阵雨", icon: "⛈" }, 96: { text: "雷雨伴冰雹", icon: "⛈" }, 99: { text: "雷雨伴冰雹", icon: "⛈" }
};

function weatherCodeInfo(code) {
  return WMO_WEATHER[Number(code)] || { text: "未知", icon: "🌡" };
}

// ---- 场景步骤：应用 / 笔记 / 文件夹 / Obsidian 命令 ----
const SCENE_STEP_ICONS = { app: "📱", note: "📄", folder: "📁", command: "⌘" };

function sanitizeSceneSteps(steps) {
  const out = [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    if (step.type === "app" && step.id) out.push({ type: "app", id: String(step.id) });
    else if (step.type === "note" && step.path) out.push({ type: "note", path: String(step.path) });
    else if (step.type === "folder" && step.path) out.push({ type: "folder", path: String(step.path) });
    else if (step.type === "command" && step.id) out.push({ type: "command", id: String(step.id), name: String(step.name || step.id) });
  }
  return out;
}

// 场景 steps 不存在时从旧字段 appIds 迁移（旧字段保留只读，保证降级不丢数据）
function ensureSceneSteps(scene) {
  if (Array.isArray(scene.steps)) scene.steps = sanitizeSceneSteps(scene.steps);
  else scene.steps = (Array.isArray(scene.appIds) ? scene.appIds : []).map(id => ({ type: "app", id: String(id) }));
  return scene.steps;
}

function sceneStepsSummary(plugin, scene) {
  const steps = ensureSceneSteps(scene);
  const counts = { app: 0, note: 0, folder: 0, command: 0 };
  for (const step of steps) if (counts[step.type] !== undefined) counts[step.type]++;
  const parts = [];
  if (counts.app) parts.push(`${counts.app} 应用`);
  if (counts.note) parts.push(`${counts.note} 笔记`);
  if (counts.folder) parts.push(`${counts.folder} 文件夹`);
  if (counts.command) parts.push(`${counts.command} 命令`);
  return parts.length ? parts.join(" · ") : "空场景";
}

// 通用搜索选择器：输入过滤、点击或回车选中
class MalPickerModal extends Modal {
  constructor(app, options) {
    super(app);
    this.pickerTitle = options.title || "选择";
    this.placeholder = options.placeholder || "输入关键词过滤";
    this.items = options.items || [];
    this.onPick = options.onPick || (() => {});
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mal-picker");
    contentEl.createEl("h3", { text: this.pickerTitle });
    const input = contentEl.createEl("input", { cls: "mal-picker-input", attr: { type: "text", placeholder: this.placeholder } });
    const list = contentEl.createDiv({ cls: "mal-picker-list" });
    const renderList = query => {
      list.empty();
      const q = query.trim().toLowerCase();
      const matched = this.items
        .filter(it => !q || it.label.toLowerCase().includes(q) || String(it.hint || "").toLowerCase().includes(q))
        .slice(0, 30);
      if (!matched.length) {
        list.createEl("p", { text: "没有匹配项", cls: "mal-muted" });
        return;
      }
      for (const it of matched) {
        const row = list.createDiv({ cls: "mal-picker-row" });
        row.createEl("span", { text: it.label, cls: "mal-picker-label" });
        if (it.hint) row.createEl("span", { text: it.hint, cls: "mal-picker-hint" });
        row.addEventListener("click", () => {
          this.close();
          this.onPick(it);
        });
      }
    };
    input.addEventListener("input", () => renderList(input.value));
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        const first = list.querySelector(".mal-picker-row");
        if (first) first.click();
      }
    });
    renderList("");
    setTimeout(() => input.focus(), 50);
  }
}

// 月历心情设置：点击日期格弹出，选表情 + 选颜色，可清除、可跳转当日日记
class MoodModal extends Modal {
  constructor(app, plugin, date, current) {
    super(app);
    this.plugin = plugin;
    this.date = date;
    this.current = current || {};
    this.emoji = current && current.emoji ? current.emoji : "";
    this.color = current && current.color ? current.color : "";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mal-mood-modal");
    const key = dateKey(this.date);
    contentEl.createEl("h3", { text: `${key} · 心情` });

    const emojiRow = contentEl.createDiv({ cls: "mal-mood-section" });
    emojiRow.createDiv({ cls: "mal-mood-label", text: "表情" });
    const emojiGrid = emojiRow.createDiv({ cls: "mal-mood-emojis" });
    const EMOJIS = ["😀", "😄", "😊", "🙂", "😐", "😴", "🤯", "😫", "😢", "😡", "🥳", "🤒"];
    for (const e of EMOJIS) {
      const item = emojiGrid.createDiv({ cls: "mal-mood-emoji", text: e });
      if (e === this.emoji) item.addClass("is-selected");
      item.addEventListener("click", () => {
        this.emoji = this.emoji === e ? "" : e;
        emojiGrid.querySelectorAll(".mal-mood-emoji").forEach(el => el.removeClass("is-selected"));
        if (this.emoji) item.addClass("is-selected");
      });
    }

    const colorRow = contentEl.createDiv({ cls: "mal-mood-section" });
    colorRow.createDiv({ cls: "mal-mood-label", text: "颜色" });
    const colorGrid = colorRow.createDiv({ cls: "mal-mood-colors" });
    const COLORS = ["#0ea5e9", "#22d3ee", "#2dd4bf", "#34d399", "#fbbf24", "#fb923c", "#f87171", "#f472b6", "#a78bfa", "#94a3b8"];
    for (const c of COLORS) {
      const item = colorGrid.createDiv({ cls: "mal-mood-swatch" });
      item.style.background = c;
      item.setAttribute("title", c);
      if (c.toLowerCase() === String(this.color).toLowerCase()) item.addClass("is-selected");
      item.addEventListener("click", () => {
        this.color = this.color.toLowerCase() === c.toLowerCase() ? "" : c;
        colorGrid.querySelectorAll(".mal-mood-swatch").forEach(el => el.removeClass("is-selected"));
        if (this.color) item.addClass("is-selected");
      });
    }

    const actions = contentEl.createDiv({ cls: "mal-mood-actions" });
    const saveBtn = actions.createEl("button", { cls: "mod-cta", text: "保存" });
    saveBtn.addEventListener("click", () => {
      if (!this.plugin.settings.moodDaily || typeof this.plugin.settings.moodDaily !== "object") this.plugin.settings.moodDaily = {};
      if (this.emoji || this.color) {
        this.plugin.settings.moodDaily[key] = { emoji: this.emoji, color: this.color };
      } else {
        delete this.plugin.settings.moodDaily[key];
      }
      this.plugin.saveSettings();
      this.close();
    });
    const clearBtn = actions.createEl("button", { text: "清除" });
    clearBtn.addEventListener("click", () => {
      if (this.plugin.settings.moodDaily) delete this.plugin.settings.moodDaily[key];
      this.plugin.saveSettings();
      this.close();
    });
    const noteBtn = actions.createEl("button", { text: "打开当日日记" });
    noteBtn.addEventListener("click", async () => {
      this.close();
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view && typeof leaf.view.openDayNote === "function") {
          await leaf.view.openDayNote(this.date);
          return;
        }
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// 算力卡面编辑：新增或修改一张卡片
class ComputeCardModal extends Modal {
  constructor(app, plugin, card, onDone) {
    super(app);
    this.plugin = plugin;
    this.card = card;
    this.onDone = onDone || (() => {});
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mal-compute-modal");
    contentEl.createEl("h3", { text: this.card ? `编辑卡片：${this.card.name}` : "添加卡片" });

    const field = (label, placeholder, value) => {
      contentEl.createDiv({ cls: "mal-mood-label", text: label });
      const input = contentEl.createEl("input", { attr: { type: "text", placeholder }, cls: "mal-mood-input" });
      input.value = value || "";
      return input;
    };

    const c = this.card || {};
    const nameInput = field("名称", "例如 GLM-5.3-Flash · 1 亿 Token", c.name);
    const valueInput = field("面值文案", "例如 1 亿 Token / 每月 500 积分", c.value);
    const amountInput = field("估值（元，仅用于统计）", "例如 300", c.amount === undefined ? "" : String(c.amount));
    const urlInput = field("专属领取网页（可选）", "https://…（留空时使用关联应用的官方网站）", c.url);
    contentEl.createDiv({ cls: "mal-mood-label", text: "关联统一应用资源（可选）" });
    const appSelect = contentEl.createEl("select", { cls: "dropdown" });
    appSelect.createEl("option", { text: "不关联本地应用（仅使用网页）", value: "" });
    const localApps = Array.isArray(this.plugin.settings.apps) ? [...this.plugin.settings.apps] : [];
    localApps.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
    for (const app of localApps) {
      appSelect.createEl("option", {
        text: `${app.name} · ${isAppBundleInstalled(app) ? "客户端已安装" : app.websiteUrl ? "网页入口可用" : "客户端不可用"}`,
        value: String(app.id || "")
      });
    }
    const linkedApp = resolveComputeCardApp(c, localApps);
    const staleAppId = c.appId && !linkedApp ? String(c.appId) : "";
    if (staleAppId) {
      appSelect.createEl("option", { text: "原关联应用暂未扫描到（保留旧关联）", value: staleAppId });
      appSelect.value = staleAppId;
    } else if (linkedApp) {
      appSelect.value = String(linkedApp.id || "");
    }
    contentEl.createEl("p", {
      cls: "mal-muted",
      text: staleAppId
        ? "当前扫描结果中没有原关联应用。可重新扫描或选择其他应用；如暂不调整，旧关联 ID 会保留，启动时不会猜测其他客户端。"
        : localApps.length
          ? "关联后，首页应用管理与算力卡册共用同一份应用资料。客户端可用时优先启动客户端，否则打开应用官网；本卡片专属领取网页优先。"
          : "当前还没有可关联的应用资源。请先扫描本机应用或添加网页应用；旧版关键词关联仍会保留兼容。"
    });
    const groupInput = field("分组", "例如 新人礼包 / 服务器 GPU / 每日福利 / 每月福利", c.group || "自定义");
    const dateField = (label, value) => {
      contentEl.createDiv({ cls: "mal-mood-label", text: label });
      const input = contentEl.createEl("input", { cls: "mal-mood-input", attr: { type: "date" } });
      input.value = value || "";
      return input;
    };
    const validFromInput = dateField("生效日期（可选）", c.validFrom);
    const validUntilInput = dateField("截止日期（可选）", c.validUntil);
    const enabledRow = contentEl.createDiv({ cls: "mal-compute-enabled-row" });
    const enabledInput = enabledRow.createEl("input", { attr: { type: "checkbox" } });
    enabledInput.checked = c.enabled !== false;
    enabledRow.createEl("span", { text: "启用此福利卡片" });
    contentEl.createEl("p", {
      cls: "mal-muted",
      text: "有效期之外或已停用的卡片仍保留在卡册中，但不会计入当前可领取价值。"
    });
    contentEl.createDiv({ cls: "mal-mood-label", text: "说明（可选）" });
    const descInput = contentEl.createEl("textarea", { cls: "mal-mood-input mal-compute-desc", attr: { rows: "2", placeholder: "一句话说明这个福利怎么用" } });
    descInput.value = c.desc || "";
    const emojiInput = field("图标（emoji）", "例如 ⚡", c.emoji);

    contentEl.createDiv({ cls: "mal-mood-label", text: "打卡周期" });
    const cycleSelect = contentEl.createEl("select", { cls: "dropdown" });
    for (const [val, label] of [["once", "一次性（只收一次）"], ["daily", "每日（每天可收）"], ["monthly", "每月（每月可收）"]]) {
      const opt = cycleSelect.createEl("option", { text: label, value: val });
      if ((c.cycle || "daily") === val) opt.selected = true;
    }

    contentEl.createDiv({ cls: "mal-mood-label", text: "颜色" });
    const colorRow = contentEl.createDiv({ cls: "mal-mood-colors" });
    const COLORS = ["#0ea5e9", "#22d3ee", "#2dd4bf", "#34d399", "#fbbf24", "#fb923c", "#f87171", "#f472b6", "#a78bfa", "#94a3b8"];
    let color = c.color || COLORS[0];
    for (const cc of COLORS) {
      const sw = colorRow.createDiv({ cls: "mal-mood-swatch" });
      sw.style.background = cc;
      if (cc === color) sw.addClass("is-selected");
      sw.addEventListener("click", () => {
        color = cc;
        colorRow.querySelectorAll(".mal-mood-swatch").forEach(el => el.removeClass("is-selected"));
        sw.addClass("is-selected");
      });
    }

    const actions = contentEl.createDiv({ cls: "mal-mood-actions" });
    const save = actions.createEl("button", { cls: "mod-cta", text: "保存" });
    save.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        new Notice("卡片名称不能为空");
        return;
      }
      const amountRaw = amountInput.value.trim();
      const amount = amountRaw === "" ? 0 : Number(amountRaw);
      if (!Number.isFinite(amount) || amount < 0) {
        new Notice("估值必须是大于或等于 0 的有效数字");
        return;
      }
      const rawUrl = urlInput.value.trim();
      const safeUrl = normalizeExternalHttpUrl(rawUrl);
      if (rawUrl && !safeUrl) {
        new Notice("领取网页必须是有效的 http:// 或 https:// 地址");
        return;
      }
      if (validFromInput.value && validUntilInput.value && validFromInput.value > validUntilInput.value) {
        new Notice("生效日期不能晚于截止日期");
        return;
      }
      const next = {
        id: c.id || `c${Date.now().toString(36)}`,
        name,
        value: valueInput.value.trim(),
        amount,
        cycle: cycleSelect.value,
        group: groupInput.value.trim() || "自定义",
        url: safeUrl,
        appId: appSelect.value || "",
        // 旧版关键词仅在未选择新应用关联时保留，便于兼容旧数据。
        appMatch: appSelect.value ? "" : String(c.appMatch || ""),
        desc: descInput.value.trim(),
        emoji: emojiInput.value.trim() || "⚡",
        color,
        validFrom: validFromInput.value || "",
        validUntil: validUntilInput.value || "",
        enabled: enabledInput.checked,
        currency: c.currency || "CNY"
      };
      const list = Array.isArray(this.plugin.settings.computeCards) ? this.plugin.settings.computeCards : [];
      const idx = list.findIndex(x => x.id === next.id);
      if (idx >= 0) list[idx] = next;
      else list.push(next);
      this.plugin.settings.computeCards = list;
      await this.plugin.saveSettings();
      this.close();
      this.onDone();
    });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

// 自定义入口的编辑弹窗：标题 / 副标题 / 图标 / 链接
class CustomEntryModal extends Modal {
  constructor(app, plugin, group, onDone) {
    super(app);
    this.plugin = plugin;
    this.group = group === "left" ? "left" : "right";
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    const isLeft = this.group === "left";
    contentEl.createEl("h3", { text: isLeft ? "左栏快捷入口" : "右栏快捷入口" });
    contentEl.createEl("p", {
      cls: "mal-muted",
      text: "2×2 快捷入口，点它会打开对应网址。最多 4 个。"
    });
    const key = isLeft ? "leftEntries" : "customEntries";
    const entries = (this.plugin.settings[key] || []).map(e => ({ ...e }));

    const listEl = contentEl.createDiv({ cls: "mal-entry-edit-list" });

    const renderList = () => {
      listEl.empty();
      entries.forEach((entry, index) => {
        const row = listEl.createDiv({ cls: "mal-entry-edit-row" });
        const label = row.createDiv({ cls: "mal-entry-edit-label" });
        if (entry.iconImage) {
          label.createEl("img", { cls: "mal-entry-thumb", attr: { src: entry.iconImage } });
        } else {
          label.createSpan({ text: entry.emoji || "🔗", cls: "mal-entry-label-emoji" });
        }
        label.createSpan({ text: entry.title || "未命名链接" });
        if (entry.url) label.createSpan({ cls: "mal-muted", text: entry.url });
        const edit = row.createEl("button", { text: "编辑" });
        edit.addEventListener("click", () => openForm(entry));
        const del = row.createEl("button", { text: "删除", cls: "mal-danger-text" });
        del.addEventListener("click", () => {
          entries.splice(index, 1);
          renderList();
        });
      });
    };

    const openForm = (entry) => {
      listEl.empty();
      const wrap = listEl.createDiv({ cls: "mal-entry-form" });

      new Setting(wrap).setName("名称").addText(text => text
        .setPlaceholder("名称").setValue(entry.title).onChange(v => { entry.title = v; }));
      new Setting(wrap).setName("网址链接").addText(text => text
        .setPlaceholder("https://").setValue(entry.url).onChange(v => { entry.url = v.trim(); }));

      // 文字图标
      new Setting(wrap).setName("文字图标").setDesc("一个 emoji，如 🔥").addText(text => text
        .setPlaceholder("🔥").setValue(entry.emoji || "").onChange(v => { entry.emoji = v; }));

      // 图标颜色（对文字图标生效）
      const colorSetting = new Setting(wrap).setName("图标颜色").setDesc("仅对文字图标生效，留空用主题默认色");
      colorSetting.addColorPicker(picker => {
        picker.setValue(entry.iconColor || "#0284c7").onChange(v => { entry.iconColor = v; });
      });

      // 上传图标（可选，替代文字图标）
      const uploadSetting = new Setting(wrap).setName("上传图标").setDesc("可选，选图后覆盖文字图标显示");
      const fileInput = uploadSetting.controlEl.createEl("input", {
        type: "file", attr: { accept: "image/*" }
      });
      fileInput.style.display = "none";
      uploadSetting.addButton(btn => btn.setButtonText("选择图片").onClick(() => fileInput.click()));
      if (entry.iconImage) {
        uploadSetting.addButton(btn => btn.setButtonText("移除图片").onClick(() => {
          entry.iconImage = "";
          openForm(entry);
        }));
        const prev = wrap.createDiv({ cls: "mal-entry-preview" });
        prev.createEl("img", { attr: { src: entry.iconImage } });
      }
      fileInput.addEventListener("change", () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          entry.iconImage = String(reader.result);
          openForm(entry);
        };
        reader.readAsDataURL(file);
      });

      const back = wrap.createEl("button", { text: "返回列表", cls: "mal-entry-back" });
      back.addEventListener("click", () => renderList());
    };

    renderList();

    const actions = contentEl.createDiv({ cls: "mal-mood-actions" });
    const addBtn = actions.createEl("button", { text: "+ 添加链接" });
    addBtn.addEventListener("click", () => {
      if (entries.length >= 4) {
        new Notice("每组最多 4 个快捷入口");
        return;
      }
      const entry = { title: "", sub: "", emoji: "", iconColor: "", iconImage: "", url: "" };
      entries.push(entry);
      openForm(entry);
    });
    const save = actions.createEl("button", { cls: "mod-cta", text: "完成" });
    save.addEventListener("click", async () => {
      this.plugin.settings[key] = entries.filter(e => e.title || e.url).slice(0, 4);
      await this.plugin.saveSettings();
      this.close();
      this.onDone();
    });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

// 广告位编辑弹窗：两行一列，每个只填图片 + 网址链接
class AdSlotModal extends Modal {
  constructor(app, plugin, onDone) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "右侧广告位" });
    contentEl.createEl("p", { cls: "mal-muted", text: "两行一列，每个广告只需一张图片 + 一个网址链接。" });
    const ads = (this.plugin.settings.adSlots || []).slice(0, 2).map(a => ({ ...a }));

    const listEl = contentEl.createDiv({ cls: "mal-entry-edit-list" });

    const renderList = () => {
      listEl.empty();
      ads.forEach((ad, index) => {
        const row = listEl.createDiv({ cls: "mal-entry-edit-row" });
        const label = row.createDiv({ cls: "mal-entry-edit-label" });
        if (ad.image) {
          label.createEl("img", { cls: "mal-entry-thumb", attr: { src: ad.image } });
        } else {
          label.createSpan({ text: "🖼", cls: "mal-entry-label-emoji" });
        }
        label.createSpan({ text: ad.url || "未设置链接" });
        const edit = row.createEl("button", { text: "编辑" });
        edit.addEventListener("click", () => openForm(ad));
        const del = row.createEl("button", { text: "删除", cls: "mal-danger-text" });
        del.addEventListener("click", () => {
          ads.splice(index, 1);
          renderList();
        });
      });
    };

    const openForm = (ad) => {
      listEl.empty();
      const wrap = listEl.createDiv({ cls: "mal-entry-form" });

      new Setting(wrap).setName("网址链接").addText(text => text
        .setPlaceholder("https://").setValue(ad.url).onChange(v => { ad.url = v.trim(); }));

      new Setting(wrap).setName("图片链接").setDesc("填 http(s) 图片地址，或用下方按钮上传本地图片").addText(text => text
        .setPlaceholder("https://example.com/ad.png").setValue(ad.image && ad.image.startsWith("http") ? ad.image : "").onChange(v => { ad.image = v.trim(); }));

      const uploadSetting = new Setting(wrap).setName("上传图片").setDesc("本地图片会转成 base64 存入配置");
      const fileInput = uploadSetting.controlEl.createEl("input", { type: "file", attr: { accept: "image/*" } });
      fileInput.style.display = "none";
      uploadSetting.addButton(btn => btn.setButtonText("选择图片").onClick(() => fileInput.click()));
      if (ad.image) {
        uploadSetting.addButton(btn => btn.setButtonText("移除图片").onClick(() => {
          ad.image = "";
          openForm(ad);
        }));
        const prev = wrap.createDiv({ cls: "mal-entry-preview" });
        prev.createEl("img", { attr: { src: ad.image } });
      }
      fileInput.addEventListener("change", () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          ad.image = String(reader.result);
          openForm(ad);
        };
        reader.readAsDataURL(file);
      });

      const back = wrap.createEl("button", { text: "返回列表", cls: "mal-entry-back" });
      back.addEventListener("click", () => renderList());
    };

    renderList();

    const actions = contentEl.createDiv({ cls: "mal-mood-actions" });
    const addBtn = actions.createEl("button", { text: "+ 添加广告" });
    addBtn.addEventListener("click", () => {
      if (ads.length >= 2) {
        new Notice("最多 2 个广告位");
        return;
      }
      const ad = { image: "", url: "" };
      ads.push(ad);
      openForm(ad);
    });
    const save = actions.createEl("button", { cls: "mod-cta", text: "完成" });
    save.addEventListener("click", async () => {
      this.plugin.settings.adSlots = ads.filter(a => a.image || a.url).slice(0, 2);
      await this.plugin.saveSettings();
      this.close();
      this.onDone();
    });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class SceneStepsModal extends Modal {
  constructor(app, plugin, scene) {
    super(app);
    this.plugin = plugin;
    this.scene = scene;
  }

  onOpen() {
    this.renderBody();
  }

  stepLabel(step) {
    if (step.type === "app") {
      const app = this.plugin.settings.apps.find(a => a.id === step.id);
      return app ? app.name : "（已移除的应用）";
    }
    if (step.type === "note") return String(step.path).split("/").pop().replace(/\.md$/i, "");
    if (step.type === "folder") return String(step.path).split("/").pop() || step.path;
    return step.name || step.id;
  }

  stepSub(step) {
    if (step.type === "app") {
      const app = this.plugin.settings.apps.find(a => a.id === step.id);
      return app ? app.category || "" : "";
    }
    if (step.type === "note") return step.path;
    if (step.type === "folder") return `${step.path} · 在 Finder 打开`;
    return step.id;
  }

  async persist() {
    await this.plugin.saveSettings();
    this.plugin.refreshViews();
    this.renderBody();
  }

  renderBody() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mal-steps-modal");
    contentEl.createEl("h3", { text: `场景步骤：${this.scene.name}` });
    contentEl.createEl("p", {
      text: "按从上到下的顺序执行：应用错峰启动（已运行的跳过），笔记直接打开，命令逐项执行。",
      cls: "mal-add-custom-hint"
    });
    const steps = ensureSceneSteps(this.scene);
    const list = contentEl.createDiv({ cls: "mal-steps-list" });
    steps.forEach((step, index) => {
      const row = list.createDiv({ cls: "mal-step-row" });
      row.createEl("span", { text: SCENE_STEP_ICONS[step.type] || "•", cls: "mal-step-icon" });
      const info = row.createDiv({ cls: "mal-step-info" });
      info.createEl("span", { text: this.stepLabel(step), cls: "mal-step-label" });
      const sub = this.stepSub(step);
      if (sub) info.createEl("span", { text: sub, cls: "mal-step-sub" });
      const up = row.createEl("button", { text: "↑", cls: "mal-button mal-cat-move" });
      up.disabled = index === 0;
      up.addEventListener("click", async () => {
        [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
        await this.persist();
      });
      const down = row.createEl("button", { text: "↓", cls: "mal-button mal-cat-move" });
      down.disabled = index === steps.length - 1;
      down.addEventListener("click", async () => {
        [steps[index], steps[index + 1]] = [steps[index + 1], steps[index]];
        await this.persist();
      });
      const del = row.createEl("button", { text: "✕", cls: "mal-button mal-cat-move mal-button-danger" });
      del.addEventListener("click", async () => {
        steps.splice(index, 1);
        await this.persist();
      });
    });
    if (!steps.length) list.createEl("p", { text: "还没有步骤，点击下方按钮添加。", cls: "mal-empty" });

    const add = contentEl.createDiv({ cls: "mal-steps-add" });
    const appBtn = add.createEl("button", { text: "＋ 应用", cls: "mal-button" });
    appBtn.addEventListener("click", () => {
      const items = this.plugin.settings.apps.filter(a => a.selected !== false)
        .map(a => ({ label: a.name, hint: a.category || "", value: { type: "app", id: a.id } }));
      new MalPickerModal(this.app, {
        title: "添加应用步骤",
        placeholder: "搜索已勾选的应用…",
        items,
        onPick: async it => { steps.push(it.value); await this.persist(); }
      }).open();
    });
    const noteBtn = add.createEl("button", { text: "＋ 笔记", cls: "mal-button" });
    noteBtn.addEventListener("click", () => {
      const items = this.app.vault.getMarkdownFiles()
        .map(f => ({ label: f.basename, hint: f.path, value: { type: "note", path: f.path } }));
      new MalPickerModal(this.app, {
        title: "添加笔记步骤",
        placeholder: "搜索库内笔记…",
        items,
        onPick: async it => { steps.push(it.value); await this.persist(); }
      }).open();
    });
    const folderBtn = add.createEl("button", { text: "＋ 文件夹", cls: "mal-button" });
    folderBtn.addEventListener("click", () => {
      const folders = this.app.vault.getAllFolders ? this.app.vault.getAllFolders() : [];
      const items = folders.filter(f => f.path !== "/")
        .map(f => ({ label: f.name, hint: f.path, value: { type: "folder", path: f.path } }));
      new MalPickerModal(this.app, {
        title: "添加文件夹步骤",
        placeholder: "搜索库内文件夹…",
        items,
        onPick: async it => { steps.push(it.value); await this.persist(); }
      }).open();
    });
    const cmdBtn = add.createEl("button", { text: "＋ Obsidian 命令", cls: "mal-button mal-primary" });
    cmdBtn.addEventListener("click", () => {
      const commands = this.app.commands.listCommands ? this.app.commands.listCommands() : [];
      const items = commands.map(c => ({ label: c.name, hint: c.id, value: { type: "command", id: c.id, name: c.name } }));
      new MalPickerModal(this.app, {
        title: "添加 Obsidian 命令步骤",
        placeholder: "搜索命令（含其他插件的命令）…",
        items,
        onPick: async it => { steps.push(it.value); await this.persist(); }
      }).open();
    });
  }
}

// 自定义文件关联规则编辑器：扩展名 → 指定应用
class FileRulesModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.renderBody();
  }

  async persist() {
    await this.plugin.saveSettings();
    this.renderBody();
  }

  renderBody() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mal-steps-modal");
    contentEl.createEl("h3", { text: "文件关联规则" });
    contentEl.createEl("p", {
      text: "文件列表右键菜单中，命中的扩展名会优先显示指定应用（高于内置分类推荐）。",
      cls: "mal-add-custom-hint"
    });
    const rules = this.plugin.settings.fileRules;
    const apps = this.plugin.settings.apps.filter(a => a.selected !== false && a.path);
    const list = contentEl.createDiv({ cls: "mal-steps-list" });
    rules.forEach((rule, index) => {
      const row = list.createDiv({ cls: "mal-step-row" });
      row.createEl("span", { text: `.${rule.ext}`, cls: "mal-rule-ext" });
      row.createEl("span", { text: "→", cls: "mal-muted" });
      const app = this.plugin.settings.apps.find(a => a.id === rule.appId);
      row.createEl("span", { text: app ? app.name : "（应用已移除）", cls: "mal-step-label" });
      const del = row.createEl("button", { text: "✕", cls: "mal-button mal-cat-move mal-button-danger" });
      del.addEventListener("click", async () => {
        rules.splice(index, 1);
        await this.persist();
      });
    });
    if (!rules.length) list.createEl("p", { text: "还没有规则。", cls: "mal-empty" });
    const add = contentEl.createDiv({ cls: "mal-steps-add" });
    const extInput = add.createEl("input", { cls: "mal-rule-input", attr: { type: "text", placeholder: "扩展名，如 blend" } });
    const select = add.createEl("select", { cls: "mal-rule-select" });
    for (const app of apps) {
      const opt = select.createEl("option", { text: app.name });
      opt.value = app.id;
    }
    const addBtn = add.createEl("button", { text: "添加规则", cls: "mal-primary" });
    addBtn.addEventListener("click", async () => {
      const ext = extInput.value.trim().replace(/^\./, "").toLowerCase();
      if (!ext) { new Notice("请输入扩展名"); return; }
      if (!select.value) { new Notice("请先勾选至少一个应用"); return; }
      const existing = rules.find(r => r.ext === ext);
      if (existing) existing.appId = select.value;
      else rules.push({ ext, appId: select.value });
      extInput.value = "";
      await this.persist();
    });
  }
}

// 使用统计：总览、Top 10 排行、最近启动、7 天趋势（解析每日笔记日志）
class UsageStatsModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mal-stats");
    contentEl.createEl("h3", { text: "应用使用统计" });
    const apps = this.plugin.settings.apps.filter(a => a.selected !== false);
    const total = apps.reduce((sum, a) => sum + (a.launchCount || 0), 0);
    contentEl.createEl("p", {
      text: `${apps.length} 个应用 · 累计启动 ${total} 次 · ${this.plugin.settings.scenes.length} 个场景`,
      cls: "mal-add-custom-hint"
    });

    contentEl.createEl("h4", { text: "使用排行 Top 10" });
    const top = [...apps].sort((a, b) => (b.launchCount || 0) - (a.launchCount || 0)).slice(0, 10);
    const max = top.length ? Math.max(top[0].launchCount || 0, 1) : 1;
    const topBox = contentEl.createDiv({ cls: "mal-stats-box" });
    if (!total) {
      topBox.createEl("p", { text: "还没有启动记录。", cls: "mal-empty" });
    }
    for (const app of top) {
      if (!app.launchCount) continue;
      const row = topBox.createDiv({ cls: "mal-stats-row" });
      row.createEl("span", { text: app.name, cls: "mal-stats-name" });
      const barWrap = row.createDiv({ cls: "mal-stats-barwrap" });
      barWrap.createDiv({ cls: "mal-stats-bar" }).style.width = `${Math.round((app.launchCount / max) * 100)}%`;
      row.createEl("span", { text: String(app.launchCount), cls: "mal-stats-count" });
    }

    contentEl.createEl("h4", { text: "最近启动" });
    const recent = [...apps].filter(a => a.lastLaunchedAt)
      .sort((a, b) => b.lastLaunchedAt - a.lastLaunchedAt).slice(0, 8);
    const recentBox = contentEl.createDiv({ cls: "mal-stats-box" });
    if (!recent.length) recentBox.createEl("p", { text: "暂无记录。", cls: "mal-empty" });
    for (const app of recent) {
      const row = recentBox.createDiv({ cls: "mal-stats-row" });
      row.createEl("span", { text: app.name, cls: "mal-stats-name" });
      row.createEl("span", {
        text: new Date(app.lastLaunchedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
        cls: "mal-stats-count"
      });
    }

    contentEl.createEl("h4", { text: "最近 7 天趋势" });
    const trend = await this.loadTrend();
    const trendBox = contentEl.createDiv({ cls: "mal-stats-box" });
    if (!trend) {
      trendBox.createEl("p", {
        text: "没有日志数据。在设置页开启「记录启动日志到每日笔记」后，这里会显示趋势。",
        cls: "mal-empty"
      });
    } else {
      const trendMax = Math.max(...trend.map(d => d.count), 1);
      for (const day of trend) {
        const row = trendBox.createDiv({ cls: "mal-stats-row" });
        row.createEl("span", { text: day.label, cls: "mal-stats-name" });
        const barWrap = row.createDiv({ cls: "mal-stats-barwrap" });
        barWrap.createDiv({ cls: "mal-stats-bar is-trend" }).style.width = `${Math.round((day.count / trendMax) * 100)}%`;
        row.createEl("span", { text: String(day.count), cls: "mal-stats-count" });
      }
    }
  }

  // 解析最近 7 天每日笔记「应用使用记录」小节的行数；没有数据返回 null
  async loadTrend() {
    let folder = "";
    let format = "YYYY-MM-DD";
    try {
      const dn = this.app.internalPlugins && this.app.internalPlugins.plugins &&
        this.app.internalPlugins.plugins["daily-notes"];
      if (dn && dn.enabled && dn.instance && dn.instance.options) {
        folder = dn.instance.options.folder || "";
        format = dn.instance.options.format || "YYYY-MM-DD";
      }
    } catch (e) { /* 用默认值 */ }
    const days = [];
    let found = 0;
    for (let i = 6; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86400000);
      const filename = window.moment ? window.moment(date).format(format) : date.toISOString().slice(0, 10);
      const notePath = `${folder ? folder + "/" : ""}${filename}.md`;
      const label = `${date.getMonth() + 1}/${date.getDate()}`;
      let count = 0;
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (file && file instanceof TFile) {
        const content = await this.app.vault.read(file);
        const matches = content.match(/^- \d{1,2}:\d{2} 启动 .+$/gm);
        count = matches ? matches.length : 0;
        if (count) found++;
      }
      days.push({ label, count });
    }
    return found ? days : null;
  }
}

// 拼音转换助手脚本（Swift CFStringTransform），首次使用时编译为插件目录下的 pinyin-helper
const PINYIN_SWIFT_SOURCE = `import Foundation
let input = try JSONDecoder().decode([String].self, from: FileHandle.standardInput.readDataToEndOfFile())
var out: [String] = []
for n in input {
  let m = NSMutableString(string: n)
  CFStringTransform(m, nil, kCFStringTransformToLatin, false)
  CFStringTransform(m, nil, kCFStringTransformStripDiacritics, false)
  out.append(m as String)
}
print(String(data: try JSONEncoder().encode(out), encoding: .utf8)!)
`;

function isNestedInsideAnotherApp(appPath) {
  const parts = path.resolve(appPath).split(path.sep).filter(Boolean);
  return parts.slice(0, -1).some(part => part.toLowerCase().endsWith(".app"));
}

function fallbackCategory(name, appPath) {
  const s = `${name} ${appPath}`.toLowerCase();
  if (/finder|system settings|系统设置|activity monitor|terminal|disk utility|迁移助理/.test(s)) return "系统工具";
  if (/chrome|safari|firefox|edge|arc browser|brave|opera/.test(s)) return "浏览器";
  if (/chatgpt|claude|豆包|元宝|通义|千问|ima|coze|astrbot|workbuddy|copilot|gemini|perplexity|kimi|deepseek|aitracker|skills desktop/.test(s)) return "AI助手";
  if (/wechat|微信|feishu|飞书|dingtalk|钉钉|wps|word|excel|powerpoint|notion|slack|zoom|腾讯会议/.test(s)) return "办公工具";
  if (/cursor|visual studio code|vscode|xcode|trae|qoder|jetbrains|intellij|webstorm|pycharm|github desktop|docker|postman/.test(s)) return "开发工具";
  if (/photoshop|illustrator|figma|sketch|affinity|pixelmator|muse|canva/.test(s)) return "设计工具";
  if (/final cut|premiere|davinci|剪映|capcut|after effects|iina|vlc|quicktime/.test(s)) return "影音工具";
  return "未分类";
}

function suggestedProfile(name, category) {
  const known = {
    "Finder": [
      "macOS 文件管理器，用于浏览文件夹、管理文件、访问磁盘和连接位置。",
      "整理本地文件、查看下载内容、管理项目资料和打开文件所在位置。"
    ],
    "ChatGPT": [
      "AI 助手，可进行自然语言问答、内容创作、资料整理、代码辅助与多模态任务。",
      "适合研究分析、写作润色、学习答疑、代码协助、方案构思和日常工作支持。"
    ],
    "Claude": [
      "AI 助手，可用于长文本理解、资料分析、写作、代码辅助和复杂问题推理。",
      "适合阅读长文档、整理研究资料、撰写内容、分析代码和处理复杂任务。"
    ],
    "豆包": [
      "AI 助手，可用于日常问答、写作、学习辅助和内容创作等任务。",
      "适合快速咨询、内容构思、文本改写、学习答疑和日常信息处理。"
    ],
    "元宝": [
      "AI 助手，可用于知识问答、资料总结、写作辅助和日常信息处理。",
      "适合信息查询、文档总结、内容整理、头脑风暴和办公辅助。"
    ],
    "ima": [
      "AI 知识管理与问答工具，可辅助收集资料、整理知识和围绕资料进行问答。",
      "适合建立个人知识库、归纳资料、检索信息和辅助学习研究。"
    ],
    "Coze": [
      "AI 智能体与工作流平台，可用于创建机器人、配置知识和组织自动化流程。",
      "适合搭建智能体、设计对话流程、连接工具和验证 AI 自动化方案。"
    ],
    "WPS 灵犀": [
      "WPS 生态中的 AI 办公助手，可辅助处理文档、表格、演示和办公内容。",
      "适合文档起草、内容总结、办公资料整理和提升日常文档处理效率。"
    ],
    "千问办公": [
      "AI 办公辅助客户端，可帮助处理信息、整理内容和完成日常办公任务。",
      "适合资料归纳、文本起草、信息整理和辅助办公流程。具体能力以客户端内功能为准。"
    ],
    "TRAE CN": [
      "AI 编程开发环境，可辅助理解代码、生成代码、修改项目和排查开发问题。",
      "适合代码编写、项目理解、Bug 排查、重构和日常软件开发。"
    ],
    "TraeWork CN": [
      "AI 工作与开发辅助客户端，可用于组织任务并借助 AI 处理工作流程。",
      "适合将重复任务交给 AI 辅助处理、整理工作步骤和提高执行效率。具体能力以客户端为准。"
    ],
    "Qoder CN": [
      "AI 编程开发工具，可辅助代码理解、生成、重构和项目开发。",
      "适合项目代码分析、功能实现、代码修改、调试和开发效率提升。"
    ],
    "AstrBot": [
      "机器人与 AI 接入平台，可用于连接模型、消息平台和机器人服务。",
      "适合搭建聊天机器人、接入 AI 模型、配置消息渠道和管理机器人能力。"
    ],
    "WorkBuddy": [
      "AI 工作助手客户端，可辅助组织任务、处理工作内容和探索自动化工作方式。",
      "适合日常任务辅助、信息整理和工作流程提效。具体能力以客户端实际功能为准。"
    ],
    "WorkBuddy AI": [
      "AI 工作辅助客户端，可借助智能能力处理信息、任务和工作流程。",
      "适合日常工作辅助、内容整理和重复任务处理。具体能力以客户端实际功能为准。"
    ],
    "得到大脑": [
      "知识学习与信息整理工具，可辅助知识获取、内容归纳和思考整理。",
      "适合学习笔记、知识梳理、资料归纳和个人知识管理。"
    ],
    "Skills Desktop": [
      "桌面端技能管理与调用工具，可用于组织和使用可复用的 AI 技能或工作能力。",
      "适合整理常用技能、管理工作流入口和快速调用重复任务能力。具体功能以客户端为准。"
    ],
    "AITracker": [
      "AI 相关任务或工具管理客户端，可作为集中查看和整理 AI 工作事项的入口。",
      "适合集中管理 AI 相关项目、任务或使用记录。具体功能以客户端为准。"
    ],
    "Muse": [
      "创意与内容辅助工具，可用于构思、创作和整理灵感。",
      "适合创意发散、内容构思、素材整理和辅助创作。"
    ],
    "Ekko Studio": [
      "创作工作台客户端，可用于组织创作任务和管理相关内容。",
      "适合集中进入创作流程、整理项目内容和管理创作任务。具体功能以客户端为准。"
    ]
  };
  if (known[name]) return { description: known[name][0], usage: known[name][1] };

  const byCategory = {
    "AI助手": [
      "AI 助手类客户端，可用于问答、内容整理、写作辅助和信息处理。具体能力以该软件实际提供的功能为准。",
      "适合日常咨询、资料总结、文本起草、思路整理和辅助学习。"
    ],
    "AI智能体": [
      "AI 智能体或自动化工具，可用于组织智能任务、连接工具或构建工作流程。具体能力以该软件实际提供的功能为准。",
      "适合搭建自动化流程、管理智能任务和减少重复操作。"
    ],
    "办公工具": [
      "办公效率客户端，可用于文档处理、信息沟通、资料管理或团队协作。具体能力以该软件实际提供的功能为准。",
      "适合日常办公、资料整理、文档协作和团队沟通。"
    ],
    "开发工具": [
      "软件开发工具，可用于代码编辑、项目管理、调试或开发辅助。具体能力以该软件实际提供的功能为准。",
      "适合编写和维护代码、管理项目、调试程序及提升开发效率。"
    ],
    "设计工具": [
      "设计与创作工具，可用于视觉设计、图像处理或创意制作。具体能力以该软件实际提供的功能为准。",
      "适合制作视觉素材、编辑图像、设计界面和整理创意内容。"
    ],
    "浏览器": [
      "网页浏览器，用于访问网站、在线服务和 Web 应用。",
      "适合网页浏览、在线办公、资料检索和访问 Web 工具。"
    ],
    "影音工具": [
      "影音创作或播放工具，可用于视频、音频内容处理或播放。",
      "适合影音播放、素材处理、剪辑和内容制作。"
    ],
    "系统工具": [
      "macOS 系统工具，用于管理设备、文件或系统功能。",
      "适合系统管理、文件管理和日常设备维护。"
    ]
  };
  return byCategory[category] || [
    "该应用的功能介绍尚可自定义。建议根据自己的实际使用方式补充说明。",
    "填写你通常使用它完成的任务，方便以后从应用中心快速识别。"
  ];
}

function normalizeApp(app, index) {
  const category = app.category || "未分类";
  const suggested = suggestedProfile(app.name || "应用", category);
  return {
    ...app,
    selected: !!app.selected,
    category,
    pinned: !!app.pinned,
    order: Number.isFinite(Number(app.order)) ? Number(app.order) : index,
    pinnedOrder: Number.isFinite(Number(app.pinnedOrder)) ? Number(app.pinnedOrder) : index,
    description: typeof app.description === "string" ? app.description : suggested.description,
    usage: typeof app.usage === "string" ? app.usage : suggested.usage,
    iconPath: app.iconPath || "",
    iconSource: app.iconSource || "",
    bundleId: typeof app.bundleId === "string" ? app.bundleId : "",
    websiteUrl: typeof app.websiteUrl === "string" ? app.websiteUrl : "",
    webOnly: !!app.webOnly,
    launchMode: app.launchMode === "web" ? "web" : "smart",
    tileW: app.tileW === 2 ? 2 : 1,
    tileH: app.tileH === 2 ? 2 : 1,
    customIcon: !!app.customIcon
  };
}

function parseLegacyApps(appsText) {
  return String(appsText || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"))
    .map((line, index) => {
      const p = line.split("|").map(x => x.trim());
      if (p.length < 2 || !p[0] || !p[1]) return null;
      return normalizeApp({
        id: `legacy-${appId(p[1])}`,
        name: p[0],
        path: p[1],
        selected: true,
        category: p[3] || "其他"
      }, index);
    })
    .filter(Boolean);
}

class MacAppLauncherView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = "home";
    this.searchTerm = "";
    this.activeCategory = "__all__";
    this.detailAppId = null;
    this.editingDetail = false;
    this.bodyEl = null;
    // 防抖搜索：150ms 内连续输入不重绘
    this.debouncedSearch = debounce(term => {
      this.searchTerm = term;
      if (this.bodyEl) this.renderBody(this.bodyEl);
    }, 150);
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Mac 应用中心"; }
  getIcon() { return "layout-grid"; }
  async onOpen() { this.render(); }
  async onClose() {
    if (this.clockTimer) {
      window.clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    this.disconnectIconObserver();
  }

  disconnectIconObserver() {
    if (this.iconObserver) {
      this.iconObserver.disconnect();
      this.iconObserver = null;
    }
  }

  // 图标懒加载：进入视口（含 200px 预载边距）才真正读取图标文件
  observeIcon(el, app) {
    if (!this.iconObserver) {
      this.iconObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.iconObserver.unobserve(entry.target);
          if (entry.target.isConnected && entry.target._malApp) {
            this.plugin.renderAppIcon(entry.target, entry.target._malApp);
          }
        }
      }, { rootMargin: "200px" });
    }
    el._malApp = app;
    this.iconObserver.observe(el);
  }

  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("mal-view");

    const header = root.createDiv({ cls: "mal-header" });
    const titleWrap = header.createDiv({ cls: "mal-title-wrap" });
    if (this.mode === "manage") {
      titleWrap.createEl("h2", { text: "管理应用", cls: "mal-title" });
      titleWrap.createEl("div", {
        text: "勾选需要展示的软件，设置分类和应用介绍",
        cls: "mal-subtitle"
      });
    } else if (this.mode === "album") {
      titleWrap.createEl("h2", { text: "AI 算力卡册", cls: "mal-title" });
      titleWrap.createEl("div", {
        text: "打开客户端或网页完成领取，返回后手动标记；右键可编辑或删除",
        cls: "mal-subtitle"
      });
    } else {
      const quote = dailyWorkQuote();
      const line = titleWrap.createDiv({ cls: "mal-quote" });
      line.createSpan({ cls: "mal-quote-label", text: "今日职场语录" });
      line.createSpan({ cls: "mal-quote-text", text: quote, attr: { title: quote } });
    }

    const controls = header.createDiv({ cls: "mal-controls" });
    // 首页搜索框在顶部 Hero 里，右上角只留一个设置图标，点开才是各项操作
    let search = null;
    if (this.mode === "manage") {
      search = controls.createEl("input", {
        attr: { type: "search", placeholder: "搜索扫描结果…" },
        cls: "mal-search"
      });
      search.value = this.searchTerm;
      search.addEventListener("input", () => this.debouncedSearch(search.value));

      const scan = controls.createEl("button", {
        text: this.plugin.scanning ? "取消扫描" : "重新扫描",
        cls: "mal-button"
      });
      scan.addEventListener("click", () => {
        if (this.plugin.scanning) this.plugin.cancelScan();
        else this.plugin.scanInstalledApps();
      });

      const all = controls.createEl("button", { text: "全选", cls: "mal-button" });
      all.addEventListener("click", () => this.plugin.setAllSelected(true));
      const none = controls.createEl("button", { text: "清空", cls: "mal-button" });
      none.addEventListener("click", () => this.plugin.setAllSelected(false));
      const done = controls.createEl("button", { text: "完成", cls: "mal-primary" });
      done.addEventListener("click", () => {
        const count = this.plugin.settings.apps.filter(a => a.selected).length;
        this.mode = "home";
        this.searchTerm = "";
        this.render();
        new Notice(count
          ? `已选择 ${count} 个应用，在应用中心展示`
          : "还没有选择要展示的应用：在管理应用里点击应用名称或勾选「展示」框", 4000);
      });
    } else if (this.mode === "album") {
      const back = controls.createEl("button", { text: "← 返回首页", cls: "mal-button" });
      back.addEventListener("click", () => {
        this.mode = "home";
        this.render();
      });
    } else {
      const gear = controls.createEl("button", {
        text: "⚙",
        cls: "mal-icon-btn",
        attr: { title: "设置与操作", "aria-label": "设置与操作" }
      });
      gear.addEventListener("click", event => this.openHomeMenu(event));
    }

    if (this.mode === "home") this.renderHero(root);
    const body = root.createDiv({ cls: "mal-body" });
    this.bodyEl = body;
    this.renderBody(body);
  }

  // 首页设置菜单：保留应用管理、扫描和重载；卡册已成为首页主体。
  openHomeMenu(event) {
    const menu = new Menu();
    menu.addItem(item => item
      .setTitle("管理应用")
      .setIcon("sliders-horizontal")
      .onClick(() => {
        this.mode = "manage";
        this.searchTerm = "";
        this.render();
      }));
    menu.addItem(item => item
      .setTitle(this.plugin.scanning ? "取消扫描" : "重新扫描应用")
      .setIcon("refresh-cw")
      .onClick(() => {
        if (this.plugin.scanning) this.plugin.cancelScan();
        else this.plugin.scanInstalledApps();
      }));
    menu.addSeparator();
    menu.addItem(item => item
      .setTitle("重载插件")
      .setIcon("rotate-cw")
      .onClick(async () => {
        new Notice("正在重载 Mac App Launcher…");
        const pluginId = this.plugin.manifest.id;
        await this.app.plugins.disablePlugin(pluginId);
        await this.app.plugins.enablePlugin(pluginId);
      }));
    menu.showAtMouseEvent(event);
  }

  // 首页顶部 Hero：大时钟 + 日期（公历 / 星期 / 农历）+ 胶囊搜索框
  renderHero(root) {
    if (this.clockTimer) {
      window.clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    const hero = root.createDiv({ cls: "mal-hero" });
    const clock = hero.createDiv({ cls: "mal-hero-clock", text: "00:00:00" });
    const tick = () => {
      const d = new Date();
      clock.setText(
        `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
      );
    };
    tick();
    this.clockTimer = window.setInterval(() => {
      if (!clock.isConnected) {
        window.clearInterval(this.clockTimer);
        this.clockTimer = null;
        return;
      }
      tick();
    }, 1000);

    const info = getCalendarInfo(new Date());
    const date = hero.createDiv({ cls: "mal-hero-date" });
    date.createSpan({ text: info.solar.replace(/^\d{4}年/, "") });
    date.createSpan({ text: info.week, cls: "mal-hero-week" });
    const lunar = info.lunar
      .replace(/^[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]年（[^）]*）/, "")
      .replace(/^[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]年/, "");
    if (lunar) date.createSpan({ text: lunar, cls: "mal-hero-lunar" });
    if (info.festival) date.createSpan({ text: info.festival, cls: "mal-hero-festival" });

    // 万年历的上班 / 休息与今日天气并入日期行，避免和下方仪表板重复
    if (this.plugin.settings.showDashboard !== false) {
      const dayType = date.createSpan({ cls: "mal-hero-daytype", text: "…" });
      this.plugin.getHolidayInfo(new Date()).then(h => {
        if (!dayType.isConnected || !h) return;
        dayType.setText(h.label);
        dayType.addClass(h.rest ? "is-rest" : "is-work");
        dayType.setAttribute("title", h.detail || h.label);
      });
      const weather = date.createSpan({ cls: "mal-hero-weather" });
      this.plugin.getWeather().then(data => {
        if (!weather.isConnected || !data) return;
        const w = weatherCodeInfo(data.code);
        weather.setText(`${w.icon} ${Math.round(data.temp)}° ${w.text}`);
        const range = Number.isFinite(data.high) && Number.isFinite(data.low)
          ? `最高 ${Math.round(data.high)}° / 最低 ${Math.round(data.low)}°`
          : "";
        weather.setAttribute("title", [range, data.city, "数据来源：Open-Meteo"].filter(Boolean).join(" · "));
      });
    }

    const box = hero.createDiv({ cls: "mal-hero-search" });
    box.createSpan({ cls: "mal-hero-search-icon", text: "⌕" });
    const input = box.createEl("input", {
      attr: { type: "search", placeholder: "搜索应用或福利卡片…" },
      cls: "mal-hero-input"
    });
    input.value = this.searchTerm;
    input.addEventListener("input", () => this.debouncedSearch(input.value));
    // 键盘操作：↑↓ 移动高亮，回车启动，Esc 清空
    input.addEventListener("keydown", event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.moveKbSelection(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.launchKbSelection();
      } else if (event.key === "Escape") {
        input.value = "";
        this.searchTerm = "";
        this.kbIndex = -1;
        this.debouncedSearch("");
        input.blur();
      }
    });
  }

  // 键盘导航：在当前首页结果里移动高亮
  kbCards() {
    if (!this.bodyEl) return [];
    return Array.from(this.bodyEl.querySelectorAll(".mal-home-quick-app"));
  }

  moveKbSelection(step) {
    const cards = this.kbCards();
    if (!cards.length) return;
    const current = cards.findIndex(card => card.classList.contains("is-kb-active"));
    let next = current < 0 ? (step > 0 ? 0 : cards.length - 1) : current + step;
    if (next < 0) next = cards.length - 1;
    if (next >= cards.length) next = 0;
    for (const card of cards) card.removeClass("is-kb-active");
    this.kbIndex = next;
    cards[next].addClass("is-kb-active");
    cards[next].scrollIntoView({ block: "nearest" });
  }

  launchKbSelection() {
    const cards = this.kbCards();
    const active = cards.find(card => card.classList.contains("is-kb-active"));
    if (!active) {
      // 没有高亮时回车 = 启动搜索结果里的第一个
      if (cards.length === 1) cards[0].click();
      return;
    }
    const appId = active.dataset.appId;
    const app = (this.plugin.settings.apps || []).find(a => a.id === appId);
    if (!app) return;
    active.removeClass("is-kb-active");
    this.kbIndex = -1;
    this.plugin.launchApp(app);
  }

  renderBody(body) {
    this.disconnectIconObserver();
    body.empty();
    const term = this.searchTerm.trim().toLocaleLowerCase();
    if (this.mode === "manage") this.renderManager(body, term);
    else if (this.mode === "album") this.renderAlbum(body, term);
    else this.renderHome(body, term);
  }

  // 首页工作区：卡册入口 + 常用应用 + 自定义入口卡，三块等宽，可拖拽换位
  renderDashboard(body, selected = []) {
    const row = body.createDiv({ cls: "mal-workspace" });
    // 三块一排：左快捷入口（2×2）/ 常用应用 / 右广告位（两行一列）
    const available = ["left", "apps", "entry"];
    const stored = (this.plugin.settings.workspaceOrder || []).filter(key => available.includes(key));
    const order = stored.length ? [...stored] : [...available];
    for (const key of available) if (!order.includes(key)) order.push(key);
    const colClass = { left: "mal-ws-left", apps: "mal-ws-mid", entry: "mal-ws-entry" };
    const sizeClass = { left: "1fr", apps: "2fr", entry: "1fr" };
    row.style.gridTemplateColumns = order.map(key => sizeClass[key] || "1fr").join(" ");

    for (const key of order) {
      const col = row.createDiv({ cls: `mal-ws-col ${colClass[key] || ""}` });
      col.dataset.ws = key;
      this.attachWorkspaceDrag(col, key);

      if (key === "apps") this.renderQuickApps(col, selected);
      else if (key === "left") this.renderCustomEntry(col, "left");
      else this.renderAdSlots(col);
    }
  }

  // 三块工作区拖拽换位：只从角落的握柄发起，避免和内部图标/条目拖拽冲突
  attachWorkspaceDrag(col, key) {
    const grip = col.createDiv({ cls: "mal-ws-grip", text: "⠿" });
    grip.setAttribute("draggable", "true");
    grip.setAttribute("title", "拖动调整这一块的位置");
    grip.addEventListener("dragstart", event => {
      event.dataTransfer.setData("text/x-mal-ws", key);
      event.dataTransfer.effectAllowed = "move";
      grip.addClass("is-dragging");
    });
    grip.addEventListener("dragend", () => grip.removeClass("is-dragging"));
    col.addEventListener("dragover", event => {
      if (!Array.from(event.dataTransfer.types).includes("text/x-mal-ws")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      col.addClass("is-ws-drop");
    });
    col.addEventListener("dragleave", () => col.removeClass("is-ws-drop"));
    col.addEventListener("drop", async event => {
      col.removeClass("is-ws-drop");
      const source = event.dataTransfer.getData("text/x-mal-ws");
      if (!source || source === key) return;
      event.preventDefault();
      const order = [...(this.plugin.settings.workspaceOrder || ["album", "apps", "entry"])];
      const from = order.indexOf(source);
      if (from < 0) return;
      order.splice(from, 1);
      const at = order.indexOf(key);
      if (at < 0) return;
      order.splice(at, 0, source);
      this.plugin.settings.workspaceOrder = order;
      await this.plugin.saveSettings();
      this.render();
    });
  }

  // 快捷入口：2×2 网格，每格一条链接，空格显示 +，点开对应网址
  renderCustomEntry(col, group = "right") {
    const entries = (group === "left"
      ? (this.plugin.settings.leftEntries || [])
      : (this.plugin.settings.customEntries || [])).slice(0, 4);
    const grid = col.createDiv({ cls: "mal-entry-grid" });
    for (let i = 0; i < 4; i++) {
      const entry = entries[i];
      if (entry) {
        const box = grid.createDiv({ cls: "mal-entry-single" });
        // 前台只展示图标 + 名字
        if (entry.iconImage) {
          box.createEl("img", { cls: "mal-entry-img", attr: { src: entry.iconImage } });
        } else if (entry.emoji) {
          const icon = box.createDiv({ cls: "mal-entry-icon", text: entry.emoji });
          if (entry.iconColor) icon.style.color = entry.iconColor;
        }
        box.createDiv({ cls: "mal-entry-title", text: entry.title || "快捷入口" });
        box.setAttribute("title", entry.url ? `${entry.title} · ${entry.url}` : "点击编辑快捷入口");
        box.addEventListener("click", () => {
          if (entry.url) openExternalUrl(entry.url);
          else this.openCustomEntryEditor(group);
        });
        box.addEventListener("contextmenu", event => {
          event.preventDefault();
          this.openCustomEntryEditor(group);
        });
      } else {
        const slot = grid.createDiv({ cls: "mal-entry-single mal-entry-slot" });
        slot.createDiv({ cls: "mal-entry-plus", text: "+" });
        slot.setAttribute("title", "添加快捷入口");
        slot.addEventListener("click", () => this.openCustomEntryEditor(group));
      }
    }
  }

  openCustomEntryEditor(group = "right") {
    new CustomEntryModal(this.app, this.plugin, group, () => this.render()).open();
  }

  // 右侧广告位：两行一列，每个只含图片 + 网址链接
  renderAdSlots(col) {
    const ads = (this.plugin.settings.adSlots || []).slice(0, 2);
    const list = col.createDiv({ cls: "mal-ad-list" });
    for (let i = 0; i < 2; i++) {
      const ad = ads[i];
      if (ad && (ad.image || ad.url)) {
        const slot = list.createDiv({ cls: "mal-ad-slot" });
        if (ad.image) slot.createEl("img", { cls: "mal-ad-img", attr: { src: ad.image } });
        slot.setAttribute("title", ad.url ? ad.url : "点击编辑广告位");
        slot.addEventListener("click", () => {
          if (ad.url) openExternalUrl(ad.url);
          else this.openAdEditor();
        });
        slot.addEventListener("contextmenu", event => {
          event.preventDefault();
          this.openAdEditor();
        });
      } else {
        const slot = list.createDiv({ cls: "mal-ad-slot mal-ad-empty" });
        slot.createDiv({ cls: "mal-entry-plus", text: "+" });
        slot.setAttribute("title", "添加广告");
        slot.addEventListener("click", () => this.openAdEditor());
      }
    }
  }

  openAdEditor() {
    new AdSlotModal(this.app, this.plugin, () => this.render()).open();
  }

  // 首页顶部常用应用：只展示置顶与高频应用，不再在卡册下方铺开全部软件。
  renderQuickApps(container, selected, term = "") {
    const apps = [...(selected || [])];
    const query = String(term || "").trim().toLocaleLowerCase();
    const candidates = query ? apps.filter(app =>
      `${app.name} ${app.path} ${app.category} ${app.description} ${app.usage}`.toLocaleLowerCase().includes(query)
    ) : apps;
    const pinOrder = this.plugin.settings.pinnedOrder || [];
    const pinRank = id => {
      const i = pinOrder.indexOf(id);
      return i < 0 ? 9999 : i;
    };
    const pinnedList = candidates.filter(a => a.pinned).sort((a, b) => pinRank(a.id) - pinRank(b.id));
    const used = candidates.filter(a => (a.launchCount || 0) > 0)
      .sort((a, b) => (b.launchCount || 0) - (a.launchCount || 0) || (b.lastLaunchedAt || 0) - (a.lastLaunchedAt || 0));
    const seenIds = new Set(pinnedList.map(a => a.id));
    const merged = pinnedList.concat(used.filter(a => !seenIds.has(a.id)));
    const list = (merged.length ? merged : candidates).slice(0, 16);

    const section = container.createDiv({ cls: "mal-home-apps" });
    const head = section.createDiv({ cls: "mal-home-apps-head" });
    const title = head.createDiv({ cls: "mal-home-apps-title" });
    title.createSpan({ text: "常用应用" });
    title.createSpan({ cls: "mal-home-apps-count", text: query ? `匹配 ${list.length} 个` : `${list.length} / ${apps.length}` });
    const manage = head.createEl("button", { text: "管理应用", cls: "mal-home-apps-manage" });
    manage.addEventListener("click", () => {
      this.mode = "manage";
      this.searchTerm = "";
      this.render();
    });

    const grid = section.createDiv({ cls: "mal-quick-grid mal-home-apps-grid" });
    // 固定每行 8 个图标，超过 8 个自动换成第二行
    grid.style.gridTemplateColumns = "repeat(8, minmax(0, 1fr))";
    if (!list.length) {
      const empty = grid.createDiv({ cls: "mal-home-apps-empty" });
      empty.createSpan({ text: query ? "没有匹配的常用应用" : "还没有常用应用" });
      const action = empty.createEl("button", {
        text: apps.length ? "选择常用应用" : (this.plugin.settings.hasScanned ? "管理应用" : "扫描本机应用"),
        cls: "mal-home-apps-manage"
      });
      action.addEventListener("click", () => {
        if (!apps.length && !this.plugin.settings.hasScanned) this.plugin.scanInstalledApps();
        else { this.mode = "manage"; this.render(); }
      });
      return;
    }

    for (const app of list) {
      const el = grid.createDiv({
        cls: `mal-quick-app mal-home-quick-app${app.pinned ? " is-pinned" : ""}`,
        attr: { tabindex: "0", role: "button", "aria-label": `启动 ${app.name}`, title: `${app.name} · 已启动 ${app.launchCount || 0} 次` }
      });
      el.dataset.appId = app.id;
      const icon = el.createDiv({ cls: "mal-quick-icon" });
      this.observeIcon(icon, app);
      el.createDiv({ cls: "mal-quick-name", text: app.name });
      el.addEventListener("click", () => this.plugin.launchApp(app));
      el.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.plugin.launchApp(app);
        }
      });
      el.addEventListener("contextmenu", event => {
        event.preventDefault();
        this.openAppMenu(app, event);
      });
      if (app.pinned && !query) {
        el.setAttribute("draggable", "true");
        el.addEventListener("dragstart", event => {
          event.dataTransfer.setData("text/plain", app.id);
          event.dataTransfer.effectAllowed = "move";
          el.addClass("is-dragging");
        });
        el.addEventListener("dragend", () => el.removeClass("is-dragging"));
        el.addEventListener("dragover", event => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          el.addClass("is-pinned-drop");
        });
        el.addEventListener("dragleave", () => el.removeClass("is-pinned-drop"));
        el.addEventListener("drop", async event => {
          event.preventDefault();
          el.removeClass("is-pinned-drop");
          const sourceId = event.dataTransfer.getData("text/plain");
          if (!sourceId || sourceId === app.id) return;
          await this.plugin.movePinnedApp(sourceId, app.id);
          this.render();
        });
      }
    }
  }

  // ---- 算力打卡卡册：汇总、入口卡、卡册页与打卡交互 ----
  // 打卡周期：once 只收一次 / daily 每天可收 / monthly 每月可收
  computeSummary() {
    const cards = Array.isArray(this.plugin.settings.computeCards) ? this.plugin.settings.computeCards : [];
    const records = Array.isArray(this.plugin.settings.computeClaimRecords) ? this.plugin.settings.computeClaimRecords : [];
    const todayKey = dateKey(new Date());
    const monthKey = todayKey.slice(0, 7);
    const byId = new Map(cards.map(card => [card.id, card]));
    const claimed = new Set();
    let claimedValue = 0;

    const validRecords = [];
    for (const record of records) {
      const card = byId.get(String(record.cardId || ""));
      // 孤儿记录保留在 data.json 供人工恢复，但跳过统计和周期状态判断。
      if (!card) continue;
      validRecords.push(record);
      claimedValue += Number(record.amountSnapshot) || 0;
      const cycle = card.cycle || "daily";
      const expectedPeriod = cycle === "once" ? "once" : cycle === "monthly" ? monthKey : todayKey;
      if (canonicalClaimPeriod(record, card) === expectedPeriod) claimed.add(card.id);
    }

    const recordsFor = card => validRecords
      .filter(record => record.cardId === card.id)
      .sort((a, b) => claimTimestamp(a) - claimTimestamp(b));
    const lastClaimRecord = card => {
      const list = recordsFor(card);
      return list.length ? list[list.length - 1] : null;
    };
    const lastClaim = card => {
      const record = lastClaimRecord(card);
      if (!record) return "";
      const timestamp = claimTimestamp(record);
      if (timestamp) return dateKey(new Date(timestamp));
      return isValidDateKey(record.periodKey) ? record.periodKey : String(record.periodKey || "");
    };

    const open = cards.filter(card =>
      isComputeCardInValidity(card, todayKey) && !claimed.has(card.id)
    );
    const valid = cards.filter(card => isComputeCardInValidity(card, todayKey));
    return {
      cards,
      records,
      claimed,
      open,
      openCount: open.length,
      openValue: open.reduce((sum, card) => sum + (Number(card.amount) || 0), 0),
      doneCount: claimed.size,
      validCount: valid.length,
      expiredCount: cards.length - valid.length,
      claimedValue,
      total: validRecords.length,
      lastClaim,
      lastClaimRecord
    };
  }

  // 与活跃月历并排的卡册入口卡：待领价值 + 收集进度，整卡可点
  renderAlbumEntry(container) {
    const s = this.computeSummary();
    const total = s.cards.length;
    const card = container.createDiv({ cls: "mal-album-entry" });

    const top = card.createDiv({ cls: "mal-album-entry-top" });
    top.createSpan({ cls: "mal-album-entry-kicker", text: "AI 算力卡册" });
    top.createSpan({ cls: "mal-album-entry-badge", text: "⚡" });
    card.createDiv({ cls: "mal-album-entry-note", text: `累计已领 ¥${s.claimedValue} · 打卡 ${s.total} 次` });

    const mid = card.createDiv({ cls: "mal-album-entry-mid" });
    mid.createDiv({ cls: "mal-album-entry-value", text: `¥${s.openValue}` });
    mid.createDiv({ cls: "mal-album-entry-sub", text: `当前可领 · 已收 ${s.doneCount}/${total} 张` });

    const bar = card.createDiv({ cls: "mal-album-entry-bar" });
    const fill = bar.createDiv({ cls: "mal-album-entry-fill" });
    fill.style.width = total ? `${Math.max(4, Math.round(s.doneCount / total * 100))}%` : "0";

    card.createDiv({ cls: "mal-album-entry-cta", text: "打开卡册 ›" });
    card.setAttribute("title", "打开 AI 算力卡册");
    card.addEventListener("click", () => {
      this.mode = "album";
      this.render();
    });
  }

  // 卡册页：说明条 + 统计卡 + 周期筛选 + 分组卡片
  renderAlbum(body, term = "") {
    const s = this.computeSummary();
    const query = String(term || "").trim().toLocaleLowerCase();
    const matchedCards = query ? s.cards.filter(card => {
      const app = this.resolveCardApp(card);
      return `${card.name || ""} ${card.group || ""} ${card.desc || ""} ${card.url || ""} ${app?.name || ""} ${app?.category || ""}`
        .toLocaleLowerCase().includes(query);
    }) : s.cards;
    const wrap = body.createDiv({ cls: "mal-album" });

    const hero = wrap.createDiv({ cls: "mal-album-hero" });
    const heroHead = hero.createDiv({ cls: "mal-album-hero-head" });
    heroHead.createSpan({ cls: "mal-album-hero-title", text: "👑 AI 算力福利" });
    heroHead.createSpan({
      cls: "mal-album-hero-note",
      text: "活动由各官方组织运营，与本插件无关；福利可能过期下架或名额有限，领取结果请以平台为准。"
    });

    const stats = hero.createDiv({ cls: "mal-album-stats" });
    const stat = (icon, label, value, sub, accent) => {
      const box = stats.createDiv({ cls: `mal-album-stat${accent ? " is-accent" : ""}` });
      box.createDiv({ cls: "mal-album-stat-icon", text: icon });
      const body = box.createDiv({ cls: "mal-album-stat-body" });
      body.createDiv({ cls: "mal-album-stat-label", text: label });
      body.createDiv({ cls: "mal-album-stat-value", text: value });
      body.createDiv({ cls: "mal-album-stat-sub", text: sub });
    };
    stat("🪙", "当前可领价值", `¥${s.openValue}`, `${s.openCount} 个有效福利待领`, true);
    stat("✅", "本期已收", `${s.doneCount} 张`, `卡册共 ${s.cards.length} 张`, false);
    stat("📈", "累计已领价值", `¥${s.claimedValue}`, `共打卡 ${s.total} 次`, false);

    const head = wrap.createDiv({ cls: "mal-album-head" });
    head.createEl("h3", { text: "AI 算力卡册" });
    const tools = head.createDiv({ cls: "mal-album-tools" });
    tools.createSpan({ cls: "mal-album-count", text: `${s.cards.length} 张 · 有效 ${s.validCount} 张 · 已收 ${s.doneCount} 张` });
    const add = tools.createEl("button", { cls: "mal-album-pill is-dark", text: "+ 添加卡片" });
    add.addEventListener("click", () => {
      new ComputeCardModal(this.app, this.plugin, null, () => this.render()).open();
    });

    // 卡册排序：一次性未领取 > 每日/每月（周期性） > 一次性已领取
    const cardRank = card => {
      const cycle = card.cycle || "daily";
      const claimed = s.claimed.has(card.id);
      if (cycle === "once") return claimed ? 2 : 0;
      return 1;
    };
    const sortedCards = [...matchedCards].sort((a, b) => cardRank(a) - cardRank(b));

    // 卡册网格：卡片收集进度的可视化，点开看详情
    const shelf = wrap.createDiv({ cls: "mal-album-shelf" });
    if (sortedCards.length) {
      for (const card of sortedCards) this.renderShelfCard(shelf, card, s);
    } else if (!query) {
      shelf.createEl("p", { cls: "mal-muted", text: "还没有卡片，点「+ 添加卡片」开始收集。" });
    }
  }

  // 卡册网格里的单张卡：面值在上、图标+名称居中、底部双标签
  renderShelfCard(grid, card, s) {
    const claimed = s.claimed.has(card.id);
    const available = isComputeCardInValidity(card);
    const cycle = card.cycle || "daily";
    const cycleLabel = cycle === "once" ? "一次性" : cycle === "daily" ? "每日" : "每月";
    const el = grid.createDiv({ cls: `mal-shelf-card${claimed ? " is-claimed" : ""}${!available ? " is-expired" : ""}` });

    const top = el.createDiv({ cls: "mal-shelf-top" });
    top.createSpan({ cls: "mal-shelf-value", text: card.value || "—" });
    top.createSpan({ cls: `mal-shelf-dot${claimed ? " is-on" : " is-off"}` });

    const main = el.createDiv({ cls: "mal-shelf-main" });
    const icon = main.createDiv({ cls: "mal-shelf-icon", text: card.emoji || "⚡" });
    icon.style.background = `color-mix(in srgb, ${card.color || "#0ea5e9"} 18%, transparent)`;
    main.createDiv({ cls: "mal-shelf-name", text: card.name });

    const foot = el.createDiv({ cls: "mal-shelf-foot" });
    foot.createSpan({ cls: "mal-shelf-cycle", text: `📅 ${cycleLabel}` });
    const isDone = claimed;
    const stateText = isDone ? "✓ 已收" : !available ? (card.enabled === false ? "已停用" : "已过期") : "○ 待收";
    foot.createSpan({ cls: `mal-shelf-state${isDone ? " is-done" : ""}`, text: stateText });

    el.setAttribute("data-card-id", card.id);
    el.setAttribute("title", `${card.name} · ${card.value || ""}${claimed ? " · 已收" : " · 待收"}`);
    el.addEventListener("click", () => this.openCardDetail(card, el));
    el.addEventListener("contextmenu", event => {
      event.preventDefault();
      this.openAlbumCardMenu(card, event);
    });
  }

  renderAlbumCard(grid, card, s) {
    const claimed = s.claimed.has(card.id);
    const available = isComputeCardInValidity(card);
    const cycle = card.cycle || "daily";
    const cycleLabel = cycle === "once" ? "一次性" : cycle === "daily" ? "每日" : "每月";
    const el = grid.createDiv({ cls: `mal-album-row${claimed ? " is-claimed" : ""}${!isComputeCardInValidity(card) ? " is-expired" : ""}` });

    const icon = el.createDiv({ cls: "mal-album-row-icon", text: card.emoji || "⚡" });
    icon.style.background = `color-mix(in srgb, ${card.color || "#0ea5e9"} 16%, transparent)`;

    const body = el.createDiv({ cls: "mal-album-row-body" });
    body.createDiv({ cls: "mal-album-row-title", text: card.name });
    if (card.value) body.createDiv({ cls: "mal-album-row-value", text: card.value });
    if (card.desc) body.createDiv({ cls: "mal-album-row-desc", text: card.desc });

    const meta = body.createDiv({ cls: "mal-album-row-meta" });
    meta.createSpan({ cls: "mal-album-row-chip", text: `${cycleLabel}领取` });
    meta.createSpan({
      cls: `mal-album-row-state${claimed ? " is-done" : ""}`,
      text: claimed
        ? (cycle === "once" ? "已收入卡册" : cycle === "daily" ? "今天已领 · 明天再来" : "本月已领 · 下月再来")
        : !available
          ? (card.enabled === false ? "已停用" : "不在福利有效期")
          : (cycle === "once" ? "一次性福利" : cycle === "daily" ? "每日可领一次" : "每月可领一次")
    });
    const localApp = this.resolveCardApp(card);
    const installed = isAppBundleInstalled(localApp);
    if (card.amount) meta.createSpan({ cls: "mal-album-row-chip is-soft", text: `参考估值 ¥${card.amount}` });
    if (localApp) meta.createSpan({
      cls: `mal-album-row-chip ${installed ? "is-client" : "is-web"}`,
      text: `${installed ? "客户端可用" : isWebOnlyApp(localApp) ? "网页应用" : "客户端未安装"} · ${localApp.name}`
    });
    const detailLink = meta.createSpan({ cls: "mal-album-row-link", text: "📖 福利详情" });
    detailLink.addEventListener("click", event => {
      event.stopPropagation();
      this.openCardDetail(card);
    });

    const side = el.createDiv({ cls: "mal-album-row-side" });
    const webUrl = this.getCardWebUrl(card, localApp);
    if (claimed) {
      const last = s.lastClaim(card);
      const stamp = side.createDiv({ cls: "mal-album-stamp" });
      stamp.createDiv({ cls: "mal-album-stamp-main", text: cycle === "daily" ? "今天已领" : cycle === "monthly" ? "本月已领" : "已收入卡册" });
      if (last) stamp.createDiv({ cls: "mal-album-stamp-date", text: `${Number(last.slice(5, 7))}.${Number(last.slice(8, 10))}` });
    } else if (!available) {
      side.createSpan({ cls: "mal-album-row-state", text: card.enabled === false ? "已停用" : "不在福利有效期" });
    } else {
      const installed = isAppBundleInstalled(localApp);
      if (installed || webUrl) {
        const mainLabel = installed ? "打开客户端" : "打开网页";
        const go = side.createEl("button", { cls: "mal-album-go", text: `${mainLabel} ↗` });
        go.setAttribute("title", "Smart：优先打开可用客户端，否则打开网页");
        go.addEventListener("click", async event => {
          event.stopPropagation();
          const opened = await this.launchOrOpen(card, localApp, "smart");
          if (opened) new Notice("入口已打开。完成实际领取后，返回卡册点击「标记已收」。", 6000);
        });
        if (installed && webUrl) {
          const arrow = side.createEl("button", { cls: "mal-album-go is-arrow", text: "▾" });
          arrow.setAttribute("title", "手动切换客户端或网页");
          arrow.addEventListener("click", event => {
            event.stopPropagation();
            const menu = new Menu();
            menu.addItem(item => item
              .setTitle(`打开客户端 · ${localApp.name}`)
              .setIcon("play")
              .onClick(async () => {
                const opened = await this.launchOrOpen(card, localApp, "client");
                if (opened) new Notice("客户端入口已打开。完成实际领取后，请手动标记。", 6000);
              }));
            menu.addItem(item => item
              .setTitle("打开网页 ↗")
              .setIcon("external-link")
              .onClick(async () => {
                const opened = await this.openUrlOnly(card, localApp);
                if (opened) new Notice("网页入口已打开。完成实际领取后，请手动标记。", 6000);
              }));
            menu.showAtEvent(event);
          });
        }
      } else {
        side.createSpan({ cls: "mal-album-row-state", text: "尚未配置启动入口" });
      }

      // 人工确认是唯一写入领取记录的入口；启动客户端/网页不会自动打卡。
      const mark = side.createEl("button", { cls: "mal-album-confirm", text: "标记已收" });
      mark.setAttribute("title", "完成实际领取后，手动确认本周期已领取");
      mark.addEventListener("click", async event => {
        event.stopPropagation();
        await this.checkinCard(card.id);
        this.render();
      });
    }

    el.setAttribute("title", `${card.name} · ${card.value || ""} · 点开看详情`);
    el.addEventListener("click", () => this.openCardDetail(card));
    el.addEventListener("contextmenu", event => {
      event.preventDefault();
      this.openAlbumCardMenu(card, event);
    });
  }

  // 卡片详情：说明 + 客户端/网页入口 + 人工标记/取消 + 编辑删除
  openCardDetail(card, srcEl = null) {
    const s = this.computeSummary();
    const claimed = s.claimed.has(card.id);
    const last = s.lastClaim(card);
    const cycle = card.cycle || "daily";
    const cycleLabel = cycle === "once" ? "一次性" : cycle === "daily" ? "每日" : "每月";
    const localApp = this.resolveCardApp(card);
    const installed = isAppBundleInstalled(localApp);
    const webUrl = this.getCardWebUrl(card, localApp);
    const available = isComputeCardInValidity(card);

    const overlay = document.body.createDiv({ cls: "mal-compute-overlay" });
    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const originEl = srcEl || document.querySelector(`.mal-shelf-card[data-card-id="${card.id}"]`);
    let ghost = null;
    const restoreOrigin = () => {
      if (ghost) { ghost.remove(); ghost = null; }
      if (originEl) originEl.style.visibility = "";
    };
    const closeOverlay = () => {
      restoreOrigin();
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = evt => { if (evt.key === "Escape") closeOverlay(); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", evt => { if (evt.target === overlay) closeOverlay(); });

    // 左侧：放大浮起的卡片
    const peek = overlay.createDiv({ cls: "mal-compute-peek" });
    peek.createDiv({ cls: "mal-peek-kicker", text: card.value || cycleLabel });
    const picon = peek.createDiv({ cls: "mal-peek-icon", text: card.emoji || "⚡" });
    picon.style.background = `color-mix(in srgb, ${card.color || "#0ea5e9"} 20%, transparent)`;
    peek.createDiv({ cls: "mal-peek-name", text: card.name });
    peek.createDiv({ cls: "mal-peek-tier", text: cycle === "once" ? "一次性卡" : cycle === "daily" ? "普通卡" : "月度卡" });
    // 左侧放大卡等翻转动画结束后再入场，避免与飞行中的卡片重叠
    peek.style.animationDelay = reducedMotion ? "0ms" : "300ms";

    // 卡片从原位翻转飞出，落到左侧放大卡的位置
    if (originEl && !reducedMotion) {
      const from = originEl.getBoundingClientRect();
      const to = peek.getBoundingClientRect();
      ghost = originEl.cloneNode(true);
      ghost.classList.add("mal-flip-ghost");
      Object.assign(ghost.style, {
        position: "fixed",
        left: from.left + "px",
        top: from.top + "px",
        width: from.width + "px",
        height: from.height + "px",
        margin: "0",
        zIndex: "10000",
        pointerEvents: "none",
        opacity: "1"
      });
      document.body.appendChild(ghost);
      originEl.style.visibility = "hidden";
      const c1x = from.left + from.width / 2;
      const c1y = from.top + from.height / 2;
      const c2x = to.left + to.width / 2;
      const c2y = to.top + to.height / 2;
      const sc = Math.max(to.width / from.width, to.height / from.height);
      const dx = c2x - c1x;
      const dy = c2y - c1y;
      const anim = ghost.animate(
        [
          { transform: "perspective(1000px) translate3d(0,0,0) scale(1) rotateY(0deg)", opacity: "1" },
          { transform: `perspective(1000px) translate3d(${dx}px, ${dy}px, 0) scale(${sc}) rotateY(180deg)`, opacity: "0.15" }
        ],
        { duration: 300, easing: "cubic-bezier(.2,.85,.3,1)", fill: "forwards" }
      );
      anim.onfinish = () => {
        if (ghost) { ghost.remove(); ghost = null; }
        if (originEl) originEl.style.visibility = "";
      };
    }

    // 右侧：详情面板
    const panel = overlay.createDiv({ cls: "mal-compute-panel" });
    panel.style.animationDelay = reducedMotion ? "0ms" : "320ms";
    const head = panel.createDiv({ cls: "mal-panel-head" });
    head.createSpan({ cls: "mal-panel-badge", text: cycle === "once" ? "一次性卡" : cycle === "daily" ? "普通卡" : "月度卡" });
    const closeBtn = head.createEl("button", { cls: "mal-panel-close", text: "✕" });
    closeBtn.addEventListener("click", closeOverlay);
    panel.createEl("h3", { cls: "mal-panel-title", text: card.name });

    const rows = panel.createDiv({ cls: "mal-panel-rows" });
    const row = (k, v) => {
      const r = rows.createDiv({ cls: "mal-panel-row" });
      r.createDiv({ cls: "mal-panel-k", text: k });
      r.createDiv({ cls: "mal-panel-v", text: v || "—" });
    };
    row("奖励", card.value || "—");
    row("说明", card.desc || "—");
    row("参与条件", localApp ? `使用 ${localApp.name}，具体以平台说明为准` : "以平台说明为准");
    row("领取与刷新", cycle === "once" ? "仅可领取一次" : cycle === "daily" ? "每天可领取一次" : "每个自然月可领取一次");
    row("有效期", `${card.validFrom || "不限"} 至 ${card.validUntil || "不限"}`);
    row("使用范围", card.amount ? `参考估值 ¥${card.amount}` : "以平台发放为准");
    row("类型", cycle === "once" ? "一次性" : cycle === "daily" ? "每天都能领" : "每月可领");
    row("已领", claimed ? `本周期已领${last ? `（${last}）` : ""}` : "本周期未领");
    if (webUrl) row("网页入口", webUrl);

    const status = panel.createDiv({ cls: `mal-compute-detail-status${claimed ? " is-done" : ""}` });
    status.setText(claimed
      ? `本周期已收${last ? ` · ${last}` : ""}`
      : !available
        ? (card.enabled === false ? "此福利已停用" : "当前不在福利有效期")
        : `本周期未收${last ? ` · 上次 ${last}` : ""}`);

    if (!claimed && available) {
      panel.createEl("p", {
        cls: "mal-panel-hint",
        text: "打开客户端或网页不会自动记为已领取。完成实际领取后，请返回这里点击「标记已收」。"
      });
    }

    const actions = panel.createDiv({ cls: "mal-mood-actions" });
    if (!claimed && available) {
      if (installed || webUrl) {
        const mainLabel = installed ? "尝试打开客户端" : "打开网页";
        const mainBtn = actions.createEl("button", { cls: "mod-cta", text: `${mainLabel} ↗` });
        mainBtn.addEventListener("click", async () => {
          const opened = await this.launchOrOpen(card, localApp, "smart");
          if (opened) new Notice("入口已打开。完成实际领取后，请返回此处点击「标记已收」。", 6000);
        });
        if (installed && webUrl) {
          const arrow = actions.createEl("button", { text: "切换入口 ▾" });
          arrow.addEventListener("click", event => {
            event.stopPropagation();
            const menu = new Menu();
            menu.addItem(item => item.setTitle(`打开客户端 · ${localApp.name}`).setIcon("play").onClick(async () => {
              const opened = await this.launchOrOpen(card, localApp, "client");
              if (opened) new Notice("客户端入口已打开。完成实际领取后，请手动标记。", 6000);
            }));
            menu.addItem(item => item.setTitle("打开网页 ↗").setIcon("external-link").onClick(async () => {
              const opened = await this.openUrlOnly(card, localApp);
              if (opened) new Notice("网页入口已打开。完成实际领取后，请手动标记。", 6000);
            }));
            menu.showAtEvent(event);
          });
        }
      } else {
        actions.createSpan({ cls: "mal-muted", text: "尚未配置可用的客户端或网页入口" });
      }
    }
    if (claimed) {
      const undo = actions.createEl("button", { text: "取消本周期记录" });
      undo.addEventListener("click", async () => {
        await this.uncheckCard(card);
        closeOverlay();
        this.render();
      });
    } else if (available) {
      const mark = actions.createEl("button", { text: "标记已收", cls: "mal-compute-confirm-detail" });
      mark.addEventListener("click", async () => {
        await this.checkinCard(card.id);
        closeOverlay();
        this.render();
      });
    }
    const edit = actions.createEl("button", { text: "编辑" });
    edit.addEventListener("click", () => {
      closeOverlay();
      new ComputeCardModal(this.app, this.plugin, card, () => this.render()).open();
    });
  }

  // 福利卡片通过稳定 appId 关联统一应用资源。
  resolveCardApp(card) {
    return resolveComputeCardApp(card, this.plugin.settings.apps || []);
  }

  getCardWebUrl(card, app = this.resolveCardApp(card)) {
    const cardUrl = normalizeExternalHttpUrl(card?.url || "");
    if (cardUrl) return cardUrl;
    if (app && isSystemAppPath(app.path)) return "";
    return normalizeExternalHttpUrl(app?.websiteUrl || "") || "";
  }

  // 手动选择网页入口；优先使用卡片专属领取链接，否则回退到应用官方网站。
  async openUrlOnly(card, localApp) {
    const app = localApp || this.resolveCardApp(card);
    const url = this.getCardWebUrl(card, app);
    if (!url) {
      new Notice(`「${card.name}」没有配置网页入口`);
      return false;
    }
    if (app) {
      const result = await this.plugin.launchApp(app, { silent: true, forceWeb: true, fallbackUrl: url });
      return !!(result && result.ok);
    }
    return openExternalUrl(url);
  }

  // Smart：优先启动有效的本地客户端；客户端不可用或启动失败时回退网页。
  async launchOrOpen(card, localApp, mode = "smart") {
    const app = localApp || this.resolveCardApp(card);
    const webUrl = this.getCardWebUrl(card, app);
    if (mode === "web") {
      if (webUrl) return openExternalUrl(webUrl);
      new Notice(`「${card.name}」没有配置网页入口`);
      return false;
    }
    if (app && isAppBundleInstalled(app)) {
      const result = await this.plugin.launchApp(app, {
        silent: true,
        fallbackUrl: webUrl
      });
      return !!(result && result.ok);
    }
    if (webUrl) return openExternalUrl(webUrl);
    new Notice(`「${card.name}」既没有可用客户端，也没有网页入口`);
    return false;
  }

  async checkinCard(cardId) {
    const card = (this.plugin.settings.computeCards || []).find(item => item.id === cardId);
    if (!card) {
      new Notice("找不到这张福利卡片");
      return false;
    }
    if (!isComputeCardInValidity(card)) {
      new Notice(card.enabled === false ? "这张福利卡片已停用" : "这张福利卡片当前不在有效期");
      return false;
    }
    const todayKey = dateKey(new Date());
    const cycle = card.cycle || "daily";
    const periodKey = cycle === "once" ? "once" : cycle === "monthly" ? todayKey.slice(0, 7) : todayKey;
    const records = Array.isArray(this.plugin.settings.computeClaimRecords)
      ? this.plugin.settings.computeClaimRecords
      : (this.plugin.settings.computeClaimRecords = []);
    const alreadyClaimed = records.some(record =>
      String(record.cardId || "") === String(cardId) &&
      canonicalClaimPeriod(record, card) === periodKey
    );
    if (alreadyClaimed) {
      new Notice(cycle === "once" ? "这张一次性福利已经记录过" : "本周期已经记录过领取");
      return false;
    }
    const claimedAt = Date.now();
    records.push(normalizeClaimRecord({
      id: `claim-${cardId}-${claimedAt.toString(36)}`,
      cardId,
      periodKey,
      claimedAt,
      amountSnapshot: Number(card.amount) || 0,
      valueSnapshot: card.value || "",
      currency: card.currency || "CNY",
      source: "manual"
    }, records.length));
    // 双写旧日期映射，方便用户临时回退到 1.27.x 时仍能看到新打卡日期。
    const legacyMap = this.plugin.settings.computeCheckins || (this.plugin.settings.computeCheckins = {});
    const legacyList = Array.isArray(legacyMap[todayKey]) ? legacyMap[todayKey] : [];
    if (!legacyList.includes(cardId)) legacyMap[todayKey] = [...legacyList, cardId];
    await this.plugin.saveSettings();
    new Notice("已记录本次领取");
    return true;
  }

  // 撤销当前周期最近一条人工确认记录，不改动其他日期或周期。
  async uncheckCard(card) {
    const records = Array.isArray(this.plugin.settings.computeClaimRecords)
      ? this.plugin.settings.computeClaimRecords
      : [];
    const cycle = card.cycle || "daily";
    const todayKey = dateKey(new Date());
    const periodKey = cycle === "once" ? "once" : cycle === "monthly" ? todayKey.slice(0, 7) : todayKey;
    const candidates = records
      .map((record, index) => ({ record, index }))
      .filter(item => String(item.record.cardId || "") === String(card.id) &&
        canonicalClaimPeriod(item.record, card) === periodKey)
      .sort((a, b) => claimTimestamp(b.record) - claimTimestamp(a.record));
    if (!candidates.length) return false;
    const removed = candidates[0].record;
    records.splice(candidates[0].index, 1);
    const removedTimestamp = claimTimestamp(removed);
    const removedDay = removedTimestamp
      ? dateKey(new Date(removedTimestamp))
      : (isValidDateKey(removed.periodKey) ? removed.periodKey : "");
    const legacyMap = this.plugin.settings.computeCheckins || {};
    if (removedDay) {
      const legacyIds = (legacyMap[removedDay] || []).filter(id => id !== card.id);
      if (legacyIds.length) legacyMap[removedDay] = legacyIds;
      else delete legacyMap[removedDay];
    }
    await this.plugin.saveSettings();
    new Notice("已撤销本周期领取记录");
    return true;
  }

  openAlbumCardMenu(card, event) {
    const menu = new Menu();
    const app = this.resolveCardApp(card);
    const webUrl = this.getCardWebUrl(card, app);
    if (webUrl) {
      menu.addItem(item => item.setTitle("打开网页入口").setIcon("external-link").onClick(() => openExternalUrl(webUrl)));
    }
    if (app && isAppBundleInstalled(app)) {
      menu.addItem(item => item
        .setTitle(`打开客户端 · ${app.name}`)
        .setIcon("monitor")
        .onClick(() => this.launchOrOpen(card, app, "client")));
    }
    menu.addItem(item => item.setTitle("编辑卡片").setIcon("pencil").onClick(() => {
      new ComputeCardModal(this.app, this.plugin, card, () => this.render()).open();
    }));
    menu.addItem(item => item.setTitle("复制名称").setIcon("copy").onClick(() => {
      navigator.clipboard.writeText(`${card.name} ${card.value || ""}`.trim());
      new Notice("已复制卡片信息");
    }));
    menu.addSeparator();
    menu.addItem(item => item.setTitle("删除卡片及其领取记录").setIcon("trash").onClick(async () => {
      const confirmed = typeof window.confirm === "function"
        ? window.confirm(`确定删除「${card.name}」及其历史领取记录吗？此操作不可撤销。`)
        : true;
      if (!confirmed) return;
      this.plugin.settings.computeCards = (this.plugin.settings.computeCards || []).filter(item => item.id !== card.id);
      this.plugin.settings.computeClaimRecords = (this.plugin.settings.computeClaimRecords || []).filter(record => record.cardId !== card.id);
      // 删除的是默认卡时记入黑名单，避免作者后续新增默认卡时把已删的卡重新并入。
      if (DEFAULT_COMPUTE_CARDS.some(def => String(def.id) === String(card.id))) {
        const deleted = new Set((this.plugin.settings.deletedCardIds || []).map(String));
        deleted.add(String(card.id));
        this.plugin.settings.deletedCardIds = [...deleted];
      }
      // 清理旧版映射中的同一卡片记录，避免旧数据残留。
      for (const [day, ids] of Object.entries(this.plugin.settings.computeCheckins || {})) {
        const next = Array.isArray(ids) ? ids.filter(id => id !== card.id) : [];
        if (next.length) this.plugin.settings.computeCheckins[day] = next;
        else delete this.plugin.settings.computeCheckins[day];
      }
      await this.plugin.saveSettings();
      this.render();
      new Notice(`已删除卡片及历史记录：${card.name}`);
    }));
    menu.showAtMouseEvent(event);
  }


  // 图例 + 总计占位（放在标题行右侧，省出高度给日历网格）
  calLegend(nav) {
    const legend = nav.createDiv({ cls: "mal-cal-legend" });
    legend.createDiv({ cls: "mal-cal-swatch is-on" });
    legend.createDiv({ cls: "mal-cal-legend-text", text: "已启动" });
    legend.createDiv({ cls: "mal-cal-swatch is-off" });
    legend.createDiv({ cls: "mal-cal-legend-text", text: "无记录" });
    return nav.createDiv({ cls: "mal-cal-total", text: "" });
  }

  // 全年视图：按周成列、周一至周日成行，底部标月份（类似 GitHub 贡献图）
  // 近一年（53 周）范围内是否有启动或心情记录
  hasRecentActivity(daily) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const endMonday = new Date(now);
    endMonday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const start = new Date(endMonday);
    start.setDate(endMonday.getDate() - 52 * 7);
    const s = dateKey(start);
    const e = dateKey(now);
    const mood = this.plugin.settings.moodDaily || {};
    return Object.keys(daily).some(k => k >= s && k <= e && daily[k] > 0)
      || Object.keys(mood).some(k => k >= s && k <= e);
  }

  // 空状态：不画一整块灰格子，给一条可读的引导
  renderYearEmpty(board) {
    const box = board.createDiv({ cls: "mal-cal-empty" });
    box.createDiv({ cls: "mal-cal-empty-icon", text: "🗓" });
    const text = box.createDiv({ cls: "mal-cal-empty-text" });
    text.createDiv({ cls: "mal-cal-empty-title", text: "近一年还没有记录" });
    text.createDiv({ cls: "mal-cal-empty-sub", text: "从应用中心启动任意应用后开始统计" });
  }

  renderYearMap(board, daily, totalEl) {
    const WEEKS = 53;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endMonday = new Date(today);
    endMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const startMonday = new Date(endMonday);
    startMonday.setDate(endMonday.getDate() - (WEEKS - 1) * 7);

    const wrap = board.createDiv({ cls: "mal-cal-year-wrap" });
    const grid = wrap.createDiv({ cls: "mal-cal-year-grid" });
    const labels = wrap.createDiv({ cls: "mal-cal-year-labels" });
    const labelCells = [];
    let total = 0;
    let prevMonth = -1;

    for (let w = 0; w < WEEKS; w++) {
      const monday = new Date(startMonday);
      monday.setDate(startMonday.getDate() + w * 7);
      labelCells.push(monday.getMonth() !== prevMonth ? `${monday.getMonth() + 1}月` : "");
      prevMonth = monday.getMonth();

      for (let d = 0; d < 7; d++) {
        const date = new Date(monday);
        date.setDate(monday.getDate() + d);
        const cell = grid.createDiv({ cls: "mal-cal-year-cell" });
        if (date > today) {
          cell.addClass("is-future");
          continue;
        }
        const key = dateKey(date);
        const count = daily[key] || 0;
        total += count;
        const mood = (this.plugin.settings.moodDaily || {})[key];
        if (mood && mood.color) {
          cell.style.background = `color-mix(in srgb, ${mood.color} 55%, transparent)`;
          cell.addClass("has-mood");
        } else if (count > 0) {
          cell.addClass(`mal-cal-l${count <= 2 ? 1 : count <= 5 ? 2 : count <= 9 ? 3 : 4}`);
        }
        if (mood && mood.emoji) cell.setText(mood.emoji);
        if (date.getTime() === today.getTime()) cell.addClass("is-today");
        cell.addClass("is-clickable");
        cell.addEventListener("click", () => this.openMoodPicker(date));
        cell.setAttribute("title", `${key} · ${mood && mood.emoji ? "心情 " + mood.emoji + " · " : ""}${count ? count + " 次启动" : "无启动记录"} · 点击设置心情`);
      }
    }

    for (const text of labelCells) labels.createDiv({ cls: "mal-cal-year-label", text });
    totalEl.setText(`近一年共 ${total} 次`);
  }

  // 点击月历日期：打开心情设置弹窗（表情 + 颜色）
  openMoodPicker(date) {
    const key = dateKey(date);
    const current = (this.plugin.settings.moodDaily || {})[key];
    new MoodModal(this.app, this.plugin, date, current).open();
  }

  // 点击月历日期：跳转到当日日记（按文件名 YYYY-MM-DD.md 全库匹配，日记类目录优先）
  async openDayNote(date) {
    const key = dateKey(date);
    const KEYWORDS = ["daily", "周期笔记", "日记", "journal", "diary"];
    const weight = f => {
      const p = f.path.toLowerCase();
      const hit = KEYWORDS.some(k => p.includes(k));
      return hit ? 0 : 1;
    };
    const matches = this.app.vault.getMarkdownFiles()
      .filter(f => f.name === `${key}.md`)
      .sort((a, b) => weight(a) - weight(b) || a.path.length - b.path.length);
    if (!matches.length) {
      new Notice(`${key} 没有找到日记（按文件名 ${key}.md 匹配）`);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(matches[0], { active: true });
  }


  renderProgress(body) {
    if (!this.plugin.scanning) return;
    const panel = body.createDiv({ cls: "mal-progress-panel" });
    panel.createDiv({ text: this.plugin.scanStatus || "正在扫描应用…" });
    const progress = panel.createEl("progress", {
      attr: {
        max: Math.max(1, this.plugin.scanTotal || 1),
        value: this.plugin.scanProgress || 0
      }
    });
    progress.addClass("mal-progress");
    panel.createDiv({
      text: `${this.plugin.scanProgress || 0} / ${this.plugin.scanTotal || "…"}`,
      cls: "mal-progress-count"
    });
  }

  renderHome(body, term) {
    this.renderProgress(body);
    const selected = (this.plugin.settings.apps || []).filter(app => app.selected);
    // 首页布局模式：classic 三栏工作区（默认） / album 常用应用 + 完整卡册
    if ((this.plugin.settings.homeMode || "classic") === "album") {
      this.renderQuickApps(body, selected, term);
      this.renderAlbum(body, term);
    } else {
      const filteredSearch = selected.filter(app =>
        `${app.name} ${app.path} ${app.category} ${app.description} ${app.usage}`.toLocaleLowerCase().includes(term)
      );
      this.renderClassicHome(body, selected, filteredSearch, term);
    }
    if (this.detailAppId) this.renderDetailPanel(body);
  }

  // 传统顺序排列（搜索状态、或关闭自由布局时使用）
  renderClassicHome(body, selected, filteredSearch, term) {
    // 无搜索词：三栏工作区 + 下方完整卡册（与三栏等宽）
    if (!term) {
      this.renderDashboard(body, selected);
      this.renderAlbum(body, "");
      return;
    }
    this.renderCategoryNav(body, selected, term);

    if (!filteredSearch.length) {
      body.createEl("p", {
        text: selected.length ? "没有匹配的应用。" : "还没有选择要展示的应用。点击“管理应用”选择软件。",
        cls: "mal-empty"
      });
      return;
    }

    if (this.activeCategory !== "__all__") {
      const categoryApps = filteredSearch.filter(app => app.category === this.activeCategory);
      const regular = categoryApps.filter(app => !app.pinned);

      // 置顶应用统一显示在顶部工作区的「常用应用」里，分类分区里不再重复
      if (regular.length) this.renderAppSection(body, this.activeCategory, regular);
      if (!categoryApps.length) {
        body.createEl("p", { text: "这个分类下暂时没有应用。", cls: "mal-empty" });
      }
    } else {
      const orderMap = new Map(this.plugin.getCategories().map((c, i) => [c.name, i]));
      const categories = [...new Set(filteredSearch.filter(app => !app.pinned).map(app => app.category || "未分类"))]
        .sort((a, b) => (orderMap.get(a) ?? 999) - (orderMap.get(b) ?? 999) || a.localeCompare(b, "zh-Hans-CN"));
      for (const category of categories) {
        const items = filteredSearch.filter(app => !app.pinned && (app.category || "未分类") === category);
        if (items.length) this.renderAppSection(body, category, items);
      }
    }
  }

  // 首页模块清单：每个模块一个 id（分类分区按 cat:分类名 记录），自由布局按此顺序渲染
  // autoHeight：模块高度按内容实际高度贴合，不留空白
  buildHomeModules(selected, filteredSearch) {
    const defs = [];
    if (this.plugin.settings.showActivityCalendar !== false) {
      defs.push({ id: "dashboard", w: 12, h: 6, autoHeight: true, render: target => this.renderDashboard(target, selected) });
    }
    defs.push({ id: "nav", w: 12, h: 2, autoHeight: true, render: target => this.renderCategoryNav(target, selected, "") });

    if (!filteredSearch.length) return defs;

    if (this.activeCategory !== "__all__") {
      const categoryApps = filteredSearch.filter(app => app.category === this.activeCategory);
      const regular = categoryApps.filter(app => !app.pinned);
      // 置顶应用统一由顶部工作区展示，这里不再单独出卡片
      if (regular.length) {
        const catId = this.activeCategory;
        defs.push({ id: `cat:${catId}`, w: 12, h: 7, autoHeight: true, render: target => this.renderAppSection(target, catId, regular) });
      }
      return defs;
    }

    const orderMap = new Map(this.plugin.getCategories().map((c, i) => [c.name, i]));
    const categories = [...new Set(filteredSearch.filter(app => !app.pinned).map(app => app.category || "未分类"))]
      .sort((a, b) => (orderMap.get(a) ?? 999) - (orderMap.get(b) ?? 999) || a.localeCompare(b, "zh-Hans-CN"));
    for (const category of categories) {
      const items = filteredSearch.filter(app => !app.pinned && (app.category || "未分类") === category);
      if (items.length) {
        defs.push({ id: `cat:${category}`, w: 12, h: 7, autoHeight: true, render: target => this.renderAppSection(target, category, items) });
      }
    }
    return defs;
  }

  // 自由布局：12 列网格，模块可拖拽换位、拖右下角改宽高，顺序与尺寸写入配置
  renderFreeHome(body, selected, filteredSearch) {
    const defs = this.buildHomeModules(selected, filteredSearch);
    const defMap = new Map(defs.map(def => [def.id, def]));
    const settings = this.plugin.settings;
    const layout = this.plugin.getHomeLayout();

    // 渲染顺序：已保存的位置里当前存在的模块 + 新模块按默认尺寸追加到末尾
    // 暂时不存在的模块（如没有笔记绑定）保留在配置里，回来时仍占原位
    const ordered = layout.filter(item => defMap.has(item.id));
    const merged = layout.slice();
    for (const def of defs) {
      if (!merged.some(item => item.id === def.id)) {
        const fresh = { id: def.id, w: def.w, h: def.h };
        if (def.autoHeight) fresh.autoHeight = true;
        merged.push(fresh);
        ordered.push(fresh);
      }
    }
    if (merged.length !== layout.length) {
      settings.homeLayout = merged;
      this.plugin.saveSettings();
    }

    if (!filteredSearch.length) {
      body.createEl("p", {
        text: selected.length ? "没有匹配的应用。" : "还没有选择要展示的应用。点击“管理应用”选择软件。",
        cls: "mal-empty"
      });
      return;
    }

    const grid = body.createDiv({ cls: "mal-home-grid" });
    for (const item of ordered) {
      const def = defMap.get(item.id);
      const mod = grid.createDiv({ cls: "mal-mod", attr: { "data-module": item.id } });
      mod.style.gridColumn = `span ${clampInt(item.w, 1, 12, 12)}`;
      // 未手动调高过的模块：行高交给内容决定，天然贴合、不留空白
      if (item.autoHeight === false) {
        const fixed = item.hPx || (36 * clampInt(item.h, 1, 400, 6) - 12);
        mod.style.height = `${fixed}px`;
        mod.style.alignSelf = "start";
      }
      const content = mod.createDiv({ cls: "mal-mod-content" });
      def.render(content);
      this.attachModuleHandles(grid, mod, item);
    }
    this.makeGridDropTail(grid);

    const foot = body.createDiv({ cls: "mal-layout-foot" });
    foot.createDiv({ cls: "mal-layout-hint", text: "拖动模块右上角 ⠿ 换位，拖动右下角调整宽高（不拖高度时自动贴合内容）" });
    const reset = foot.createEl("button", { text: "恢复默认布局", cls: "mal-nav-chip" });
    reset.addEventListener("click", async () => {
      await this.plugin.resetHomeLayout();
      this.render();
      new Notice("首页布局已恢复默认");
    });
  }

  // 模块上的拖拽把手与缩放手柄
  attachModuleHandles(grid, mod, item) {
    const grip = mod.createDiv({ cls: "mal-mod-grip", text: "⠿", attr: { title: "按住拖动换位" } });
    grip.setAttribute("draggable", "true");
    grip.addEventListener("dragstart", event => {
      event.dataTransfer.setData("application/x-mal-mod", item.id);
      event.dataTransfer.effectAllowed = "move";
      this.draggingModuleId = item.id;
      mod.addClass("is-dragging");
    });
    grip.addEventListener("dragend", () => {
      this.draggingModuleId = null;
      mod.removeClass("is-dragging");
      this.clearModuleDropTargets(grid);
    });
    mod.addEventListener("dragover", event => {
      if (!this.draggingModuleId || this.draggingModuleId === item.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      this.clearModuleDropTargets(grid);
      mod.addClass("is-drop-target");
    });
    mod.addEventListener("dragleave", event => {
      if (event.relatedTarget && mod.contains(event.relatedTarget)) return;
      mod.removeClass("is-drop-target");
    });
    mod.addEventListener("drop", async event => {
      if (!this.draggingModuleId || this.draggingModuleId === item.id) return;
      event.preventDefault();
      event.stopPropagation();
      const dragged = this.draggingModuleId;
      this.draggingModuleId = null;
      this.clearModuleDropTargets(grid);
      await this.plugin.moveHomeModule(dragged, item.id);
      this.render();
    });

    const handle = mod.createDiv({ cls: "mal-mod-resize", attr: { title: "拖动调整宽高" } });
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const styles = getComputedStyle(grid);
      const gap = parseFloat(styles.columnGap) || 12;
      const colWidth = Math.max(1, (grid.clientWidth - gap * 11) / 12);
      const startX = event.clientX;
      const startY = event.clientY;
      const startW = mod.offsetWidth;
      const startH = mod.offsetHeight;
      const startW0 = item.w;
      const startH0 = item.hPx || startH;
      mod.addClass("is-resizing");
      document.body.classList.add("mal-resizing");

      const onMove = moveEvent => {
        const width = startW + (moveEvent.clientX - startX);
        const height = startH + (moveEvent.clientY - startY);
        const w = clampInt((width + gap) / (colWidth + gap), 1, 12, item.w);
        const hPx = Math.max(24, Math.round(height));
        if (w === item.w && hPx === item.hPx) return;
        item.autoHeight = false; // 手动改了高度，就不再自动贴合
        item.w = w;
        item.hPx = hPx;
        item.h = clampInt((hPx + 12) / 36, 1, 400, item.h);
        mod.style.gridColumn = `span ${w}`;
        // 高度直接落到像素，缩放跟手，不留内部空白
        mod.style.height = `${hPx}px`;
        mod.style.alignSelf = "start";
      };
      const onUp = async () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.body.classList.remove("mal-resizing");
        mod.removeClass("is-resizing");
        if (item.w !== startW0 || item.hPx !== startH0) await this.plugin.saveSettings();
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  }

  // 拖到网格空白处 = 排到末尾
  makeGridDropTail(grid) {
    grid.addEventListener("dragover", event => {
      if (!this.draggingModuleId || event.target !== grid) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      grid.addClass("is-drop-end");
    });
    grid.addEventListener("dragleave", event => {
      if (event.target === grid) grid.removeClass("is-drop-end");
    });
    grid.addEventListener("drop", async event => {
      if (!this.draggingModuleId || event.target !== grid) return;
      event.preventDefault();
      const dragged = this.draggingModuleId;
      this.draggingModuleId = null;
      grid.removeClass("is-drop-end");
      this.clearModuleDropTargets(grid);
      await this.plugin.moveHomeModule(dragged, null);
      this.render();
    });
  }

  clearModuleDropTargets(grid) {
    if (!grid) return;
    grid.querySelectorAll(".mal-mod.is-drop-target").forEach(el => el.removeClass("is-drop-target"));
    grid.removeClass("is-drop-end");
  }

  renderCategoryNav(body, selected, term) {
    const nav = body.createDiv({ cls: "mal-category-nav" });
    const orderMap = new Map(this.plugin.getCategories().map((c, i) => [c.name, i]));
    const categories = [...new Set(selected.map(app => app.category || "未分类"))]
      .sort((a, b) => (orderMap.get(a) ?? 999) - (orderMap.get(b) ?? 999) || a.localeCompare(b, "zh-Hans-CN"));
    const buttons = categories.map(category => ({
      id: category,
      label: `${this.plugin.categoryIcon(category) ? this.plugin.categoryIcon(category) + " " : ""}${category} ${selected.filter(app => (app.category || "未分类") === category).length}`
    }));

    for (const item of buttons) {
      const button = nav.createEl("button", {
        text: item.label,
        cls: `mal-nav-chip ${this.activeCategory === item.id ? "is-active" : ""}`
      });
      button.addEventListener("click", () => {
        // 没有「全部」按钮：再点一次当前分类即取消筛选，回到全部
        this.activeCategory = this.activeCategory === item.id ? "__all__" : item.id;
        this.detailAppId = null;
        this.render();
      });
      // 分类芯片本身可拖拽：左右换位即调整分类顺序
      button.setAttribute("draggable", "true");
      button.title = "点击筛选，再点一次取消；按住拖动可调整分类顺序";
      button.addEventListener("dragstart", event => {
        event.dataTransfer.setData("application/x-mal-category", item.id);
        event.dataTransfer.effectAllowed = "move";
        button.addClass("is-dragging");
      });
      button.addEventListener("dragend", () => button.removeClass("is-dragging"));
      button.addEventListener("dragover", event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        button.addClass("is-drop-target");
      });
      button.addEventListener("dragleave", () => button.removeClass("is-drop-target"));
      button.addEventListener("drop", async event => {
        event.preventDefault();
        button.removeClass("is-drop-target");
        // 优先识别分类拖拽：拖到哪个芯片前就插到哪个分类前
        const draggedCategory = event.dataTransfer.getData("application/x-mal-category");
        if (draggedCategory) {
          if (draggedCategory !== item.id) {
            await this.plugin.reorderCategory(draggedCategory, item.id);
            new Notice(`已将分类「${draggedCategory}」移到「${item.id}」之前`);
          }
          return;
        }
        const sourceId = event.dataTransfer.getData("text/plain");
        const app = this.plugin.settings.apps.find(entry => entry.id === sourceId);
        if (!app) return;
        app.category = item.id;
        this.plugin.learnCategory(app);
        await this.plugin.saveSettings();
        this.render();
        new Notice(`已将 ${app.name} 移入「${item.id}」`);
      });
    }
    // 把分类芯片拖到导航条空白处 = 排到末尾
    nav.addEventListener("dragover", event => {
      if (event.target === nav) event.preventDefault();
    });
    nav.addEventListener("drop", async event => {
      if (event.target !== nav) return;
      const draggedCategory = event.dataTransfer.getData("application/x-mal-category");
      if (!draggedCategory) return;
      event.preventDefault();
      await this.plugin.reorderCategory(draggedCategory, null);
      new Notice(`已将分类「${draggedCategory}」排到末尾`);
    });
  }

  renderAppSection(body, title, apps, iconOverride, keepOrder, compact) {
    const isPinnedStrip = apps.length > 0 && apps.every(app => app.pinned);
    const section = body.createDiv({ cls: isPinnedStrip ? "mal-pinned-top" : "mal-section" });
    if (title) {
      const icon = iconOverride || this.plugin.categoryIcon(title);
      const heading = section.createEl("h3", { text: `${icon ? icon + " " : ""}${title}`, cls: "mal-category" });
      heading.createSpan({ cls: "mal-section-count", text: String(apps.length) });
    }
    const grid = section.createDiv({ cls: `mal-grid ${this.plugin.settings.viewMode === "list" ? "is-list" : ""} ${compact ? "is-compact" : ""}` });
    const sorted = keepOrder ? [...apps] : [...apps].sort((a, b) => {
      const aKey = a.pinned ? (a.pinnedOrder ?? a.order ?? 0) : (a.order ?? 0);
      const bKey = b.pinned ? (b.pinnedOrder ?? b.order ?? 0) : (b.order ?? 0);
      return aKey - bKey || a.name.localeCompare(b.name, "zh-Hans-CN");
    });

    // 分批渲染：首屏 60 张同步出，其余按帧追加，应用很多时也不卡主线程
    const BATCH = 60;
    let index = 0;
    const renderBatch = () => {
      if (!grid.isConnected) return; // 视图已重绘，丢弃剩余批次
      const frag = document.createDocumentFragment();
      const end = Math.min(index + BATCH, sorted.length);
      for (; index < end; index++) frag.appendChild(this.buildAppCard(sorted[index]));
      grid.appendChild(frag);
      if (index < sorted.length) requestAnimationFrame(renderBatch);
    };
    renderBatch();
  }

  // 单个应用卡片（含全部交互），由 renderAppSection 分批挂载
  buildAppCard(app) {
    const card = document.createElement("div");
    card.className = "mal-app-card";
    card.dataset.tile = `${app.tileW === 2 ? 2 : 1}x${app.tileH === 2 ? 2 : 1}`;
    card.dataset.appId = app.id;
    card.setAttribute("draggable", "true");
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `查看 ${app.name} 介绍`);
    const icon = card.createDiv({ cls: "mal-app-icon" });
    this.observeIcon(icon, app);
    card.createDiv({ text: app.name, cls: "mal-app-name" });

    card.addEventListener("click", event => {
      this.detailAppId = app.id;
      this.editingDetail = false;
      this.render();
    });
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.detailAppId = app.id;
        this.editingDetail = false;
        this.render();
      }
    });

    card.addEventListener("contextmenu", event => this.openAppMenu(app, event));

    card.addEventListener("dragstart", event => {
      event.dataTransfer.setData("text/plain", app.id);
      event.dataTransfer.effectAllowed = "move";
      card.addClass("is-dragging");
    });
    card.addEventListener("dragend", () => card.removeClass("is-dragging"));
    card.addEventListener("dragover", event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      card.addClass("is-drop-target");
    });
    card.addEventListener("dragleave", () => card.removeClass("is-drop-target"));
    card.addEventListener("drop", async event => {
      event.preventDefault();
      card.removeClass("is-drop-target");
      const sourceId = event.dataTransfer.getData("text/plain");
      if (!sourceId || sourceId === app.id) return;
      await this.plugin.moveAppToTarget(sourceId, app.id);
      this.render();
    });
    return card;
  }

  // 应用右键菜单：首页磁贴、详情弹窗图标、管理列表图标共用同一套「设置与编辑」
  openAppMenu(app, event) {
    if (!event) return;
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem(item => item
      .setTitle(`打开 ${app.name}`)
      .setIcon("play")
      .onClick(() => this.plugin.launchApp(app)));
    menu.addItem(item => item
      .setTitle(`布局：${app.tileW === 2 ? 2 : 1}×${app.tileH === 2 ? 2 : 1}`)
      .setIcon("layout-grid")
      .onClick(() => {
        // 二级菜单：四个磁贴尺寸，当前尺寸打勾
        const layoutMenu = new Menu();
        [
          [1, 1, "1×1 方形"],
          [2, 1, "2×1 横向"],
          [1, 2, "1×2 竖向"],
          [2, 2, "2×2 大方块"]
        ].forEach(([w, h, label]) => {
          const checked = (app.tileW === 2 ? 2 : 1) === w && (app.tileH === 2 ? 2 : 1) === h;
          layoutMenu.addItem(entry => entry
            .setTitle(`${checked ? "✓ " : ""}${label}`)
            .onClick(async () => {
              app.tileW = w;
              app.tileH = h;
              await this.plugin.saveSettings();
              this.render();
            }));
        });
        setTimeout(() => layoutMenu.showAtPosition({ x: event.clientX, y: event.clientY }), 0);
      }));
    menu.addItem(item => item
      .setTitle(app.customIcon ? "更换图标…" : "编辑图标…")
      .setIcon("image")
      .onClick(async () => {
        const ok = await this.plugin.pickAppIcon(app);
        if (ok) this.render();
      }));
    if (app.customIcon) {
      menu.addItem(item => item
        .setTitle("恢复默认图标")
        .setIcon("rotate-ccw")
        .onClick(async () => {
          await this.plugin.resetAppIcon(app);
          this.render();
        }));
    }
    menu.addItem(item => item
      .setTitle("编辑主页")
      .setIcon("pencil")
      .onClick(() => {
        this.detailAppId = app.id;
        this.editingDetail = true;
        this.render();
      }));
    if (app.websiteUrl && !isSystemAppPath(app.path)) {
      menu.addItem(item => item
        .setTitle("打开官方网站 ↗")
        .setIcon("external-link")
        .onClick(() => this.plugin.launchApp(app, { forceWeb: true })));
    }
    menu.addItem(item => item
      .setTitle(app.pinned ? "取消置顶" : "置顶应用")
      .setIcon("pin")
      .onClick(async () => {
        await this.plugin.togglePin(app);
        this.render();
      }));
    menu.addSeparator();
    if (app.path) {
      menu.addItem(item => item
        .setTitle("在 Finder 中显示")
        .setIcon("folder-open")
        .onClick(() => this.plugin.revealInFinder(app)));
      menu.addItem(item => item
        .setTitle("复制应用路径")
        .setIcon("copy")
        .onClick(() => {
          navigator.clipboard.writeText(app.path || "");
          new Notice("已复制应用路径");
        }));
    }
    // 启动参数白名单：编辑器打开当前库 / 终端进入笔记目录
    if (app.path && this.plugin.isEditorApp(app)) {
      menu.addItem(item => item
        .setTitle(`用 ${app.name} 打开当前库`)
        .setIcon("vault")
        .onClick(() => this.plugin.openPathWithApp(app, this.app.vault.adapter.getBasePath())));
    }
    if (app.path && this.plugin.isTerminalApp(app)) {
      const note = this.plugin.getActiveNoteFile();
      const dir = note && note.parent && note.parent.path
        ? path.join(this.app.vault.adapter.getBasePath(), note.parent.path)
        : this.app.vault.adapter.getBasePath();
      menu.addItem(item => item
        .setTitle(`在 ${app.name} 中打开${note && note.parent && note.parent.path ? "笔记目录" : "库根目录"}`)
        .setIcon("terminal")
        .onClick(() => this.plugin.openPathWithApp(app, dir)));
    }
    if (app.custom) {
      menu.addSeparator();
      menu.addItem(item => item
        .setTitle("移除应用")
        .setIcon("trash")
        .onClick(async () => {
          await this.plugin.removeCustomApp(app);
          new Notice(`已移除：${app.name}`);
          this.render();
        }));
    } else {
      menu.addSeparator();
      menu.addItem(item => item
        .setTitle("从首页隐藏")
        .setIcon("eye-off")
        .onClick(async () => {
          app.selected = false;
          await this.plugin.saveSettings();
          new Notice(`已从首页隐藏：${app.name}（可在「管理应用」里重新勾选）`);
          this.render();
        }));
    }
    menu.showAtMouseEvent(event);
  }

  renderDetailPanel(body) {
    const app = this.plugin.settings.apps.find(item => item.id === this.detailAppId);
    if (!app) {
      this.detailAppId = null;
      return;
    }

    const overlay = body.createDiv({ cls: "mal-detail-backdrop" });
    overlay.addEventListener("click", event => {
      if (event.target === overlay) {
        this.detailAppId = null;
        this.render();
      }
    });

    const panel = overlay.createDiv({ cls: "mal-detail-panel" });
    const top = panel.createDiv({ cls: "mal-detail-top" });
    const identity = top.createDiv({ cls: "mal-detail-identity" });
    const icon = identity.createDiv({ cls: "mal-detail-icon" });
    icon.setAttribute("title", "右键可设置 / 编辑图标与布局");
    this.plugin.renderAppIcon(icon, app);
    icon.addEventListener("contextmenu", event => this.openAppMenu(app, event));
    const names = identity.createDiv({ cls: "mal-detail-names" });
    names.createEl("h3", { text: app.name });
    names.createEl("div", {
      text: `${app.category || "未分类"} · ${isAppBundleInstalled(app) ? "客户端已安装" : app.websiteUrl ? "网页入口可用" : "客户端不可用"}`,
      cls: "mal-detail-meta"
    });
    if (app.path) names.createEl("div", { text: app.path, cls: "mal-detail-meta mal-app-path" });
    else if (app.websiteUrl) names.createEl("div", { text: "网页应用资源", cls: "mal-detail-meta mal-app-path" });
    const launches = app.launchCount || 0;
    const lastUsed = app.lastLaunchedAt
      ? new Date(app.lastLaunchedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "从未";
    names.createEl("div", {
      text: `启动 ${launches} 次 · 最近使用：${lastUsed}${app.custom ? " · 手动添加" : ""}`,
      cls: "mal-detail-meta mal-detail-stats"
    });

    const actions = top.createDiv({ cls: "mal-detail-actions" });
    const pin = actions.createEl("button", {
      text: app.pinned ? "★ 已置顶" : "☆ 置顶",
      cls: "mal-button"
    });
    pin.addEventListener("click", async () => {
      await this.plugin.togglePin(app);
      this.render();
    });
    if (app.path) {
      const reveal = actions.createEl("button", { text: "在 Finder 显示", cls: "mal-button" });
      reveal.addEventListener("click", () => this.plugin.revealInFinder(app));
    }
    if (app.custom) {
      const remove = actions.createEl("button", { text: "移除", cls: "mal-button mal-button-danger" });
      remove.addEventListener("click", async () => {
        await this.plugin.removeCustomApp(app);
        this.detailAppId = null;
        new Notice(`已移除：${app.name}`);
        this.render();
      });
    }
    const close = actions.createEl("button", { text: "✕", cls: "mal-button" });
    close.addEventListener("click", () => {
      this.detailAppId = null;
      this.render();
    });

    panel.createEl("div", { text: "功能介绍", cls: "mal-detail-label" });
    if (this.editingDetail) {
      const description = panel.createEl("textarea", {
        cls: "mal-detail-textarea",
        attr: { rows: "3", placeholder: "介绍这个软件主要能做什么…" }
      });
      description.value = app.description || "";
      panel.createEl("div", { text: "主要用途 / 使用场景", cls: "mal-detail-label" });
      const usage = panel.createEl("textarea", {
        cls: "mal-detail-textarea",
        attr: { rows: "3", placeholder: "写下你通常用它完成哪些任务…" }
      });
      usage.value = app.usage || "";

      panel.createEl("div", { text: "官方网站 / 网页备用入口", cls: "mal-detail-label" });
      let websiteUrlInput = null;
      if (isSystemAppPath(app.path)) {
        panel.createEl("p", {
          cls: "mal-muted",
          text: "这是 macOS 系统应用，不配置官方网站入口。已有历史字段会保留，但不会作为应用网页入口使用。"
        });
      } else {
        websiteUrlInput = panel.createEl("input", {
          cls: "mal-detail-hotkey",
          attr: { type: "url", placeholder: "https://example.com" }
        });
        websiteUrlInput.value = app.websiteUrl || "";
      }

      panel.createEl("div", { text: "启动快捷键（可选，如 Mod+Shift+1，清空即取消）", cls: "mal-detail-label" });
      const hotkeyInput = panel.createEl("input", {
        cls: "mal-detail-hotkey",
        attr: { type: "text", placeholder: "Mod+Shift+1", spellcheck: "false" }
      });
      hotkeyInput.value = app.hotkey || "";

      const editActions = panel.createDiv({ cls: "mal-detail-edit-actions" });
      const save = editActions.createEl("button", { text: "保存介绍", cls: "mal-primary" });
      save.addEventListener("click", async () => {
        const rawWebsiteUrl = websiteUrlInput ? websiteUrlInput.value.trim() : "";
        const safeWebsiteUrl = normalizeExternalHttpUrl(rawWebsiteUrl);
        if (rawWebsiteUrl && !safeWebsiteUrl) {
          new Notice("官方网站必须是有效的 http:// 或 https:// 地址", 6000);
          return;
        }
        app.description = description.value.trim();
        app.usage = usage.value.trim();
        if (!isSystemAppPath(app.path)) app.websiteUrl = safeWebsiteUrl || "";
        app.launchMode = "smart";
        const hotkey = hotkeyInput.value.trim();
        app.hotkey = hotkey;
        if (hotkey && !this.plugin.parseHotkey(hotkey)) {
          new Notice("快捷键格式无效，应为如 Mod+Shift+1 的组合", 6000);
          return;
        }
        await this.plugin.saveSettings();
        this.plugin.refreshAppHotkeys();
        this.editingDetail = false;
        new Notice(`已保存 ${app.name} 的介绍${hotkey ? `，快捷键 ${hotkey} 已生效` : ""}`);
        this.render();
      });
      const cancel = editActions.createEl("button", { text: "取消", cls: "mal-button" });
      cancel.addEventListener("click", () => {
        this.editingDetail = false;
        this.render();
      });
    } else {
      panel.createEl("p", {
        text: app.description || "尚未填写功能介绍。点击“编辑介绍”补充说明。",
        cls: "mal-detail-description"
      });
      panel.createEl("div", { text: "主要用途 / 使用场景", cls: "mal-detail-label" });
      panel.createEl("p", {
        text: app.usage || "尚未填写使用场景。",
        cls: "mal-detail-description"
      });
      panel.createEl("div", { text: "统一网页入口", cls: "mal-detail-label" });
      const websiteRow = panel.createDiv({ cls: "mal-detail-note-row" });
      if (isSystemAppPath(app.path)) {
        websiteRow.createSpan({ cls: "mal-detail-meta", text: "macOS 系统应用不配置官方网站入口" });
      } else {
        websiteRow.createSpan({
          cls: "mal-detail-meta",
          text: app.websiteUrl || "尚未设置官方网站；可在编辑介绍中添加"
        });
        if (app.websiteUrl) {
          const openWebsite = websiteRow.createEl("button", { text: "打开网页 ↗", cls: "mal-button" });
          openWebsite.addEventListener("click", () => this.plugin.launchApp(app, { forceWeb: true }));
        }
      }

      const editActions = panel.createDiv({ cls: "mal-detail-edit-actions" });
      const edit = editActions.createEl("button", { text: "编辑介绍", cls: "mal-button" });
      edit.addEventListener("click", () => {
        this.editingDetail = true;
        this.render();
      });
    }

    // 福利卡片不重复保存应用资料，只通过 appId 关联当前应用资源。
    panel.createEl("div", { text: "关联算力福利", cls: "mal-detail-label" });
    const linkedCards = (this.plugin.settings.computeCards || []).filter(card => card.appId === app.id);
    if (linkedCards.length) {
      const linkedList = panel.createDiv({ cls: "mal-app-linked-benefits" });
      for (const card of linkedCards) {
        const row = linkedList.createDiv({ cls: "mal-app-linked-benefit" });
        const info = row.createDiv({ cls: "mal-app-linked-benefit-info" });
        info.createDiv({ cls: "mal-app-linked-benefit-title", text: card.name });
        info.createDiv({
          cls: "mal-detail-meta",
          text: `${card.cycle === "once" ? "一次性" : card.cycle === "monthly" ? "每月" : "每日"} · ${card.value || "福利"}`
        });
        const openCard = row.createEl("button", { text: "查看", cls: "mal-button" });
        openCard.addEventListener("click", () => {
          this.detailAppId = null;
          this.mode = "album";
          this.render();
          this.openCardDetail(card);
        });
      }
    } else {
      panel.createEl("p", { text: "暂无关联福利卡片。可在算力卡册编辑福利时关联此应用。", cls: "mal-detail-meta" });
    }
    const openAlbum = panel.createEl("button", { text: "打开算力卡册", cls: "mal-button" });
    openAlbum.addEventListener("click", () => {
      this.detailAppId = null;
      this.mode = "album";
      this.render();
    });

    const footer = panel.createDiv({ cls: "mal-detail-footer" });
    const launch = footer.createEl("button", { text: `智能打开 ${app.name}`, cls: "mal-launch-button" });
    launch.addEventListener("click", () => this.plugin.launchApp(app));
  }

  renderManager(body, term) {
    this.renderProgress(body);
    let apps = this.plugin.settings.apps.filter(app =>
      `${app.name} ${app.path} ${app.category} ${app.description} ${app.usage}`.toLocaleLowerCase().includes(term)
    );
    if (this.showUncategorizedOnly) {
      apps = apps.filter(app => !app.category || app.category === "未分类");
    }
    // 管理列表按「分类管理」里的排序规则分组排列，同分类内按名称排序
    const catOrder = new Map(this.plugin.getCategories().map((c, i) => [c.name, i]));
    apps.sort((a, b) =>
      (catOrder.get(a.category || "未分类") ?? 999) - (catOrder.get(b.category || "未分类") ?? 999) ||
      a.name.localeCompare(b.name, "zh-Hans-CN")
    );

    const summary = body.createDiv({ cls: "mal-manage-summary" });
    this.updateManageSummary(summary);

    // 工具条：未分类速筛 + 分类管理开关
    const toolbar = body.createDiv({ cls: "mal-manage-toolbar" });
    const uncatLabel = toolbar.createEl("label", { cls: "mal-manage-uncat" });
    const uncatCheck = uncatLabel.createEl("input", { attr: { type: "checkbox" } });
    uncatCheck.checked = !!this.showUncategorizedOnly;
    uncatCheck.addEventListener("change", () => {
      this.showUncategorizedOnly = uncatCheck.checked;
      this.render();
    });
    uncatLabel.createEl("span", { text: " 只看未分类" });
    const catMgrBtn = toolbar.createEl("button", {
      text: this.showCategoryManager ? "收起分类管理" : "分类管理",
      cls: "mal-button"
    });
    catMgrBtn.addEventListener("click", () => {
      this.showCategoryManager = !this.showCategoryManager;
      this.render();
    });
    const sceneMgrBtn = toolbar.createEl("button", {
      text: this.showSceneManager ? "收起场景模式" : "场景模式",
      cls: "mal-button"
    });
    sceneMgrBtn.addEventListener("click", () => {
      this.showSceneManager = !this.showSceneManager;
      this.render();
    });
    const batchBtn = toolbar.createEl("button", {
      text: this.batchMode ? "退出批量操作" : "批量操作",
      cls: this.batchMode ? "mal-primary" : "mal-button"
    });
    batchBtn.addEventListener("click", () => {
      this.batchMode = !this.batchMode;
      if (!this.batchMode && this.batchSelected) this.batchSelected.clear();
      this.render();
    });

    if (this.showCategoryManager) this.renderCategoryManager(body);
    if (this.showSceneManager) this.renderSceneManager(body);

    this.renderAddCustomApp(body);
    this.renderAgentApiPanel(body);

    if (!this.plugin.settings.hasScanned && !apps.length) {
      body.createEl("p", { text: "还没有扫描记录。点击“重新扫描”。", cls: "mal-empty" });
      return;
    }

    const list = body.createDiv({ cls: "mal-manage-list" });
    const datalistId = `mal-categories-${this.plugin.manifest.id}`;
    const datalist = list.createEl("datalist", { attr: { id: datalistId } });
    const categories = new Set([...this.plugin.getCategories().map(c => c.name), ...this.plugin.settings.apps.map(a => a.category).filter(Boolean)]);
    for (const category of categories) datalist.createEl("option", { attr: { value: category } });

    // 批量操作条：点「批量操作」后才出现，平时不占位、不误导
    if (!this.batchSelected) this.batchSelected = new Set();
    if (this.batchMode) {
    const batchBar = list.createDiv({ cls: "mal-batch-bar" });
    const selectedCount = this.batchSelected.size;
    if (selectedCount > 0) {
      batchBar.createEl("span", { text: `已选 ${selectedCount} 个`, cls: "mal-batch-count" });
      const batchInput = batchBar.createEl("input", {
        attr: { type: "text", list: datalistId, placeholder: "设为分类…" },
        cls: "mal-category-input"
      });
      const applyBtn = batchBar.createEl("button", { text: "应用", cls: "mal-primary" });
      applyBtn.addEventListener("click", async () => {
        const category = batchInput.value.trim();
        if (!category) { new Notice("请输入目标分类"); return; }
        let changed = 0;
        for (const app of this.plugin.settings.apps) {
          if (this.batchSelected.has(app.id)) {
            app.category = category;
            this.plugin.learnCategory(app);
            changed++;
          }
        }
        this.plugin.ensureCategoryEntry(category);
        await this.plugin.saveSettings();
        new Notice(`已将 ${changed} 个应用分类为：${category}`);
        this.batchSelected.clear();
        this.render();
      });
      const clearBtn = batchBar.createEl("button", { text: "清除选择", cls: "mal-button" });
      clearBtn.addEventListener("click", () => {
        this.batchSelected.clear();
        this.render();
      });
    } else {
      batchBar.createEl("span", { text: "勾选行首复选框可批量设置分类", cls: "mal-batch-hint" });
    }
    }

    for (const app of apps) {
      const row = list.createDiv({ cls: this.batchMode ? "mal-manage-row is-batch" : "mal-manage-row" });
      if (this.batchMode) {
      const batchCheck = row.createEl("input", { attr: { type: "checkbox", title: "批量操作选择（用于批量设分类，不影响展示）" }, cls: "mal-check mal-batch-check" });
      batchCheck.checked = this.batchSelected.has(app.id);
      batchCheck.addEventListener("change", () => {
        if (batchCheck.checked) this.batchSelected.add(app.id);
        else this.batchSelected.delete(app.id);
        this.render();
      });
      }
      const checkbox = row.createEl("input", { attr: { type: "checkbox", title: "在应用中心展示此应用" }, cls: "mal-check" });
      checkbox.checked = !!app.selected;
      const setSelected = async checked => {
        app.selected = checked;
        checkbox.checked = checked;
        await this.plugin.saveSettings();
        this.updateManageSummary(summary);
        if (checked) await this.plugin.ensureIcon(app);
      };
      checkbox.addEventListener("change", () => setSelected(checkbox.checked));

      const icon = row.createDiv({ cls: "mal-manage-icon" });
      icon.setAttribute("title", "右键可设置 / 编辑图标与布局");
      this.observeIcon(icon, app);
      icon.addEventListener("contextmenu", event => this.openAppMenu(app, event));

      const info = row.createDiv({ cls: "mal-app-info" });
      // 点图标或名称区域也能切换「展示」，避免误点旁边的批量选择框
      for (const el of [icon, info]) {
        el.style.cursor = "pointer";
        el.title = "点击切换：在应用中心展示 / 隐藏";
        el.addEventListener("click", () => setSelected(!app.selected));
      }
      info.createEl("div", { text: app.name, cls: "mal-manage-name" });
      info.createEl("div", { text: app.path || app.websiteUrl || "网页应用", cls: "mal-app-path" });

      const tools = row.createDiv({ cls: "mal-manage-tools" });
      const categoryInput = tools.createEl("input", {
        attr: { type: "text", list: datalistId, placeholder: "输入分类" },
        cls: "mal-category-input"
      });
      categoryInput.value = app.category || "未分类";
      categoryInput.addEventListener("change", async () => {
        app.category = categoryInput.value.trim() || "未分类";
        this.plugin.ensureCategoryEntry(app.category);
        this.plugin.learnCategory(app);
        await this.plugin.saveSettings();
        new Notice(`已将 ${app.name} 分类为：${app.category}`);
      });
      const profile = tools.createEl("button", { text: "介绍", cls: "mal-button" });
      profile.addEventListener("click", () => {
        this.mode = "home";
        this.detailAppId = app.id;
        this.editingDetail = true;
        this.render();
      });
    }
  }

  // 分类管理面板：新增、重命名、排序、删除
  renderCategoryManager(body) {
    const panel = body.createDiv({ cls: "mal-cat-manager" });
    panel.createEl("h3", { text: "分类管理" });
    for (const cat of this.plugin.getCategories()) {
      const row = panel.createDiv({ cls: "mal-cat-row" });
      const iconInput = row.createEl("input", {
        cls: "mal-cat-icon",
        attr: { type: "text", maxlength: "4", title: "分类图标（emoji）" }
      });
      iconInput.value = cat.icon || "";
      iconInput.addEventListener("change", async () => {
        await this.plugin.renameCategory(cat.name, cat.name, iconInput.value);
      });
      const nameInput = row.createEl("input", { cls: "mal-cat-name", attr: { type: "text" } });
      nameInput.value = cat.name;
      nameInput.addEventListener("change", async () => {
        const result = await this.plugin.renameCategory(cat.name, nameInput.value, cat.icon);
        if (!result.ok) {
          new Notice(result.error);
          nameInput.value = cat.name;
        } else if (nameInput.value.trim() !== cat.name) {
          new Notice(`分类「${cat.name}」已重命名为「${nameInput.value.trim()}」`);
        }
      });
      const count = this.plugin.settings.apps.filter(a => a.category === cat.name).length;
      row.createEl("span", { text: `${count} 个应用`, cls: "mal-cat-count" });
      const up = row.createEl("button", { text: "↑", cls: "mal-button mal-cat-move" });
      up.addEventListener("click", () => this.plugin.moveCategory(cat.name, -1));
      const down = row.createEl("button", { text: "↓", cls: "mal-button mal-cat-move" });
      down.addEventListener("click", () => this.plugin.moveCategory(cat.name, 1));
      if (cat.name !== "未分类") {
        const del = row.createEl("button", { text: "删除", cls: "mal-button mal-button-danger" });
        del.addEventListener("click", async () => {
          const result = await this.plugin.removeCategory(cat.name);
          new Notice(result.ok ? `已删除分类「${cat.name}」，应用归入未分类` : result.error);
        });
      }
    }
    const addRow = panel.createDiv({ cls: "mal-cat-row mal-cat-add" });
    const newIcon = addRow.createEl("input", { cls: "mal-cat-icon", attr: { type: "text", maxlength: "4", placeholder: "🆕" } });
    const newName = addRow.createEl("input", { cls: "mal-cat-name", attr: { type: "text", placeholder: "新分类名称" } });
    const addBtn = addRow.createEl("button", { text: "添加分类", cls: "mal-primary" });
    addBtn.addEventListener("click", async () => {
      const result = await this.plugin.addCategory(newName.value, newIcon.value);
      new Notice(result.ok ? `已添加分类：${newName.value.trim()}` : result.error);
    });
  }

  // 场景模式面板：用批量勾选的应用创建场景，一键启动一组应用
  renderSceneManager(body) {
    const panel = body.createDiv({ cls: "mal-cat-manager" });
    panel.createEl("h3", { text: "场景模式" });
    panel.createEl("p", {
      text: "场景可一键执行一串步骤：启动应用、打开笔记/文件夹、执行 Obsidian 命令。先用勾选的应用创建，再点「步骤」补充其他步骤；快速启动面板（Cmd+Shift+Space）可搜到场景。",
      cls: "mal-add-custom-hint"
    });
    for (const scene of this.plugin.settings.scenes) {
      const row = panel.createDiv({ cls: "mal-cat-row" });
      row.createEl("span", { text: "🎬", cls: "mal-scene-icon" });
      row.createEl("span", { text: scene.name, cls: "mal-scene-name" });
      row.createEl("span", { text: sceneStepsSummary(this.plugin, scene), cls: "mal-cat-count" });
      const stepsBtn = row.createEl("button", { text: "步骤", cls: "mal-button" });
      stepsBtn.addEventListener("click", () => new SceneStepsModal(this.app, this.plugin, scene).open());
      const launch = row.createEl("button", { text: "启动", cls: "mal-primary" });
      launch.addEventListener("click", () => this.plugin.launchScene(scene));
      const close = row.createEl("button", { text: "关闭", cls: "mal-button" });
      close.addEventListener("click", () => this.plugin.closeScene(scene));
      const canvasBtn = row.createEl("button", { text: "画布", cls: "mal-button" });
      canvasBtn.addEventListener("click", () => this.plugin.exportSceneCanvas(scene));
      const del = row.createEl("button", { text: "删除", cls: "mal-button mal-button-danger" });
      del.addEventListener("click", async () => {
        await this.plugin.removeScene(scene.id);
        new Notice(`已删除场景「${scene.name}」`);
      });
    }
    if (!this.plugin.settings.scenes.length) {
      panel.createEl("p", { text: "还没有场景。", cls: "mal-empty" });
    }
    const addRow = panel.createDiv({ cls: "mal-cat-row mal-cat-add" });
    const nameInput = addRow.createEl("input", { cls: "mal-cat-name", attr: { type: "text", placeholder: "新场景名称，如：写作模式" } });
    const createBtn = addRow.createEl("button", { text: "用勾选的应用创建", cls: "mal-primary" });
    createBtn.addEventListener("click", async () => {
      const ids = [...(this.batchSelected || [])];
      const result = await this.plugin.addScene(nameInput.value, ids);
      if (result.ok) {
        new Notice(`已创建场景「${nameInput.value.trim()}」（${ids.length} 个应用）`);
        this.batchSelected.clear();
        this.render();
      } else {
        new Notice(result.error, 6000);
      }
    });
  }

  renderAddCustomApp(body) {
    const panel = body.createDiv({ cls: "mal-add-custom" });
    panel.createEl("h3", { text: "手动添加应用" });
    panel.createEl("p", {
      text: "添加扫描不到的应用（如 Parallels 虚拟机应用、自编译应用）。点击「选择应用…」在 Finder 里挑 .app，选中后自动填入路径。",
      cls: "mal-add-custom-hint"
    });
    const row = panel.createDiv({ cls: "mal-add-custom-row" });
    const pathInput = row.createEl("input", {
      cls: "mal-category-input mal-add-path",
      attr: { type: "text", placeholder: "点左侧「选择应用…」挑选，或粘贴路径", spellcheck: "false" }
    });
    const pickBtn = row.createEl("button", { text: "选择应用…", cls: "mal-button" });
    pickBtn.addEventListener("click", async () => {
      pickBtn.setAttr("disabled", "true");
      try {
        const picked = await this.plugin.pickAppBundle();
        if (picked) pathInput.value = picked;
      } catch (error) {
        new Notice(`选择应用失败：${error.message || error}`, 6000);
      } finally {
        pickBtn.removeAttribute("disabled");
      }
    });
    const catInput = row.createEl("input", {
      cls: "mal-category-input mal-add-category",
      attr: { type: "text", placeholder: "分类（可选）" }
    });
    const btn = row.createEl("button", { text: "添加应用", cls: "mal-primary" });
    btn.addEventListener("click", async () => {
      btn.setAttr("disabled", "true");
      try {
        const result = await this.plugin.addCustomApp(pathInput.value, catInput.value);
        if (result.ok) {
          new Notice(`已添加：${result.app.name}`);
          this.render();
        } else {
          new Notice(result.error, 6000);
          btn.removeAttribute("disabled");
        }
      } catch (error) {
        new Notice(`添加失败：${error.message || error}`, 6000);
        btn.removeAttribute("disabled");
      }
    });

    const webRow = panel.createDiv({ cls: "mal-add-custom-web-row" });
    webRow.createSpan({ cls: "mal-add-custom-hint", text: "没有本地客户端？也可以直接添加一个网页应用，后续福利卡片可关联它。" });
    const webBtn = webRow.createEl("button", { text: "＋ 添加网页应用", cls: "mal-button" });
    webBtn.addEventListener("click", () => {
      const modal = new Modal(this.app);
      modal.onOpen = () => {
        const content = modal.contentEl;
        content.addClass("mal-compute-modal");
        content.createEl("h3", { text: "添加网页应用" });
        const makeField = (label, placeholder) => {
          content.createDiv({ cls: "mal-mood-label", text: label });
          return content.createEl("input", { cls: "mal-mood-input", attr: { type: "text", placeholder } });
        };
        const nameInput = makeField("应用名称", "例如 ChatGPT 网页版");
        const urlInput = makeField("官方网站", "https://example.com");
        const categoryInput = makeField("分类（可选）", "例如 AI助手");
        const actions = content.createDiv({ cls: "mal-mood-actions" });
        const save = actions.createEl("button", { text: "添加网页应用", cls: "mod-cta" });
        save.addEventListener("click", async () => {
          save.setAttr("disabled", "true");
          const result = await this.plugin.addWebApp(nameInput.value, urlInput.value, categoryInput.value);
          if (!result.ok) {
            new Notice(result.error, 6000);
            save.removeAttribute("disabled");
            return;
          }
          modal.close();
          new Notice(result.updated ? `已更新网页入口：${result.app.name}` : `已添加网页应用：${result.app.name}`);
          this.render();
        });
        const cancel = actions.createEl("button", { text: "取消" });
        cancel.addEventListener("click", () => modal.close());
      };
      modal.onClose = () => modal.contentEl.empty();
      modal.open();
    });
  }

  renderAgentApiPanel(body) {
    const panel = body.createDiv({ cls: "mal-agent-panel" });
    const heading = panel.createDiv({ cls: "mal-agent-heading" });
    const titleWrap = heading.createDiv();
    titleWrap.createEl("h3", { text: "Agent 启动接口" });
    titleWrap.createEl("p", {
      text: "让 YOLO、Claude Code、Codex 或其他可调用本机 HTTP / curl 的 Agent 查询并启动已勾选的软件。",
      cls: "mal-agent-description"
    });

    const status = panel.createEl("span", {
      text: this.plugin.agentServer && this.plugin.agentServer.listening ? "运行中" : "未启动",
      cls: this.plugin.agentServer && this.plugin.agentServer.listening ? "mal-agent-status is-running" : "mal-agent-status"
    });

    const endpointLabel = panel.createEl("label", { text: "本机接口地址", cls: "mal-agent-label" });
    const endpoint = panel.createEl("input", {
      cls: "mal-agent-input",
      attr: { type: "text", readonly: "readonly", "aria-label": "本机接口地址" }
    });
    endpoint.value = `http://127.0.0.1:${this.plugin.settings.agentPort || 43171}`;

    panel.createEl("label", { text: "访问令牌（Bearer Token）", cls: "mal-agent-label" });
    const token = panel.createEl("input", {
      cls: "mal-agent-input",
      attr: { type: "text", readonly: "readonly", spellcheck: "false", "aria-label": "Agent API 访问令牌" }
    });
    token.value = this.plugin.sessionAgentToken || "（已安全存储，仅生成当次可见；需要新令牌请点击重置）";

    const actions = panel.createDiv({ cls: "mal-agent-actions" });
    const copy = actions.createEl("button", { text: "复制 Agent 接入说明", cls: "mal-primary" });
    copy.addEventListener("click", () => this.plugin.copyAgentInstructions());
    const rotate = actions.createEl("button", { text: "重置访问令牌", cls: "mal-button" });
    rotate.addEventListener("click", async () => {
      const fresh = crypto.randomBytes(32).toString("hex");
      this.plugin.sessionAgentToken = fresh;
      this.plugin.settings.agentTokenHash = crypto.createHash("sha256").update(fresh).digest("hex");
      await this.plugin.saveSettings();
      this.render();
      new Notice("Agent API 访问令牌已重置，旧令牌立即失效。新令牌仅本次会话可见，请立即复制保存。", 8000);
    });

    const note = panel.createEl("p", {
      text: "安全说明：接口仅监听本机 127.0.0.1；Agent 只能启动你在上方应用清单中勾选展示的软件，不能传入任意程序路径或执行任意命令。",
      cls: "mal-agent-note"
    });
    const sample = panel.createEl("pre", { cls: "mal-agent-sample" });
    sample.setText(
      `查询应用：GET /v1/apps\n启动应用：POST /v1/launch\n请求头：Authorization: Bearer ${this.plugin.sessionAgentToken || "<token>"}`
    );
  }

  updateManageSummary(summary) {
    summary.empty();
    summary.createEl("span", {
      text: `已扫描 ${this.plugin.settings.apps.length} 个应用 · 已选择 ${this.plugin.settings.apps.filter(a => a.selected).length} 个 · 已置顶 ${this.plugin.settings.apps.filter(a => a.pinned).length} 个`
    });
    summary.createEl("span", {
      text: this.plugin.scanning ? "正在扫描，可随时取消" : "勾选展示，分类和介绍会自动保存",
      cls: "mal-muted"
    });
  }
}

// ---- 快速启动面板（类 Spotlight） ----
class QuickLaunchModal {
  constructor(plugin) {
    this.plugin = plugin;
    this.isOpen = false;
    this.selectedIndex = 0;
    this.query = "";
    this.results = [];
    this.modalEl = null;
    this.inputEl = null;
    this.listEl = null;
    this._onKeyDown = this.handleKeyDown.bind(this);
    this._onInput = debounce(() => this.updateResults(), 80);
    this._onClickOutside = event => {
      if (this.modalEl && event.target === this.modalEl) this.close();
    };
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.selectedIndex = 0;
    this.query = "";
    this.build();
    this.updateResults();
    // 等下一帧再聚焦，确保元素已挂载
    setTimeout(() => this.inputEl && this.inputEl.focus(), 10);
    document.addEventListener("keydown", this._onKeyDown, true);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    document.removeEventListener("keydown", this._onKeyDown, true);
    if (this.modalEl && this.modalEl.parentNode) {
      this.modalEl.parentNode.removeChild(this.modalEl);
    }
    this.modalEl = null;
    this.inputEl = null;
    this.listEl = null;
  }

  build() {
    const overlay = document.createElement("div");
    overlay.className = "mal-quick-launch-overlay";
    overlay.addEventListener("click", this._onClickOutside);

    const panel = document.createElement("div");
    panel.className = "mal-quick-launch-panel";

    const searchWrap = document.createElement("div");
    searchWrap.className = "mal-quick-launch-search-wrap";
    const icon = document.createElement("span");
    icon.className = "mal-quick-launch-search-icon";
    icon.textContent = "⌘";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "mal-quick-launch-input";
    input.placeholder = "搜索应用并启动…";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.addEventListener("input", () => {
      this.query = input.value;
      this.selectedIndex = 0;
      this._onInput();
    });
    searchWrap.appendChild(icon);
    searchWrap.appendChild(input);

    const list = document.createElement("div");
    list.className = "mal-quick-launch-list";

    const hint = document.createElement("div");
    hint.className = "mal-quick-launch-hint";
    hint.innerHTML = "<span>↑↓</span> 选择 <span>↵</span> 启动 <span>Esc</span> 关闭";

    panel.appendChild(searchWrap);
    panel.appendChild(list);
    panel.appendChild(hint);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    this.modalEl = overlay;
    this.inputEl = input;
    this.listEl = list;
  }

  updateResults() {
    const apps = this.plugin.settings.apps.filter(app => app.selected);
    const searched = fuzzySearchApps(apps, this.query);
    if (this.query.trim()) {
      // 有搜索词：相关度 + 使用频率加成（log 平滑，避免刷次数碾压相关度）
      for (const item of searched) {
        item.score += Math.log10(1 + (item.app.launchCount || 0)) * 0.5;
      }
      searched.sort((a, b) => b.score - a.score);
    } else {
      // 无搜索词：按使用频率降序，次数相同按名称
      searched.sort((a, b) =>
        (b.app.launchCount || 0) - (a.app.launchCount || 0) ||
        a.app.name.localeCompare(b.app.name, "zh-Hans-CN")
      );
    }
    // 场景条目：有关键词时参与模糊匹配，包装成伪应用
    if (this.query.trim() && this.plugin.settings.scenes.length) {
      const pseudoScenes = this.plugin.settings.scenes.map(s => ({
        id: `scene-${s.id}`,
        name: s.name,
        category: `场景 · ${sceneStepsSummary(this.plugin, s)}`,
        isScene: true,
        scene: s,
        launchCount: 0,
        description: "",
        usage: ""
      }));
      const sceneHits = fuzzySearchApps(pseudoScenes, this.query);
      const merged = [...searched, ...sceneHits].sort((a, b) => b.score - a.score);
      this.results = merged.slice(0, 12).map(item => item.app);
    } else {
      // 最多显示 12 个，避免列表过长
      this.results = searched.slice(0, 12).map(item => item.app);
    }
    if (this.selectedIndex >= this.results.length) {
      this.selectedIndex = Math.max(0, this.results.length - 1);
    }
    this.renderList();
  }

  renderList() {
    if (!this.listEl) return;
    this.listEl.innerHTML = "";
    if (!this.results.length) {
      const empty = document.createElement("div");
      empty.className = "mal-quick-launch-empty";
      empty.textContent = this.query ? "没有匹配的应用" : "还没有选择任何应用";
      this.listEl.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    this.results.forEach((app, index) => {
      const item = document.createElement("div");
      item.className = `mal-quick-launch-item ${index === this.selectedIndex ? "is-selected" : ""}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", index === this.selectedIndex ? "true" : "false");

      const iconDiv = document.createElement("div");
      iconDiv.className = "mal-quick-launch-item-icon";
      if (app.isScene) {
        iconDiv.textContent = "🎬";
        iconDiv.className += " mal-fallback-icon";
      } else
      this.plugin.iconCache.get(app.id)
        ? (() => {
            const img = document.createElement("img");
            img.src = this.plugin.iconCache.get(app.id);
            img.alt = "";
            img.className = "mal-native-icon";
            iconDiv.appendChild(img);
            return true;
          })()
        : (() => {
            iconDiv.textContent = "📦";
            iconDiv.className += " mal-fallback-icon";
            if (app.iconPath && fs.existsSync(app.iconPath)) {
              this.plugin.iconCache.load(app.id, app.iconPath, fs).then(dataUrl => {
                if (dataUrl && this.listEl && this.listEl.contains(item)) {
                  iconDiv.innerHTML = "";
                  iconDiv.className = "mal-quick-launch-item-icon";
                  const img = document.createElement("img");
                  img.src = dataUrl;
                  img.alt = "";
                  img.className = "mal-native-icon mal-icon-fade-in";
                  iconDiv.appendChild(img);
                }
              });
            }
            return false;
          })();

      const info = document.createElement("div");
      info.className = "mal-quick-launch-item-info";
      const name = document.createElement("div");
      name.className = "mal-quick-launch-item-name";
      name.textContent = app.name;
      const meta = document.createElement("div");
      meta.className = "mal-quick-launch-item-meta";
      meta.textContent = app.category || "未分类";
      info.appendChild(name);
      info.appendChild(meta);

      const shortcut = document.createElement("div");
      shortcut.className = "mal-quick-launch-item-shortcut";
      shortcut.textContent = "↵";

      item.appendChild(iconDiv);
      item.appendChild(info);
      item.appendChild(shortcut);

      item.addEventListener("click", () => {
        this.selectedIndex = index;
        this.launchSelected();
      });
      item.addEventListener("mouseenter", () => {
        this.selectedIndex = index;
        this.updateSelection();
      });

      frag.appendChild(item);
    });
    this.listEl.appendChild(frag);
    this.ensureSelectedVisible();
  }

  updateSelection() {
    if (!this.listEl) return;
    const items = this.listEl.querySelectorAll(".mal-quick-launch-item");
    items.forEach((item, i) => {
      if (i === this.selectedIndex) {
        item.classList.add("is-selected");
        item.setAttribute("aria-selected", "true");
      } else {
        item.classList.remove("is-selected");
        item.setAttribute("aria-selected", "false");
      }
    });
    this.ensureSelectedVisible();
  }

  ensureSelectedVisible() {
    if (!this.listEl) return;
    const items = this.listEl.querySelectorAll(".mal-quick-launch-item");
    const selected = items[this.selectedIndex];
    if (!selected) return;
    const listRect = this.listEl.getBoundingClientRect();
    const itemRect = selected.getBoundingClientRect();
    if (itemRect.top < listRect.top) {
      selected.scrollIntoView({ block: "start" });
    } else if (itemRect.bottom > listRect.bottom) {
      selected.scrollIntoView({ block: "end" });
    }
  }

  handleKeyDown(event) {
    if (!this.isOpen) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (this.results.length) {
          this.selectedIndex = (this.selectedIndex + 1) % this.results.length;
          this.updateSelection();
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (this.results.length) {
          this.selectedIndex = (this.selectedIndex - 1 + this.results.length) % this.results.length;
          this.updateSelection();
        }
        break;
      case "Enter":
        event.preventDefault();
        this.launchSelected();
        break;
      case "Escape":
        event.preventDefault();
        this.close();
        break;
    }
  }

  launchSelected() {
    const app = this.results[this.selectedIndex];
    if (!app) return;
    if (app.isScene) this.plugin.launchScene(app.scene);
    else this.plugin.launchApp(app);
    this.close();
  }
}

// ---- 导入配置弹窗 ----
class ImportConfigModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "导入配置" });
    contentEl.createEl("p", {
      text: "粘贴由「导出配置」生成的 JSON。导入会覆盖当前的应用列表、场景与分类。",
      cls: "mal-detail-meta"
    });
    const textarea = contentEl.createEl("textarea", {
      cls: "mal-import-textarea",
      attr: { rows: "10", spellcheck: "false", placeholder: '{"apps":[…],"scenes":[…],"categories":[…]}' }
    });
    const row = contentEl.createDiv({ cls: "mal-detail-edit-actions" });
    const ok = row.createEl("button", { text: "确认导入", cls: "mal-primary" });
    ok.addEventListener("click", async () => {
      const result = await this.plugin.importConfig(textarea.value);
      if (result.ok) {
        new Notice(`已导入 ${result.apps} 个应用、${result.scenes} 个场景`);
        this.close();
      } else {
        new Notice(`导入失败：${result.error}`, 7000);
      }
    });
    const cancel = row.createEl("button", { text: "取消", cls: "mal-button" });
    cancel.addEventListener("click", () => this.close());
  }

  onClose() { this.contentEl.empty(); }
}

// ---- 关于弹窗：作者、版本、内置更新日志 ----
class AboutModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mal-about-modal");

    const head = contentEl.createDiv({ cls: "mal-about-head" });
    head.createEl("h2", { text: "Mac App Launcher" });
    head.createSpan({ cls: "mal-settings-version", text: `v${this.plugin.manifest.version}` });

    contentEl.createEl("p", { cls: "mal-about-author", text: "作者：阎大大" });
    contentEl.createEl("p", { cls: "mal-about-desc", text: this.plugin.manifest.description || "" });

    const btns = contentEl.createDiv({ cls: "mal-about-btns" });
    const links = [
      ["GitHub 仓库", "https://github.com/y12589/mac-app-launcher"],
      ["完整更新日志", "https://github.com/y12589/mac-app-launcher/blob/YDD/CHANGELOG.md"],
      ["提交 Issue", "https://github.com/y12589/mac-app-launcher/issues"]
    ];
    for (const [label, url] of links) {
      const btn = btns.createEl("button", { text: label, cls: "mal-button" });
      btn.addEventListener("click", () => window.open(url, "_blank"));
    }

    contentEl.createEl("h3", { text: "更新日志" });
    const log = contentEl.createDiv({ cls: "mal-about-log" });
    for (const entry of ABOUT_CHANGELOG) {
      const item = log.createDiv({ cls: "mal-about-log-entry" });
      item.createEl("div", { cls: "mal-about-log-version", text: entry.version });
      const ul = item.createEl("ul");
      for (const line of entry.changes) {
        ul.createEl("li", { text: line });
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class MacAppLauncherSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("mal-settings");

    // 头部：插件名 + 版本徽章
    const header = containerEl.createDiv({ cls: "mal-settings-header" });
    header.createEl("h2", { text: "Mac App Launcher" });
    header.createSpan({ cls: "mal-settings-version", text: `v${this.plugin.manifest.version}` });

    // ── 常规 ──
    containerEl.createDiv({ cls: "mal-settings-group", text: "常规" });

    new Setting(containerEl)
      .setName("启动时自动拉起场景")
      .setDesc("打开 Obsidian 后约 3 秒自动启动该场景内的一组应用。")
      .addDropdown(drop => {
        drop.addOption("", "不自动启动");
        for (const scene of this.plugin.settings.scenes) {
          drop.addOption(scene.id, scene.name);
        }
        drop.setValue(this.plugin.settings.autoLaunchSceneId || "");
        drop.onChange(async value => {
          this.plugin.settings.autoLaunchSceneId = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("记录启动日志到每日笔记")
      .setDesc("每次通过本插件启动应用时，在当天日记的「应用使用记录」小节追加一行。默认关闭。")
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.logToDailyNote === true);
        toggle.onChange(async value => {
          this.plugin.settings.logToDailyNote = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("允许自动执行画布工作流")
      .setDesc("开启后可用命令「执行当前画布的工作流」按连线顺序启动应用、打开笔记。")
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.canvasExecuteEnabled !== false);
        toggle.onChange(async value => {
          this.plugin.settings.canvasExecuteEnabled = value;
          await this.plugin.saveSettings();
        });
      });

    // ── Agent API ──
    containerEl.createDiv({ cls: "mal-settings-group", text: "Agent API" });

    const running = !!(this.plugin.agentServer && this.plugin.agentServer.listening);
    const statusSetting = new Setting(containerEl).setName("服务状态");
    statusSetting.descEl.empty();
    statusSetting.descEl.createSpan({ cls: `mal-status-dot${running ? " is-on" : ""}` });
    statusSetting.descEl.createSpan({
      text: running
        ? `运行中 · 监听 127.0.0.1:${this.plugin.settings.agentPort || 43171}`
        : "已停止 · 打开下方开关启动"
    });

    new Setting(containerEl)
      .setName("启用 Agent API")
      .setDesc("关闭后本机 Agent 接口停止服务，插件其余功能不受影响。")
      .addToggle(toggle => {
        toggle.setValue(!!this.plugin.settings.agentApiEnabled);
        toggle.onChange(async value => {
          this.plugin.settings.agentApiEnabled = value;
          await this.plugin.saveSettings();
          if (value) {
            try {
              await this.plugin.startAgentServer();
            } catch (error) {
              new Notice(`Agent API 启动失败：${error.message || error}`, 8000);
            }
          } else {
            await this.plugin.stopAgentServer();
          }
          this.display();
        });
      });

    let portInput = null;
    new Setting(containerEl)
      .setName("监听端口")
      .setDesc("默认 43171，被占用时自动改用可用端口。修改后点「应用端口」重启服务生效。")
      .addText(text => {
        portInput = text;
        text.inputEl.addClass("mal-port-input");
        text.setPlaceholder("43171");
        text.setValue(String(this.plugin.settings.agentPort || 43171));
      })
      .addButton(button => {
        button.setButtonText("应用端口");
        button.onClick(async () => {
          const port = parseInt(portInput.getValue(), 10);
          if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            new Notice("端口无效，请输入 1–65535 之间的数字。", 6000);
            return;
          }
          this.plugin.settings.agentPort = port;
          await this.plugin.saveSettings();
          if (this.plugin.settings.agentApiEnabled) {
            await this.plugin.stopAgentServer();
            try {
              await this.plugin.startAgentServer();
            } catch (error) {
              new Notice(`Agent API 启动失败：${error.message || error}`, 8000);
            }
          }
          new Notice(`Agent API 端口已设为 ${this.plugin.settings.agentPort}`);
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("访问令牌")
      .setDesc("调用接口（健康检查除外）须携带此令牌，重置后旧令牌立即失效。")
      .addText(text => {
        text.inputEl.addClass("mal-token-input");
        text.setValue(this.plugin.sessionAgentToken || "（已安全存储，仅生成当次可见）");
        text.inputEl.setAttribute("readonly", "readonly");
        text.inputEl.setAttribute("spellcheck", "false");
      })
      .addButton(button => {
        button.setButtonText("重置令牌");
        button.onClick(async () => {
          const fresh = crypto.randomBytes(32).toString("hex");
          this.plugin.sessionAgentToken = fresh;
          this.plugin.settings.agentTokenHash = crypto.createHash("sha256").update(fresh).digest("hex");
          await this.plugin.saveSettings();
          new Notice("Agent API 访问令牌已重置，旧令牌立即失效。新令牌仅本次会话可见，请立即复制保存。", 8000);
          this.display();
        });
      })
      .addButton(button => {
        button.setButtonText("复制接入说明");
        button.onClick(() => this.plugin.copyAgentInstructions());
      });

    // ── 更新 ──
    containerEl.createDiv({ cls: "mal-settings-group", text: "更新" });

    new Setting(containerEl)
      .setName("启动时自动检查更新")
      .setDesc("启动 Obsidian 时检查 GitHub Release，发现新版自动下载并覆盖插件文件。")
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.autoCheckUpdates !== false);
        toggle.onChange(async value => {
          this.plugin.settings.autoCheckUpdates = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("下载加速镜像")
      .setDesc("可选。直连 GitHub 下载更新不稳定时，填镜像前缀（如 https://mirror.ghproxy.com），留空则直连。下载失败会自动重试 3 次。")
      .addText(text => {
        text.inputEl.addClass("mal-mirror-input");
        text.setPlaceholder("留空直连 GitHub");
        text.setValue(this.plugin.settings.downloadMirror || "");
        text.onChange(async value => {
          this.plugin.settings.downloadMirror = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("检查更新")
      .setDesc(`${this.plugin.getUpdateStatusText()}。点击立即检查一次，发现新版自动下载覆盖并重载。`)
      .addButton(button => {
        button.setButtonText("立即检查");
        button.onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.checkForUpdates({ manual: true });
          } finally {
            button.setDisabled(false);
            this.display();
          }
        });
      });

    // ── 首页小组件：万年历与天气 ──
    containerEl.createDiv({ cls: "mal-settings-group", text: "首页小组件" });

    new Setting(containerEl)
      .setName("显示万年历与今日天气")
      .setDesc("在应用中心首页顶部展示公历、农历、节日与当天天气；关闭后首页只保留应用列表。")
      .addToggle(tg => tg.setValue(this.plugin.settings.showDashboard !== false).onChange(async v => {
        this.plugin.settings.showDashboard = v;
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      }));

    new Setting(containerEl)
      .setName("天气位置")
      .setDesc("留空则按网络定位自动识别城市；也可填写城市名（如 苏州、上海）固定位置。天气数据来自 Open-Meteo，只发送经纬度，不上传任何本地数据。")
      .addText(t => t.setPlaceholder("自动定位").setValue(this.plugin.settings.weatherCity).onChange(async v => {
        this.plugin.settings.weatherCity = v.trim();
        this.plugin.weatherCache = null;
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      }));

    new Setting(containerEl)
      .setName("显示活跃月历")
      .setDesc("按天统计应用启动次数，用月历热力图展示活跃程度。数据只存本地配置，最多保留 400 天。")
      .addToggle(tg => tg.setValue(this.plugin.settings.showActivityCalendar !== false).onChange(async v => {
        this.plugin.settings.showActivityCalendar = v;
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      }));

    new Setting(containerEl)
      .setName("首页布局")
      .setDesc("三栏工作区：算力卡册入口 / 常用应用 / 自定义入口卡，三块可拖拽换位。常用应用 + 卡册：顶部最多 8 个常用应用，下方展示完整卡册。")
      .addDropdown(dd => dd
        .addOption("classic", "三栏工作区（默认）")
        .addOption("album", "常用应用 + 卡册")
        .setValue(this.plugin.settings.homeMode || "classic")
        .onChange(async v => {
          this.plugin.settings.homeMode = v === "album" ? "album" : "classic";
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        }));

    new Setting(containerEl)
      .setName("首页自由布局")
      .setDesc("首页模块（仪表板、笔记绑定、每个分类分区）可拖动换位、拖动右下角调整宽高，布局自动保存。关闭后按内容顺序排列。")
      .addToggle(tg => tg.setValue(this.plugin.settings.homeFreeLayout !== false).onChange(async v => {
        this.plugin.settings.homeFreeLayout = v;
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      }))
      .addButton(btn => btn.setButtonText("恢复默认布局").onClick(async () => {
        await this.plugin.resetHomeLayout();
        new Notice("首页布局已恢复默认");
      }));

    // ── 维护：调试日志与历史清理 ──
    containerEl.createDiv({ cls: "mal-settings-group", text: "维护" });

    new Setting(containerEl)
      .setName("调试日志")
      .setDesc("记录扫描、场景执行等关键操作到插件目录 debug.log（超 256KB 自动截断），排障时再开启。")
      .addToggle(tg => tg.setValue(this.plugin.settings.debugLog).onChange(async v => {
        this.plugin.settings.debugLog = v;
        await this.plugin.saveSettings();
      }))
      .addButton(btn => btn.setButtonText("清除日志").onClick(() => {
        try {
          const file = path.join(this.plugin.pluginDirPath(), "debug.log");
          if (fs.existsSync(file)) fs.unlinkSync(file);
          new Notice("调试日志已清除");
        } catch (e) { new Notice("清除失败"); }
      }));

    new Setting(containerEl)
      .setName("清除使用统计")
      .setDesc("把所有应用的启动次数和最近启动时间清零（不影响每日笔记里已有的日志）。")
      .addButton(btn => btn.setButtonText("清除统计").setWarning().onClick(async () => {
        for (const app of this.plugin.settings.apps) {
          app.launchCount = 0;
          app.lastLaunchedAt = 0;
        }
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
        new Notice("使用统计已清零");
      }));

    new Setting(containerEl)
      .setName("清除图标缓存")
      .setDesc("删除已提取的应用图标，下次打开应用中心时重新生成。")
      .addButton(btn => btn.setButtonText("清除缓存").setWarning().onClick(() => {
        try {
          this.plugin.iconCache.clear();
          const dir = path.join(this.plugin.pluginDirPath(), "icons");
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
          new Notice("图标缓存已清除，重开应用中心后重新生成");
        } catch (e) { new Notice("清除失败"); }
      }));

    // ── 文件关联与统计 ──
    containerEl.createDiv({ cls: "mal-settings-group", text: "文件关联与统计" });

    new Setting(containerEl)
      .setName("文件关联规则")
      .setDesc("把指定扩展名绑定到指定应用，右键菜单优先显示（高于内置分类推荐）。")
      .addButton(btn => btn.setButtonText("管理规则").onClick(() => {
        new FileRulesModal(this.app, this.plugin).open();
      }));

    new Setting(containerEl)
      .setName("应用使用统计")
      .setDesc("使用排行、最近启动与最近 7 天趋势（趋势来自每日笔记启动日志）。")
      .addButton(btn => btn.setButtonText("查看统计").onClick(() => {
        new UsageStatsModal(this.app, this.plugin).open();
      }));

    // ── 配置管理 ──
    containerEl.createDiv({ cls: "mal-settings-group", text: "配置管理" });

    new Setting(containerEl)
      .setName("导入 / 导出配置")
      .setDesc("导出应用资源、场景、分类、算力福利卡片与领取历史为 JSON，可粘贴到其他 Vault 导入；导入会覆盖对应数据。")
      .addButton(btn => btn.setButtonText("导出到剪贴板").onClick(async () => {
        await navigator.clipboard.writeText(this.plugin.exportConfig());
        new Notice("配置已复制到剪贴板");
      }))
      .addButton(btn => btn.setButtonText("导入…").onClick(() => {
        new ImportConfigModal(this.app, this.plugin).open();
      }));

    // ── 关于 ──
    containerEl.createDiv({ cls: "mal-settings-group", text: "关于" });

    new Setting(containerEl)
      .setName("关于 Mac App Launcher")
      .setDesc("作者 阎大大 · 查看版本信息与更新日志")
      .addButton(button => {
        button.setButtonText("打开关于页");
        button.setCta();
        button.onClick(() => {
          new AboutModal(this.app, this.plugin).open();
        });
      });
  }
}

module.exports = class MacAppLauncherPlugin extends Plugin {
  // 配置迁移备份：不覆盖已有 data.json.vN.bak；备份失败必须中止迁移。
  createMigrationBackup(oldSchemaVersion) {
    const dataFile = path.join(this.pluginDirPath(), "data.json");
    if (!fs.existsSync(dataFile)) return "";
    const startVersion = Math.max(1, Number(oldSchemaVersion) || 1);
    let version = startVersion;
    let backupFile = `${dataFile}.v${version}.bak`;
    while (fs.existsSync(backupFile)) {
      version += 1;
      backupFile = `${dataFile}.v${version}.bak`;
    }
    fs.copyFileSync(dataFile, backupFile, fs.constants.COPYFILE_EXCL);
    const sourceSize = fs.statSync(dataFile).size;
    const backupSize = fs.statSync(backupFile).size;
    if (sourceSize !== backupSize) {
      try { fs.unlinkSync(backupFile); } catch (_) {}
      throw new Error("data.json 备份校验失败，迁移已中止");
    }
    console.log(`[Mac App Launcher] 迁移前备份完成：${path.basename(backupFile)}`);
    return backupFile;
  }

  // 仅为原始 data.json 中完全缺少 bundleId 字段的应用回填。
  // 空字符串、null 等已存在值均视为用户已有值，不覆盖。
  async collectMissingBundleIdUpdates(rawApps, legacyApps = false) {
    const rawList = Array.isArray(rawApps) ? rawApps : [];
    const byId = new Map();
    const byPath = new Map();
    for (const raw of rawList) {
      if (!raw || typeof raw !== "object") continue;
      if (raw.id) byId.set(String(raw.id), raw);
      if (raw.path) {
        try { byPath.set(path.resolve(String(raw.path)), raw); } catch (_) {}
      }
    }
    const targets = (this.settings.apps || []).filter(app => {
      if (!app || !app.path || app.bundleId || !isAppBundleInstalled(app)) return false;
      if (legacyApps) return true;
      let raw = byId.get(String(app.id || ""));
      if (!raw) {
        try { raw = byPath.get(path.resolve(String(app.path))); } catch (_) {}
      }
      // bundleId 的空字符串是旧版 normalizeApp 写入的“未回填”占位，不是用户配置；
      // 非空已有值绝不覆盖。
      return !!raw && (!hasOwnField(raw, "bundleId") || raw.bundleId === undefined || raw.bundleId === null || String(raw.bundleId).trim() === "");
    });
    const updates = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const app = targets[cursor++];
        try {
          const info = await this.readAppInfo(app.path);
          if (info && info.bundleId) updates.push({ id: app.id, bundleId: info.bundleId });
        } catch (error) {
          this.debugLog("[migration] bundleId 回填失败", app.name, String(error && error.message || error));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, targets.length)) }, worker));
    return updates;
  }

  // 统一加载期迁移入口。所有持久化改动先规划、再备份、最后一次 saveSettings。
  async loadSettings(loaded, rawApps, legacyApps = false) {
    const oldSchemaVersion = Number(this.settings.schemaVersion) || 0;
    const oldClaimsSchema = Number(this.settings.computeClaimsSchema) || 0;

    const plannedCards = (this.settings.computeCards || []).map(card => ({ ...card }));
    // 默认卡合并：作者在 DEFAULT_COMPUTE_CARDS 新增的卡片自动并入用户卡册（跳过用户已删除的 ID）
    const deletedCardIds = new Set((this.settings.deletedCardIds || []).map(String));
    const existingCardIds = new Set(plannedCards.map(card => String(card.id)));
    const addedDefaultCards = [];
    for (const def of DEFAULT_COMPUTE_CARDS) {
      const id = String(def.id);
      if (existingCardIds.has(id) || deletedCardIds.has(id)) continue;
      addedDefaultCards.push(normalizeComputeCard(def, plannedCards.length + addedDefaultCards.length));
    }
    const cardsChanged = addedDefaultCards.length > 0;
    if (cardsChanged) plannedCards.push(...addedDefaultCards);
    const linksChanged = migrateComputeCardAppLinks(plannedCards, this.settings.apps || []);

    const rawClaimRecords = Array.isArray(loaded && loaded.computeClaimRecords)
      ? loaded.computeClaimRecords
      : [];
    const plannedRecords = mergeComputeClaimRecords(
      this.settings.computeClaimRecords || [],
      this.settings.computeCheckins || {},
      plannedCards,
      rawClaimRecords
    );
    const recordsChanged = JSON.stringify(plannedRecords) !== JSON.stringify(this.settings.computeClaimRecords || []);

    const bundleUpdates = await this.collectMissingBundleIdUpdates(rawApps, legacyApps);

    const rawLayout = Array.isArray(loaded && loaded.homeLayout) ? loaded.homeLayout : [];
    const rawLayoutById = new Map(rawLayout.filter(item => item && item.id).map(item => [item.id, item]));
    const plannedLayout = (this.settings.homeLayout || []).map(item => {
      const next = { ...item };
      const raw = rawLayoutById.get(item.id);
      if (raw && !hasOwnField(raw, "autoHeight")) next.autoHeight = true;
      if (raw && raw.autoHeight === false && !hasOwnField(raw, "hPx")) {
        next.hPx = 36 * clampInt(raw.h, 1, 400, 6) - 12;
      }
      return next;
    });
    const layoutChanged = JSON.stringify(plannedLayout) !== JSON.stringify(this.settings.homeLayout || []);

    const categoryNames = new Set((this.settings.categories || []).map(item => item && item.name));
    const missingCategories = [...new Set((this.settings.apps || [])
      .map(app => String(app && app.category || "").trim())
      .filter(name => name && name !== "未分类" && !categoryNames.has(name)))];

    const migrationNeeded =
      oldSchemaVersion < SCHEMA_VERSION ||
      oldClaimsSchema < 2 ||
      linksChanged ||
      cardsChanged ||
      recordsChanged ||
      bundleUpdates.length > 0 ||
      layoutChanged ||
      missingCategories.length > 0;

    if (!migrationNeeded) return false;

    // 备份必须先于所有迁移字段写入；备份失败时抛错，由 onload 中止插件初始化。
    const backupPath = this.createMigrationBackup(oldSchemaVersion);

    this.settings.computeCards = plannedCards;
    this.settings.computeClaimRecords = plannedRecords;
    this.settings.homeLayout = plannedLayout;
    for (const update of bundleUpdates) {
      const app = (this.settings.apps || []).find(item => String(item.id) === String(update.id));
      if (app && (!hasOwnField(app, "bundleId") || app.bundleId === "")) {
        app.bundleId = update.bundleId;
      }
    }
    for (const name of missingCategories) this.ensureCategoryEntry(name);

    this.settings.computeClaimsSchema = Math.max(oldClaimsSchema, 2);
    this.settings.schemaVersion = Math.max(oldSchemaVersion, SCHEMA_VERSION);
    // computeCheckins 是旧版兼容映射，刻意保留；其他用户数据也由 settings 初始化时的 spread 保留。
    await this.saveSettings();

    console.log("[Mac App Launcher] 配置迁移完成", {
      schemaVersion: this.settings.schemaVersion,
      computeClaimsSchema: this.settings.computeClaimsSchema,
      linkedCards: linksChanged,
      claimRecordsBefore: (this.settings.computeClaimRecords || []).length,
      bundleIdsBackfilled: bundleUpdates.length,
      backup: backupPath || "fresh-install-no-data.json"
    });
    return true;
  }

  async onload() {
    // 平台守卫：核心能力全部依赖 macOS（open/plutil/qlmanage/sips），
    // Windows/Linux 桌面端明确提示并停用，而不是静默坏掉
    if (process.platform !== "darwin") {
      new Notice("Mac App Launcher 依赖 macOS 系统能力，当前平台无法使用，插件已自动停用。", 10000);
      return;
    }
    const loaded = await this.loadData() || {};
    const legacyApps = !Array.isArray(loaded.apps);
    const rawApps = Array.isArray(loaded.apps) ? loaded.apps : parseLegacyApps(loaded.appsText);
    // token 迁移：明文 → sha256 哈希存储；明文仅在生成的当次会话内可见
    const legacyToken = typeof loaded.agentToken === "string" && loaded.agentToken.length >= 32 ? loaded.agentToken : "";
    let tokenHash = typeof loaded.agentTokenHash === "string" && loaded.agentTokenHash.length === 64 ? loaded.agentTokenHash : "";
    this.sessionAgentToken = "";
    if (!tokenHash && legacyToken) {
      tokenHash = crypto.createHash("sha256").update(legacyToken).digest("hex");
      this.sessionAgentToken = legacyToken; // 本会话仍可见，便于用户备份
    }
    if (!tokenHash) {
      this.sessionAgentToken = crypto.randomBytes(32).toString("hex");
      tokenHash = crypto.createHash("sha256").update(this.sessionAgentToken).digest("hex");
    }
    // 保留未知/未来版本字段，避免设置对象重建时静默丢弃用户数据；明文旧 token 不再写回。
    const { agentToken: _legacyAgentToken, ...preservedLoaded } = loaded;
    this.settings = {
      ...preservedLoaded,
      apps: rawApps.map((app, index) => normalizeApp(app, index)),
      hasScanned: !!loaded.hasScanned,
      agentPort: Number.isInteger(Number(loaded.agentPort)) && Number(loaded.agentPort) > 0 ? Number(loaded.agentPort) : 43171,
      agentTokenHash: tokenHash,
      agentApiEnabled: loaded.agentApiEnabled !== false,
      viewMode: loaded.viewMode === "list" ? "list" : "grid",
      categories: Array.isArray(loaded.categories)
        ? loaded.categories.filter(c => c && c.name).map((c, i) => ({
            name: String(c.name),
            icon: typeof c.icon === "string" ? c.icon : "📁",
            order: Number.isFinite(Number(c.order)) ? Number(c.order) : i
          }))
        : DEFAULT_CATEGORY_META.map((c, i) => ({ ...c, order: i })),
      categoryRules: loaded.categoryRules && typeof loaded.categoryRules === "object" && !Array.isArray(loaded.categoryRules)
        ? loaded.categoryRules : {},
      scenes: Array.isArray(loaded.scenes)
        ? loaded.scenes.filter(s => s && s.name).map(s => {
            const scene = {
              id: String(s.id || crypto.randomBytes(6).toString("hex")),
              name: String(s.name),
              appIds: Array.isArray(s.appIds) ? s.appIds : []
            };
            if (Array.isArray(s.steps)) scene.steps = s.steps;
            ensureSceneSteps(scene); // 旧场景从 appIds 迁移为步骤列表
            return scene;
          })
        : [],
      autoCheckUpdates: loaded.autoCheckUpdates !== false,
      lastUpdateCheck: typeof loaded.lastUpdateCheck === "string" ? loaded.lastUpdateCheck : "",
      latestVersion: typeof loaded.latestVersion === "string" ? loaded.latestVersion : "",
      downloadMirror: typeof loaded.downloadMirror === "string" ? loaded.downloadMirror : "",
      autoLaunchSceneId: typeof loaded.autoLaunchSceneId === "string" ? loaded.autoLaunchSceneId : "",
      logToDailyNote: loaded.logToDailyNote === true,
      canvasExecuteEnabled: loaded.canvasExecuteEnabled !== false,
      // 自定义文件关联规则：扩展名 → 指定应用，优先级高于内置分类推荐
      fileRules: Array.isArray(loaded.fileRules)
        ? loaded.fileRules.filter(r => r && r.ext && r.appId).map(r => ({
            ext: String(r.ext).replace(/^\./, "").toLowerCase(),
            appId: String(r.appId)
          }))
        : [],
      schemaVersion: loaded.schemaVersion || 0,
      // 首页小组件：万年历 + 今日天气 + 活跃月历
      showDashboard: loaded.showDashboard !== false,
      showActivityCalendar: loaded.showActivityCalendar !== false,
      weatherCity: typeof loaded.weatherCity === "string" ? loaded.weatherCity : "",
      launchDaily: loaded.launchDaily && typeof loaded.launchDaily === "object" ? loaded.launchDaily : {},
      moodDaily: loaded.moodDaily && typeof loaded.moodDaily === "object" ? loaded.moodDaily : {},
      pinnedOrder: Array.isArray(loaded.pinnedOrder) ? loaded.pinnedOrder : [],
      // 左栏快捷入口（2×2）：与右栏同一套结构，最多 4 条
      leftEntries: (() => {
        const pick = item => item && typeof item === "object"
          ? {
              title: String(item.title || ""),
              sub: String(item.sub || ""),
              emoji: String(item.emoji || ""),
              iconColor: String(item.iconColor || ""),
              iconImage: String(item.iconImage || ""),
              url: String(item.url || "")
            }
          : null;
        return Array.isArray(loaded.leftEntries) ? loaded.leftEntries.map(pick).filter(Boolean) : [];
      })(),
      // 右侧广告位：两行一列，每个只含图片 + 网址链接
      adSlots: (() => {
        const pick = item => item && typeof item === "object"
          ? { image: String(item.image || ""), url: String(item.url || "") }
          : null;
        return Array.isArray(loaded.adSlots) ? loaded.adSlots.map(pick).filter(Boolean) : [];
      })(),
      // 首页自定义链接：多条，每条标题 / 副标题 / 图标 / 链接，排成两行
      customEntries: (() => {
        const pick = item => item && typeof item === "object"
          ? {
              title: String(item.title || ""),
              sub: String(item.sub || ""),
              emoji: String(item.emoji || ""),
              iconColor: String(item.iconColor || ""),
              iconImage: String(item.iconImage || ""),
              url: String(item.url || "")
            }
          : null;
        if (Array.isArray(loaded.customEntries) && loaded.customEntries.length) {
          const list = loaded.customEntries.map(pick).filter(Boolean);
          if (list.length) return list;
        }
        const single = pick(loaded.customEntry);
        if (single) return [single];
        return [{ title: "更多白嫖快看【AI信息差】", sub: "点此自定义标题与链接", emoji: "🔥", url: "" }];
      })(),
      // 首页三块工作区顺序：album 算力 / apps 常用应用 / entry 自定义入口
      workspaceOrder: (() => {
        // 三块一排：left 左快捷入口 / apps 常用应用 / entry 右快捷入口
        const keys = ["left", "apps", "entry"];
        const saved = Array.isArray(loaded.workspaceOrder)
          ? loaded.workspaceOrder.filter(k => keys.includes(k))
          : [];
        // 旧版配置（含 album、没有 left）统一回落到默认顺序
        if (!saved.includes("left")) return [...keys];
        for (const key of keys) if (!saved.includes(key)) saved.push(key);
        return saved;
      })(),
      // 算力卡册：不再因旧版 computeSchema 不匹配而丢弃用户自定义卡片。
      computeCards: Array.isArray(loaded.computeCards)
        ? loaded.computeCards.map((card, index) => normalizeComputeCard(card, index))
        : DEFAULT_COMPUTE_CARDS.map((card, index) => normalizeComputeCard(card, index)),
      // 用户主动删除的默认卡 ID：作者后续新增默认卡时，跳过这些 ID，避免删除的卡被重新并入。
      deletedCardIds: Array.isArray(loaded.deletedCardIds) ? loaded.deletedCardIds.map(String) : [],
      // 旧版日期 → 卡片 ID 映射仅用于一次性迁移和兼容备份；新记录使用独立周期记录。
      computeCheckins: loaded.computeCheckins && typeof loaded.computeCheckins === "object" ? loaded.computeCheckins : {},
      computeClaimRecords: Array.isArray(loaded.computeClaimRecords)
        ? loaded.computeClaimRecords.map((record, index) => normalizeClaimRecord(record, index))
        : [],
      computeClaimsSchema: Number(loaded.computeClaimsSchema) || 0,
      computeSchema: 3,
      // 首页布局模式：classic = 三栏工作区（默认）；album = 常用应用 + 完整卡册
      homeMode: loaded.homeMode === "album" ? "album" : "classic",
      // 首页自由布局：模块顺序与宽高（12 列网格；autoHeight 未关闭时高度贴合内容）
      homeFreeLayout: loaded.homeFreeLayout !== false,
      homeLayout: Array.isArray(loaded.homeLayout)
        ? loaded.homeLayout
            .filter(item => item && typeof item.id === "string" && item.id)
            .reduce((list, item) => {
              if (!list.some(entry => entry.id === item.id)) {
                const entry = {
                  id: item.id,
                  w: clampInt(item.w, 1, 12, 12),
                  h: clampInt(item.h, 1, 400, 6),
                  autoHeight: item.autoHeight !== false
                };
                if (!entry.autoHeight) {
                  entry.hPx = clampInt(item.hPx, 24, 4000, 36 * entry.h - 12);
                }
                list.push(entry);
              }
              return list;
            }, [])
        : [],
      debugLog: loaded.debugLog === true
    };
    this.weatherCache = null;
    this.weatherPromise = null;
    this.holidayCache = null;
    // 所有字段回填与周期领取记录迁移统一在 loadSettings 中执行。
    // 迁移前备份 data.json；备份失败则停止加载，避免覆盖用户原始数据。
    try {
      await this.loadSettings(loaded, rawApps, legacyApps);
    } catch (error) {
      console.error("[Mac App Launcher] 配置迁移失败，已停止插件初始化", error);
      new Notice(`Mac App Launcher 配置迁移失败，未继续写入数据：${error.message || error}。请检查插件目录中的 data.json 与备份权限。`, 10000);
      return;
    }
    this.scanning = false;
    this.scanCancelled = false;
    this.scanProgress = 0;
    this.scanTotal = 0;
    this.scanStatus = "";
    this.iconJobs = new Map();
    this.iconCache = new IconCache(300); // 图标内存缓存，LRU 淘汰

    this.registerView(VIEW_TYPE, leaf => new MacAppLauncherView(leaf, this));
    this.addSettingTab(new MacAppLauncherSettingTab(this.app, this));
    this.addRibbonIcon("layout-grid", "打开 Mac 应用中心", () => this.activateView());
    this.addCommand({
      id: "open-mac-app-launcher",
      name: "打开 Mac 应用中心",
      callback: () => this.activateView()
    });
    this.addCommand({
      id: "scan-mac-apps",
      name: "扫描本机已安装应用",
      callback: () => this.scanInstalledApps()
    });
    // 快速启动命令（可绑定全局快捷键）
    this.quickLaunch = new QuickLaunchModal(this);
    this.addCommand({
      id: "quick-launch-app",
      name: "快速启动应用",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: " " }],
      callback: () => this.quickLaunch.open()
    });
    // URL Scheme：obsidian://mac-app-launcher?app=名称或ID
    this.registerObsidianProtocolHandler("mac-app-launcher", params => {
      const query = (params.app || "").trim();
      if (!query) {
        this.quickLaunch.open();
        return;
      }
      const apps = this.settings.apps.filter(app => app.selected);
      const q = query.toLowerCase();
      // 先精确匹配 ID / 名称，再退到子串，最后模糊
      let target = apps.find(app => app.id === query) ||
        apps.find(app => (app.name || "").toLowerCase() === q) ||
        apps.find(app => (app.name || "").toLowerCase().includes(q));
      if (!target) {
        const ranked = fuzzySearchApps(apps, query);
        target = ranked.length ? ranked[0].app : null;
      }
      if (target) {
        this.launchApp(target);
      } else {
        new Notice(`Mac App Launcher：找不到应用「${query}」`, 6000);
      }
    });
    await this.saveSettings();
    if (this.settings.agentApiEnabled) {
      try {
        await this.startAgentServer();
      } catch (error) {
        console.error("[Mac App Launcher] Agent API startup failed", error);
        new Notice(`Agent API 启动失败：${error.message || error}`, 8000);
      }
    }
    if (this.settings.autoCheckUpdates) {
      this.checkForUpdates().catch(error => {
        console.error("[Mac App Launcher] Auto update check failed", error);
      });
    }
    // 后台补齐存量应用的拼音索引
    this.buildPinyin(this.settings.apps);
    // 注册单应用快捷键
    this.refreshAppHotkeys();
    // 注册场景启动命令
    this.refreshSceneCommands();
    this.debugLog(`插件加载完成 v${this.manifest.version}，应用 ${this.settings.apps.length} 个，场景 ${this.settings.scenes.length} 个`);
    // 笔记内嵌应用启动卡片：```app-launcher 代码块
    this.registerMarkdownCodeBlockProcessor("app-launcher", (source, el) => this.renderLauncherBlock(source, el));
    // 文件列表右键菜单：按类型打开 / 启动绑定场景
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => this.buildFileMenu(menu, file)));
    // 公开 API：供 QuickAdd / Templater 等插件调用
    this.registerPublicApi();
    this.addCommand({
      id: "execute-active-canvas",
      name: "执行当前画布的工作流",
      callback: () => this.executeActiveCanvas()
    });
    this.addCommand({
      id: "show-usage-stats",
      name: "查看应用使用统计",
      callback: () => new UsageStatsModal(this.app, this).open()
    });
    this.addCommand({
      id: "manage-file-rules",
      name: "管理文件关联规则",
      callback: () => new FileRulesModal(this.app, this).open()
    });
    // 启动时自动拉起指定场景（延迟等待界面就绪）
    if (this.settings.autoLaunchSceneId) {
      setTimeout(() => {
        const scene = (this.settings.scenes || []).find(s => s.id === this.settings.autoLaunchSceneId);
        if (scene) this.launchScene(scene);
      }, 3000);
    }
  }

  // ---- 单应用快捷键 ----
  refreshAppHotkeys() {
    const commands = this.app.commands;
    // 先注销旧命令
    for (const id of Object.keys(commands.commands)) {
      if (id.startsWith(`${this.manifest.id}:launch-hotkey-`)) {
        commands.removeCommand(id);
      }
    }
    for (const app of this.settings.apps) {
      if (!app.hotkey || !app.selected) continue;
      const commandId = `launch-hotkey-${app.id}`;
      this.addCommand({
        id: commandId,
        name: `启动：${app.name}`,
        hotkeys: [this.parseHotkey(app.hotkey)].filter(Boolean),
        callback: () => this.launchApp(app)
      });
    }
  }

  // ---- 场景命令：每个场景注册一条命令面板指令 ----
  refreshSceneCommands() {
    const commands = this.app.commands;
    for (const id of Object.keys(commands.commands)) {
      if (id.startsWith(`${this.manifest.id}:launch-scene-`)) {
        commands.removeCommand(id);
      }
    }
    for (const scene of this.settings.scenes) {
      this.addCommand({
        id: `launch-scene-${scene.id}`,
        name: `启动场景：${scene.name}`,
        callback: () => this.launchScene(scene)
      });
    }
  }

  // 解析 "Mod+Shift+1" 形式为 Obsidian hotkey 对象
  parseHotkey(text) {
    const parts = String(text || "").split("+").map(p => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    const key = parts.pop();
    if (!key) return null;
    const modifiers = [];
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === "mod" || lower === "cmd" || lower === "command" || lower === "⌘") modifiers.push("Mod");
      else if (lower === "shift" || lower === "⇧") modifiers.push("Shift");
      else if (lower === "alt" || lower === "option" || lower === "opt" || lower === "⌥") modifiers.push("Alt");
      else if (lower === "ctrl" || lower === "control" || lower === "⌃") modifiers.push("Ctrl");
    }
    return { modifiers, key: key.length === 1 ? key.toUpperCase() : key };
  }

  async onunload() {
    this.scanCancelled = true;
    await this.stopAgentServer();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    if (window.MacAppLauncher) delete window.MacAppLauncher;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---- 今日天气：坐标来自设置里的城市名，留空则按网络定位识别城市 ----
  // 只向天气服务发送经纬度，不上传应用列表、使用记录或任何本地数据；结果缓存 30 分钟
  async getWeather() {
    const CACHE_MS = 30 * 60 * 1000;
    const now = Date.now();
    if (this.weatherCache && now - this.weatherCache.at < CACHE_MS) return this.weatherCache;
    if (this.weatherPromise) return this.weatherPromise;
    const fetchJson = async (url) => {
      const res = await requestUrl({ url, method: "GET", throw: false });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      return res.json || JSON.parse(res.text);
    };
    this.weatherPromise = (async () => {
      try {
        let lat;
        let lon;
        let city = "";
        const cityName = String(this.settings.weatherCity || "").trim();
        if (cityName) {
          const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=zh&format=json`);
          const hit = geo && Array.isArray(geo.results) ? geo.results[0] : null;
          if (!hit) throw new Error("城市未找到");
          lat = Number(hit.latitude);
          lon = Number(hit.longitude);
          city = String(hit.name || cityName);
        } else {
          const ip = await fetchJson("https://get.geojs.io/v1/ip/geo.json");
          lat = Number(ip.latitude);
          lon = Number(ip.longitude);
          city = String(ip.city || "");
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("定位失败");
        }
        const wx = await fetchJson(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
          `&current=temperature_2m,relative_humidity_2m,weather_code` +
          `&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`
        );
        const cur = wx.current || {};
        const daily = wx.daily || {};
        const data = {
          temp: Number(cur.temperature_2m),
          humidity: Number(cur.relative_humidity_2m),
          code: cur.weather_code,
          high: Array.isArray(daily.temperature_2m_max) ? Number(daily.temperature_2m_max[0]) : NaN,
          low: Array.isArray(daily.temperature_2m_min) ? Number(daily.temperature_2m_min[0]) : NaN,
          city,
          at: Date.now()
        };
        this.weatherCache = data;
        this.debugLog("[weather] 已更新", city, `${data.temp}°`);
        return data;
      } catch (error) {
        this.debugLog("[weather] 获取失败", String(error && error.message || error));
        return null;
      } finally {
        this.weatherPromise = null;
      }
    })();
    return this.weatherPromise;
  }

  // ---- 今日上班 / 休息：官方节假日与调休安排 ----
  async getHolidayInfo(date) {
    const year = date.getFullYear();
    const key = dateKey(date);
    const weekday = date.getDay();
    const weekend = weekday === 0 || weekday === 6;
    const fallback = () => ({
      label: weekend ? "周末 · 休息" : "工作日",
      rest: weekend,
      detail: weekend ? "周六周日按休息日显示" : "周一至周五按工作日显示"
    });
    try {
      const data = await this.loadHolidayYear(year);
      const hit = data && Array.isArray(data.days) ? data.days.find(d => d.date === key) : null;
      if (hit) {
        if (hit.isOffDay) return { label: `${hit.name} · 休息`, rest: true, detail: `${key}：${hit.name} 放假` };
        return { label: `${hit.name} · 调休上班`, rest: false, detail: `${key}：${hit.name} 调休上班` };
      }
      return fallback();
    } catch (error) {
      this.debugLog("[holiday] 获取失败", String(error && error.message || error));
      return fallback();
    }
  }

  // 年度节假日安排：优先读插件目录缓存，没有则从 holiday-cn 拉取（国务院公告整理）
  async loadHolidayYear(year) {
    if (this.holidayCache && this.holidayCache.year === year) return this.holidayCache.data;
    const dir = path.join(this.pluginDirPath(), "holidays");
    const file = path.join(dir, `${year}.json`);
    try {
      const text = await fs.promises.readFile(file, "utf8");
      const data = JSON.parse(text);
      this.holidayCache = { year, data };
      return data;
    } catch (e) { /* 无本地缓存，走网络 */ }
    // 依次尝试多个源：jsDelivr CDN 优先（国内可达），GitHub raw 作为备选
    const urls = [
      `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
      `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`
    ];
    for (const url of urls) {
      try {
        const res = await requestUrl({ url, throw: false });
        if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
        const data = JSON.parse(res.text);
        this.holidayCache = { year, data };
        try {
          await fs.promises.mkdir(dir, { recursive: true });
          await fs.promises.writeFile(file, JSON.stringify(data), "utf8");
        } catch (e) { /* 缓存写盘失败不影响使用 */ }
        return data;
      } catch (e) { /* 该源失败，换下一个 */ }
    }
    this.holidayCache = { year, data: null };
    throw new Error("节假日数据获取失败");
  }

  // ---- 置顶应用拖拽排序：把 source 插到 target 之前，写入 pinnedOrder ----
  async movePinnedApp(sourceId, targetId) {
    const apps = this.settings.apps || [];
    const pinnedApps = apps.filter(a => a.pinned).map(a => a.id);
    const order = (this.settings.pinnedOrder || []).filter(id => pinnedApps.includes(id));
    for (const id of pinnedApps) if (!order.includes(id)) order.push(id);
    const from = order.indexOf(sourceId);
    if (from < 0) return; // 只接受置顶应用作为拖拽源
    order.splice(from, 1);
    const at = order.indexOf(targetId);
    if (at < 0) return;
    order.splice(at, 0, sourceId);
    this.settings.pinnedOrder = order;
    await this.saveSettings();
  }

  // ---- 活跃月历：每次成功启动累加当天次数，只保留最近 400 天 ----
  recordLaunchDaily() {
    if (!this.settings.launchDaily || typeof this.settings.launchDaily !== "object") this.settings.launchDaily = {};
    const key = dateKey(new Date());
    this.settings.launchDaily[key] = (this.settings.launchDaily[key] || 0) + 1;
    const keys = Object.keys(this.settings.launchDaily).sort();
    if (keys.length > 400) {
      for (const old of keys.slice(0, keys.length - 400)) delete this.settings.launchDaily[old];
    }
  }

  // ---- 调试日志：写入插件目录 debug.log，超过 256KB 自动截断前半 ----
  debugLog(...args) {
    if (!this.settings || !this.settings.debugLog) return;
    try {
      const file = path.join(this.pluginDirPath(), "debug.log");
      const line = `${new Date().toISOString()} ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`;
      if (fs.existsSync(file) && fs.statSync(file).size > 262144) {
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(-131072));
      }
      fs.appendFileSync(file, line);
    } catch (e) { /* 日志写入失败不影响主流程 */ }
  }

  // ---- 配置导入导出：跨 Vault 迁移应用、场景与分类 ----
  exportConfig() {
    const {
      apps, scenes, categories, categoryRules, fileRules,
      computeCards, computeClaimRecords, computeCheckins
    } = this.settings;
    return JSON.stringify({
      version: this.manifest.version,
      apps, scenes, categories, categoryRules, fileRules,
      computeSchema: 3,
      computeCards,
      computeClaimRecords,
      // 保留旧映射仅用于兼容旧版导入器；新版本以 computeClaimRecords 为准。
      computeCheckins
    }, null, 2);
  }

  async importConfig(text) {
    let data;
    try {
      data = JSON.parse(String(text || ""));
    } catch (e) {
      return { ok: false, error: "JSON 格式无效" };
    }
    if (!data || !Array.isArray(data.apps)) return { ok: false, error: "缺少 apps 数组" };
    this.settings.apps = data.apps.map((app, index) => normalizeApp(app, index));
    if (Array.isArray(data.scenes)) {
      this.settings.scenes = data.scenes.filter(s => s && s.name).map(s => {
        const scene = {
          id: String(s.id || crypto.randomBytes(6).toString("hex")),
          name: String(s.name),
          appIds: Array.isArray(s.appIds) ? s.appIds : []
        };
        if (Array.isArray(s.steps)) scene.steps = s.steps;
        ensureSceneSteps(scene);
        return scene;
      });
    }
    if (Array.isArray(data.categories) && data.categories.length) {
      this.settings.categories = data.categories.filter(c => c && c.name).map((c, i) => ({
        name: String(c.name),
        icon: typeof c.icon === "string" ? c.icon : "📁",
        order: Number.isFinite(Number(c.order)) ? Number(c.order) : i
      }));
    }
    if (data.categoryRules && typeof data.categoryRules === "object" && !Array.isArray(data.categoryRules)) {
      this.settings.categoryRules = data.categoryRules;
    }
    if (Array.isArray(data.fileRules)) {
      this.settings.fileRules = data.fileRules.filter(r => r && r.ext && r.appId).map(r => ({
        ext: String(r.ext).replace(/^\./, "").toLowerCase(),
        appId: String(r.appId)
      }));
    }
    if (Array.isArray(data.computeCards)) {
      this.settings.computeCards = data.computeCards.map((card, index) => normalizeComputeCard(card, index));
      migrateComputeCardAppLinks(this.settings.computeCards, this.settings.apps);
    }
    const importedLegacyMap = data.computeCheckins && typeof data.computeCheckins === "object" && !Array.isArray(data.computeCheckins)
      ? data.computeCheckins
      : this.settings.computeCheckins;
    if (data.computeCheckins && typeof data.computeCheckins === "object" && !Array.isArray(data.computeCheckins)) {
      const mergedLegacyMap = { ...(this.settings.computeCheckins || {}) };
      for (const [day, ids] of Object.entries(data.computeCheckins)) {
        const existingIds = Array.isArray(mergedLegacyMap[day]) ? mergedLegacyMap[day] : [];
        mergedLegacyMap[day] = [...new Set([...existingIds, ...(Array.isArray(ids) ? ids : [])])];
      }
      this.settings.computeCheckins = mergedLegacyMap;
    }
    if (Array.isArray(data.computeClaimRecords)) {
      const importedRawRecords = data.computeClaimRecords;
      const importedRecords = importedRawRecords.map((record, index) => normalizeClaimRecord(record, index));
      this.settings.computeClaimRecords = mergeComputeClaimRecords(
        importedRecords,
        importedLegacyMap,
        this.settings.computeCards,
        importedRawRecords
      );
      this.settings.computeClaimsSchema = 2;
    } else if (data.computeCheckins && typeof data.computeCheckins === "object" && Array.isArray(data.computeCards)) {
      this.settings.computeClaimRecords = mergeComputeClaimRecords(
        [],
        importedLegacyMap,
        this.settings.computeCards,
        []
      );
      this.settings.computeClaimsSchema = 2;
    }
    this.settings.computeSchema = 3;
    this.settings.hasScanned = true;
    await this.saveSettings();
    this.refreshAppHotkeys();
    this.refreshSceneCommands();
    this.refreshViews();
    return { ok: true, apps: this.settings.apps.length, scenes: this.settings.scenes.length };
  }

  // ---- Canvas 工作流自动执行：按连线顺序执行当前画布 ----
  async executeActiveCanvas() {
    if (this.settings.canvasExecuteEnabled === false) {
      new Notice("画布自动执行已在设置中关闭");
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "canvas") {
      new Notice("请先打开一个 .canvas 画布");
      return;
    }
    let canvas;
    try {
      canvas = JSON.parse(await this.app.vault.read(file));
    } catch (e) {
      new Notice("画布文件解析失败");
      return;
    }
    const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
    const edges = Array.isArray(canvas.edges) ? canvas.edges : [];
    // 有向图 + Kahn 拓扑排序；多个起点按 x 坐标从左到右
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const indeg = new Map(nodes.map(n => [n.id, 0]));
    const adj = new Map();
    for (const e of edges) {
      if (!nodeById.has(e.fromNode) || !nodeById.has(e.toNode)) continue;
      if (!adj.has(e.fromNode)) adj.set(e.fromNode, []);
      adj.get(e.fromNode).push(e.toNode);
      indeg.set(e.toNode, indeg.get(e.toNode) + 1);
    }
    const queue = nodes.filter(n => indeg.get(n.id) === 0)
      .sort((a, b) => (a.x || 0) - (b.x || 0))
      .map(n => n.id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const next of adj.get(id) || []) {
        indeg.set(next, indeg.get(next) - 1);
        if (indeg.get(next) === 0) queue.push(next);
      }
    }
    if (order.length < nodes.length) {
      new Notice("检测到循环连线，已取消执行。请检查画布中的连线。", 6000);
      return;
    }
    // 依次执行：app-launcher 节点启动应用、file 节点打开笔记、
    // mal-step 节点执行命令/打开文件夹（场景导出的结构化步骤），装饰性节点静默忽略
    const running = await this.getRunningBundleIds();
    let launched = 0;
    let opened = 0;
    let commands = 0;
    let alreadyRunning = 0;
    const failed = [];
    const vaultBase = (this.app.vault.adapter && this.app.vault.adapter.getBasePath) ? this.app.vault.adapter.getBasePath() : "";
    for (const id of order) {
      const node = nodeById.get(id);
      if (node.type === "file" && node.file) {
        const target = this.app.vault.getAbstractFileByPath(node.file);
        if (target && target instanceof TFile) {
          await this.app.workspace.getLeaf(false).openFile(target);
          opened++;
        } else {
          failed.push(node.file);
        }
        continue;
      }
      if (node.type !== "text") continue;
      // 场景导出的结构化步骤节点：command / folder
      const stepBlock = /```mal-step\s*\n([\s\S]*?)```/.exec(node.text || "");
      if (stepBlock) {
        const type = (/^type:\s*(.+)$/m.exec(stepBlock[1]) || [])[1];
        if (type === "command") {
          const cmdId = (/^id:\s*(.+)$/m.exec(stepBlock[1]) || [])[1];
          const cmdName = ((/^name:\s*(.+)$/m.exec(stepBlock[1]) || [])[1]) || cmdId || "未知命令";
          if (cmdId && this.app.commands.commands && this.app.commands.commands[cmdId.trim()]) {
            try {
              await this.app.commands.executeCommandById(cmdId.trim());
              commands++;
            } catch (error) {
              failed.push(`命令执行失败：${cmdName}`);
            }
          } else {
            failed.push(`命令不存在：${cmdName}`);
          }
        } else if (type === "folder") {
          const folderPath = ((/^path:\s*(.+)$/m.exec(stepBlock[1]) || [])[1] || "").trim();
          if (folderPath && this.app.vault.getAbstractFileByPath(folderPath)) {
            try {
              await execFileAsync("open", [path.join(vaultBase, folderPath)]);
              opened++;
            } catch (error) {
              failed.push(`文件夹打开失败：${folderPath}`);
            }
          } else {
            failed.push(`文件夹不存在：${folderPath || "未指定"}`);
          }
        }
        continue;
      }
      const block = /```app-launcher\s*\n([\s\S]*?)```/.exec(node.text || "");
      if (!block) continue;
      const names = [...block[1].matchAll(/^app:\s*(.+)$/gm)].map(x => x[1].trim());
      for (const name of names) {
        const app = this.findAppByQuery(name);
        if (!app) { failed.push(name); continue; }
        const bundleId = await this.resolveBundleId(app);
        if (bundleId && running.has(bundleId.toLowerCase())) { alreadyRunning++; continue; }
        await this.launchApp(app, { silent: true });
        launched++;
        await new Promise(r => setTimeout(r, 500));
      }
    }
    const parts = [`启动 ${launched} 个应用`];
    if (opened) parts.push(`打开 ${opened} 个笔记/文件夹`);
    if (commands) parts.push(`执行 ${commands} 个命令`);
    if (alreadyRunning) parts.push(`${alreadyRunning} 个已在运行`);
    new Notice(`画布工作流执行完成：${parts.join("，")}`, 6000);
    if (failed.length) new Notice(`未能处理：${failed.join("、")}`, 8000);
  }

  // ---- 公开 API：供 QuickAdd 宏、Templater 脚本调用 ----
  findAppByQuery(query) {
    const apps = this.settings.apps.filter(a => a.selected);
    const q = String(query || "").trim();
    if (!q) return null;
    const lower = q.toLowerCase();
    let target = apps.find(a => a.id === q) ||
      apps.find(a => (a.name || "").toLowerCase() === lower) ||
      apps.find(a => (a.name || "").toLowerCase().includes(lower));
    if (!target) {
      const ranked = fuzzySearchApps(apps, q);
      target = ranked.length ? ranked[0].app : null;
    }
    return target;
  }

  // ---- 公开 API 事件总线：第三方插件可订阅启动事件，监听器异常不影响主流程 ----
  emitPublicEvent(name, payload) {
    const subs = this.publicEventSubs && this.publicEventSubs.get(name);
    if (!subs) return;
    for (const cb of [...subs]) {
      try { cb(payload); } catch (e) { console.warn("[Mac App Launcher] API event listener failed", e); }
    }
  }

  // 应用/场景的对外字段（不含内部状态，供第三方安全使用）
  toPublicApp(a) {
    return {
      id: a.id, name: a.name, path: a.path,
      bundleId: a.bundleId || "",
      websiteUrl: isSystemAppPath(a.path) ? "" : (a.websiteUrl || ""),
      installed: isAppBundleInstalled(a),
      webOnly: isWebOnlyApp(a),
      category: a.category || "未分类",
      pinned: !!a.pinned, custom: !!a.custom,
      launchCount: a.launchCount || 0,
      lastLaunchedAt: a.lastLaunchedAt || null
    };
  }

  registerPublicApi() {
    if (!this.publicEventSubs) this.publicEventSubs = new Map();
    window.MacAppLauncher = {
      apiVersion: 2,
      version: this.manifest.version,
      // 事件订阅："app-launched" / "scene-launched"，返回退订函数
      on: (event, cb) => {
        if (typeof cb !== "function") return () => {};
        if (!this.publicEventSubs.has(event)) this.publicEventSubs.set(event, new Set());
        this.publicEventSubs.get(event).add(cb);
        return () => { const s = this.publicEventSubs.get(event); if (s) s.delete(cb); };
      },
      off: (event, cb) => {
        const s = this.publicEventSubs.get(event);
        if (s) s.delete(cb);
      },
      // 启动应用（精确名/id → 子串 → 模糊），返回 Promise<{ok}>
      launch: name => {
        const app = this.findAppByQuery(name);
        if (!app) return Promise.resolve({ ok: false, error: `找不到应用：${name}` });
        return this.launchApp(app, { silent: true });
      },
      // 启动场景（名称或 id）
      launchScene: name => {
        const key = String(name || "");
        const scene = (this.settings.scenes || []).find(s => s.id === key) || (this.settings.scenes || []).find(s => s.name === key);
        if (!scene) return Promise.resolve({ ok: false, error: `找不到场景：${name}` });
        return this.launchScene(scene).then(() => ({ ok: true }));
      },
      // 查询：已勾选应用列表
      apps: () => this.settings.apps.filter(a => a.selected).map(a => this.toPublicApp(a)),
      // 查询：场景列表（含步骤摘要）
      scenes: () => (this.settings.scenes || []).map(s => ({
        id: s.id, name: s.name,
        stepCount: ensureSceneSteps(s).length,
        summary: sceneStepsSummary(this, s)
      })),
      // 查询：模糊搜索已勾选应用，返回前 10 条（含得分）
      search: query => fuzzySearchApps(this.settings.apps.filter(a => a.selected), String(query || ""))
        .slice(0, 10)
        .map(item => ({ ...this.toPublicApp(item.app), score: Math.round(item.score * 100) / 100 })),
      // 查询：单个应用详情，找不到返回 null
      getApp: name => {
        const app = this.findAppByQuery(name);
        return app ? this.toPublicApp(app) : null;
      },
      // 查询：应用是否正在运行
      isRunning: async name => {
        const app = this.findAppByQuery(name);
        if (!app) return { ok: false, error: `找不到应用：${name}` };
        const bundleId = await this.resolveBundleId(app);
        if (!bundleId) return { ok: true, running: false, app: app.name };
        const running = await this.getRunningBundleIds();
        return { ok: true, running: running.has(bundleId.toLowerCase()), app: app.name, bundleId };
      }
    };
  }

  async startAgentServer() {
    if (this.agentServer && this.agentServer.listening) return;
    const server = http.createServer((req, res) => {
      this.handleAgentRequest(req, res).catch(error => {
        console.error("[Mac App Launcher] Agent API request failed", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        }
        if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: "internal_error" }));
      });
    });
    this.agentServer = server;

    const listen = port => new Promise((resolve, reject) => {
      const onError = error => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });

    try {
      await listen(this.settings.agentPort || 43171);
    } catch (error) {
      if (error.code !== "EADDRINUSE") {
        this.agentServer = null;
        throw error;
      }
      // If the default port is already occupied, ask macOS for an available
      // ephemeral localhost port and expose the actual port in the UI.
      await listen(0);
    }

    const address = server.address();
    if (address && typeof address === "object") {
      this.settings.agentPort = address.port;
      await this.saveSettings();
    }
  }

  async stopAgentServer() {
    if (!this.agentServer) return;
    const server = this.agentServer;
    this.agentServer = null;
    if (server.listening) {
      await new Promise(resolve => server.close(() => resolve()));
    }
  }

  getUpdateStatusText() {
    const current = this.manifest.version || "未知";
    const latest = this.settings.latestVersion || "尚未检查";
    const last = this.settings.lastUpdateCheck
      ? new Date(this.settings.lastUpdateCheck).toLocaleString("zh-Hans-CN")
      : "尚未检查";
    return `当前版本 ${current} · 最新已知版本 ${latest} · 上次检查 ${last}`;
  }

  // 更新包下载地址：可选镜像前缀（解决国内直连 GitHub 不稳定）
  // 协议白名单：镜像必须是 https://，否则忽略并回退直连（防明文下载被中间人替换更新包）
  releaseAssetUrl(version, file) {
    const url = `https://github.com/y12589/mac-app-launcher/releases/download/${version}/${file}`;
    let mirror = (this.settings.downloadMirror || "").trim().replace(/\/+$/, "");
    if (mirror && !/^https:\/\/[^\s/]+/i.test(mirror)) {
      mirror = "";
      if (!this.mirrorWarned) {
        this.mirrorWarned = true;
        new Notice("下载镜像必须以 https:// 开头，已回退为 GitHub 直连。请在设置页修正镜像地址。", 8000);
      }
    }
    return mirror ? `${mirror}/${url}` : url;
  }

  // 网络错误（ECONNRESET/超时等）自动重试，HTTP 状态错误不重试
  async fetchWithRetry(url, tries = 3) {
    let lastError = null;
    for (let i = 0; i < tries; i++) {
      try {
        return await this.fetchBuffer(url);
      } catch (error) {
        lastError = error;
        if (/^HTTP \d+/.test(String(error && error.message))) throw error;
        if (i < tries - 1) await new Promise(resolve => setTimeout(resolve, 800 * (i + 1)));
      }
    }
    throw lastError;
  }

  fetchBuffer(url, redirects = 5) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          "User-Agent": "mac-app-launcher",
          "Accept": "application/vnd.github+json"
        }
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(this.fetchBuffer(res.headers.location, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(15000, () => req.destroy(new Error("请求超时")));
    });
  }

  compareVersions(a, b) {
    const pa = String(a || "").replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
    const pb = String(b || "").replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
  }

  async checkForUpdates({ manual = false } = {}) {
    if (this.updateInProgress) return null;
    this.updateInProgress = true;
    try {
      const buf = await this.fetchWithRetry("https://api.github.com/repos/y12589/mac-app-launcher/releases/latest");
      const release = JSON.parse(buf.toString("utf8"));
      const latest = String(release.tag_name || "").replace(/^v/, "");
      this.settings.latestVersion = latest;
      this.settings.lastUpdateCheck = new Date().toISOString();
      await this.saveSettings();
      // 当前版本必须读磁盘 manifest：Obsidian 缓存的 this.manifest 可能落后于磁盘文件，
      // 用缓存版比较会永远误判「有新版」，陷入下载→覆盖→重载→再下载的死循环
      let currentVersion = this.manifest.version;
      try {
        const diskManifest = JSON.parse(fs.readFileSync(path.join(this.getPluginDirectory(), "manifest.json"), "utf8"));
        if (diskManifest && diskManifest.version) currentVersion = String(diskManifest.version);
      } catch (e) { /* 读不到就退回缓存版本 */ }
      if (!latest || this.compareVersions(latest, currentVersion) <= 0) {
        if (manual) new Notice(`Mac App Launcher 已是最新版本（${currentVersion}）`);
        return null;
      }
      new Notice(`发现新版 ${latest}，正在自动下载并覆盖…`, 8000);
      const ok = await this.installUpdate(latest);
      return ok ? latest : null;
    } catch (error) {
      console.error("[Mac App Launcher] Update check failed", error);
      if (manual) new Notice(`检查更新失败：${error.message || error}`, 8000);
      return null;
    } finally {
      this.updateInProgress = false;
    }
  }

  async installUpdate(version) {
    const dir = this.getPluginDirectory();
    const files = ["main.js", "manifest.json", "styles.css"];
    try {
      const downloaded = {};
      for (const file of files) {
        const data = await this.fetchWithRetry(this.releaseAssetUrl(version, file));
        if (!data || !data.length) throw new Error(`下载 ${file} 为空`);
        downloaded[file] = data;
      }
      const manifest = JSON.parse(downloaded["manifest.json"].toString("utf8"));
      if (manifest.id !== this.manifest.id) throw new Error("下载的 manifest id 不匹配，已中止更新");
      if (String(manifest.version) !== String(version)) throw new Error("下载的 manifest 版本与 Release 不一致，已中止更新");
      if (this.compareVersions(manifest.version, this.manifest.version) <= 0) {
        throw new Error("下载的版本不高于当前版本，疑似回退攻击，已中止更新");
      }
      for (const file of files) {
        const target = path.join(dir, file);
        if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`);
      }
      for (const file of files) {
        fs.writeFileSync(path.join(dir, file), downloaded[file]);
      }
      new Notice(`Mac App Launcher 已更新到 ${version}，正在重载插件…`, 8000);
      await this.reloadSelf();
      return true;
    } catch (error) {
      console.error("[Mac App Launcher] Update install failed", error);
      new Notice(`自动更新失败：${error.message || error}。原文件已备份为 .bak，请检查插件目录。`, 8000);
      return false;
    }
  }

  async reloadSelf() {
    try {
      const plugins = this.app.plugins;
      if (!plugins || typeof plugins.disablePlugin !== "function" || typeof plugins.enablePlugin !== "function") {
        throw new Error("no reload api");
      }
      await plugins.disablePlugin(this.manifest.id);
      await plugins.enablePlugin(this.manifest.id);
    } catch (_) {
      new Notice("请重启 Obsidian 以加载新版本。", 8000);
    }
  }

  sendAgentJson(res, status, payload) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(JSON.stringify(payload));
  }

  isValidAgentToken(req) {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return false;
    const expected = Buffer.from(this.settings.agentTokenHash || "", "hex");
    if (!expected.length) return false;
    const provided = crypto.createHash("sha256").update(header.slice(7)).digest();
    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(provided, expected);
  }

  // 简单限速：每来源 IP 每分钟 120 次，防本机误调用打爆
  isRateLimited(req) {
    const ip = req.socket.remoteAddress || "unknown";
    const now = Date.now();
    if (!this.rateLimiter) this.rateLimiter = new Map();
    let bucket = this.rateLimiter.get(ip);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 60000 };
      this.rateLimiter.set(ip, bucket);
    }
    if (this.rateLimiter.size > 100) this.rateLimiter.clear();
    bucket.count++;
    return bucket.count > 120;
  }

  async readAgentBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", chunk => {
        body += chunk.toString("utf8");
        if (Buffer.byteLength(body, "utf8") > 8192) {
          reject(new Error("request body too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (_) {
          reject(new Error("invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  async handleAgentRequest(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const route = url.pathname;

    // Health is intentionally minimal and does not disclose app names or token data.
    if (req.method === "GET" && route === "/v1/health") {
      return this.sendAgentJson(res, 200, { ok: true, service: "mac-app-launcher" });
    }

    if (this.isRateLimited(req)) {
      return this.sendAgentJson(res, 429, { ok: false, error: "rate_limited", message: "Too many requests, please slow down." });
    }

    if (!this.isValidAgentToken(req)) {
      return this.sendAgentJson(res, 401, { ok: false, error: "unauthorized", message: "Provide a valid Bearer token." });
    }

    if (req.method === "GET" && route === "/v1/apps") {
      const category = url.searchParams.get("category");
      const query = (url.searchParams.get("q") || "").trim();
      let pool = this.settings.apps
        .filter(app => app.selected)
        .filter(app => !category || app.category === category);
      if (query) {
        pool = fuzzySearchApps(pool, query).map(item => item.app);
      }
      const apps = pool.map(app => ({
        id: app.id,
        name: app.name,
        category: app.category || "未分类",
        pinned: !!app.pinned,
        description: app.description || "",
        usage: app.usage || "",
        launchCount: app.launchCount || 0,
        lastLaunchedAt: app.lastLaunchedAt || null
      }));
      return this.sendAgentJson(res, 200, { ok: true, count: apps.length, apps });
    }

    if (req.method === "GET" && route === "/v1/categories") {
      const categories = [...new Set(
        this.settings.apps.filter(app => app.selected).map(app => app.category || "未分类")
      )].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
      return this.sendAgentJson(res, 200, { ok: true, categories });
    }

    if (req.method === "POST" && route === "/v1/launch") {
      let body;
      try {
        body = await this.readAgentBody(req);
      } catch (error) {
        return this.sendAgentJson(res, 400, { ok: false, error: "bad_request", message: error.message });
      }

      const requested = String(body.id || body.app || body.name || "").trim();
      if (!requested) {
        return this.sendAgentJson(res, 400, {
          ok: false,
          error: "missing_app",
          message: "Send JSON with {\"app\":\"Exact App Name\"} or {\"id\":\"app-id\"}."
        });
      }

      const enabledApps = this.settings.apps.filter(app => app.selected);
      let matches = enabledApps.filter(app => app.id === requested);
      if (!matches.length) {
        matches = enabledApps.filter(app => app.name.toLocaleLowerCase() === requested.toLocaleLowerCase());
      }
      // 模糊兜底：精确无果时启用模糊匹配，唯一高分才启动，否则返回候选
      if (!matches.length && body.fuzzy !== false) {
        const ranked = fuzzySearchApps(enabledApps, requested);
        if (ranked.length && ranked[0].score >= 2 && (ranked.length === 1 || ranked[0].score > ranked[1].score * 1.3)) {
          matches = [ranked[0].app];
        } else if (ranked.length && ranked[0].score >= 1) {
          return this.sendAgentJson(res, 409, {
            ok: false,
            error: "ambiguous_app",
            message: "No exact match. Fuzzy candidates returned; retry with a more precise name or an id. Send {\"fuzzy\":false} to disable fuzzy matching.",
            matches: ranked.slice(0, 5).map(item => ({ id: item.app.id, name: item.app.name, category: item.app.category, score: Math.round(item.score * 100) / 100 }))
          });
        }
      }
      if (!matches.length) {
        return this.sendAgentJson(res, 404, {
          ok: false,
          error: "app_not_available",
          message: "App not found or not enabled in the Obsidian launcher. Query GET /v1/apps for enabled apps."
        });
      }
      if (matches.length > 1) {
        return this.sendAgentJson(res, 409, {
          ok: false,
          error: "ambiguous_app",
          message: "More than one enabled app has this name. Use its app id.",
          matches: matches.map(app => ({ id: app.id, name: app.name, category: app.category }))
        });
      }

      const app = matches[0];
      const result = await this.launchApp(app, { silent: true });
      if (!result.ok) {
        return this.sendAgentJson(res, 500, { ok: false, error: "launch_failed", app: app.name, message: result.error });
      }
      return this.sendAgentJson(res, 200, {
        ok: true,
        launched: true,
        app: { id: app.id, name: app.name, category: app.category }
      });
    }

    // 批量启动：{"ids":["id1","id2"]} 或 {"names":["微信","飞书"]}（精确匹配）
    if (req.method === "POST" && route === "/v1/launch-batch") {
      let body;
      try {
        body = await this.readAgentBody(req);
      } catch (error) {
        return this.sendAgentJson(res, 400, { ok: false, error: "bad_request", message: error.message });
      }
      const requested = [
        ...(Array.isArray(body.ids) ? body.ids : []),
        ...(Array.isArray(body.names) ? body.names : []),
        ...(Array.isArray(body.apps) ? body.apps : [])
      ].map(v => String(v || "").trim()).filter(Boolean);
      if (!requested.length) {
        return this.sendAgentJson(res, 400, {
          ok: false,
          error: "missing_apps",
          message: "Send JSON with {\"ids\":[\"id1\",\"id2\"]} or {\"names\":[\"App A\",\"App B\"]}."
        });
      }
      const enabledApps = this.settings.apps.filter(app => app.selected);
      const results = [];
      for (const item of requested.slice(0, 20)) {
        const app = enabledApps.find(a => a.id === item) ||
          enabledApps.find(a => a.name.toLocaleLowerCase() === item.toLocaleLowerCase());
        if (!app) {
          results.push({ requested: item, ok: false, error: "app_not_available" });
          continue;
        }
        const launch = await this.launchApp(app, { silent: true });
        results.push(launch.ok
          ? { requested: item, ok: true, id: app.id, name: app.name }
          : { requested: item, ok: false, error: launch.error || "launch_failed", id: app.id, name: app.name });
      }
      const okCount = results.filter(r => r.ok).length;
      return this.sendAgentJson(res, 200, { ok: okCount > 0, launched: okCount, total: results.length, results });
    }

    return this.sendAgentJson(res, 404, { ok: false, error: "not_found" });
  }

  async copyAgentInstructions() {
    const baseUrl = `http://127.0.0.1:${this.settings.agentPort}`;
    const token = this.sessionAgentToken;
    if (!token) {
      new Notice("令牌仅生成当次会话可见。请先点击「重置访问令牌」生成新令牌并立即复制。", 8000);
      return;
    }
    const instructions = [
      "Mac App Launcher 本机 Agent API",
      `Base URL: ${baseUrl}`,
      `Authorization: Bearer ${token}`,
      "",
      "查询可启动应用（支持 ?q=关键词 模糊搜索、?category=分类 过滤，返回含 launchCount 使用统计）：",
      `curl -s "${baseUrl}/v1/apps" -H "Authorization: Bearer ${token}"`,
      `curl -s "${baseUrl}/v1/apps?q=weixin" -H "Authorization: Bearer ${token}"`,
      "",
      "启动一个应用（精确名称或 id；精确无果时自动模糊匹配，候选不唯一会返回 409 及候选列表）：",
      `curl -s -X POST "${baseUrl}/v1/launch" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{"app":"ChatGPT"}'`,
      "",
      "批量启动（上限 20 个，逐项返回结果）：",
      `curl -s -X POST "${baseUrl}/v1/launch-batch" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{"names":["微信","飞书"]}'`,
      "",
      "Agent 使用规则：先查询 /v1/apps；只允许从返回列表中选择应用；用户明确要求打开时调用 POST /v1/launch 或 /v1/launch-batch。不要使用任意路径或任意 shell 命令代替此接口。"
    ].join("\n");

    try {
      await navigator.clipboard.writeText(instructions);
      new Notice("Agent API 接入说明已复制");
    } catch (error) {
      console.error("[Mac App Launcher] Clipboard write failed", error);
      new Notice("复制失败，请从管理页面手动复制接口地址和访问令牌。", 6000);
    }
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view && typeof leaf.view.render === "function") leaf.view.render();
    }
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      existing[0].view.render();
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  getPluginDirectory() {
    if (this.manifest.dir) {
      return path.isAbsolute(this.manifest.dir)
        ? this.manifest.dir
        : path.resolve(this.app.vault.adapter.getBasePath(), this.manifest.dir);
    }
    return path.join(
      this.app.vault.adapter.getBasePath(),
      this.app.vault.configDir || ".obsidian",
      "plugins",
      this.manifest.id
    );
  }

  // 别名：历史代码两个名字都在用（迁移备份 / 调试日志 / 维护按钮），缺它会静默失败
  pluginDirPath() {
    return this.getPluginDirectory();
  }

  discoverAppPaths() {
    const found = new Set();
    const home = os.homedir();
    const roots = ["/Applications", "/System/Applications", path.join(home, "Applications")];

    const walk = (dir, depth) => {
      if (depth < 0 || !fs.existsSync(dir)) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name.endsWith(".app")) {
          if (!isNestedInsideAnotherApp(full)) found.add(path.resolve(full));
        } else if (entry.isDirectory() && depth > 0) {
          walk(full, depth - 1);
        }
      }
    };

    for (const root of roots) walk(root, 4);
    const finderPath = "/System/Library/CoreServices/Finder.app";
    if (fs.existsSync(path.join(finderPath, "Contents", "Info.plist"))) found.add(finderPath);

    return [...found].filter(appPath =>
      fs.existsSync(path.join(appPath, "Contents", "Info.plist"))
    ).sort();
  }

  async readAppInfo(appPath) {
    const plistPath = path.join(appPath, "Contents", "Info.plist");
    try {
      const json = await execFileAsync("/usr/bin/plutil", [
        "-convert", "json", "-o", "-", plistPath
      ], { timeout: 5000 });
      const info = JSON.parse(json);
      const name = info.CFBundleDisplayName || info.CFBundleName || path.basename(appPath, ".app");
      const bundleId = String(info.CFBundleIdentifier || "");
      let iconName = info.CFBundleIconFile || "";
      if (iconName && !iconName.toLowerCase().endsWith(".icns")) iconName += ".icns";
      let iconSource = iconName ? path.join(appPath, "Contents", "Resources", iconName) : "";
      if (!iconSource || !fs.existsSync(iconSource)) {
        try {
          const resources = path.join(appPath, "Contents", "Resources");
          const files = fs.readdirSync(resources).filter(f => f.toLowerCase().endsWith(".icns"));
          files.sort((a, b) => {
            const score = n => (/appicon|application|icon/i.test(n) ? 0 : 1);
            return score(a) - score(b) || a.length - b.length;
          });
          iconSource = files.length ? path.join(resources, files[0]) : "";
        } catch (_) { iconSource = ""; }
      }
      if (iconSource && !fs.existsSync(iconSource)) iconSource = "";
      return { name, iconSource, bundleId };
    } catch (_) {
      return { name: path.basename(appPath, ".app"), iconSource: "", bundleId: "" };
    }
  }

  async scanInstalledApps() {
    if (this.scanning) return;
    this.scanning = true;
    this.scanCancelled = false;
    this.scanProgress = 0;
    this.scanTotal = 0;
    this.scanStatus = "正在读取应用目录…";
    this.refreshViews();
    const scanStartedAt = Date.now();
    this.debugLog("开始扫描应用");
    new Notice("开始快速扫描常见 Mac 应用目录…");

    try {
      const paths = this.discoverAppPaths();
      this.scanTotal = paths.length;
      this.scanStatus = `发现 ${paths.length} 个应用包，正在读取名称和路径…`;
      this.refreshViews();

      const previous = this.settings.apps || [];
      const previousByPath = new Map(previous.map(app => [path.resolve(app.path || ""), app]));
      const previousByBundle = new Map();
      const previousByName = new Map();
      for (const app of previous) {
        const bundle = String(app.bundleId || "");
        const name = String(app.name || "").toLowerCase();
        if (bundle) {
          if (!previousByBundle.has(bundle)) previousByBundle.set(bundle, []);
          previousByBundle.get(bundle).push(app);
        }
        if (name) {
          if (!previousByName.has(name)) previousByName.set(name, []);
          previousByName.get(name).push(app);
        }
      }
      const results = [];
      let cursor = 0;
      let completed = 0;

      const worker = async () => {
        while (!this.scanCancelled) {
          const index = cursor++;
          if (index >= paths.length) return;
          const appPath = paths[index];
          const info = await this.readAppInfo(appPath);
          const byBundle = info.bundleId ? (previousByBundle.get(info.bundleId) || []) : [];
          const byName = previousByName.get(info.name.toLowerCase()) || [];
          const old = previousByPath.get(path.resolve(appPath)) ||
            (byBundle.length === 1 ? byBundle[0] : null) ||
            (byName.length === 1 ? byName[0] : null);
          const suggested = suggestedProfile(info.name, old?.category || fallbackCategory(info.name, appPath));

          results.push(normalizeApp({
            id: old?.id || appId(appPath),
            name: info.name,
            path: appPath,
            // 用户已有 bundleId 优先保留；只有旧数据缺字段/空值时才采用扫描结果。
            bundleId: old?.bundleId || info.bundleId || "",
            websiteUrl: old?.websiteUrl || "",
            webOnly: false,
            custom: !!old?.custom,
            launchMode: old?.launchMode || "smart",
            selected: old ? !!old.selected : false,
            category: old?.category || learnedCategory(info.name, this.settings.categoryRules) || fallbackCategory(info.name, appPath),
            pinned: old?.pinned || false,
            order: old?.order,
            description: old?.description || suggested.description,
            usage: old?.usage || suggested.usage,
            iconPath: old?.iconPath && fs.existsSync(old.iconPath) ? old.iconPath : "",
            iconSource: info.iconSource || old?.iconSource || "",
            customIcon: !!old?.customIcon,
            tileW: old?.tileW,
            tileH: old?.tileH,
            launchCount: old?.launchCount || 0,
            lastLaunchedAt: old?.lastLaunchedAt || null,
            // 用户绑定数据必须跨重扫保留：关联笔记、置顶顺序、快捷键
            notePath: old?.notePath || "",
            pinnedOrder: old?.pinnedOrder,
            hotkey: old?.hotkey || ""
          }, results.length));

          completed++;
          this.scanProgress = completed;
          if (completed % 8 === 0 || completed === paths.length) {
            this.scanStatus = `正在读取应用信息：${completed}/${paths.length}`;
            this.refreshViews();
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(8, Math.max(1, paths.length)) }, worker));
      if (this.scanCancelled) {
        this.scanStatus = "扫描已取消";
        new Notice("扫描已取消，未覆盖之前的应用清单。", 5000);
        return;
      }

      results.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
      // 保留手动添加的应用（扫描不到的，如 Parallels、自编译 .app）
      const resultPaths = new Set(results.map(app => path.resolve(app.path || "")));
      const matchedIds = new Set(results.map(app => app.id));
      const customApps = previous.filter(app =>
        app.custom && !matchedIds.has(app.id) && !resultPaths.has(path.resolve(app.path || ""))
      );
      this.settings.apps = [...results, ...customApps];
      this.settings.hasScanned = true;
      // 首次扫描或重扫后，尝试把旧版关键词关联升级为稳定 appId。
      migrateComputeCardAppLinks(this.settings.computeCards, this.settings.apps);
      await this.saveSettings();
      this.scanStatus = `扫描完成：发现 ${results.length} 个应用`;
      this.debugLog(`扫描完成：${results.length} 个应用，耗时 ${Date.now() - scanStartedAt}ms`);
      new Notice(`扫描完成：发现 ${results.length} 个应用。`, 7000);
      // 后台构建拼音索引（不阻塞扫描完成）
      this.buildPinyin(this.settings.apps);
    } catch (error) {
      console.error("[Mac App Launcher] Scan failed", error);
      new Notice(`扫描失败：${error.message || error}`, 8000);
    } finally {
      this.scanning = false;
      this.refreshViews();
    }
  }

  cancelScan() {
    if (!this.scanning) return;
    this.scanCancelled = true;
    this.scanStatus = "正在停止扫描…";
    this.refreshViews();
    new Notice("已请求取消扫描，请稍候。");
  }

  async setAllSelected(selected) {
    for (const app of this.settings.apps) app.selected = selected;
    await this.saveSettings();
    this.refreshViews();
    new Notice(selected ? "已全选扫描结果" : "已清空展示选择");
  }

  async togglePin(app) {
    if (!app.pinned) {
      const pinned = this.settings.apps.filter(entry => entry.pinned);
      const minPinnedOrder = pinned.length
        ? Math.min(...pinned.map(entry => Number.isFinite(Number(entry.pinnedOrder)) ? Number(entry.pinnedOrder) : 0))
        : 0;
      app.pinned = true;
      app.pinnedOrder = minPinnedOrder - 1;
    } else {
      // Keep app.order untouched so unpinning restores its previous normal position.
      app.pinned = false;
    }
    await this.saveSettings();
    new Notice(app.pinned ? `${app.name} 已直接置顶` : `${app.name} 已取消置顶`);
  }

  async moveAppToTarget(sourceId, targetId) {
    const source = this.settings.apps.find(app => app.id === sourceId);
    const target = this.settings.apps.find(app => app.id === targetId);
    if (!source || !target || source === target) return;

    const reorder = (group, keyName, fromId, toId) => {
      const from = group.findIndex(app => app.id === fromId);
      const to = group.findIndex(app => app.id === toId);
      if (from < 0 || to < 0) return;
      const [moved] = group.splice(from, 1);
      const adjustedTarget = group.findIndex(app => app.id === toId);
      group.splice(adjustedTarget, 0, moved);
      group.forEach((app, index) => { app[keyName] = index; });
    };

    if (source.pinned && target.pinned) {
      // Reorder the global top strip without changing either app's category.
      const group = this.settings.apps
        .filter(app => app.selected && app.pinned)
        .sort((a, b) => (a.pinnedOrder ?? 0) - (b.pinnedOrder ?? 0));
      reorder(group, "pinnedOrder", sourceId, targetId);
    } else if (!source.pinned && !target.pinned) {
      // Dragging within ordinary app cards also moves the app to that category.
      source.category = target.category || "未分类";
      const group = this.settings.apps
        .filter(app => app.selected && !app.pinned && app.category === source.category)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      reorder(group, "order", sourceId, targetId);
    } else if (!source.pinned && target.pinned) {
      // Dropping a normal app on a pinned app promotes it to the top strip,
      // but its original category remains unchanged.
      source.pinned = true;
      const group = this.settings.apps
        .filter(app => app.selected && app.pinned)
        .sort((a, b) => (a.pinnedOrder ?? 0) - (b.pinnedOrder ?? 0));
      reorder(group, "pinnedOrder", sourceId, targetId);
    } else {
      // Dropping a pinned app onto a regular app unpins it and adopts the
      // regular app's category.
      source.pinned = false;
      source.category = target.category || "未分类";
      const group = this.settings.apps
        .filter(app => app.selected && !app.pinned && app.category === source.category)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      reorder(group, "order", sourceId, targetId);
    }

    await this.saveSettings();
    new Notice(`已调整 ${source.name} 的位置`);
  }

  async ensureIcon(app) {
    if (app.iconPath && fs.existsSync(app.iconPath)) return;
    if (this.iconJobs.has(app.id)) return this.iconJobs.get(app.id);

    const job = (async () => {
      const iconsDir = path.join(this.getPluginDirectory(), "icons");
      fs.mkdirSync(iconsDir, { recursive: true });
      const output = path.join(iconsDir, `${app.id}.png`);

      if (app.iconSource && fs.existsSync(app.iconSource)) {
        try {
          await execFileAsync("/usr/bin/sips", [
            "-s", "format", "png", "-Z", "128", app.iconSource, "--out", output
          ], { timeout: 10000 });
          if (fs.existsSync(output)) {
            app.iconPath = output;
            await this.saveSettings();
            this.refreshViews();
            return;
          }
        } catch (error) {
          console.warn("[Mac App Launcher] sips icon conversion failed", app.name, error);
        }
      }

      const quickLookDir = path.join(iconsDir, `${app.id}-quicklook`);
      try {
        fs.mkdirSync(quickLookDir, { recursive: true });
        await execFileAsync("/usr/bin/qlmanage", [
          "-t", "-s", "128", "-o", quickLookDir, app.path
        ], { timeout: 8000 });
        const png = fs.readdirSync(quickLookDir).find(name => name.toLowerCase().endsWith(".png"));
        if (png) {
          fs.copyFileSync(path.join(quickLookDir, png), output);
          app.iconPath = output;
          await this.saveSettings();
          this.refreshViews();
        }
      } catch (error) {
        console.warn("[Mac App Launcher] Quick Look icon extraction skipped", app.name, error);
      }
    })().finally(() => {
      this.iconJobs.delete(app.id);
    });

    this.iconJobs.set(app.id, job);
    return job;
  }

  renderAppIcon(container, app) {
    container.empty();
    const cached = this.iconCache.get(app.id);
    if (cached) {
      container.createEl("img", {
        attr: { src: cached, alt: "", draggable: "false" },
        cls: "mal-native-icon"
      });
      return;
    }
    if (app.iconPath && fs.existsSync(app.iconPath)) {
      // 异步加载图标，加载完后只更新这一个容器
      this.iconCache.load(app.id, app.iconPath, fs).then(dataUrl => {
        if (dataUrl) {
          container.empty();
          container.createEl("img", {
            attr: { src: dataUrl, alt: "", draggable: "false" },
            cls: "mal-native-icon mal-icon-fade-in"
          });
        }
      });
      // 先显示占位符，避免布局跳动
      container.createEl("span", { text: "📦", cls: "mal-fallback-icon" });
      return;
    }
    container.createEl("span", { text: "📦", cls: "mal-fallback-icon" });
    if (app.selected) this.ensureIcon(app);
  }

  launchApp(app, options = {}) {
    const target = String(app?.path || "");
    const silent = !!options.silent;
    const fallbackUrl = options.fallbackUrl || (isSystemAppPath(target) ? "" : (app?.websiteUrl || ""));
    const recordWebLaunch = () => {
      if (!app) return { ok: true, mode: "web" };
      app.launchCount = (app.launchCount || 0) + 1;
      app.lastLaunchedAt = Date.now();
      this.recordLaunchDaily();
      this.saveSettings();
      this.logLaunchToDaily(app).catch(err => console.warn("[Mac App Launcher] 写入每日笔记失败", err));
      this.emitPublicEvent("app-launched", {
        id: app.id, name: app.name, category: app.category || "未分类", mode: "web"
      });
      if (!silent) new Notice(`已打开网页入口：${app.name}`);
      return { ok: true, mode: "web" };
    };
    const openWebFallback = () => {
      if (!fallbackUrl) return null;
      const opened = openExternalUrl(fallbackUrl);
      return opened ? recordWebLaunch() : null;
    };

    if (options.forceWeb) {
      const webResult = openWebFallback();
      if (webResult) return Promise.resolve(webResult);
      const message = `「${app?.name || "应用"}」没有配置有效的官方网站`;
      if (!silent) new Notice(message);
      return Promise.resolve({ ok: false, error: message });
    }

    if (!target || !isAppBundleInstalled(app)) {
      const webResult = openWebFallback();
      if (webResult) {
        if (!silent) new Notice(`本地客户端不可用，已打开 ${app?.name || "应用"} 的网页入口`);
        return Promise.resolve(webResult);
      }
      const message = `本地客户端不可用且没有网页备用入口：${app?.name || "应用"}`;
      if (!silent) new Notice(message, 7000);
      return Promise.resolve({ ok: false, error: message });
    }

    const args = String(app.name || "").toLowerCase() === "finder" ? [os.homedir()] : [target];
    return new Promise(resolve => {
      execFile("/usr/bin/open", args, error => {
        if (error) {
          console.error("[Mac App Launcher] Launch failed", app, error);
          const webResult = openWebFallback();
          if (webResult) {
            if (!silent) new Notice(`客户端启动失败，已切换到 ${app.name} 的网页入口`, 7000);
            resolve(webResult);
            return;
          }
          const message = `启动失败：${app.name}。请检查应用是否仍安装在原位置。`;
          if (!silent) new Notice(message, 7000);
          resolve({ ok: false, error: message });
        } else {
          // 仅成功启动本地客户端时计入应用启动统计；网页回退不混入客户端使用统计。
          app.launchCount = (app.launchCount || 0) + 1;
          app.lastLaunchedAt = Date.now();
          this.recordLaunchDaily();
          this.saveSettings();
          this.logLaunchToDaily(app).catch(err => console.warn("[Mac App Launcher] 写入每日笔记失败", err));
          this.emitPublicEvent("app-launched", { id: app.id, name: app.name, category: app.category || "未分类", mode: "client" });
          if (!silent) new Notice(`已请求启动：${app.name}`);
          resolve({ ok: true, mode: "client" });
        }
      });
    });
  }


  // ---- 每日笔记：记录启动日志（默认关闭）----
  async logLaunchToDaily(app) {
    if (!this.settings.logToDailyNote) return;
    const now = new Date();
    // 尊重 Daily Notes 核心插件的目录与文件名格式配置
    let folder = "";
    let format = "YYYY-MM-DD";
    try {
      const dn = this.app.internalPlugins && this.app.internalPlugins.plugins &&
        this.app.internalPlugins.plugins["daily-notes"];
      if (dn && dn.enabled && dn.instance && dn.instance.options) {
        folder = dn.instance.options.folder || "";
        format = dn.instance.options.format || "YYYY-MM-DD";
      }
    } catch (e) { /* 配置读取失败时用默认值 */ }
    const filename = window.moment ? window.moment(now).format(format) : now.toISOString().slice(0, 10);
    const notePath = `${folder ? folder + "/" : ""}${filename}.md`;
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const heading = "## 应用使用记录";
    const line = `- ${time} 启动 ${app.name}`;
    let file = this.app.vault.getAbstractFileByPath(notePath);
    if (!file || !(file instanceof TFile)) {
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }
      await this.app.vault.create(notePath, `${heading}\n\n${line}\n`);
      return;
    }
    const content = await this.app.vault.read(file);
    if (content.includes(heading)) {
      const headingEnd = content.indexOf("\n", content.indexOf(heading)) + 1;
      await this.app.vault.modify(file, content.slice(0, headingEnd) + `${line}\n` + content.slice(headingEnd));
    } else {
      await this.app.vault.modify(file, content.replace(/\s*$/, "") + `\n\n${heading}\n\n${line}\n`);
    }
  }

  // 当前活动笔记上下文：仅供编辑器/终端「打开当前库 / 当前笔记目录」操作使用。
  getActiveNoteFile() {
    const file = this.app.workspace.getActiveFile();
    if (file) {
      this.lastNoteFile = file;
      return file;
    }
    if (this.lastNoteFile && this.app.vault.getAbstractFileByPath(this.lastNoteFile.path)) {
      return this.lastNoteFile;
    }
    return null;
  }

  // ---- 文件列表右键菜单：按文件类型推荐应用打开 / 启动绑定场景 ----
  buildFileMenu(menu, file) {
    const base = this.app.vault.adapter.getBasePath();
    if (file instanceof TFolder) {
      menu.addItem(item => item
        .setTitle("在 Finder 中打开")
        .setIcon("folder-open")
        .onClick(() => {
          execFile("/usr/bin/open", [path.join(base, file.path)], err => {
            if (err) new Notice("无法在 Finder 中打开该文件夹");
          });
        }));
      return;
    }
    if (!(file instanceof TFile)) return;
    const abs = path.join(base, file.path);
    // 笔记 frontmatter 里声明的场景
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache && cache.frontmatter;
    let scenesRaw = fm ? (fm["app-scene"] || fm["app-scenes"] || fm.scene || []) : [];
    if (typeof scenesRaw === "string") scenesRaw = [scenesRaw];
    if (!Array.isArray(scenesRaw)) scenesRaw = [];
    const scenes = scenesRaw
      .map(name => this.settings.scenes.find(s => s.name === String(name)))
      .filter(Boolean);
    if (scenes.length) menu.addSeparator();
    for (const scene of scenes) {
      menu.addItem(item => item
        .setTitle(`启动场景：${scene.name}`)
        .setIcon("play")
        .onClick(() => this.launchScene(scene)));
    }
    // 自定义文件关联规则优先于内置分类推荐
    const ext = (file.extension || "").toLowerCase();
    const customRule = (this.settings.fileRules || []).find(r => r.ext === ext);
    const customApp = customRule
      ? this.settings.apps.find(a => a.id === customRule.appId && a.selected && a.path)
      : null;
    if (customApp) {
      menu.addSeparator();
      menu.addItem(item => item
        .setTitle(`用 ${customApp.name} 打开（自定义规则）`)
        .setIcon("star")
        .onClick(() => {
          execFile("/usr/bin/open", ["-a", customApp.path, abs], err => {
            if (err) new Notice(`无法用 ${customApp.name} 打开该文件`);
            else new Notice(`已用 ${customApp.name} 打开`);
          });
        }));
    }
    // 按扩展名推荐应用
    const rule = EXT_CATEGORY_RULES.find(r => r.exts.includes(ext));
    if (!rule) return;
    const candidates = this.settings.apps
      .filter(a => a.selected && a.path && rule.cats.includes(a.category) && (!customApp || a.id !== customApp.id))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.launchCount || 0) - (a.launchCount || 0))
      .slice(0, 3);
    if (!candidates.length) return;
    menu.addSeparator();
    for (const app of candidates) {
      menu.addItem(item => item
        .setTitle(`用 ${app.name} 打开`)
        .setIcon("external-link")
        .onClick(() => {
          execFile("/usr/bin/open", ["-a", app.path, abs], err => {
            if (err) new Notice(`无法用 ${app.name} 打开该文件`);
            else new Notice(`已用 ${app.name} 打开`);
          });
        }));
    }
  }

  // ---- Markdown 启动卡片：```app-launcher 代码块 ----
  renderLauncherBlock(source, el) {
    el.empty();
    el.addClass("mal-md-block");
    const queries = [];
    let note = "";
    for (const raw of String(source || "").split(/\r?\n/)) {
      const m = raw.match(/^\s*([^:：\s]+)\s*[:：]\s*(.+?)\s*$/);
      if (!m) {
        // 无 key 的裸行按应用名处理
        if (raw.trim() && !queries.length && !note) queries.push(raw.trim());
        continue;
      }
      const key = m[1].toLowerCase();
      if (key === "app" || key === "应用") queries.push(m[2]);
      else if (key === "note" || key === "说明") note = m[2];
    }
    if (!queries.length) {
      el.createDiv({ text: "用法：在 app-launcher 代码块中写「app: 应用名称」", cls: "mal-md-empty" });
      return;
    }
    const apps = this.settings.apps.filter(a => a.selected);
    for (const query of queries) {
      const q = query.toLowerCase();
      let target = apps.find(a => a.id === query) ||
        apps.find(a => (a.name || "").toLowerCase() === q) ||
        apps.find(a => (a.name || "").toLowerCase().includes(q));
      if (!target) {
        const ranked = fuzzySearchApps(apps, query);
        target = ranked.length ? ranked[0].app : null;
      }
      if (!target) {
        el.createDiv({ text: `找不到应用「${query}」，请确认已在应用中心勾选`, cls: "mal-md-empty" });
        continue;
      }
      const card = el.createDiv({ cls: "mal-md-card" });
      const icon = card.createDiv({ cls: "mal-md-icon" });
      this.renderAppIcon(icon, target);
      const info = card.createDiv({ cls: "mal-md-info" });
      info.createDiv({ text: target.name, cls: "mal-md-name" });
      const desc = note || target.description || target.usage || target.category || "";
      if (desc) info.createDiv({ text: desc, cls: "mal-md-desc" });
      const btn = card.createEl("button", { text: "打开", cls: "mal-md-open" });
      btn.addEventListener("click", () => this.launchApp(target));
    }
  }

  // ---- 启动参数白名单：仅允许把目录路径交给编辑器 / 终端类应用 ----
  isEditorApp(app) {
    const s = `${app.name} ${app.path}`.toLowerCase();
    return /visual studio code|vscode|cursor|trae|qoder|xcode|webstorm|pycharm|intellij|goland|rider|sublime|zed|nova|textmate|bbedit|typora/.test(s);
  }

  isTerminalApp(app) {
    const s = `${app.name} ${app.path}`.toLowerCase();
    return /terminal|iterm|warp|kitty|alacritty|wezterm|hyper|终端/.test(s);
  }

  // 只允许传目录路径，拒绝文件与可疑参数
  openPathWithApp(app, dirPath) {
    if (!app || !app.path || !dirPath) return;
    const resolved = path.resolve(dirPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      new Notice("目标目录不存在");
      return;
    }
    execFile("/usr/bin/open", ["-a", app.path, resolved], err => {
      if (err) new Notice(`无法用 ${app.name} 打开目录`);
      else new Notice(`已用 ${app.name} 打开目录`);
    });
  }

  // 在 Finder 中显示应用
  revealInFinder(app) {
    if (!app.path) return;
    execFile("/usr/bin/open", ["-R", app.path], error => {
      if (error) new Notice(`无法在 Finder 中显示：${app.name}`);
    });
  }

  // 移除手动添加的应用。福利卡片保留原 appId，待应用重新添加/扫描后可恢复关联。
  async removeCustomApp(app) {
    if (!app.custom) return false;
    for (const card of this.settings.computeCards || []) {
      if (String(card.appId || "") !== String(app.id || "")) continue;
      // 仅复制应用原本已有的官网，不猜测 URL；appId 保留，便于日后恢复关联。
      if (!card.url && app.websiteUrl && !isSystemAppPath(app.path)) card.url = app.websiteUrl;
    }
    this.settings.apps = this.settings.apps.filter(item => item.id !== app.id);
    await this.saveSettings();
    this.refreshViews();
    return true;
  }

  // 用 macOS 原生选择面板挑 .app，选完直接拿到路径（取消时返回空串）
  async pickAppBundle() {
    try {
      const out = await execFileAsync("osascript", [
        "-e", 'choose file with prompt "选择要添加的应用（.app）" of type {"com.apple.application-bundle"}',
        "-e", "return POSIX path of result"
      ]);
      return String(out || "").trim();
    } catch (error) {
      const text = `${(error && error.stderr) || ""}${(error && error.message) || ""}`;
      if (text.includes("-128")) return "";
      throw error;
    }
  }

  // 用 macOS 原生面板挑图标图片（PNG / JPG / ICNS 等）
  async pickImageFile() {
    try {
      const out = await execFileAsync("osascript", [
        "-e", 'choose file with prompt "选择图标图片（PNG / JPG / ICNS）" of type {"public.image"}',
        "-e", "return POSIX path of result"
      ]);
      return String(out || "").trim();
    } catch (error) {
      const text = `${(error && error.stderr) || ""}${(error && error.message) || ""}`;
      if (text.includes("-128")) return "";
      throw error;
    }
  }

  // 编辑图标：把用户选的图片转成 256px PNG，存进插件 icons 目录并指向它
  async pickAppIcon(app) {
    let picked = "";
    try {
      picked = await this.pickImageFile();
    } catch (error) {
      new Notice("无法打开图片选择器，请重试");
      return false;
    }
    if (!picked) return false;
    if (!fs.existsSync(picked)) {
      new Notice("找不到该图片文件");
      return false;
    }
    try {
      const iconsDir = path.join(this.getPluginDirectory(), "icons");
      fs.mkdirSync(iconsDir, { recursive: true });
      const output = path.join(iconsDir, `custom-${app.id}.png`);
      await execFileAsync("/usr/bin/sips", [
        "-s", "format", "png", "-Z", "256", picked, "--out", output
      ], { timeout: 15000 });
      if (!fs.existsSync(output)) throw new Error("icon conversion failed");
      app.iconPath = output;
      app.customIcon = true;
      this.iconCache.invalidate(app.id);
      await this.saveSettings();
      this.refreshViews();
      new Notice(`已更新 ${app.name} 的图标`);
      return true;
    } catch (error) {
      console.warn("[Mac App Launcher] custom icon failed", app.name, error);
      new Notice("图标转换失败，请换一张 PNG / JPG 图片");
      return false;
    }
  }

  // 恢复默认图标：清掉自定义路径，按系统图标重新提取
  async resetAppIcon(app) {
    app.customIcon = false;
    app.iconPath = "";
    this.iconCache.invalidate(app.id);
    await this.saveSettings();
    await this.ensureIcon(app);
    this.refreshViews();
    new Notice(`已恢复 ${app.name} 的默认图标`);
  }

  // 手动添加应用：支持任意路径的 .app（Parallels、自编译等扫描不到的应用）
  async addCustomApp(appPath, category) {
    const trimmed = (appPath || "").trim();
    if (!trimmed) return { ok: false, error: "请输入应用路径" };
    const resolved = path.resolve(trimmed.replace(/^~(?=\/|$)/, os.homedir()));
    if (!resolved.toLowerCase().endsWith(".app")) {
      return { ok: false, error: "路径必须以 .app 结尾" };
    }
    if (!fs.existsSync(path.join(resolved, "Contents", "Info.plist"))) {
      return { ok: false, error: "该路径下找不到有效的应用包" };
    }
    if (this.settings.apps.some(app => path.resolve(app.path || "") === resolved)) {
      return { ok: false, error: "该应用已在列表中" };
    }
    const info = await this.readAppInfo(resolved);
    const app = normalizeApp({
      id: appId(resolved),
      name: info.name,
      path: resolved,
      bundleId: info.bundleId || "",
      websiteUrl: "",
      webOnly: false,
      launchMode: "smart",
      selected: true,
      category: (category || "").trim() || learnedCategory(info.name, this.settings.categoryRules) || fallbackCategory(info.name, resolved),
      pinned: false,
      custom: true,
      description: "",
      usage: "",
      iconPath: "",
      iconSource: info.iconSource || "",
      launchCount: 0,
      lastLaunchedAt: null
    }, this.settings.apps.length);
    this.settings.apps.push(app);
    migrateComputeCardAppLinks(this.settings.computeCards, this.settings.apps);
    await this.saveSettings();
    this.refreshViews();
    this.buildPinyin([app]);
    return { ok: true, app };
  }

  // 添加网页应用：作为统一应用资源的一等记录，可被首页和多张福利卡片共享。
  async addWebApp(name, websiteUrl, category) {
    const appName = String(name || "").trim();
    if (!appName) return { ok: false, error: "请输入应用名称" };
    const safeUrl = normalizeExternalHttpUrl(websiteUrl);
    if (!safeUrl) return { ok: false, error: "官方网站必须是有效的 http:// 或 https:// 地址" };

    const existing = this.settings.apps.find(app =>
      String(app.name || "").trim().toLowerCase() === appName.toLowerCase()
    );
    if (existing && isSystemAppPath(existing.path)) {
      return { ok: false, error: `「${existing.name}」是 macOS 系统应用，不能配置为网页应用或添加官方网站入口。` };
    }
    if (existing) {
      const currentUrl = normalizeExternalHttpUrl(existing.websiteUrl || "");
      if (currentUrl && currentUrl !== safeUrl) {
        return { ok: false, error: `应用「${existing.name}」已存在且配置了不同的网站入口。请使用不同名称添加，或在应用详情中编辑官方网站。` };
      }
      existing.websiteUrl = safeUrl;
      if (!existing.category || existing.category === "未分类") {
        existing.category = String(category || "").trim() || "其他";
      }
      this.ensureCategoryEntry(existing.category);
      migrateComputeCardAppLinks(this.settings.computeCards, this.settings.apps);
      await this.saveSettings();
      this.refreshViews();
      return { ok: true, app: existing, updated: true };
    }

    const app = normalizeApp({
      id: `web-${crypto.randomBytes(8).toString("hex")}`,
      name: appName,
      path: "",
      bundleId: "",
      websiteUrl: safeUrl,
      webOnly: true,
      launchMode: "smart",
      selected: true,
      category: String(category || "").trim() || "其他",
      pinned: false,
      custom: true,
      description: "",
      usage: "",
      iconPath: "",
      iconSource: "",
      launchCount: 0,
      lastLaunchedAt: null
    }, this.settings.apps.length);
    this.settings.apps.push(app);
    this.ensureCategoryEntry(app.category);
    migrateComputeCardAppLinks(this.settings.computeCards, this.settings.apps);
    await this.saveSettings();
    this.refreshViews();
    this.buildPinyin([app]);
    return { ok: true, app, updated: false };
  }

  // ---- 首页自由布局 ----
  getHomeLayout() {
    if (!Array.isArray(this.settings.homeLayout)) this.settings.homeLayout = [];
    return this.settings.homeLayout;
  }

  // 把模块拖到目标模块之前（beforeId 为空则排到末尾）
  async moveHomeModule(id, beforeId) {
    const items = this.getHomeLayout();
    const from = items.findIndex(item => item.id === id);
    if (from < 0 || id === beforeId) return false;
    const [item] = items.splice(from, 1);
    const to = beforeId ? items.findIndex(entry => entry.id === beforeId) : -1;
    if (to >= 0) items.splice(to, 0, item);
    else items.push(item);
    await this.saveSettings();
    return true;
  }

  async resetHomeLayout() {
    this.settings.homeLayout = [];
    await this.saveSettings();
    this.refreshViews();
  }

  // ---- 分类管理 ----
  getCategories() {
    const cats = [...(this.settings.categories || [])].sort((a, b) => a.order - b.order);
    if (!cats.some(c => c.name === "未分类")) {
      cats.push({ name: "未分类", icon: "❓", order: cats.length });
    }
    return cats;
  }

  categoryIcon(name) {
    const found = (this.settings.categories || []).find(c => c.name === name);
    return found ? found.icon : "";
  }

  async addCategory(name, icon) {
    const trimmed = (name || "").trim();
    if (!trimmed) return { ok: false, error: "请输入分类名称" };
    if (this.settings.categories.some(c => c.name === trimmed)) {
      return { ok: false, error: "分类已存在" };
    }
    const maxOrder = Math.max(-1, ...this.settings.categories.map(c => c.order));
    this.settings.categories.push({ name: trimmed, icon: (icon || "").trim() || "📁", order: maxOrder + 1 });
    await this.saveSettings();
    this.refreshViews();
    return { ok: true };
  }

  async renameCategory(oldName, newName, icon) {
    const trimmed = (newName || "").trim();
    if (!trimmed) return { ok: false, error: "名称不能为空" };
    const cat = this.settings.categories.find(c => c.name === oldName);
    if (!cat) return { ok: false, error: "分类不存在" };
    if (trimmed !== oldName && this.settings.categories.some(c => c.name === trimmed)) {
      return { ok: false, error: "新名称已被占用" };
    }
    cat.name = trimmed;
    if (typeof icon === "string" && icon.trim()) cat.icon = icon.trim();
    if (trimmed !== oldName) {
      for (const app of this.settings.apps) {
        if (app.category === oldName) app.category = trimmed;
      }
      for (const key of Object.keys(this.settings.categoryRules || {})) {
        if (this.settings.categoryRules[key] === oldName) this.settings.categoryRules[key] = trimmed;
      }
    }
    await this.saveSettings();
    this.refreshViews();
    return { ok: true };
  }

  async removeCategory(name) {
    if (name === "未分类") return { ok: false, error: "「未分类」不能删除" };
    this.settings.categories = this.settings.categories.filter(c => c.name !== name);
    for (const app of this.settings.apps) {
      if (app.category === name) app.category = "未分类";
    }
    for (const key of Object.keys(this.settings.categoryRules || {})) {
      if (this.settings.categoryRules[key] === name) delete this.settings.categoryRules[key];
    }
    await this.saveSettings();
    this.refreshViews();
    return { ok: true };
  }

  // 补登「应用在用在、但分类表里没有」的分类，排序与管理面板才能识别它
  ensureCategoryEntry(name, icon = "📁") {
    const trimmed = (name || "").trim();
    if (!trimmed || trimmed === "未分类") return;
    if (this.settings.categories.some(c => c.name === trimmed)) return;
    const maxOrder = Math.max(-1, ...this.settings.categories.map(c => Number(c.order) || 0));
    this.settings.categories.push({ name: trimmed, icon, order: maxOrder + 1 });
  }

  // 分类拖拽排序：把 name 插到 beforeName 前面（beforeName 为 null 时排到末尾），重排 order 后持久化
  async reorderCategory(name, beforeName) {
    this.ensureCategoryEntry(name);
    if (beforeName) this.ensureCategoryEntry(beforeName);
    const cats = [...this.settings.categories].sort((a, b) => a.order - b.order);
    const from = cats.findIndex(c => c.name === name);
    if (from < 0) return;
    const [moved] = cats.splice(from, 1);
    const insertAt = beforeName ? cats.findIndex(c => c.name === beforeName) : cats.length;
    if (insertAt < 0) return;
    cats.splice(insertAt, 0, moved);
    cats.forEach((c, i) => { c.order = i; });
    this.settings.categories = cats;
    await this.saveSettings();
    this.refreshViews();
  }

  async moveCategory(name, dir) {
    const cats = [...this.settings.categories].sort((a, b) => a.order - b.order);
    const index = cats.findIndex(c => c.name === name);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= cats.length) return;
    const tmp = cats[index].order;
    cats[index].order = cats[target].order;
    cats[target].order = tmp;
    await this.saveSettings();
    this.refreshViews();
  }

  // 归类学习：用户手动改分类时记录应用名 → 分类
  learnCategory(app) {
    if (!app.name || !app.category || app.category === "未分类") return;
    this.settings.categoryRules = this.settings.categoryRules || {};
    this.settings.categoryRules[String(app.name).toLowerCase()] = app.category;
  }

  // ---- 场景模式：一键启动一组应用 ----
  async addScene(name, appIds) {
    const trimmed = (name || "").trim();
    if (!trimmed) return { ok: false, error: "请输入场景名称" };
    if (!appIds || !appIds.length) return { ok: false, error: "请先勾选要加入场景的应用" };
    if (this.settings.scenes.some(s => s.name === trimmed)) return { ok: false, error: "场景已存在" };
    this.settings.scenes.push({
      id: crypto.randomBytes(6).toString("hex"),
      name: trimmed,
      appIds: [...appIds],
      steps: appIds.map(id => ({ type: "app", id: String(id) }))
    });
    await this.saveSettings();
    this.refreshSceneCommands();
    this.refreshViews();
    return { ok: true };
  }

  async removeScene(id) {
    this.settings.scenes = this.settings.scenes.filter(s => s.id !== id);
    if (this.settings.autoLaunchSceneId === id) this.settings.autoLaunchSceneId = "";
    await this.saveSettings();
    this.refreshSceneCommands();
    this.refreshViews();
  }

  // 按步骤列表执行场景：应用错峰启动（已运行跳过）、笔记/文件夹直接打开、
  // Obsidian 命令先检查存在再执行（白名单：只能是用户亲手挑进场景的命令 id）
  async launchScene(scene) {
    const steps = ensureSceneSteps(scene);
    if (!steps.length) {
      new Notice(`场景「${scene.name}」里没有步骤，点「步骤」按钮添加`);
      return;
    }
    this.debugLog(`启动场景「${scene.name}」，共 ${steps.length} 步`);
    const hasAppStep = steps.some(s => s.type === "app");
    const running = hasAppStep ? await this.getRunningBundleIds() : new Set();
    let launched = 0, opened = 0, commands = 0, skippedRunning = 0;
    const failed = [];
    const vaultBase = () => (this.app.vault.adapter && this.app.vault.adapter.getBasePath) ? this.app.vault.adapter.getBasePath() : "";
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.type === "app") {
        const app = this.settings.apps.find(a => a.id === step.id);
        if (!app) { failed.push("应用已移除"); continue; }
        const bundleId = await this.resolveBundleId(app);
        if (bundleId && running.has(bundleId.toLowerCase())) { skippedRunning++; continue; }
        await this.launchApp(app, { silent: true });
        launched++;
        // 错峰启动，避免同时拉起多个应用造成卡顿
        if (steps.slice(i + 1).some(s => s.type === "app")) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } else if (step.type === "note") {
        const file = this.app.vault.getAbstractFileByPath(step.path);
        if (file instanceof TFile) {
          await this.app.workspace.getLeaf(false).openFile(file);
          opened++;
        } else {
          failed.push(`笔记不存在：${step.path}`);
        }
      } else if (step.type === "folder") {
        const folder = this.app.vault.getAbstractFileByPath(step.path);
        if (folder) {
          try {
            await execFileAsync("open", [path.join(vaultBase(), step.path)]);
            opened++;
          } catch (error) {
            failed.push(`文件夹打开失败：${step.path}`);
          }
        } else {
          failed.push(`文件夹不存在：${step.path}`);
        }
      } else if (step.type === "command") {
        const registered = this.app.commands.commands && this.app.commands.commands[step.id];
        if (!registered) {
          failed.push(`命令不存在：${step.name || step.id}`);
          continue;
        }
        try {
          await this.app.commands.executeCommandById(step.id);
          commands++;
        } catch (error) {
          failed.push(`命令执行失败：${step.name || step.id}`);
        }
      }
    }
    const parts = [];
    if (launched) parts.push(`启动 ${launched} 个应用`);
    if (opened) parts.push(`打开 ${opened} 个笔记/文件夹`);
    if (commands) parts.push(`执行 ${commands} 个命令`);
    if (skippedRunning) parts.push(`跳过 ${skippedRunning} 个已在运行`);
    let message = parts.length ? `场景「${scene.name}」：${parts.join("，")}` : `场景「${scene.name}」没有可执行的步骤`;
    if (failed.length) message += `；未完成：${failed.join("、")}`;
    this.debugLog(`场景「${scene.name}」执行结束：${parts.join("，") || "无可执行步骤"}${failed.length ? `；未完成 ${failed.length} 项` : ""}`);
    this.emitPublicEvent("scene-launched", { id: scene.id, name: scene.name, launched, opened, commands, skippedRunning, failed: failed.length });
    new Notice(message, 7000);
  }

  // 当前正在运行的应用 bundle ID 集合（小写）；查询失败时返回空集，退化为全部启动
  async getRunningBundleIds() {
    try {
      const out = await execFileAsync("osascript", [
        "-e", 'tell application "System Events" to get bundle identifier of every process whose background only is false'
      ]);
      return new Set(String(out || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
    } catch (error) {
      return new Set();
    }
  }

  // ---- Canvas 工作流：把场景导出为可点击启动的画布 ----
  async exportSceneCanvas(scene) {
    const steps = ensureSceneSteps(scene);
    if (!steps.length) {
      new Notice(`场景「${scene.name}」里没有步骤`);
      return;
    }
    const nodes = [{
      id: "scene-title",
      type: "text",
      text: `# 🎬 ${scene.name}\n${sceneStepsSummary(this, scene)}，应用节点可点击启动`,
      x: 0, y: -170, width: 420, height: 130
    }];
    const nodeIds = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const nodeId = `step-${i}`;
      if (step.type === "app") {
        const app = this.settings.apps.find(a => a.id === step.id);
        if (!app) continue;
        nodes.push({
          id: nodeId,
          type: "text",
          text: `\`\`\`app-launcher\napp: ${app.name}\n\`\`\``,
          x: nodeIds.length * 300, y: 0, width: 250, height: 190
        });
      } else if (step.type === "note") {
        nodes.push({ id: nodeId, type: "file", file: step.path, x: nodeIds.length * 300, y: 0, width: 300, height: 190 });
      } else if (step.type === "folder") {
        nodes.push({
          id: nodeId,
          type: "text",
          text: `📁 **打开文件夹**\n${step.path}\n\`\`\`mal-step\ntype: folder\npath: ${step.path}\n\`\`\``,
          x: nodeIds.length * 300, y: 0, width: 250, height: 190
        });
      } else if (step.type === "command") {
        nodes.push({
          id: nodeId,
          type: "text",
          text: `⌘ **执行命令**\n${step.name || step.id}\n\`\`\`mal-step\ntype: command\nid: ${step.id}\nname: ${step.name || step.id}\n\`\`\``,
          x: nodeIds.length * 300, y: 0, width: 250, height: 190
        });
      } else {
        continue;
      }
      nodeIds.push(nodeId);
    }
    const edges = [];
    for (let i = 0; i < nodeIds.length - 1; i++) {
      edges.push({
        id: `edge-${i}`,
        fromNode: nodeIds[i], fromSide: "right",
        toNode: nodeIds[i + 1], toSide: "left"
      });
    }
    const folder = "工作流";
    const name = String(scene.name).replace(/[\\/:*?"<>|]/g, "-");
    const filePath = `${folder}/${name}.canvas`;
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    let file = existing;
    const content = JSON.stringify({ nodes, edges }, null, 2);
    if (existing && existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      file = await this.app.vault.create(filePath, content);
    }
    new Notice(`已生成工作流画布：${name}.canvas`);
    await this.app.workspace.getLeaf(false).openFile(file);
    return file;
  }

  // 读取应用的 CFBundleIdentifier（结果缓存在 app.bundleId，避免重复读 plist）
  async resolveBundleId(app) {
    if (app.bundleId) return app.bundleId;
    try {
      const out = await execFileAsync("defaults", ["read", path.join(app.path, "Contents", "Info"), "CFBundleIdentifier"]);
      app.bundleId = String(out || "").trim();
    } catch (error) {
      app.bundleId = "";
    }
    return app.bundleId;
  }

  // 关闭场景：按 bundle ID 发送 macOS 原生退出指令（不受应用显示名语言影响），
  // 有未保存内容时应用会自行弹窗询问
  async closeScene(scene) {
    // 只对有 app 步骤的场景生效，笔记/文件夹/命令步骤没有「关闭」语义
    const apps = ensureSceneSteps(scene)
      .filter(s => s.type === "app")
      .map(s => this.settings.apps.find(a => a.id === s.id))
      .filter(Boolean);
    if (!apps.length) {
      new Notice(`场景「${scene.name}」里没有应用步骤`);
      return;
    }
    let closed = 0;
    let resolved = false;
    for (let i = 0; i < apps.length; i++) {
      try {
        const before = apps[i].bundleId;
        const bundleId = await this.resolveBundleId(apps[i]);
        if (bundleId && bundleId !== before) resolved = true;
        if (!bundleId) continue;
        await execFileAsync("osascript", ["-e", `tell application id "${bundleId}" to quit`]);
        closed++;
      } catch (error) {
        // 应用未运行或拒绝退出，跳过
      }
      if (i < apps.length - 1) await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (resolved) await this.saveSettings(); // 缓存新读到的 bundleId
    new Notice(`场景「${scene.name}」已退出 ${closed}/${apps.length} 个应用（未保存内容会弹窗询问）`, 6000);
  }

  // ---- 拼音搜索 ----
  async ensurePinyinHelper() {
    if (this.cachedPinyinHelper && fs.existsSync(this.cachedPinyinHelper)) {
      return this.cachedPinyinHelper;
    }
    const pluginDir = path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir);
    const bin = path.join(pluginDir, "pinyin-helper");
    if (fs.existsSync(bin)) {
      this.cachedPinyinHelper = bin;
      return bin;
    }
    const src = path.join(pluginDir, "pinyin-helper.swift");
    if (!fs.existsSync(src)) fs.writeFileSync(src, PINYIN_SWIFT_SOURCE);
    new Notice("首次使用拼音搜索，正在编译转换组件（约几秒钟）…");
    await execFileAsync("swiftc", [src, "-o", bin, "-O"]);
    this.cachedPinyinHelper = bin;
    return bin;
  }

  async buildPinyin(apps) {
    const need = (apps || this.settings.apps).filter(a => !a.pinyinAbbr && /[\u4e00-\u9fff]/.test(a.name || ""));
    if (!need.length) return;
    try {
      const helper = await this.ensurePinyinHelper();
      const names = need.map(a => a.name);
      const stdout = await new Promise((resolve, reject) => {
        const child = spawn(helper, []);
        let out = "";
        let err = "";
        child.stdout.on("data", d => { out += d; });
        child.stderr.on("data", d => { err += d; });
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`)));
        child.stdin.write(JSON.stringify(names));
        child.stdin.end();
      });
      const converted = JSON.parse(stdout);
      let changed = false;
      need.forEach((app, i) => {
        const spaced = String(converted[i] || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim();
        const words = spaced.split(/\s+/).filter(Boolean);
        if (!words.length) return;
        app.pinyinFull = words.join("");
        app.pinyinAbbr = words.map(w => w[0]).join("");
        changed = true;
      });
      if (changed) await this.saveSettings();
    } catch (error) {
      console.warn("[mac-app-launcher] pinyin build failed:", error && error.message || error);
    }
  }
};
