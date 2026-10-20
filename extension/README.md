# 临窗 Windowseat · Edge 侧边栏扩展（M0）

MV3 扩展：任意网页划词 → 侧边栏流式解释 / 翻译 / 总结 / 追问 / 存到临窗。
纯原生 JS，无构建、无远程代码；只与本机 loopback 上的 DSH 通信（`http://127.0.0.1:34281` 起，逐端口 34281→34282→34283）。
接口契约见仓库根 `CONTRACT.md`。

## 安装（Edge）

1. 打开 `edge://extensions`，开启「开发人员模式」。
2. 「加载解压缩的扩展」选择本目录 `github/windowseat/extension`。
3. 启动 DSH 桌面端（桥会在 `127.0.0.1:34281` 起服务）。
4. 点工具栏的临窗图标，或按 `Alt+Shift+P` 打开侧边栏；连接状态点变绿即就绪。

## 文件

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | MV3 清单：side_panel、content_scripts（`<all_urls>`）、service worker、命令 `Alt+Shift+P`、contextMenus |
| `background.js` | 端口探测 `34281→34282→34283` 的 `/windowseat/health`、状态广播、content→sidepanel 消息路由、划词动作缓存并打开侧栏、右键菜单 |
| `content.js` / `content.css` | 划词浮条（Shadow DOM 隔离，`Esc` 关闭）；上报 `{title,url,selection,description}`；对页面样式零侵入 |
| `sidepanel.html/.css/.js` | 侧栏：顶栏品牌 + 连接状态 + 新会话、上下文 chips、消息流（停止/重试/复制、流式光标）、composer、未连接三步引导、刷新后恢复会话 |
| `assets/` | 官方品牌资产（`brand-mark.svg`、`brand-wordmark-blue.svg`，未改色未拉伸） |
| `icons/` | 16/32/48/128 PNG 图标（由官方 App 图标等比缩放生成，非空白占位） |

## 调试

- `sidepanel.html?mock=1`：无需 chrome API / 桥，用内置假对话渲染（截图与设计走查用）。
  - 追加 `&scenario=onboard|welcome|streaming|error|long` 切换未连接引导 / 欢迎页 / 流式中 / 错误态 / 两轮长对话。
  - 追加 `&scroll=bottom` 打开即滚到底部。
- `sidepanel.html?port=34282`：强制指定桥端口（本地假桥联调用，不写 storage、不影响正常探测）。

## 权限说明

- `sidePanel`：打开浏览器侧边栏。
- `activeTab` / `scripting`：读取当前标签页标题、URL 与摘要（页面内 content script 不可用时兜底注入）。
- `tabs`：取当前窗口活动标签页；`storage`：会话与状态持久化；`contextMenus`：右键「存到临窗」。
- `host_permissions: ["http://127.0.0.1/*"]`：只访问本机回环上的 DSH，不含任何外部域名。

## 已知限制（M0）

- 页面选择器浮条不注入浏览器内置页（`edge://`、`chrome://`、扩展商店等）。
- 首次连接需要 DSH 已启动；若端口被占用，按 34281→34282→34283 顺序回退。
- 真实 DSH 桥当前为 M0 版本，空回答会显示「本机 DSH 返回了空内容」并提供重试（等待桥后续完善）。
- `Alt+Shift+P` 的全局快捷键在无头（headless）环境下不会分配，需在真实 Edge 窗口验证。
