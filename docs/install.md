# 安装与使用

> 平台：Windows 10/11 + Microsoft Edge（桌面端）。需要本机已安装并可运行 DeepSeek Harness（desktop profile）。

## 1. 前置检查

- Edge：任意近期稳定版（MV3 支持）。
- DSH：`dsh --version` 能正常输出；桌面端能正常打开（本机有登录态，侧栏复用该登录态，不需要另外配 API Key）。
- Node.js：仓库脚本用 Node 运行（建议 20+）。

## 2. 安装 DSH 宿主插件（本机桥）

```bash
git clone <仓库地址> windowseat
cd windowseat
node scripts/dev-install.mjs desktop
```

脚本会做三件事：

1. 把本仓库以 `link:` 方式加进 `desktop` profile 的依赖；
2. 在 `dsh.profile.bundles` 里追加 `windowseat-bridge`；
3. 写入/更新 profile 的 `cordis.patch.yml`，触发 DSH 热重组。

若想手动安装，等价步骤：

```bash
dsh plugin --profile desktop add link:<仓库绝对路径>
```

然后在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 末尾追加：

```json
"windowseat-bridge"
```

再在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 追加 bridge 配置（可选）：

```yaml
- id: windowseat-bridge
  config:
    reasoningEffort: off   # off | low | high | max
    debug: false
    # idleMs: 120000
    # maxStreamMs: 600000
```

保存后约 3–5 秒热生效；确认桥已启动：

```bash
curl http://127.0.0.1:34281/windowseat/health
# {"ok":true,"name":"windowseat-bridge","version":"0.6.0", ...}
```

端口被占用时会自动尝试 34282、34283，并写入 `%USERPROFILE%\.dsh\windowseat-port`（扩展按同样顺序探测）。

## 3. 加载 Edge 扩展

1. 地址栏打开 `edge://extensions`；
2. 打开「开发人员模式」；
3. 点「加载解压缩的扩展」，选择 `<仓库路径>\extension`；
4. 点浏览器工具栏的扩展图标（或 `Alt+Shift+P`，若未分配快捷键可在 `edge://extensions/shortcuts` 手动绑定）打开侧边栏。

## 4. 验证

- 侧边栏顶部显示「已连接」绿点；
- 在任意网页选中一段文字 → 浮条出现 → 点「解释」→ 侧栏自动带入选中内容并流式回答；
- 点输入框上方「协同小队」可查看本会话的 Agent Team（如果该会话里创建过队员）。

## 5. 更新与卸载

- 更新：`git pull` 后在 `edge://extensions` 点扩展的「重新加载」；如 bridge 代码有更新，触发一次 profile 热重组（改一下 `cordis.patch.yml`）或重启 DSH。
- 卸载：`edge://extensions` 移除扩展；`dsh plugin --profile desktop remove windowseat-bridge`；删除 `%USERPROFILE%\.dsh\windowseat-*.json` 与 `windowseat-bridge.log`。

## 6. 本地文件白名单

默认只索引 `%USERPROFILE%\Documents`（如果该目录存在）。要加入其它目录：

- 面板右上角「滑块」图标 → 设置 → 本地文件白名单 → 添加目录；
- 或直接编辑 `%USERPROFILE%\.dsh\windowseat-files.json`：

```json
{ "dirs": ["C:\\Users\\<你>\\Documents", "D:\\资料"] }
```

白名单外的路径会被拒绝（403 `path_not_allowed`）；只读引用，不写盘、不删除。

## 7. 常见问题

**Q：侧边栏一直「未连接」？**

1. `curl http://127.0.0.1:34281/windowseat/health` 是否返回 200；
2. 端口被别的进程占用时看 `%USERPROFILE%\.dsh\windowseat-port`；
3. 扩展依次探测 34281/34282/34283，点面板里的「重新检测」。

**Q：回答很慢 / 首字很久？**

面板设置里把「思考强度」设为「关」或「快」（`off` / `low`）；默认已经是 `off`。

**Q：快捷键 `Alt+Shift+P` 没反应？**

命令行加载的扩展可能没有分配快捷键，在 `edge://extensions/shortcuts` 里手动绑定。

**Q：能在 `edge://` 内置页使用吗？**

不能，浏览器不允许扩展注入内置页；其它 `http(s)` 页面可以。

## 8. 安全说明

- 桥只监听 `127.0.0.1`，并校验 Host 与扩展 Origin；
- 页面内容、本地文件、截图在本机链路里流转；扩展自身不上传，模型推理是否走云端取决于你的 DSH 配置；
- 扩展无远程代码、无遥测；文件检索只读。

更多见 [SECURITY.md](../SECURITY.md) 与 [PRIVACY.md](../PRIVACY.md)。
