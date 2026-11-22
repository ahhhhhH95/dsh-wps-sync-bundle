# dsh-wps-sync-bundle

把 DeepSeek Harness 的会话、定时任务和工作区同步到本机的 WPS 同步文件夹，供 WPS Office 上传到云盘，并在其他设备上通过同一个同步文件夹取回。

插件不调用 WPS 服务器，也不需要任何第三方账号：它只读写你选定的本地同步目录，剩下的上传/下载交给 WPS Office 自己完成。

## 功能

- **主管理面板**：插件页 →「WPS 云盘同步」；一个面板管理同步文件夹、会话、工作区、定时任务、传输队列、最近问题、远程设备和暂存档案。
- **三个本地列表**：会话、工作区、定时任务。每一行都可以单独「上传」、切换「自动」，并显示最近同步时间与最后一次结果。
- **会话头部控件**：每个会话右上角的工具区只显示当前会话的上传按钮和自动开关，不混入其他会话。
- **同步根选择**：优先调用系统目录选择器；选择器不可用时退回手动路径输入，绝不伪造保存成功。面板会显示检测到的 WPS 同步目录，并校验目录是否可用。
- **远程设备**：扫描同一同步文件夹里其他设备发布的条目，查看版本并「拉取」；拉取只写入 `DSH-Sync/imports`，不会覆盖任何已有内容。
- **暂存档案浏览**：会话转录（`transcript.md` / `session.jsonl`）与任务 JSON 可以只读浏览，明确标注「已下载只读档案，运行时导入不受支持」。
- **工作区恢复**：只对工作区开放。必须显式填写目标文件夹，冲突策略为 `skip`（默认）或 `rename`，永远不提供 `overwrite`；目标也不能是同步根或其子目录。
- **自动同步**：默认开启。会话在每轮结束时由其自动开关决定是否上传，任务目录全局共享一份；工作区按 `workspaceScanIntervalSec` 周期扫描后镜像。启动时会先扫描一次；设为 `0` 只禁用后续周期扫描。
- **队列与错误可见**：写入按序执行，面板显示排队/执行/完成/失败状态，最近错误单独列出。

## 使用

1. 安装并启用插件，打开「插件」页，进入「WPS 云盘同步」。
2. 在「同步文件夹」里点「选择文件夹」，选中 WPS Office 的同步文件夹本身（通常是 `WPS Cloud Files/<账号 ID>`）。若本机没有目录选择器，直接输入绝对路径后保存。
3. 在「会话」「工作区」「定时任务」中按需上传；或点右上角「全部上传」。每行的「自动」开关控制该条目之后是否随轮次/变更自动上传。
4. 在另一台设备上打开同一同步文件夹，点「扫描远程」查看条目，点「拉取」把副本放进暂存档案。
5. 工作区副本可在「暂存档案」里点「恢复」，选择目标文件夹后写入；会话和任务只能浏览。

## 同步目录布局

所有写入都发生在同步根下的 `DSH-Sync/` 中：

```
DSH-Sync/
  manifest.json
  devices/<deviceId>/manifest.json
  conversations/<deviceId>/<slug>-<sessionId>/
    session.jsonl
    transcript.md
    meta.json
  tasks/<deviceId>/scheduled-tasks.json
  workspaces/<deviceId>/<slug>-<workspaceId>/...
  imports/<importId>/...
```

- 相对路径统一使用 `/`，可跨平台搬运。
- 写入前校验 schema 与内容哈希；写入使用隐藏临时文件再重命名，避免半成品。
- `imports/` 暂存目录位于同步根下的 `DSH-Sync/` 内，其中的副本永远不会再次上传（不回传），避免设备之间来回复制。

## 限制

- 不调用任何 WPS API，也不代替 WPS Office 上传；`DSH-Sync` 必须位于 WPS 正在同步的目录里才会进入云端。
- 会话与定时任务没有安全的运行时导入 API：拉取结果是**只读档案**，不会注入当前 DSH 配置。
- 工作区恢复只写文件，不合并、不覆盖；目标目录必须由用户明确指定，且不能位于同步根内。
- 同一时间只处理一个写队列；大文件或大量工作区文件需要等待。
- WPS 的离线占位文件在磁盘上可能尚未水合：上传前需先由 WPS 下载/水合，或将该文件设为“本地可用”，否则读取可能失败或超时。
- 单个文件读取默认超过 120 秒会以 `copy-timeout` 结束本次上传任务，队列不会永久卡死，后续自动同步仍会重试；可用环境变量 `DSH_WPS_SYNC_COPY_TIMEOUT_MS` 调整超时（单位毫秒，`0` = 不限制，不推荐）。
- UI 不轮询会话事件；需要最新状态时点「刷新」，写操作完成后会自动刷新一次。

## 常见问题（Troubleshooting）

### 面板显示“无法连接同步服务”

- **现象**：插件页里的列表一直加载不出来，面板提示无法连接同步服务。
- **原因**：页面还停在旧的 Host 端口上。`dsh web` 每次启动都会换端口，旧标签页的前端仍向旧地址请求 `/api/wps-sync/state`，自然拿不到状态。
- **做法**：重新打开 `dsh web` 打印的 URL；桌面版按 `Ctrl+Shift+R` 硬刷新。客户端现在把“端口过期/网络层失败”和“没有可用传输通道”分成 `stale_endpoint` 与 `no_transport` 两个错误码，提示文案也不同：前者让你重新打开 URL 或硬刷新，后者提示改用 localhost 或重新加载页面。

### 桌面版（Electron）为什么不需要 CORS

- **现象**：桌面版里插件能正常访问本机 Host，但服务端没有任何 `Access-Control-*` 响应头；换一个 Origin 直接请求则会被拒绝。
- **原因**：桌面渲染器的页面来源是自定义协议 `dsh-app://app`，不是 http(s)。请求由 Electron 的 `forwardWebRequest` 转发到 loopback 宿主：转发时会去掉 `origin`/`host`/`cookie`，再由宿主侧补回。宿主因此只按 loopback Host 做围栏，Origin 缺失可以接受，存在则必须是同 authority 的 http(s) 或桌面自定义协议。
- **做法**：不要“顺手”加 CORS，也不要把客户端改成绝对 URL。客户端始终用相对 URL（`/api/wps-sync/...`），插件服务端永不发送 `Access-Control-*` 头；陌生 Origin 一律拒绝（`wps-sync/forbidden-origin`），跨站的 `Sec-Fetch-Site: cross-site` 也拒绝（`wps-sync/forbidden-site`）。

### `wps_sync_status` 里的 `routes` 怎么看

- **现象**：插件已启用，但请求 404 或连不上；`wps_sync_status` 返回里有一组 `routes` 字段，不知道哪个才表示出问题。
- **原因**：插件有 HTTP（`/api/wps-sync`）和 RPC（`/wps-sync`）两条通道，任一条挂载失败都会单独记录。`routes` 只反映挂载结果，不是业务数据。
- **做法**：
  - `routes.http` / `routes.rpc` 的取值是 `mounted`（已挂上）、`duplicate`（路径被占用，正在有界重试）、`failed`（最终失败）、`absent`（该通道没有注册，例如 RPC 不可用时由 webServer 兜底）。
  - `routes.detail` 可选，给出失败或重试的具体原因（如 `duplicate prefix route`、自检超时）。
  - `routes.history` 有事件时才出现，是最近 8 条路由事件的环形缓冲，每条为 `code | where | message` 字符串。某些宿主上 `connection.rpc.handle` 注册会失败，插件会自动回退到 webServer 兜底路由；这类中途事件只留在 `history`，属于已自愈，不会进用户可见的 `errors[]`。
  - 只有**最终没挂上**才会进 `errors[]`，代码是 `wps-sync/route-http-failed` 或 `wps-sync/route-rpc-*`（如 `route-rpc-failed`、`route-rpc-duplicate`、`route-rpc-effect-failed`）。面板只列 `errors[]`，要看 `routes` 请直接调用 `wps_sync_status`。

### 恢复（restore）的冲突策略

- **现象**：恢复工作区时目标目录已有同名文件，不确定会不会被覆盖。
- **原因**：恢复只支持 `skip` 与 `rename` 两种冲突策略，二者都不覆盖已有文件。
- **做法**：`skip`（默认）遇到已存在文件就跳过，计入 `skipped`；`rename` 改名写入，形如 `README (2).md`，计入 `renamed`。没有 `overwrite` 选项。恢复目标必须显式指定为绝对路径，且不能位于同步目录内，否则报 `wps-sync/target-in-sync-root`。恢复只对工作区开放；会话和定时任务只能作为只读归档浏览（`runtimeImportSupported:false`），不要写成“可恢复”。

## 配置项

`cordis.patch.yml` 中的默认配置（可在插件页修改）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `syncRootDir` | `''` | 同步根；留空时使用检测到的 WPS 同步目录 |
| `autoSync` | `true` | 新条目的自动同步默认值 |
| `excludePatterns` | `node_modules`, `.git`, `dist`, `*.log` | 工作区镜像排除项 |
| `maxFileSizeMB` | `20` | 单个镜像文件上限（MB） |
| `workspaceScanIntervalSec` | `60` | 工作区扫描间隔（秒） |
| `taskHistoryLimit` | `50` | 每个计划任务保留的投递记录数 |
| `debounceMs` | `1500` | 轮次结束/计划变更后的合并窗口（毫秒） |
| `deviceName` | `''` | 自定义设备名；留空时使用系统主机名 |

## Agent 工具

- `wps_sync_list`：列出会话/工作区/任务及同步状态。
- `wps_sync_upload`：上传单个条目或全部。
- `wps_sync_set_auto`：开关自动同步。
- `wps_sync_status`：读取同步目录、队列、错误与导入记录。
- `wps_sync_remote_list`：列出其他设备发布的条目。
- `wps_sync_pull`：拉取到暂存档案。
- `wps_sync_restore`：把工作区档案恢复到显式目标目录。

## 开发与校验

Host 侧通过 `webServer` 暴露 `GET/POST /api/wps-sync/*`，并对写请求校验 `x-wps-sync-token`；桌面端也可通过 `/wps-sync` RPC 通道转发。Client 只依赖浏览器模块表中的 `react`（可选 `react-dom` 仅用于弹层 portal），不引用任何 `@deepseek-ai/*` 客户端包。

```powershell
node --check client.js
```

本项目未附带浏览器测试环境；面板与会话头部控件的实际渲染、主题适配和目录选择器行为需要在真实 DSH Web GUI 中人工验证。

## 文件

```
client.js        React Client（无 JSX，__ModuleLoader__）
locale/en.json   英文元数据
locale/zh.json   中文元数据
icon.svg         36×36 插件图标
docs/DETAIL.md   英文详情页（单图）
docs/DETAIL.zh.md 中文详情页（单图）
docs/preview.svg 640×300 预览图
lib/             Host 同步引擎、桥接、工具
index.js         Host 入口
```