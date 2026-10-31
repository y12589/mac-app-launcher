# 开发者 API（window.MacAppLauncher）

Mac App Launcher 向 Obsidian 全局暴露 `window.MacAppLauncher`，供 QuickAdd 宏、Templater 脚本、DataviewJS、其他第三方插件直接调用。

- 纯本地 JavaScript API，无需令牌、不经过网络。
- 只能操作你在应用中心**勾选展示**的应用，不能启动任意路径的程序。
- `apiVersion` 当前为 `2`。调用前建议检查：`window.MacAppLauncher && window.MacAppLauncher.apiVersion >= 2`。

## 方法一览

| 方法 | 返回 | 说明 |
|---|---|---|
| `launch(name)` | `Promise<{ok, error?}>` | 启动应用，按 精确名/id → 子串 → 模糊 依次匹配 |
| `launchScene(nameOrId)` | `Promise<{ok, error?}>` | 启动场景（名称或 id） |
| `apps()` | `Array<AppInfo>` | 已勾选应用列表 |
| `scenes()` | `Array<SceneInfo>` | 场景列表，含步骤数与摘要 |
| `search(query)` | `Array<AppInfo & {score}>` | 模糊搜索已勾选应用，前 10 条 |
| `getApp(name)` | `AppInfo \| null` | 单个应用详情 |
| `isRunning(name)` | `Promise<{ok, running, app, bundleId?}>` | 应用是否正在运行 |
| `on(event, cb)` | `() => void`（退订函数） | 订阅启动事件 |
| `off(event, cb)` | `void` | 取消订阅 |

### AppInfo 字段

```js
{
  id: "a1b2c3...",           // 稳定 id（路径哈希）
  name: "微信",
  path: "/Applications/WeChat.app",
  category: "办公工具",
  pinned: false,
  custom: false,              // 是否手动添加
  launchCount: 12,
  lastLaunchedAt: 1793450000000 // 毫秒时间戳或 null
}
```

### SceneInfo 字段

```js
{ id: "f3e9a1b2c4d5", name: "写作环境", stepCount: 4, summary: "3 应用 · 1 笔记" }
```

## 事件订阅

| 事件 | payload |
|---|---|
| `"app-launched"` | `{ id, name, category }` |
| `"scene-launched"` | `{ id, name, launched, opened, commands, skippedRunning, failed }` |

`on()` 返回退订函数，插件卸载时建议退订；监听器抛异常不会影响主流程。

```js
// 第三方插件 onload 中
this.unsub = window.MacAppLauncher?.on("app-launched", ({ name }) => {
  console.log("应用已启动：", name);
});
// onunload 中
this.unsub?.();
```

## 调用示例

### QuickAdd 宏（Macro 的 user script）

```js
module.exports = async () => {
  const mal = window.MacAppLauncher;
  if (!mal) { new Notice("未安装 Mac App Launcher"); return; }
  await mal.launch("微信");
  await mal.launchScene("写作环境");
};
```

### Templater 脚本

```
<%* const mal = window.MacAppLauncher; if (mal) await mal.launch("Obsidian"); %>
```

### DataviewJS：列出高频应用

```
const apps = window.MacAppLauncher.apps()
  .sort((a, b) => b.launchCount - a.launchCount).slice(0, 5);
dv.table(["应用", "分类", "启动次数"], apps.map(a => [a.name, a.category, a.launchCount]));
```

### 条件启动：只在未运行时拉起

```js
const mal = window.MacAppLauncher;
const st = await mal.isRunning("Bear");
if (st.ok && !st.running) await mal.launch("Bear");
```

## 与本机 Agent API 的区别

| | 开发者 API（本文档） | Agent API（AGENT-API.md） |
|---|---|---|
| 调用方 | Obsidian 内的脚本/插件 | Obsidian 外的本机程序（AI Agent、快捷指令） |
| 通道 | `window.MacAppLauncher` 全局对象 | HTTP `127.0.0.1:43171`，Bearer 令牌 |
| 鉴权 | 无（同进程信任） | 强制令牌 + 限速 |
