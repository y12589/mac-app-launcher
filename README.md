Mac App Launcher
======================

适用：macOS + Obsidian 桌面版（Intel / Apple Silicon）。
当前版本：1.17.1（作者：阎大大）。完整更新记录见 CHANGELOG.md。

插件定位：增强 Obsidian 内的应用管理体验——让应用自然出现在写笔记、看文件、做项目、整理知识的每一个环节，而不是一个嵌在 Obsidian 里的独立启动器。

完整使用说明（每个功能的详细用法）：[USER-GUIDE.md](USER-GUIDE.md)。

## 应用管理基础（1.7.x）

1. 扫描本机应用、原生图标、分类导航、置顶、拖拽排序、一键启动。
2. 分类可自定义：新增、重命名、删除、排序，每个分类可配 emoji 图标。
3. 批量分类与归类学习：手动改过的分类按应用名记住，之后扫描自动命中。
4. 拼音搜索：首字母（wx）或全拼（weixin）匹配中文应用名；快速启动面板（Cmd+Shift+Space）与搜索框均生效。
5. 单应用快捷键、应用详情弹窗（介绍、用途、快捷键可编辑）。
6. 场景模式：一键启动/关闭一组应用；场景启动 0.5 秒错峰；关闭按 bundle ID 匹配；可设置打开 Obsidian 约 3 秒后自动拉起指定场景。
7. 设置页自动更新（失败自动重试、支持下载加速镜像）、服务状态行、关于页内置更新日志。

## 与 Obsidian 深度融合（1.8 – 1.9）

8. 当前笔记推荐：应用中心顶部根据当前笔记的名称、父文件夹、正文标签与 frontmatter tags 匹配相关应用，Top 4 点击直接启动。
9. Markdown 启动卡片：笔记里写 ` ```app-launcher ` 代码块（`app: 应用名`，可多个、可 `note:` 自定义说明），渲染成带图标和打开按钮的卡片。
10. Frontmatter 应用绑定：笔记 YAML 写 `apps: [应用名]`、`app-scene: 场景名`，应用中心出现「本篇笔记绑定」区，支持单个启动、全部错峰启动、场景一键启动；未安装的应用灰显。
11. 文件右键菜单：文件列表右键按文件类型推荐应用打开（图片→设计工具、代码→开发工具、PDF→办公工具、影音→影音工具），文件夹可「在 Finder 中打开」，绑定场景的笔记可直接启动场景。

## 知识管理体系（1.10 – 1.14）

12. 应用知识库：一键为应用创建资料卡笔记（存入「应用资料」文件夹），模板含 frontmatter（type: application 等）、内嵌启动卡片、安装配置/使用技巧/常见故障/相关笔记四章节；详情弹窗展示反向链接，点击直达引用它的笔记。
13. 每日笔记启动日志：设置页开启后，每次启动应用自动在当天日记「应用使用记录」小节追加一行；尊重 Daily Notes 插件的目录与文件名格式。默认关闭。
14. 启动参数白名单：编辑器类应用（VS Code、Cursor 等）右键可「打开当前库」，终端类应用（Terminal、iTerm 等）右键可「进入当前笔记目录」。只允许传递目录路径。
15. 公开 API：`window.MacAppLauncher.launch(name)` / `launchScene(name)` / `apps()`，供 QuickAdd 宏、Templater 脚本与其他插件直接调用。
16. 配置导入导出：设置页一键导出应用、场景、分类与归类规则为 JSON，粘贴到其他 Vault 导入即可复刻整套工作环境。
17. Bases 数据库视图：一键生成「应用资料.base」，把应用资料卡接入 Obsidian 原生 Bases（表格 + 卡片视图，需 Obsidian 1.9+）。

## Canvas 工作流（1.15 – 1.17）

18. 场景导出画布：场景管理行点「画布」，生成 `工作流/场景名.canvas`——每个应用一个可点击启动的节点，按执行顺序连线串联。
19. 画布自动执行：命令面板「执行当前画布的工作流」，按连线拓扑顺序启动应用（已运行的跳过）、打开 file 节点指向的笔记；检测到循环连线自动拦截；结束后汇总启动/打开/跳过数量并点名失败项。设置页有开关（默认开）。
20. 场景运行状态感知：启动场景时已在运行的应用自动跳过，不重复拉起。

升级：
推荐用设置页自动更新：打开插件设置 → 检查更新 → 按提示更新，data.json 与 icons 文件夹不受影响。
手动覆盖（备用）：
1. 完全退出 Obsidian（Cmd+Q）。
2. 解压 ZIP。
3. 用 mac-app-launcher 文件夹覆盖当前库的 .obsidian/plugins/mac-app-launcher/
4. 保留旧目录中的 data.json（不要删除），icons 文件夹也可保留。
5. 重新打开 Obsidian。

Agent API（HTTP，供本机 Agent 调用）：
- Base URL: http://127.0.0.1:43171（端口冲突时自动换，以设置页「服务状态」为准）
- 除健康检查外需请求头 `Authorization: Bearer <TOKEN>`（管理页可查看/重置）

1) 检查服务：
curl http://127.0.0.1:43171/v1/health

2) 查询已勾选应用（支持 ?category= 与 ?q= 拼音搜索，返回含使用统计）：
curl -H "Authorization: Bearer <TOKEN>" "http://127.0.0.1:43171/v1/apps?q=微信"

3) 查询分类：
curl -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:43171/v1/categories

4) 启动应用（精确无果自动模糊匹配，候选不唯一返回 409）：
curl -X POST http://127.0.0.1:43171/v1/launch \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"app":"ChatGPT"}'

5) 批量启动（上限 20 个）：
curl -X POST http://127.0.0.1:43171/v1/launch-batch \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"names":["微信","飞书"]}'

插件内公开 API（供 QuickAdd / Templater / 其他插件）：
```js
await MacAppLauncher.launch("VS Code");      // 模糊启动应用
await MacAppLauncher.launchScene("写作模式"); // 启动场景
MacAppLauncher.apps();                        // 列出已勾选应用
```

Agent 推荐指令：
“当我要求打开某个 Mac 客户端时，先调用 Mac App Launcher 的 GET /v1/apps 查询允许启动的软件；如果用户指定的软件在列表中，调用 POST /v1/launch，传入精确 app 名称或 id。不要自行使用 open 命令或猜测应用路径。如果应用不在列表中，告诉我先在 Obsidian 插件里勾选该应用。”

安全：
- Agent API 仅绑定 127.0.0.1，随机 Bearer Token（SHA-256 哈希存储），限速每来源每分钟 120 次。
- 只能启动插件中已勾选的应用，不接受任意路径或 shell 命令。
- 启动参数白名单仅允许传递目录路径给编辑器/终端类应用。
- 退出 Obsidian 后 API 随插件停止。

应用中心：
- 顶部区块：当前笔记推荐、本篇笔记绑定（需 frontmatter 声明）、最近启动。
- 点击卡片：详情弹窗（统计、介绍/用途/快捷键编辑、应用笔记与关联知识）。
- 卡片右键：启动、Finder 显示、复制路径、打开/创建应用笔记、编辑器打开当前库、终端进入笔记目录。
- 星标置顶、拖拽排序、分类导航、网格/列表视图切换。
- 快速启动面板（Cmd+Shift+Space）：搜应用、搜场景，回车启动。
