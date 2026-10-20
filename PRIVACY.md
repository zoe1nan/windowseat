# 隐私说明

临窗 Windowseat 是**纯本地桥接**工具：扩展不收集、不向任何自有服务器上传、不把页面/文件原文落盘。页面内容会经由本机桥交给本机的 DeepSeek Harness（DSH）处理；如果你的 DSH 使用云端模型，内容会由 DSH 按你的配置发送给对应模型提供方。

## 会接触到的数据

| 数据 | 用途 | 去向 |
|---|---|---|
| 当前页面标题 / URL | 作为提问上下文 | 只发给本机 DSH |
| 选中文字 / 正文摘录（≤8000 字） | 作为提问上下文 | 只发给本机 DSH |
| 当前页面截图（你主动点「截图」时） | 视觉提问 | 只发给本机 DSH |
| 白名单目录内文件正文（你主动 @ 时） | 文件问答 | 只发给本机 DSH |
| 会话标题与时间 | 历史会话列表 | 存在本机 `%USERPROFILE%\.dsh\windowseat-sessions.json` |
| 面板草稿/最近消息缓存 | 刷新后恢复面板显示 | 存在浏览器扩展本地存储 `chrome.storage.local`（只在本机，不随账号同步） |
| 设置（思考强度 / 白名单） | 面板设置 | 存在本机 `%USERPROFILE%\.dsh\windowseat-settings.json` |

以上除 DSH 本身外，不会经过任何第三方服务。是否会离开设备，取决于你本机 DSH 配置的模型通道（DeepSeek Harness 自身的行为，与本扩展无关）。

## 不会做的事

- 不收集遥测 / 埋点 / 崩溃上报；
- 扩展自身不上传页面内容、文件内容、截图；是否发往云端由你的 DSH 模型配置决定；
- 不读取浏览历史、书签、密码；
- 不在后台静默截屏或读页面（截图与页面读取由你的操作触发）；
- 不写入你的文件系统（文件检索只读）。

## 本地存储清单

- `%USERPROFILE%\.dsh\windowseat-port` — 桥端口号
- `%USERPROFILE%\.dsh\windowseat-sessions.json` — 历史会话元数据（标题/时间/条数，不含正文）
- `%USERPROFILE%\.dsh\windowseat-settings.json` — 设置
- `%USERPROFILE%\.dsh\windowseat-files.json` — 本地文件白名单
- `%USERPROFILE%\.dsh\windowseat-bridge.log` — 调试日志（仅 `debug: true` 时写入）

删除这些文件即可清除本地痕迹；卸载扩展与桥插件后不再产生新数据。

## 权限说明

| 权限 | 为什么需要 |
|---|---|
| `sidePanel` | 打开侧边栏 |
| `activeTab` / `tabs` | 读取当前标签页标题/URL；截图时定位活动标签 |
| `scripting` | 在页面注入划词浮条与正文采集脚本 |
| `storage` | 记住扩展侧小状态 |
| `contextMenus` | 右键菜单入口 |
| `http://127.0.0.1/*` | 与本机桥通信 |
| `<all_urls>`（host_permissions） | 仅有它才能在任意网页注入划词浮条、截取当前可视页面 |

扩展不使用 `debugger`，不注入 `edge://` 等内置页。

## 演示素材说明

仓库中的截图与宣传片录制于 0.5.0：片中的「数据不出设备」指扩展→本机桥这条链路；0.6.0 起界面文案已改为「本地桥接 · 由本机 DSH 处理」，以免与云端模型配置产生歧义。
