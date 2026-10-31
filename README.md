Mac App Launcher
======================

适用：macOS + Obsidian 桌面版（Intel / Apple Silicon）。

本版重点：
1. 置顶应用直接显示在应用中心顶部“常用应用”区域，不创建置顶文件夹、分类或导航入口。
2. 置顶只是显示优先级，不改变应用原有分类；取消置顶后回到原分类和普通排序。
3. 拖动置顶卡片排序时，不改变软件原有分类。
4. 增加本机 Agent API：YOLO、Claude Code、Codex 或其他能调用本机 HTTP / curl 的 Agent，可查询已勾选应用并请求插件启动客户端。
5. API 只监听 127.0.0.1，并要求随机访问令牌；Agent 只能启动用户在插件中勾选展示的应用，不接受任意程序路径或 shell 命令。
6. 保留扫描、原生图标、分类、应用资料卡、编辑用途和一键启动。

升级：
1. 完全退出 Obsidian（Cmd+Q）。
2. 解压 ZIP。
3. 用 mac-app-launcher 文件夹覆盖当前库的：
   .obsidian/plugins/mac-app-launcher/
4. 保留旧目录中的 data.json（不要删除），icons 文件夹也可保留。
5. 重新打开 Obsidian。
6. 打开“管理应用”，页面顶部会显示 Agent 启动接口、接口地址和访问令牌。

Agent API：
- Base URL: http://127.0.0.1:43171
  注意：若默认端口已被占用，插件会自动选一个可用端口；以 Obsidian 管理页面显示的端口为准。
- 所有 API（除健康检查）都要带请求头：
  Authorization: Bearer <管理页面显示的访问令牌>

1) 检查服务：
curl http://127.0.0.1:43171/v1/health

2) 查询已勾选、允许 Agent 启动的应用：
curl -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:43171/v1/apps

3) 查询分类：
curl -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:43171/v1/categories

4) 启动应用（按准确名称匹配）：
curl -X POST http://127.0.0.1:43171/v1/launch \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"app":"ChatGPT"}'

也可以按应用 id 启动：
-d '{"id":"应用ID"}'

Agent 推荐指令：
“当我要求打开某个 Mac 客户端时，先调用 Mac App Launcher 的 GET /v1/apps 查询允许启动的软件；如果用户指定的软件在列表中，调用 POST /v1/launch，传入精确 app 名称或 id。不要自行使用 open 命令或猜测应用路径。如果应用不在列表中，告诉我先在 Obsidian 插件里勾选该应用。”

安全：
- 服务仅绑定 127.0.0.1，不对局域网开放。
- 使用随机 Bearer Token 认证。
- Agent 仅能启动插件中已勾选的应用。
- 不支持任意路径、任意命令或远程主机控制。
- 在管理页面点击“重置访问令牌”可立即使旧令牌失效。
- 退出 Obsidian 后，本机 API 服务随插件停止。

应用中心：
- 点击应用卡片：打开介绍资料卡。
- 在资料卡点击“打开 XXX”：启动应用。
- 点击星标：将应用直接提升到页面顶部；取消星标后回到原分类。
- 拖动两个置顶应用之间的卡片：只调整置顶顺序，不改变分类。
- 拖动普通应用到另一个分类的卡片：移动到目标分类并调整顺序。
- 点击分类导航：筛选该分类；该分类中已置顶应用仍显示在内容顶部。
- 点击“编辑介绍”：自定义软件功能介绍和用途。
