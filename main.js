const { Plugin, ItemView, Notice, PluginSettingTab, Setting, Menu, Modal } = require("obsidian");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const VIEW_TYPE = "mac-app-launcher-view";

// 关于页内置更新日志（发版时同步精简版，完整版见 GitHub CHANGELOG）
const ABOUT_CHANGELOG = [
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
    iconSource: app.iconSource || ""
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
  async onClose() {}

  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("mal-view");

    const header = root.createDiv({ cls: "mal-header" });
    const titleWrap = header.createDiv({ cls: "mal-title-wrap" });
    titleWrap.createEl("h2", {
      text: this.mode === "manage" ? "管理应用" : "应用中心",
      cls: "mal-title"
    });
    titleWrap.createEl("div", {
      text: this.mode === "manage"
        ? "勾选需要展示的软件，设置分类和应用介绍"
        : "点击应用卡片查看用途，再通过启动按钮打开软件；拖动卡片可调整顺序",
      cls: "mal-subtitle"
    });

    const controls = header.createDiv({ cls: "mal-controls" });
    const search = controls.createEl("input", {
      attr: { type: "search", placeholder: this.mode === "manage" ? "搜索扫描结果…" : "搜索已选应用…" },
      cls: "mal-search"
    });
    search.value = this.searchTerm;

    const scan = controls.createEl("button", {
      text: this.plugin.scanning ? "取消扫描" : "重新扫描",
      cls: "mal-button"
    });
    scan.addEventListener("click", () => {
      if (this.plugin.scanning) this.plugin.cancelScan();
      else this.plugin.scanInstalledApps();
    });

    if (this.mode === "manage") {
      const all = controls.createEl("button", { text: "全选", cls: "mal-button" });
      all.addEventListener("click", () => this.plugin.setAllSelected(true));
      const none = controls.createEl("button", { text: "清空", cls: "mal-button" });
      none.addEventListener("click", () => this.plugin.setAllSelected(false));
      const done = controls.createEl("button", { text: "完成", cls: "mal-primary" });
      done.addEventListener("click", () => {
        this.mode = "home";
        this.searchTerm = "";
        this.render();
      });
    } else {
      const toggleView = controls.createEl("button", {
        text: this.plugin.settings.viewMode === "list" ? "▦ 网格" : "☰ 列表",
        cls: "mal-button",
        attr: { title: "切换网格 / 列表视图" }
      });
      toggleView.addEventListener("click", async () => {
        this.plugin.settings.viewMode = this.plugin.settings.viewMode === "list" ? "grid" : "list";
        await this.plugin.saveSettings();
        this.render();
      });
      const manage = controls.createEl("button", { text: "管理应用", cls: "mal-primary" });
      manage.addEventListener("click", () => {
        this.mode = "manage";
        this.searchTerm = "";
        this.render();
      });
    }

    const body = root.createDiv({ cls: "mal-body" });
    this.bodyEl = body;
    search.addEventListener("input", () => {
      this.debouncedSearch(search.value);
    });
    this.renderBody(body);
  }

  renderBody(body) {
    body.empty();
    const term = this.searchTerm.trim().toLocaleLowerCase();
    if (this.mode === "manage") this.renderManager(body, term);
    else this.renderHome(body, term);
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
    const selected = this.plugin.settings.apps.filter(app => app.selected);
    if (!this.plugin.settings.hasScanned && !selected.length) {
      const empty = body.createDiv({ cls: "mal-empty-panel" });
      empty.createEl("div", { text: "⌕", cls: "mal-empty-icon" });
      empty.createEl("h3", { text: "先扫描你的 Mac 应用" });
      empty.createEl("p", { text: "扫描后，你可以自己选择要展示的软件，并设置分类。" });
      const btn = empty.createEl("button", { text: "扫描本机应用", cls: "mal-primary" });
      btn.addEventListener("click", () => this.plugin.scanInstalledApps());
      return;
    }

    const filteredSearch = selected.filter(app =>
      `${app.name} ${app.path} ${app.category} ${app.description} ${app.usage}`.toLocaleLowerCase().includes(term)
    );
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
      const pinned = categoryApps.filter(app => app.pinned);
      const regular = categoryApps.filter(app => !app.pinned);

      // Pinning is a display priority, not a category. Pinned apps remain at
      // the top of the current view while retaining their original category.
      if (pinned.length) this.renderAppSection(body, "常用应用", pinned);
      if (regular.length) this.renderAppSection(body, this.activeCategory, regular);
      if (!pinned.length && !regular.length) {
        body.createEl("p", { text: "这个分类下暂时没有应用。", cls: "mal-empty" });
      }
    } else {
      // 最近启动条：无搜索词时显示最近用过的 8 个
      if (!term) {
        const recent = selected
          .filter(app => app.lastLaunchedAt)
          .sort((a, b) => (b.lastLaunchedAt || 0) - (a.lastLaunchedAt || 0))
          .slice(0, 8);
        if (recent.length) this.renderAppSection(body, "最近启动", recent, "🕘", true);
      }
      const pinned = filteredSearch.filter(app => app.pinned);
      if (pinned.length) this.renderAppSection(body, "常用应用", pinned);

      const orderMap = new Map(this.plugin.getCategories().map((c, i) => [c.name, i]));
      const categories = [...new Set(filteredSearch.filter(app => !app.pinned).map(app => app.category || "未分类"))]
        .sort((a, b) => (orderMap.get(a) ?? 999) - (orderMap.get(b) ?? 999) || a.localeCompare(b, "zh-Hans-CN"));
      for (const category of categories) {
        const items = filteredSearch.filter(app => !app.pinned && (app.category || "未分类") === category);
        if (items.length) this.renderAppSection(body, category, items);
      }
    }

    if (this.detailAppId) this.renderDetailPanel(body);
  }

  renderCategoryNav(body, selected, term) {
    const nav = body.createDiv({ cls: "mal-category-nav" });
    const orderMap = new Map(this.plugin.getCategories().map((c, i) => [c.name, i]));
    const categories = [...new Set(selected.map(app => app.category || "未分类"))]
      .sort((a, b) => (orderMap.get(a) ?? 999) - (orderMap.get(b) ?? 999) || a.localeCompare(b, "zh-Hans-CN"));
    const buttons = [
      { id: "__all__", label: `全部 ${selected.length}` },
      ...categories.map(category => ({
        id: category,
        label: `${this.plugin.categoryIcon(category) ? this.plugin.categoryIcon(category) + " " : ""}${category} ${selected.filter(app => (app.category || "未分类") === category).length}`
      }))
    ];

    for (const item of buttons) {
      const button = nav.createEl("button", {
        text: item.label,
        cls: `mal-nav-chip ${this.activeCategory === item.id ? "is-active" : ""}`
      });
      button.addEventListener("click", () => {
        this.activeCategory = item.id;
        this.detailAppId = null;
        this.render();
      });
      button.addEventListener("dragover", event => {
        if (item.id === "__all__") return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        button.addClass("is-drop-target");
      });
      button.addEventListener("dragleave", () => button.removeClass("is-drop-target"));
      button.addEventListener("drop", async event => {
        if (item.id === "__all__") return;
        event.preventDefault();
        button.removeClass("is-drop-target");
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
  }

  renderAppSection(body, title, apps, iconOverride, keepOrder) {
    const isPinnedStrip = apps.length > 0 && apps.every(app => app.pinned);
    const section = body.createDiv({ cls: isPinnedStrip ? "mal-pinned-top" : "mal-section" });
    if (title) {
      const icon = iconOverride || this.plugin.categoryIcon(title);
      section.createEl("h3", { text: `${icon ? icon + " " : ""}${title}`, cls: "mal-category" });
    }
    const grid = section.createDiv({ cls: `mal-grid ${this.plugin.settings.viewMode === "list" ? "is-list" : ""}` });
    const sorted = keepOrder ? [...apps] : [...apps].sort((a, b) => {
      const aKey = a.pinned ? (a.pinnedOrder ?? a.order ?? 0) : (a.order ?? 0);
      const bKey = b.pinned ? (b.pinnedOrder ?? b.order ?? 0) : (b.order ?? 0);
      return aKey - bKey || a.name.localeCompare(b.name, "zh-Hans-CN");
    });

    for (const app of sorted) {
      const card = grid.createDiv({
        cls: "mal-app-card",
        attr: { draggable: "true", tabindex: "0", role: "button", "aria-label": `查看 ${app.name} 介绍` }
      });
      const icon = card.createDiv({ cls: "mal-app-icon" });
      this.plugin.renderAppIcon(icon, app);
      card.createDiv({ text: app.name, cls: "mal-app-name" });

      const pin = card.createEl("button", {
        text: app.pinned ? "★" : "☆",
        cls: `mal-pin-btn ${app.pinned ? "is-pinned" : ""}`,
        attr: { type: "button", title: app.pinned ? "取消置顶" : "置顶应用" }
      });
      pin.addEventListener("click", async event => {
        event.stopPropagation();
        await this.plugin.togglePin(app);
        this.render();
      });

      card.addEventListener("click", event => {
        if (event.target.closest(".mal-pin-btn")) return;
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

      card.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        const menu = new Menu();
        menu.addItem(item => item
          .setTitle(`打开 ${app.name}`)
          .setIcon("play")
          .onClick(() => this.plugin.launchApp(app)));
        menu.addItem(item => item
          .setTitle(app.pinned ? "取消置顶" : "置顶应用")
          .setIcon("pin")
          .onClick(async () => {
            await this.plugin.togglePin(app);
            this.render();
          }));
        menu.addSeparator();
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
        }
        menu.showAtMouseEvent(event);
      });

      card.addEventListener("dragstart", event => {
        if (event.target.closest(".mal-pin-btn")) {
          event.preventDefault();
          return;
        }
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
    }
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
    this.plugin.renderAppIcon(icon, app);
    const names = identity.createDiv({ cls: "mal-detail-names" });
    names.createEl("h3", { text: app.name });
    names.createEl("div", { text: `${app.category || "未分类"} · ${app.path}`, cls: "mal-detail-meta" });
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
    const reveal = actions.createEl("button", { text: "在 Finder 显示", cls: "mal-button" });
    reveal.addEventListener("click", () => this.plugin.revealInFinder(app));
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

      panel.createEl("div", { text: "启动快捷键（可选，如 Mod+Shift+1，清空即取消）", cls: "mal-detail-label" });
      const hotkeyInput = panel.createEl("input", {
        cls: "mal-detail-hotkey",
        attr: { type: "text", placeholder: "Mod+Shift+1", spellcheck: "false" }
      });
      hotkeyInput.value = app.hotkey || "";

      const editActions = panel.createDiv({ cls: "mal-detail-edit-actions" });
      const save = editActions.createEl("button", { text: "保存介绍", cls: "mal-primary" });
      save.addEventListener("click", async () => {
        app.description = description.value.trim();
        app.usage = usage.value.trim();
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

      const editActions = panel.createDiv({ cls: "mal-detail-edit-actions" });
      const edit = editActions.createEl("button", { text: "编辑介绍", cls: "mal-button" });
      edit.addEventListener("click", () => {
        this.editingDetail = true;
        this.render();
      });
    }

    const footer = panel.createDiv({ cls: "mal-detail-footer" });
    const launch = footer.createEl("button", { text: `打开 ${app.name}`, cls: "mal-launch-button" });
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

    // 批量操作条
    if (!this.batchSelected) this.batchSelected = new Set();
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
      batchBar.createEl("span", { text: "勾选左侧复选框可批量设置分类", cls: "mal-batch-hint" });
    }

    for (const app of apps) {
      const row = list.createDiv({ cls: "mal-manage-row" });
      const batchCheck = row.createEl("input", { attr: { type: "checkbox" }, cls: "mal-check mal-batch-check" });
      batchCheck.checked = this.batchSelected.has(app.id);
      batchCheck.addEventListener("change", () => {
        if (batchCheck.checked) this.batchSelected.add(app.id);
        else this.batchSelected.delete(app.id);
        this.render();
      });
      const checkbox = row.createEl("input", { attr: { type: "checkbox" }, cls: "mal-check" });
      checkbox.checked = !!app.selected;
      checkbox.addEventListener("change", async () => {
        app.selected = checkbox.checked;
        await this.plugin.saveSettings();
        this.updateManageSummary(summary);
        if (app.selected) await this.plugin.ensureIcon(app);
      });

      const icon = row.createDiv({ cls: "mal-manage-icon" });
      this.plugin.renderAppIcon(icon, app);

      const info = row.createDiv({ cls: "mal-app-info" });
      info.createEl("div", { text: app.name, cls: "mal-manage-name" });
      info.createEl("div", { text: app.path, cls: "mal-app-path" });

      const tools = row.createDiv({ cls: "mal-manage-tools" });
      const categoryInput = tools.createEl("input", {
        attr: { type: "text", list: datalistId, placeholder: "输入分类" },
        cls: "mal-category-input"
      });
      categoryInput.value = app.category || "未分类";
      categoryInput.addEventListener("change", async () => {
        app.category = categoryInput.value.trim() || "未分类";
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
      text: "场景可一键启动一组应用。先在下方列表勾选应用，再回到这里创建；快速启动面板（Cmd+Shift+Space）可搜到场景。",
      cls: "mal-add-custom-hint"
    });
    for (const scene of this.plugin.settings.scenes) {
      const row = panel.createDiv({ cls: "mal-cat-row" });
      row.createEl("span", { text: "🎬", cls: "mal-scene-icon" });
      row.createEl("span", { text: scene.name, cls: "mal-scene-name" });
      row.createEl("span", { text: `${scene.appIds.length} 个应用`, cls: "mal-cat-count" });
      const launch = row.createEl("button", { text: "启动", cls: "mal-primary" });
      launch.addEventListener("click", () => this.plugin.launchScene(scene));
      const close = row.createEl("button", { text: "关闭", cls: "mal-button" });
      close.addEventListener("click", () => this.plugin.closeScene(scene));
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
      text: "添加扫描不到的应用（如 Parallels 虚拟机应用、自编译应用），支持 ~ 开头的路径。",
      cls: "mal-add-custom-hint"
    });
    const row = panel.createDiv({ cls: "mal-add-custom-row" });
    const pathInput = row.createEl("input", {
      cls: "mal-category-input mal-add-path",
      attr: { type: "text", placeholder: "应用路径，如 ~/Applications/MyApp.app", spellcheck: "false" }
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
        category: `场景 · ${s.appIds.length} 个应用`,
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
  async onload() {
    const loaded = await this.loadData() || {};
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
    this.settings = {
      apps: rawApps.map((app, index) => normalizeApp(app, index)),
      hasScanned: !!loaded.hasScanned,
      agentPort: Number.isInteger(Number(loaded.agentPort)) && Number(loaded.agentPort) > 0 ? Number(loaded.agentPort) : 43171,
      agentTokenHash: tokenHash,
      agentApiEnabled: loaded.agentApiEnabled !== false,
      viewMode: loaded.viewMode === "list" ? "list" : "grid",
      categories: Array.isArray(loaded.categories) && loaded.categories.length
        ? loaded.categories.filter(c => c && c.name).map((c, i) => ({
            name: String(c.name),
            icon: typeof c.icon === "string" ? c.icon : "📁",
            order: Number.isFinite(Number(c.order)) ? Number(c.order) : i
          }))
        : DEFAULT_CATEGORY_META.map((c, i) => ({ ...c, order: i })),
      categoryRules: loaded.categoryRules && typeof loaded.categoryRules === "object" && !Array.isArray(loaded.categoryRules)
        ? loaded.categoryRules : {},
      scenes: Array.isArray(loaded.scenes)
        ? loaded.scenes.filter(s => s && s.name).map(s => ({
            id: String(s.id || crypto.randomBytes(6).toString("hex")),
            name: String(s.name),
            appIds: Array.isArray(s.appIds) ? s.appIds : []
          }))
        : [],
      autoCheckUpdates: loaded.autoCheckUpdates !== false,
      lastUpdateCheck: typeof loaded.lastUpdateCheck === "string" ? loaded.lastUpdateCheck : "",
      latestVersion: typeof loaded.latestVersion === "string" ? loaded.latestVersion : "",
      downloadMirror: typeof loaded.downloadMirror === "string" ? loaded.downloadMirror : "",
      autoLaunchSceneId: typeof loaded.autoLaunchSceneId === "string" ? loaded.autoLaunchSceneId : ""
    };
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
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
  releaseAssetUrl(version, file) {
    const url = `https://github.com/y12589/mac-app-launcher/releases/download/${version}/${file}`;
    const mirror = (this.settings.downloadMirror || "").trim().replace(/\/+$/, "");
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
      if (!latest || this.compareVersions(latest, this.manifest.version) <= 0) {
        if (manual) new Notice(`Mac App Launcher 已是最新版本（${this.manifest.version}）`);
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
      return { name, iconSource };
    } catch (_) {
      return { name: path.basename(appPath, ".app"), iconSource: "" };
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
    new Notice("开始快速扫描常见 Mac 应用目录…");

    try {
      const paths = this.discoverAppPaths();
      this.scanTotal = paths.length;
      this.scanStatus = `发现 ${paths.length} 个应用包，正在读取名称和路径…`;
      this.refreshViews();

      const previous = this.settings.apps || [];
      const previousByPath = new Map(previous.map(app => [path.resolve(app.path || ""), app]));
      const previousByName = new Map(previous.map(app => [(app.name || "").toLowerCase(), app]));
      const results = [];
      let cursor = 0;
      let completed = 0;

      const worker = async () => {
        while (!this.scanCancelled) {
          const index = cursor++;
          if (index >= paths.length) return;
          const appPath = paths[index];
          const info = await this.readAppInfo(appPath);
          const old = previousByPath.get(path.resolve(appPath)) || previousByName.get(info.name.toLowerCase());
          const suggested = suggestedProfile(info.name, old?.category || fallbackCategory(info.name, appPath));

          results.push(normalizeApp({
            id: appId(appPath),
            name: info.name,
            path: appPath,
            selected: old ? !!old.selected : false,
            category: old?.category || learnedCategory(info.name, this.settings.categoryRules) || fallbackCategory(info.name, appPath),
            pinned: old?.pinned || false,
            order: old?.order,
            description: old?.description || suggested.description,
            usage: old?.usage || suggested.usage,
            iconPath: old?.iconPath && fs.existsSync(old.iconPath) ? old.iconPath : "",
            iconSource: info.iconSource || old?.iconSource || "",
            launchCount: old?.launchCount || 0,
            lastLaunchedAt: old?.lastLaunchedAt || null
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
      const customApps = previous.filter(app =>
        app.custom && !resultPaths.has(path.resolve(app.path || ""))
      );
      this.settings.apps = [...results, ...customApps];
      this.settings.hasScanned = true;
      await this.saveSettings();
      this.scanStatus = `扫描完成：发现 ${results.length} 个应用`;
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
    const target = app.path || "";
    const silent = !!options.silent;
    if (!target) {
      const message = `缺少应用路径：${app.name}`;
      if (!silent) new Notice(message);
      return Promise.resolve({ ok: false, error: message });
    }

    const args = app.name.toLowerCase() === "finder" ? [os.homedir()] : [target];
    return new Promise(resolve => {
      execFile("/usr/bin/open", args, error => {
        if (error) {
          console.error("[Mac App Launcher] Launch failed", app, error);
          const message = `启动失败：${app.name}。请检查应用是否仍安装在原位置。`;
          if (!silent) new Notice(message, 7000);
          resolve({ ok: false, error: message });
        } else {
          // 频率统计：记录启动次数与最近启动时间
          app.launchCount = (app.launchCount || 0) + 1;
          app.lastLaunchedAt = Date.now();
          this.saveSettings();
          if (!silent) new Notice(`已请求启动：${app.name}`);
          resolve({ ok: true });
        }
      });
    });
  }

  // 在 Finder 中显示应用
  revealInFinder(app) {
    if (!app.path) return;
    execFile("/usr/bin/open", ["-R", app.path], error => {
      if (error) new Notice(`无法在 Finder 中显示：${app.name}`);
    });
  }

  // 移除手动添加的应用
  async removeCustomApp(app) {
    if (!app.custom) return;
    this.settings.apps = this.settings.apps.filter(item => item.id !== app.id);
    await this.saveSettings();
    this.refreshViews();
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
    await this.saveSettings();
    this.refreshViews();
    this.buildPinyin([app]);
    return { ok: true, app };
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
      appIds: [...appIds]
    });
    await this.saveSettings();
    this.refreshViews();
    return { ok: true };
  }

  async removeScene(id) {
    this.settings.scenes = this.settings.scenes.filter(s => s.id !== id);
    if (this.settings.autoLaunchSceneId === id) this.settings.autoLaunchSceneId = "";
    await this.saveSettings();
    this.refreshViews();
  }

  async launchScene(scene) {
    const apps = scene.appIds
      .map(id => this.settings.apps.find(a => a.id === id))
      .filter(Boolean);
    if (!apps.length) {
      new Notice(`场景「${scene.name}」里没有可用应用`);
      return;
    }
    // 错峰启动，避免同时拉起多个应用造成卡顿
    for (let i = 0; i < apps.length; i++) {
      await this.launchApp(apps[i], { silent: true });
      if (i < apps.length - 1) await new Promise(resolve => setTimeout(resolve, 500));
    }
    new Notice(`场景「${scene.name}」已启动 ${apps.length} 个应用`);
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
    const apps = scene.appIds
      .map(id => this.settings.apps.find(a => a.id === id))
      .filter(Boolean);
    if (!apps.length) {
      new Notice(`场景「${scene.name}」里没有应用`);
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
