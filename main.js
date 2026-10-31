const { Plugin, ItemView, Notice, PluginSettingTab, Setting } = require("obsidian");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const VIEW_TYPE = "mac-app-launcher-view";
const DEFAULT_CATEGORIES = [
  "AI助手", "AI智能体", "办公工具", "开发工具", "设计工具",
  "浏览器", "影音工具", "系统工具", "其他", "未分类"
];

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
      const manage = controls.createEl("button", { text: "管理应用", cls: "mal-primary" });
      manage.addEventListener("click", () => {
        this.mode = "manage";
        this.searchTerm = "";
        this.render();
      });
    }

    const body = root.createDiv({ cls: "mal-body" });
    search.addEventListener("input", () => {
      this.searchTerm = search.value;
      this.renderBody(body);
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
      const pinned = filteredSearch.filter(app => app.pinned);
      if (pinned.length) this.renderAppSection(body, "常用应用", pinned);

      const categories = [...new Set(filteredSearch.filter(app => !app.pinned).map(app => app.category || "未分类"))];
      for (const category of categories) {
        const items = filteredSearch.filter(app => !app.pinned && (app.category || "未分类") === category);
        if (items.length) this.renderAppSection(body, category, items);
      }
    }

    if (this.detailAppId) this.renderDetailPanel(body);
  }

  renderCategoryNav(body, selected, term) {
    const nav = body.createDiv({ cls: "mal-category-nav" });
    const categories = [...new Set(selected.map(app => app.category || "未分类"))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    const buttons = [
      { id: "__all__", label: `全部 ${selected.length}` },
      ...categories.map(category => ({
        id: category,
        label: `${category} ${selected.filter(app => app.category === category).length}`
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
        await this.plugin.saveSettings();
        this.render();
        new Notice(`已将 ${app.name} 移入「${item.id}」`);
      });
    }
  }

  renderAppSection(body, title, apps) {
    const isPinnedStrip = apps.length > 0 && apps.every(app => app.pinned);
    const section = body.createDiv({ cls: isPinnedStrip ? "mal-pinned-top" : "mal-section" });
    if (title) section.createEl("h3", { text: title, cls: "mal-category" });
    const grid = section.createDiv({ cls: "mal-grid" });
    const sorted = [...apps].sort((a, b) => {
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

    const actions = top.createDiv({ cls: "mal-detail-actions" });
    const pin = actions.createEl("button", {
      text: app.pinned ? "★ 已置顶" : "☆ 置顶",
      cls: "mal-button"
    });
    pin.addEventListener("click", async () => {
      await this.plugin.togglePin(app);
      this.render();
    });
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

      const editActions = panel.createDiv({ cls: "mal-detail-edit-actions" });
      const save = editActions.createEl("button", { text: "保存介绍", cls: "mal-primary" });
      save.addEventListener("click", async () => {
        app.description = description.value.trim();
        app.usage = usage.value.trim();
        await this.plugin.saveSettings();
        this.editingDetail = false;
        new Notice(`已保存 ${app.name} 的介绍`);
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
    const apps = this.plugin.settings.apps.filter(app =>
      `${app.name} ${app.path} ${app.category} ${app.description} ${app.usage}`.toLocaleLowerCase().includes(term)
    );

    const summary = body.createDiv({ cls: "mal-manage-summary" });
    this.updateManageSummary(summary);
    this.renderAgentApiPanel(body);

    if (!this.plugin.settings.hasScanned && !apps.length) {
      body.createEl("p", { text: "还没有扫描记录。点击“重新扫描”。", cls: "mal-empty" });
      return;
    }

    const list = body.createDiv({ cls: "mal-manage-list" });
    const datalistId = `mal-categories-${this.plugin.manifest.id}`;
    const datalist = list.createEl("datalist", { attr: { id: datalistId } });
    const categories = new Set([...DEFAULT_CATEGORIES, ...this.plugin.settings.apps.map(a => a.category).filter(Boolean)]);
    for (const category of categories) datalist.createEl("option", { attr: { value: category } });

    for (const app of apps) {
      const row = list.createDiv({ cls: "mal-manage-row" });
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
    token.value = this.plugin.settings.agentToken || "";

    const actions = panel.createDiv({ cls: "mal-agent-actions" });
    const copy = actions.createEl("button", { text: "复制 Agent 接入说明", cls: "mal-primary" });
    copy.addEventListener("click", () => this.plugin.copyAgentInstructions());
    const rotate = actions.createEl("button", { text: "重置访问令牌", cls: "mal-button" });
    rotate.addEventListener("click", async () => {
      this.plugin.settings.agentToken = crypto.randomBytes(32).toString("hex");
      await this.plugin.saveSettings();
      this.render();
      new Notice("Agent API 访问令牌已重置，旧令牌立即失效。");
    });

    const note = panel.createEl("p", {
      text: "安全说明：接口仅监听本机 127.0.0.1；Agent 只能启动你在上方应用清单中勾选展示的软件，不能传入任意程序路径或执行任意命令。",
      cls: "mal-agent-note"
    });
    const sample = panel.createEl("pre", { cls: "mal-agent-sample" });
    sample.setText(
      `查询应用：GET /v1/apps\n启动应用：POST /v1/launch\n请求头：Authorization: Bearer ${this.plugin.settings.agentToken || "<token>"}`
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

class MacAppLauncherSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Mac App Launcher 设置" });

    containerEl.createEl("h3", { text: "Agent API" });
    new Setting(containerEl)
      .setName("启用 Agent API")
      .setDesc("关闭后本机 127.0.0.1 的 Agent 启动接口停止服务，插件其余功能不受影响。")
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
      .setName("Agent API 端口")
      .setDesc("默认 43171；端口被占用时插件会自动改用一个可用端口并保存实际端口。修改后点“应用端口”重启接口生效。")
      .addText(text => {
        portInput = text;
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
      .setDesc("Agent 调用除健康检查外的接口时必须携带此令牌。重置后旧令牌立即失效。")
      .addText(text => {
        text.setValue(this.plugin.settings.agentToken || "");
        text.inputEl.setAttribute("readonly", "readonly");
        text.inputEl.setAttribute("spellcheck", "false");
      })
      .addButton(button => {
        button.setButtonText("重置访问令牌");
        button.onClick(async () => {
          this.plugin.settings.agentToken = crypto.randomBytes(32).toString("hex");
          await this.plugin.saveSettings();
          new Notice("Agent API 访问令牌已重置，旧令牌立即失效。");
          this.display();
        });
      })
      .addButton(button => {
        button.setButtonText("复制 Agent 接入说明");
        button.onClick(() => this.plugin.copyAgentInstructions());
      });

    containerEl.createEl("h3", { text: "更新" });
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
      .setName("更新状态")
      .setDesc(this.plugin.getUpdateStatusText());

    new Setting(containerEl)
      .setName("检查更新")
      .setDesc("立即从 GitHub Release 检查一次，发现新版自动下载并覆盖，完成后重载插件。")
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
  }
}

module.exports = class MacAppLauncherPlugin extends Plugin {
  async onload() {
    const loaded = await this.loadData() || {};
    const rawApps = Array.isArray(loaded.apps) ? loaded.apps : parseLegacyApps(loaded.appsText);
    this.settings = {
      apps: rawApps.map((app, index) => normalizeApp(app, index)),
      hasScanned: !!loaded.hasScanned,
      agentPort: Number.isInteger(Number(loaded.agentPort)) && Number(loaded.agentPort) > 0 ? Number(loaded.agentPort) : 43171,
      agentToken: typeof loaded.agentToken === "string" && loaded.agentToken.length >= 32
        ? loaded.agentToken
        : crypto.randomBytes(32).toString("hex"),
      agentApiEnabled: loaded.agentApiEnabled !== false,
      autoCheckUpdates: loaded.autoCheckUpdates !== false,
      lastUpdateCheck: typeof loaded.lastUpdateCheck === "string" ? loaded.lastUpdateCheck : "",
      latestVersion: typeof loaded.latestVersion === "string" ? loaded.latestVersion : ""
    };
    this.scanning = false;
    this.scanCancelled = false;
    this.scanProgress = 0;
    this.scanTotal = 0;
    this.scanStatus = "";
    this.iconJobs = new Map();

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
      const buf = await this.fetchBuffer("https://api.github.com/repos/y12589/mac-app-launcher/releases/latest");
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
        const data = await this.fetchBuffer(`https://github.com/y12589/mac-app-launcher/releases/download/${version}/${file}`);
        if (!data || !data.length) throw new Error(`下载 ${file} 为空`);
        downloaded[file] = data;
      }
      const manifest = JSON.parse(downloaded["manifest.json"].toString("utf8"));
      if (manifest.id !== this.manifest.id) throw new Error("下载的 manifest id 不匹配，已中止更新");
      if (String(manifest.version) !== String(version)) throw new Error("下载的 manifest 版本与 Release 不一致，已中止更新");
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
    const provided = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.settings.agentToken || "");
    if (!expected.length || provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(provided, expected);
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

    if (!this.isValidAgentToken(req)) {
      return this.sendAgentJson(res, 401, { ok: false, error: "unauthorized", message: "Provide a valid Bearer token." });
    }

    if (req.method === "GET" && route === "/v1/apps") {
      const category = url.searchParams.get("category");
      const apps = this.settings.apps
        .filter(app => app.selected)
        .filter(app => !category || app.category === category)
        .map(app => ({
          id: app.id,
          name: app.name,
          category: app.category || "未分类",
          pinned: !!app.pinned,
          description: app.description || "",
          usage: app.usage || ""
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

    return this.sendAgentJson(res, 404, { ok: false, error: "not_found" });
  }

  async copyAgentInstructions() {
    const baseUrl = `http://127.0.0.1:${this.settings.agentPort}`;
    const token = this.settings.agentToken;
    const instructions = [
      "Mac App Launcher 本机 Agent API",
      `Base URL: ${baseUrl}`,
      `Authorization: Bearer ${token}`,
      "",
      "先查询可启动应用：",
      `curl -s "${baseUrl}/v1/apps" -H "Authorization: Bearer ${token}"`,
      "",
      "启动一个已勾选的应用（将 ChatGPT 替换成目标应用的精确名称）：",
      `curl -s -X POST "${baseUrl}/v1/launch" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{"app":"ChatGPT"}'`,
      "",
      "Agent 使用规则：先查询 /v1/apps；只允许从返回列表中选择应用；用户明确要求打开时调用 POST /v1/launch。不要使用任意路径或任意 shell 命令代替此接口。"
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
            category: old?.category || fallbackCategory(info.name, appPath),
            pinned: old?.pinned || false,
            order: old?.order,
            description: old?.description || suggested.description,
            usage: old?.usage || suggested.usage,
            iconPath: old?.iconPath && fs.existsSync(old.iconPath) ? old.iconPath : "",
            iconSource: info.iconSource || old?.iconSource || ""
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
      this.settings.apps = results;
      this.settings.hasScanned = true;
      await this.saveSettings();
      this.scanStatus = `扫描完成：发现 ${results.length} 个应用`;
      new Notice(`扫描完成：发现 ${results.length} 个应用。`, 7000);
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
    if (app.iconPath && fs.existsSync(app.iconPath)) {
      try {
        const data = fs.readFileSync(app.iconPath).toString("base64");
        container.createEl("img", {
          attr: { src: `data:image/png;base64,${data}`, alt: "", draggable: "false" },
          cls: "mal-native-icon"
        });
        return;
      } catch (error) {
        console.warn("[Mac App Launcher] Could not read icon", error);
      }
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
          if (!silent) new Notice(`已请求启动：${app.name}`);
          resolve({ ok: true });
        }
      });
    });
  }
};
