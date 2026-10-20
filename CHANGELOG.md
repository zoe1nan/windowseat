# 更新日志

本项目遵循语义化版本；日期为发布日。

## 0.6.0 — 2026-10-20

公开发布前的安全加固版。

- 安全：新增统一门禁 `lib/http.js`（Host + Origin 白名单 + `Sec-Fetch-Site` 判定 + `application/json` 强制 + 24MB 上限）
- 安全：bridge/files/sessions 所有 handler 统一调用门禁；CORS 只回显白名单来源；固定 `manifest.key` 后只信任本扩展 ID
- 安全：文件白名单拒绝盘符根 / 系统目录 / 凭据目录**及其祖先目录**（封堵 Documents.. 之类父目录绕过）；错误信息不再回显绝对路径；500 不泄漏内部消息
- 修复：/windowseat/files 与 /windowseat/sessions 端点此前只校验 Host、未校验来源，可被跨站页面 CSRF（已修复）
- 修复：sessions DELETE 非法 ID 会抛异常（已改为 400）
- 文档：隐私表述与实际数据流对齐（本机桥接；云端模型配置下由 DSH 转发）
- 仓库：公开前隐私清理、LICENSE/NOTICE/SECURITY/PRIVACY/CI/隐私守卫

## 0.5.0 — 2026-10-19

M1 首个完整版本。

- 新增：设置抽屉（思考强度 off/low/high/max、本地文件白名单、快捷键说明、版本）
- 新增：Markdown 渲染增强（表格、代码块语言标签 + 一键复制、链接、段内换行）
- 新增：协同小队只读 dock（DSH `agentTeam` 投影：成员 phase、共享任务状态）
- 新增：`GET/POST /windowseat/settings`，设置持久化到 `~/.dsh/windowseat-settings.json`
- 修复：默认 cwd 与默认文件白名单不再写死开发机路径

## 0.4.0 — 2026-10-19

- 新增：协同小队 dock 初版（成员 / 任务 / 进度，展开每 8 秒刷新）
- 新增：`GET /windowseat/team?sessionId=`（只读，未启用 Agent Team 时返回 lead 兜底）

## 0.3.0 — 2026-10-19

- 新增：截图提问（`captureVisibleTab` → 图片随消息发给本机视觉模型，最多 4 张）
- 新增：`/windowseat/chat` 支持 `images` 字段；面板缩略图 / 多图 / 发送后清理

## 0.2.0 — 2026-10-19

- 新增：`@` 本地文件检索（白名单只读、@ 浮层、文件正文随消息发送）
- 新增：历史会话（列表 / 搜索 / 分页 / 重命名 / 删除 / 切回续聊）
- 新增：页面上下文自动刷新、断线自动重连（指数退避）、演示启动脚本
- 新增：`/windowseat/files/{search,read,config}`、`/windowseat/sessions*`

## 0.1.2 — 2026-10-19

- 修复：「总结此页」拿不到页面正文（content script 采集正文摘录 ≤8000 字，面板 payload 补 `text`，提示词禁止模型调工具抓页面）
- 修复：扩展启动后已打开标签页缺少 content script（启动 / 页面完成时补注入）

## 0.1.1 — 2026-10-19

- 修复：长回答被固定 180 秒超时误杀 → 改为「120 秒空闲超时 + 600 秒绝对上限」
- 优化：侧栏默认 `reasoningEffort: off`，首字 9.6s → 1.9s；可在配置切回 low/high/max

## 0.1.0 — 2026-10-19

- 首个可玩版本（M0）：Edge 侧边栏（B 浅色 UI）、划词浮条、页面上下文、流式回答、停止/重试、自动重连、本机 loopback bridge。
