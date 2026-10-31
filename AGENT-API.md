# Mac App Launcher — Agent 接入说明

插件运行时会在本机启动一个仅绑定 `127.0.0.1` 的 HTTP API。YOLO 或其他 Agent 如果可以调用终端命令、HTTP 请求或 `curl`，即可通过这个 API 让插件启动 Mac 客户端。

## 第一步：从 Obsidian 获取连接信息

打开 Mac App Launcher → 管理应用 → Agent 启动接口。

复制：
- Base URL（默认 `http://127.0.0.1:43171`，端口冲突时可能自动变化）
- Bearer Token

不要把 Token 分享给不可信的人或远程服务。

## 第二步：查询可启动应用

```bash
curl -s "http://127.0.0.1:43171/v1/apps" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

只会返回 Obsidian 插件中已经勾选展示的应用。

## 第三步：启动指定应用

```bash
curl -s -X POST "http://127.0.0.1:43171/v1/launch" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"app":"ChatGPT"}'
```

也可用应用 ID：
```json
{"id":"APP_ID"}
```

## Agent 的建议系统指令

当用户要求打开、启动或切换到某个 Mac 客户端时：
1. 请求 `GET /v1/apps` 获取当前允许启动的应用列表。
2. 只使用列表中精确匹配的 `name` 或 `id`。
3. 请求 `POST /v1/launch` 启动该应用。
4. 根据 API 返回的 `ok` 字段判断是否成功。
5. 如果应用不在列表中，告知用户先在 Obsidian 的 Mac App Launcher 中勾选该应用。
6. 不要猜测路径，不要执行任意 `open` 命令来绕过插件的允许列表。

## 接口

- `GET /v1/health`：健康检查，无需令牌。
- `GET /v1/apps`：返回已勾选的应用。
- `GET /v1/apps?category=AI助手`：按分类筛选。
- `GET /v1/categories`：返回分类列表。
- `POST /v1/launch`：启动指定应用。

除健康检查外均需要 `Authorization: Bearer YOUR_TOKEN`。

## 安全边界

- API 只监听 `127.0.0.1`，不是局域网服务。
- 所有启动目标都从插件保存的已勾选应用列表中解析。
- API 不接受任意 `.app` 路径，也不提供 shell 执行接口。
- 退出 Obsidian 或禁用插件后，API 停止。
- 可在插件管理页面重置 Token。
