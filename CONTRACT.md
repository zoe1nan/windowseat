# 临窗 Windowseat · 集成契约（0.6.0）

> 本文件是 bridge（DSH 宿主插件）与 Edge 扩展之间的唯一接口契约。M0 目标是「真实 Edge 里可玩」：侧边栏面板 + 选文/页面上下文 + 流式回答 + 自动重连；M1 已加 @ 本地文件、历史会话、截图提问、协同小队、设置。
> 各自实现必须严格按本文件；接口变更先改本文件再改代码。

## 1. 架构与进程

```
Edge 扩展 (MV3)                        本机 DSH（已运行）
┌──────────────────────────┐          ┌─────────────────────────────┐
│ sidepanel.html  ← 面板 UI │  HTTP/SSE │ windowseat-bridge（宿主插件）│
│ content_script  选文/页面 │ ────────▶ │  · 自起 http://127.0.0.1:34281..3 │
│ background(sw)  端口探测  │          │  · ctx.get('sessionController') │
└──────────────────────────┘          │  · agent/assistant-stream → SSE │
                                       └─────────────────────────────┘
```

- 桥接插件自己用 `node:http` 起服务，**不依赖 DSH web 端口**；只 bind `127.0.0.1`。
- 端口候选：`34281 → 34282 → 34283`，占用则顺延；成功后写 `~/.dsh/windowseat-port`（内容为端口号），扩展启动时先读该文件作为提示，再依次探测 `/windowseat/health`。
- 扩展只与本机回环桥通信，无自有云服务、无遥测。页面内容由本机 DSH 处理；DSH 若配置云端模型，会按 DSH 配置转发给模型提供方（扩展不直接访问外网）。

## 2. 扩展 ↔ 桥 契约（0.6.0）

安全门禁（所有 handler 统一调用 `lib/http.js` 的 `assertRequestAllowed`）：
- **Host**：必须是 `127.0.0.1:<port>` 或 `localhost:<port>`（防 DNS rebinding）；
- **Origin**：有 Origin 时必须在白名单（默认只有钉了 `manifest.key` 的本扩展 `chrome-extension://dkbhbbgajakmcgphebiallphkacekbhh`），CORS 只回显白名单 Origin 并带 `Vary: Origin`；
- 无 Origin 时按 `Sec-Fetch-Site` 区分：`none`/缺省放行（本机进程、扩展 GET），`same-origin/same-site/cross-site` 拒绝；
- **Content-Type**：POST 必须是 `application/json`（否则 415）；请求体上限 24MB；
- `OPTIONS` 预检通过门禁后 204；错误统一 `{ok:false,error:{code,message}}`，500 不泄漏内部消息。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/windowseat/health` | — | `{ ok:true, name:"windowseat-bridge", version:"0.6.0", pid, at }` |
| POST | `/windowseat/session` | `{}` | `{ ok:true, sessionId }` |
| POST | `/windowseat/chat` | `{ sessionId?, text, page?: { title, url, selection?, description?, text? }, attachments?: [...], images?: [{ mediaType, data, name? }] }` | `text/event-stream`（见 §3） |
| POST | `/windowseat/stop` | `{ sessionId }` | `{ ok:true }` |

约定：
- `sessionId` 省略时由桥内部创建/复用一个会话；M0 允许扩展每次打开面板新建会话，聊天中复用。
- 桥把所有 `page` 字段拼成上下文前缀放进用户消息（不改动用户原文，只加前缀块）：
  ```
  页面：{title}
  URL：{url}
  选中：{selection}
  摘要：{description}
  ---
  {text}
  ```
- 错误统一 `{ ok:false, error:{ code, message } }`。
- 截图（0.3.0 起）：`images` 为纯 base64（不含 `data:` 前缀），`mediaType` 只接受 `image/png|image/jpeg|image/webp`，单张 base64 ≤ 4MB、最多 4 张；桥把文本与图片一起拼进 `sessionController.prompt` 的 content parts：`[{type:'text',text}, {type:'image',mediaType,data,name}]`。

## 3. SSE 流格式（`POST /windowseat/chat`）

响应头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache`、`Connection: keep-alive`。
每条事件为 `data: <json>\n\n`，JSON 形如：

| type | 字段 | 说明 |
|---|---|---|
| `meta` | `{ sessionId }` | 流开始 |
| `delta` | `{ text }` | 增量文本（可多段） |
| `done` | `{ ok:true }` | 正常结束 |
| `error` | `{ code, message }` | 失败（随后关闭流） |
| `stopped` | `{}` | 被 `/stop` 中止 |

- 客户端断开时桥要清理监听；`/stop` 之后最多 2s 内必须发 `stopped` 并结束流。
- 心跳：每 15s 发一条注释行 `: ping\n\n`（可选，M0 不强制）。

## 4. 已验证的 DSH 宿主 API（bridge 直接用）

> 2026-10-19 在真实 desktop profile 上实测通过（HMR 热装探针）：`sessionController.create` + `prompt` + `agent/assistant-stream` 可端到端拿到流式文本（1.9s 返回「你好」）。

```js
// inject: ['webServer'] 不是必须；bridge 自起 node:http，不需要 webServer。
const sc = ctx.get('sessionController')

// 1) 建会话（cwd 传仓库目录或用户工作目录）
const created = await sc.create({ cwd: process.cwd() })
// → { sessionId, agentPreset: 'standard' }

// 2) 发消息（第二个参数必须是 AbortSignal）
const ac = new AbortController()
await sc.prompt(
  { sessionId, content: [{ type: 'text', text: message }], requestId: randomUUID() },
  ac.signal,
)

// 3) 流式文本：全局事件，用 attemptId 前缀过滤本会话
ctx.on('agent/assistant-stream', ({ frame }) => {
  if (!frame.attemptId.startsWith(sessionId + ':')) return
  if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') emitDelta(frame.chunk.text)
  if (frame.type === 'end') emitDone(frame.outcome?.kind === 'committed')
})

// 4) 中止：调用 controller 的 cancel（签名以 lib/types/commands.js 为准；bridge 侧先 try 两种形态）
await sc.cancel({ sessionId })
```

- `frame` 的 chunk 类型除 `text-delta` 还有 `reasoning-delta`、`tool-call-delta`、`block-start`、`finish`；M0 只透传 `text-delta`，其余忽略（可选把 finish 转 done）。
- 监听器要用 `ctx.effect(() => ctx.on(...))` 注册，随插件卸载自动清理。
- 会话可复用：同一 `sessionId` 多次 `prompt` 即多轮对话。

## 5. 扩展 MVP（M0）验收

1. Edge 加载未打包扩展后，点击工具栏图标打开侧边栏（或 `Alt+Shift+P`）。
2. 面板显示品牌：官方 wordmark（`assets/brand-wordmark-blue.svg` 复制进扩展）或 「临窗 Windowseat」文字 + 官方蓝 #4D6BFE；无单字头像/圆形首字母。
3. 连接状态：探测 34281→34283，失败显示「未连接，请先启动 DSH」；成功绿点「已连接」。
4. 任意网页选中一段文字 → 页面浮条「解释 / 翻译 / 总结 / 追问 / 存到临窗」出现；点任一动作 → 面板自动打开、带入选中文本与页面信息并发送。
5. 面板对话区流式显示回答（可停止、可重试）；回答里不出现 `agent`/`session` 之类的内部字段。
6. 浏览器重启 / DSH 重启后：面板刷新能自动重连，旧会话给出「继续」入口。
7. 320/400/560px 宽度下不重叠、不裁切；中文微软雅黑、英文 Segoe UI；字号 ≥12px、正文行高 ≥1.6。

## 6. 目录与写入范围（避免多人互踩）

| 路径 | Owner | 内容 |
|---|---|---|
| `github/windowseat/index.js` | bridge-dev | 宿主插件：http server、CORS、sessionController、SSE |
| `github/windowseat/lib/` | bridge-dev | 可选辅助模块 |
| `github/windowseat/extension/` | ext-dev | MV3 全部：manifest、sidepanel、content、background、icons |
| `github/windowseat/package.json`、`cordis.patch.yml` | lead | 插件清单/补丁，勿改 |
| `github/windowseat/CONTRACT.md` | lead | 本文件，勿改（有异议发消息） |
| `github/windowseat/docs/` | lead | 安装与演示脚本 |

UI 方向：浅色、品牌蓝 #4D6BFE、圆角玻璃与胶囊（视觉稿见 README 截图）。

## 7. 本地调试

```bash
# 桥健康
curl -s http://127.0.0.1:34281/windowseat/health
# 建会话
curl -s -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:34281/windowseat/session
# 流式聊天（-N 关闭缓冲）
curl -sN -X POST -H 'Content-Type: application/json' \
  -d '{"text":"只回复两个字：你好"}' http://127.0.0.1:34281/windowseat/chat
```

安装：`dsh plugin --profile desktop add link:<仓库绝对路径>` + profile `dsh.profile.bundles` 追加 `"windowseat-bridge"`，然后改 `cordis.patch.yml` 触发 HMR。

## 8. 边界（M0 不做）

- 不做本地文件检索、多 agent 协同、审批卡、截图、Markdown 完整渲染（只做安全纯文本 + 代码块等宽）。
- 不用 `<iframe>`；不做自由拖拽；不申请 `debugger`/`<all_urls>` 常驻注入之外的权限。
- 不引入任何远程代码/远程配置（Edge 商店审核红线）。

## 9. @本地文件检索（M1，插件 0.1.2 新增）

> 本章由 files-dev 在 task-11 追加。§8「M0 不做本地文件检索」一条自 0.1.2 起不再适用，
> 其余边界（无远程代码、无云端上传、仅本机 loopback）保持不变。

### 9.1 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/windowseat/files/search?q=&limit=` | 按文件名 / 相对路径模糊匹配白名单目录内的文件 |
| GET | `/windowseat/files/read?path=` | 读取单个文件内容（文本 ≤200KB；二进制只返回元信息） |
| GET | `/windowseat/files/config` | 读取当前白名单与配置来源 |
| POST | `/windowseat/files/config` | 增删白名单（`add` / `remove`，或 `dirs` 整表替换） |

全部为只读语义（`POST /config` 只改插件自己的白名单文件）。统一安全门禁（Host + Origin 白名单 + `Sec-Fetch-Site` + `Content-Type: application/json` + 24MB body 上限）、CORS 只回显白名单来源、`OPTIONS 204`、
错误结构（`{ok:false,error:{code,message}}`）与 §2 其它端点完全一致；未知子路径返回 `404 not_found`。

### 9.2 `GET /search`

- `q`：关键词，可含空格（按 token 匹配文件名与相对路径；空 `q` = 最近修改的文件）。
- `limit`：默认 8，范围 1–20。
- 返回：

```json
{
  "ok": true,
  "query": "sched",
  "limit": 8,
  "results": [
    {"name": "scheduler-notes-2026-09.md", "path": "D:\demo\workspace\scheduler-notes-2026-09.md",
     "dir": "D:\demo\workspace", "rel": "windowseat-demo\scheduler-notes-2026-09.md",
     "size": 848, "mtime": 1792407589257.28, "mtimeIso": "2026-10-19T10:59:49.257Z", "ext": ".md"}
  ],
  "elapsedMs": 28,
  "scanned": 553,
  "truncated": false,
  "whitelist": ["%USERPROFILE%\\Documents"],
  "missingDirs": []
}
```

`scanned` 为实际遍历条目数；扫描有 `MAX_SCAN_MS`（1.5s）/`MAX_SCAN_ENTRIES`（30000）上限，
超限时 `truncated: true`。`missingDirs` 列出白名单里不存在的目录（跳过不报错）。

### 9.3 `GET /read`

- `path`：必须是绝对路径，且 realpath 后落在白名单目录内（否则 `403 path_not_allowed`）。
- 文本文件返回 `kind:"text"` + `text`（最多 200KB，超长 `truncated:true`）；按扩展名/NUL 字节/UTF-8
  合法性识别为二进制时返回 `kind:"binary"` + `text:null` + `reason`，不含正文。
- 返回：

```json
{"ok": true, "file": {"name":"scheduler-notes-2026-09.md", "path":"D:\demo\workspace\...",
  "dir":"D:\demo\workspace", "size":848, "mtime":1792407589257.28,
  "mtimeIso":"2026-10-19T10:59:49.257Z", "ext":".md", "kind":"text",
  "text":"...", "truncated":false, "textBytes":848}}
```

### 9.4 `GET/POST /config`

- 默认白名单：`%USERPROFILE%\Documents`（首次启动时若存在）；最多 20 个目录。系统目录、凭据目录及其**祖先目录**（如 `C:\Users`、`Documents\..`、盘符根）一律拒绝加入；用户根目录本身也不允许。
- `POST` body 支持字符串或字符串数组：

```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{"add":"D:/demo/workspace"}' \
  http://127.0.0.1:34281/windowseat/files/config
curl -s -X POST -H 'Content-Type: application/json' -d '{"remove":["D:/demo/workspace"]}' \
  http://127.0.0.1:34281/windowseat/files/config
```

- 新增目录必须存在且是目录，否则 `400 dir_not_found` / `400 not_a_directory`；空操作 `400 empty_config`。
- 持久化到 `~/.dsh/windowseat-files.json`（可用 env `WINDOWSEAT_FILES_CONFIG` 覆盖），原子写入。

### 9.5 安全边界

- 只读：不提供写入 / 删除 / 移动 / 重命名任何文件的接口。
- 白名单 realpath 校验：拒绝 `..`、符号链接跳到白名单外、以及白名单目录外的一切路径。
- 默认跳过 `node_modules`、`.git`、`.svn`、`.hg`、`__pycache__`、`.cache`、`.next`、`.nuxt`、`.turbo`、
  `.pnpm-store`、`.yarn`、`AppData`、`System Volume Information`、`$Recycle.Bin`、`Windows` 等目录，以及所有 `.` 开头的目录。
- 不跟随符号链接（Dirent.isSymbolicLink 直接跳过）。
- 文件内容只在本机链路（扩展 ↔ 本机 bridge ↔ 本机 DSH）内流转；DSH 若配置云端模型，内容会由 DSH 按配置转发给模型提供方。
- 错误响应不回显服务器绝对路径；500 不泄漏内部 message（详情只写本机日志）。

### 9.6 扩展侧约定

- `extension/files.js` 监听 composer 的 `@`，防抖 150ms 调 `/files/search`；`↑↓` 选择、`Enter`/`Tab` 引用、
  `Esc` 关闭；无匹配显示「没找到，试试文件名/路径关键词」。
- 引用后在 `#ctxRow` 追加 `文件 · 文件名` chip（可点 × 移除）；同时调 `/files/read` 取正文。
- 发送时扩展在 `POST /windowseat/chat` 的 body 里**额外**带上 `attachments: [{path,name,size,kind,text,truncated}]`，
  并把文件正文并入 `text`（当前 bridge 只读 `text`/`page`，`attachments` 会被忽略但保留字段供后续版本使用）。
- 单文件文本上限 200KB；单次最多 6 个附件、合计文本上限 600KB（超出丢弃最旧附件）。

## 10. 历史会话与页面上下文（M1·线路 A，插件 0.1.2 新增）

> 本章由 files-dev 在 task-12 追加。桥只保存**会话元数据**（标题、时间、消息数），不保存消息正文；
> 会话正文仍由 DSH 自己持有，扩展侧面板刷新后通过 `sessionId` 继续对话。

### 10.1 路由表

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/windowseat/sessions?query=&limit=&before=` | 按标题模糊检索历史会话，`updatedAt` 倒序分页 |
| POST | `/windowseat/sessions/rename` | 重命名会话（body：`{sessionId,title}`） |
| DELETE | `/windowseat/sessions/:id` | 删除会话元数据（`:id` 需 URL 编码） |

Host 校验、CORS、`OPTIONS` 预检与错误结构（`{ok:false,error:{code,message}}`）同 §2；未知子路径返回 404。

### 10.2 列表

查询参数：

- `query`：可选，按标题做本地不区分大小写模糊匹配；为空返回全部。
- `limit`：可选，默认 20，最大 50。
- `before`：可选，上一页最后一条的 `updatedAt`（毫秒时间戳），用于加载更早的会话。

返回：

```json
{
  "ok": true,
  "sessions": [
    {
      "sessionId": "session-8f3a…",
      "cwd": "<repo>",
      "title": "根据我本地的调度器文档，Q4 的目标切片大小…",
      "createdAt": 1792409100123,
      "updatedAt": 1792409400456,
      "messageCount": 3
    }
  ],
  "hasMore": false,
  "nextBefore": null,
  "total": 1
}
```

标题规则：取首条用户消息（含 @文件上下文时取 `【用户问题】` 之后的部分）去掉开头 `@文件名` 后，
压缩空白并截前 30 个字符；空消息记为「（无标题）」。最多保留 500 个会话，超出丢弃最旧的。

### 10.3 聊天侧写入

`POST /windowseat/chat` 行为不变（`lib/bridge.js` 未改动）：`sessionId` 可选，传入即复用 DSH 会话。
插件在 HTTP 层旁路监听该请求：

- 请求体里的 `text` 与响应 SSE 第一帧 `{"type":"meta","sessionId":"…"}` 配对后，把该会话写入元数据；
- 首次出现创建记录（`messageCount = 1`），之后每次 `messageCount += 1`、更新 `updatedAt`；
- 流式响应、停止、超时逻辑不受影响；SSE 帧格式仍见 §3。

### 10.4 重命名 / 删除

```bash
curl -s -X POST http://127.0.0.1:34281/windowseat/sessions/rename \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"session-8f3a…","title":"调度器 Q4 目标"}'

curl -s -X DELETE http://127.0.0.1:34281/windowseat/sessions/session-8f3a…
```

- 重命名：`400 invalid_session`（缺 `sessionId`）、`400 invalid_title`（空/超 80 字）、`404 session_not_found`。
- 删除：`404 session_not_found`；返回 `{ok:true,removed:true,sessionId}`。
- 删除只删元数据文件里的记录，不影响 DSH 侧的会话数据。

### 10.5 持久化

- 默认文件：`~/.dsh/windowseat-sessions.json`；可用环境变量 `WINDOWSEAT_SESSIONS_CONFIG` 覆盖。
- 结构：`{"version":1,"updatedAt":<ms>,"sessions":[...]}`；写入为 tmp + rename 原子替换（权限 0600），
  `recordChat` 触发的写盘防抖 500ms，进程退出前由插件 `dispose` 调用 `flush()` 落盘。
- 文件损坏时按空列表启动，不阻塞 bridge。

### 10.6 扩展侧行为

- 顶栏新增「历史」按钮 → 左侧抽屉：标题/相对时间/消息数；搜索框防抖 150ms 调列表接口；
  列表滚到底自动 `before` 分页；当前会话高亮。
- 点击会话：面板清空本地消息后切换到该 `sessionId`（只保留标题），空态显示
  「继续这个会话 + 标题 + 相对时间」，直接提问即接着原 DSH 会话聊。
- 重命名：行内输入框，`Enter`/失焦提交、`Esc` 取消；删除：第一次点击进入确认态，3 秒内再点一次才删除。
- 页面上下文自动刷新：background 监听 `tabs.onActivated` 与 `tabs.onUpdated`（URL 变化、加载完成）后广播
  `{type:'ws/page-changed', page:{title,url}, tabId}`；面板收到后更新页面 chip、清掉失效的选中文本；
  URL 变化那次广播里标题往往还是地址，加载完成时会再广播一次，把 chip 标题换成最终页面标题；
  用户手动 × 掉的页面（同一 URL）本次会话内不再自动加回（离开后返回、同页刷新都不加回）。
- 断连：顶栏状态变为「未连接」，消息流顶部显示「本地 DSH 桥未连接 · 正在重试（n/5）…」条与「立即重试」按钮；
  自动重试 5 次后停止并提示检查 DSH；发送失败的消息保留「重试」按钮，空回答有兜底文案。


## 11. 协同小队（GET /windowseat/team）

`GET /windowseat/team?sessionId=<id>` 读取该会话的 DSH `agentTeam` 投影（只读）。

- 200：`{ ok: true, sessionId, kind: "sequenced" | null, asOfSeq, team: { members: [{ id, name, role, phase }], tasks: [{ id, revision, subject, description, status, blockedBy, writeScopes, ownerName?, ready, writeScopeWarnings }], failure?, note? } }`
- 会话未启用 Team 时返回 lead 单成员 + 空任务板 + `note`；缺 `sessionId` → 400 `invalid_session`；读取超时 → 504 `team_timeout`。
- 侧栏只读展示，不提供写接口；成员创建与任务变更仍由 DSH 主控会话里的 Agent Team 工具完成。

## 12. 设置（M1 新增，bridge 0.5.0）

```
GET  /windowseat/settings
  → 200 { ok, reasoningEffort, efforts:["off","low","high","max"], idleMs, maxStreamMs, settingsFile, version }

POST /windowseat/settings
  body: { reasoningEffort: "off"|"low"|"high"|"max" }
  → 200 { ok, reasoningEffort, idleMs, maxStreamMs, settingsFile }
  → 400 invalid_effort
```

- 持久化：`~/.dsh/windowseat-settings.json`（mode 0600，先写 tmp 再 rename）；启动时读取作为默认值。
- 作用：只对侧栏**新建会话**安装该思考强度（`sessionController.selectModel`），随后把全局默认还原；`fastSelectionApplied` 在修改设置时清空以便新会话重新安装。
- 白名单设置沿用 `GET/POST /windowseat/files/config`（`add` / `remove` / `dirs`），UI 在侧栏设置抽屉内。
