# Changelog

## 0.2.41（修复控制台在 Magpie 沙箱内无法保存设置）

- **根因**：Magpie 用 `sandbox="allow-scripts"`（不含 `allow-forms`）承载插件页面，浏览器在该沙箱内会完全跳过表单提交——`submit` 事件根本不触发。控制台的「保存」按钮原本是 `type="submit"`、事件监听在表单 `submit` 上，因此在 Magpie 内嵌控制台里点击毫无反应；直接调 `/api/settings` 或在普通浏览器标签页打开却完全正常，所以此前难以复现。受影响的不仅是「显示 Cursor 官方模型」，而是整张「可编辑参数」表单。
- 修复：保存按钮改为 `type="button"` 并直接绑定 `click`，表单仍保留 `submit` 兜底；输入框内回车由 `keydown` 拦截后调用同一保存函数。在 `sandbox="allow-scripts"` 的不透明源 iframe 中实测开 → 关 → 开均可保存并触发引擎切换。升级后需要**刷新控制台页面**（已打开的旧页面仍是旧按钮）才能拿到新脚本。
- Windows 写盘加固（次要原因，一并保留）：`lib/bridge-settings.js` 改用与 `lib/settings.js` 相同的原子写，并针对 `EPERM` / `EBUSY` / `EACCES` 短暂重试；读取遇到瞬时占用时沿用上一次成功读取的值，不再回退默认值导致后台用错误模式重启引擎。
- 控制台保存只提交已加载完成的字段：首轮状态尚未返回时数字输入框为空，此前会把空值提交成 `NaN` 并触发严格校验失败；保存后回读校验，若控制台服务仍是升级前驻留内存的旧版本（不认识新字段），会明确提示「完全退出并重启 Magpie」。
- 概览版本行显示「插件版本 · 后台 <后台版本>」，不一致时标黄；开关已保存但引擎尚未切换时，「模型目录」显示「切换中」。
- 新增回归测试：控制台保存按钮不得依赖表单提交（静态断言按钮类型与 click 绑定）；Windows 瞬时 rename 失败重试且不残留临时文件、瞬时读失败复用上次成功值。安装测试的临时目录清理改为带重试的 `rmSync`，消除 Windows 上刚执行过的引擎副本被杀毒软件暂锁导致的偶发 `EPERM` 清理失败。
- 实测两种模式切换：开 → 关 → 开每次约 3–4 秒生效，引擎 PID 变化，代理端口（`http://127.0.0.1:18671`）与控制台服务保持不变，开关可逆。模式是引擎的启动参数（`CURSOR_BRIDGE_OFFICIAL_MODELS`），切换由后台就地重启引擎完成，进行中的对话可能中断一次；零重启热切换需要修改原生引擎（改为按请求读取模式）并重新构建各平台二进制，不在本版范围内。
- 版本号升至 0.2.41；原生引擎不变（`engineVersion` 仍为 0.2.16）。全量测试 129 通过、0 失败、33 项按平台跳过。

## 0.2.40（Cursor 官方模型与 Magpie 模型共存）

- 新增控制台开关「显示 Cursor 官方模型」（`bridge-settings.json` 的 `showOfficialModels`，默认关闭）。开启后 `AvailableModels` / `GetUsableModels` 先透传 Cursor 官方目录，再追加 Magpie 目录：官方模型无角标、按 Cursor 订阅计费；Magpie 模型保留 `MAGPIE` 角标、继续走本地引擎；Cursor 自带的 Auto 随官方目录恢复。关闭时保持原行为——只发布桥接目录、写入 `display_configuration` 隐藏 Auto，并且不请求官方目录。
- 合并失败时安全降级：Cursor 未登录（401）、离线、非 2xx 或无法解析的压缩帧，都会回退到本地目录并记录 `engine.log`，模型菜单不会变成空白，也不会向 Cursor 返回 500。
- 路由不需要新增逻辑：官方模型的 `model_hash` 不在本地模型表中，桥接按既有规则 `mark_upstream` 后原样转发 Cursor 官方；Magpie 模型仍由本地 Agent 引擎处理。
- 控制台状态卡片新增「模型目录」（仅 Magpie / 官方 + Magpie），保存开关后会重启引擎并提示当前对话可能中断一次；顺带修复 `runtime.mode` / `runtime.engineMode` 未透传到控制台、导致「切换中」状态不显示的问题。
- 原生引擎 `engineVersion` 升至 0.2.16（启动开关 `CURSOR_BRIDGE_OFFICIAL_MODELS`、合并回退保护）；插件版本升至 0.2.40。`build-native.sh` 与 `build-native-windows.sh` 的版本校验改为读取 `engineVersion`，与「插件版本与引擎版本可不同」的既有约定一致。
- 验证范围：Rust `model_catalog` 9 项单测通过（含合并与回退），JS 全量 151 项通过；真机验证了开关可逆、关闭时零上游请求、未登录 401 时正确回退本地目录。官方目录返回 200 时的混排、选择官方模型对话与 Auto 可见性依赖已登录的 Cursor 账号，未纳入本次自动化验证；从关闭切到开启后若 Auto 未恢复，重启一次 Cursor 可清除客户端缓存的隐藏状态。

## 0.2.39（修复 Cursor 关闭后无法读取存储）

- 修复「Cursor 完全退出后，Cursor 存储面板读取失败」：报错为 `in prepare, unable to open database file (14)`（`SQLITE_CANTOPEN`）。根因是 Cursor 干净退出时会删除 `state.vscdb-wal` / `state.vscdb-shm`，而 SQLite 的只读连接（`-readonly` / `bun:sqlite` 的 `readonly`）无权创建共享内存文件，第一条语句即失败。此前这形成一个死循环——Cursor 关闭时读不到会话列表、无法选择要删除的内容；Cursor 运行时能读，但删除被进程检测拒绝。
- `control/database.js` 的 `sqlite()` 现在只在真正的 `CANTOPEN` 上回退：以读写连接打开并立即设置 `PRAGMA query_only = ON`，由语句层拒绝任何写入，读取语义不变（实测 `INSERT` 返回 `attempt to write a readonly database`）。回退按数据库路径记忆，`-shm` 重新出现（Cursor 启动）或数据库被移除时自动失效。
- 只读连接默认设置 5 秒 `busy_timeout`：冷启动重建 sidecar 时，面板同一批并发查询（如 `readDatabase` 的一读加三路并发）会短暂争用 WAL 锁，此前约 4/30 的轮次直接报 `database is locked (5)`；等待即可通过，现在由 SQLite 内部重试。
- 回退设置三道安全边界：目标必须是已存在的普通文件，避免读写连接凭空创建空数据库；超时被终止的子进程不重试，避免等待时间翻倍；回退失败时不记录记忆。CLI 与 Bun 两条路径语义一致。
- 未放开删除约束：Cursor 运行中仍拒绝删除与压缩（它会把内存中的会话写回数据库）；关闭 Cursor 后即可在同一面板完成「浏览 → 选择 → 预览 → 删除」。错误提示改为区分「被 Cursor 写入占用」与「文件或目录权限不足」，不再一律建议关闭 Cursor。
- 修复 Linux 上 `cursorRunning()` 的误判：原先 `pgrep -f 'cursor'` 会匹配命令行里含该词的所有进程（包括 Magpie 自身的 `magpie-agent-cursor-bridge` 路径与 `cursor-agent`），导致 Cursor 已退出时仍被判定为运行中、删除永久被拒；现在按可执行名锚定 `(^|/)cursor( |$)`。macOS 与 Windows 的判断未变。
- 新增 4 项回归测试：WAL 库在 sidecar 被删除后仍可读取且拒绝写入、缺失路径不会被创建、冷启动并发读取等待瞬态锁、Cursor 存储面板「关闭态浏览 → 预览 → 删除」端到端用例。全量 157 项，149 通过、8 项按平台跳过。
- 本机实测（48.5 GB / 1271 万页 / 11902 个会话）：概览 479 ms、会话列表首页 16 ms、会话详情 204 ms、统计端点正常返回。
- Cursor 已实测范围升至 3.28.x–3.32.10（3.32.10 已验证）；控制台版本比较、README、使用文档与兼容测试同步更新。
- 版本号升至 0.2.39；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.38（Cursor 存储浏览、诊断与清理）

- 控制台新增「Cursor 存储」折叠卡片，浏览 Cursor 自己的 `globalStorage/state.vscdb`（与桥接的 `bridge.db` 相互独立）。概览显示文件 / WAL / SHM 体积、页数 × 页大小、空闲页、会话总数、主 / 子代理数量、有会话的工作区数与最近写入时间。
- 会话列表读取 `composerHeaders`（约 1.2 万行、13 MB，`recency` 与 `workspaceId` 均有索引），按 `recency` 倒序分页，可按主会话 / 子代理 / 归档筛选；`workspaceStorage/<hash>/workspace.json` 把 `workspaceId` 映射为真实项目路径，列表与筛选项显示项目名。
- 会话列表列序为 ID / 会话 / 项目 / 体积 / 更新时间 / 类型：ID 显示 8 位短值、悬停查看完整 UUID；体积在列表渲染后异步计算——一次请求把当前页 50 个会话的主键区间合并为单条 `UNION ALL` 语句（每个会话的 `bubbleId:` 区间 + `composerData` 行），结果按会话缓存 5 分钟，浏览与会话打开不被体积统计阻塞。
- 会话列表新增时间筛选：最近 7 天 / 1 个月 / 3 个月 / 半年 / 一年，反向的早于 7 天 / 1 个月 / 3 个月 / 半年，或自定义起止日期（按最近活动时间 `lastUpdatedAt`，为 0 的迁移行回退 `createdAt`）；时间参数按毫秒校验后才进入 SQL，非法值视为不限。
- 会话列表新增命名与模式筛选：已命名 / 未命名，以及 agent / chat / multitask；两项都读 `composerHeaders.value` 的 JSON 字段，约 1.2 万行全表判断，无额外扫描成本。
- 筛选区改为带标签的下拉组（项目 / 类型 / 时间 / 命名 / 模式），下拉统一 32 px 高度、圆角与自绘箭头（去掉各平台原生外观差异），「重置」按钮与下拉同高对齐；会话总数显示在重置按钮旁。
- 会话列表默认每页 10 条，可选 10 / 20 / 50 / 100，分页区显示「第 X / Y 页」；切换条数或重置筛选都会回到第一页。
- 会话详情由 `composerData:<composerId>` 单行读取加 `bubbleId:<composerId>:` 主键区间读取组成；消息按 value 内的 `createdAt` 排序（bubble key 是随机 UUID，key 顺序不等于时间顺序）。同一前缀下混有三类行：对话消息（UUID id）、Agent 工具调用（`call_*` id，正文在 `toolFormerData`）、流式快照（`/s:<n>` 后缀）。现在流式快照只计数不列出，工具调用默认显示（显示工具名 / 状态 / 参数摘要），可取消「显示工具调用」只看对话；详情头部同时给出消息、工具、分片三类数量。
- 会话详情改为弹窗：点击列表「打开」后在居中的模态框中查看消息，列表保持原位，不再把详情堆在页面底部；支持 Esc、遮罩与关闭按钮退出；原文弹窗叠在其上，Esc 逐层关闭。
- 会话详情改为 Cursor Chat 式布局：用户消息显示为浅灰气泡，助手回复为无边框正文；移除「上一页 / 下一页」，改为一次载入（上限 1500 条）后在弹窗内滚动到底自动追加 30 条，首屏不足一屏时自动补足。
- 工具调用按 Cursor 自身的 `toolStatusText` / `agent-conversation-phrase-copy` 语义渲染：单行「完成态动词 + 精简目标」，读取显示文件名（带行号区间）、搜索文件显示 glob、搜索内容显示 `pattern in 文件`、执行命令显示命令行、子代理显示任务描述、MCP 显示工具名；状态非 completed 时动词改为进行态或「尝试…」。行高约 26 px，点击展开参数与结果（ANSI 转义已清理），失败行标注「尝试…」。
- 修复 Magpie WebView 中会话弹窗消息区高度塌陷（只有标题栏、正文空白）：弹窗不再依赖 flex 自适应高度（WebView 内 flex 列布局把正文压成 0），改为内容自然撑开、正文区独立限高滚动（720 px，支持 `min(72vh, 780px)` 时取 72vh）。
- 修复会话列表「打开」按钮在窄列中被压成竖排文字：列宽增至 84 px 并给按钮最小宽度。
- 原文改为弹窗查看：点击消息上的「查看原文」打开模态框，显示格式化后的 JSON（超过 64 KB 不格式化）、原始大小与所在表；弹窗支持 Esc、遮罩点击与关闭按钮退出。
- 修复展开原文时报「key 含有非法字符」：`safeKey` 原先只允许字母数字和 `._:-`，而流式分片的 key 带 `/s:<n>` 后缀（本机样本中约 20% 的 bubble 行受影响），现在放行可打印 ASCII，仅拒绝引号、反斜杠与 GLOB 通配符。
- 体积诊断按 Cursor 官方 `storageSizeScanMain` 的 8 个前缀类别统计（Agent 内容块 / Agent 检查点 / Agent 产物 / 会话数据 / 消息正文 / 文件检查点 / 代码差异 / 云端代理缓存）外加 ItemTable；**打开面板不会扫盘**，每类需手动点击：小类直接精确统计（秒级），`Agent 内容块 / 会话数据 / 消息正文 / 文件检查点` 默认用 1/16 十六进制分桶采样外推（本机实测 1–25 秒），也可选择精确统计（内容块类可能数分钟）。结果按类别缓存 2 分钟，文件体积变化超过 1 GB 时提前失效；并发点击合并为同一个子进程。
- 「Cursor CLI 接管」卡片移到「可编辑参数」下方，与接管开关相邻；其余卡片顺序不变。
- Cursor 已实测范围升至 3.28.x–3.32.5，控制台对 3.32.5 显示「已实测」；兼容测试同步加入 3.32.0 / 3.32.5，范围外用例改为 3.33.0 与 3.32.6。
- 新增会话管理与删除（二期）：列表支持逐行勾选与「全选当前页」，选中后出现批量操作栏；「删除选中…」与「删除筛选结果…」共用同一确认弹窗，删除前先统计会话数、数据行数、数据体积、数据库大小、磁盘可用，以及 `exact / bubbleId / checkpointId / codeBlockPartialInlineDiffFates / composerHeaders` 各类行数。
- 删除范围严格限定在会话自身：`composerData` / `composerConversationState` / `composerConvHeaders` 精确键，`bubbleId:` / `checkpointId:` / `messageRequestContext:` / `codeBlockDiff:` / `codeBlockPartialInlineDiffFates:` 前缀，以及 `composerHeaders` 行和对应的 `composerChatViewPane` 残留键；**不触碰 `agentKv:blob`**（引用关系由 Cursor 官方 GC 负责），`inlineDiff:*` 按工作区归属、不随会话删除。
- 删除安全：服务端每次执行前检测 Cursor 进程（macOS/Linux 用 `pgrep`，Windows 用 `tasklist`），运行中直接拒绝并返回原因；前端要求勾选「我已完全退出 Cursor」并输入「删除」才可提交，弹窗内实时显示 Cursor 运行状态；一次最多 100 个会话，超出提示缩小筛选范围。
- 新增「清理与压缩」小节：「删除筛选结果」复用当前筛选条件（项目 / 类型 / 时间 / 命名 / 模式），超过 100 个会提示；「压缩…」显示数据库大小、空闲页、WAL、预计临时空间与磁盘可用，空间不足 1.1 倍时拒绝执行，完成后显示前后大小与释放量。
- 卡片下方「官方清理入口」列出 Cursor 命令面板中的 `Developer: Delete Old Chats`、`Developer: GC Agent KV Blobs`、`Developer: Reclaim Free Space`，并注明它们会保护仍在工作区会话列表中的聊天；本模块不代为执行这些命令，删除与压缩走自己的确认与进程检测流程。
- 所有查询通过 `-readonly` 打开数据库（Windows 回退 Bun 内置 SQLite），WAL 模式下可与 Cursor 的写入并存，Cursor 运行中即可浏览；查询带 `busy_timeout`、分级超时与结果上限，长统计不占用控制台的其他请求。
- 实现分层：`lib/platform.js` 抽出 `cursorUserDirFor` 并新增 `cursorGlobalStorageFor` / `cursorWorkspaceStorageFor`（三平台一致）；`control/cursor-store.js` 提供查询、分类扫描与受保护的写操作（会话删除、VACUUM）；`control/server.js` 新增 `/api/cursor-store/*` 路由；`control/database.js` 导出 `sqlite` / `quoteText` 供复用，并允许调用方调整输出缓冲上限。
- 新增 `test/cursor-store.test.js`（19 项：三平台路径、workspace 映射、概览、缺库降级、列表筛选与分页、消息时间排序与截断、单条读取与注入拒绝、分类精确统计、采样外推、类别定义、会话体积与缓存、时间窗口筛选、分片与工具分离、命名/模式筛选、删除预览与执行、压缩、Cursor 运行检测）；全量 153 项，145 通过、8 项按平台跳过。
- 版本号升至 0.2.38；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.37（修复 Windows「对话一次后断开」与自启动被拦截）

- 修复 Windows 上「对话一次后就断开」（issue #1）：自动保留策略原先在 supervisor 进程内执行，Windows 随包运行时（Bun）的 `bun:sqlite` 全同步，`quick_check` 与分批删除会让事件循环停顿数秒到数分钟；期间 supervisor 停止读取引擎 stderr，引擎写日志被 64 KiB 管道背压阻塞，Cursor 的回合随即卡死。默认保留策略恰好在启动 60 秒后首次执行，因此表现为「第一次对话后断开」。现在保留任务改由独立子进程 `bridge.js retain` 执行，supervisor 只等待并解析一行 JSON 结果，数据库再大也不阻塞引擎与对话。
- 引擎崩溃重启或模式切换不再先还原再写回 Cursor 的 `http.proxy`：Cursor 每次看到代理变化都会重建传输层，正在进行的对话会立即断开。替换引擎沿用已记录的代理端口，代理设置全程不动；只有真正断开（连接文件失效、外部改动代理、停止后台）才还原。
- Magpie 网关目录连续失败时不再停止正在运行的引擎：运行中的引擎仍持有上一份完整目录，supervisor 改为发布带 `warning` 的 `connected` 状态并持续重试，网关恢复后自动回到正常状态；只有没有引擎在跑且超过「网关断线容错」时才回退到 Cursor 自带后端。
- `connection.json` 写到一半或处在 unlink/rename 间隙时不再误判为断开：引擎存活期间容忍 5 秒的解析失败，持续无效才按断开处理，避免 Magpie 更新目录时打断对话。
- Windows 后台的 `console.log` / `console.error` 现在镜像写入 `supervisor.log` / `supervisor-error.log`（4 MiB 轮转一份 `.1`），无控制台运行时也能从控制台「日志与诊断」看到启动、重启、网关告警与错误。
- 修复 Windows 自启动 VBS 被安全软件拦截时 setup 直接报错退出（issue #2）：启动文件夹写入失败时自动改用 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 注册表项，命令指向安装目录下隐藏窗口的 `supervisor-launch.vbs`；两种方式都不可用时只打印警告并继续启动后台服务，setup 不再中止。卸载会同时清理启动文件夹 VBS、兜底 VBS 与注册表值，控制台「后台服务」也能识别两种自启动形式。
- 新增 `test/retention.test.js`（子进程参数、结果解析、失败与超时），supervisor 与 install 用例覆盖保留任务不阻塞主循环、引擎崩溃不触碰代理、目录持续故障保留引擎、连接文件半写入、Windows 注册表兜底/全被拦截/双形式卸载。
- 测试：全量 134 项；本机 Windows 119 通过、15 项按平台跳过，macOS/Linux 跳过项相应减少。
- 版本号升至 0.2.37；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.36（参数卡片默认收起与 Cursor 3.31.17 兼容）

- 「可编辑参数」改为折叠卡片，默认收起，点击标题或右侧箭头展开；收起时标题右侧显示当前运行模式（如「默认模式 · 展开编辑」），展开后的编辑、保存与提示行为不变。
- 折叠卡片的卡片外壳（去内边距、标题布局、展开箭头、状态文字）抽成共享规则，「模型显示名」「数据库管理」「可编辑参数」三张卡片复用同一套样式；键盘聚焦 `summary` 时显示焦点环。
- 修复保存后状态滞后：`POST /api/settings` 写盘后清空 2 秒概览缓存，控制台保存成功后同步更新本地快照并立即刷新摘要，运行模式不再在「已保存」提示后短暂显示旧值。
- 参数表单的 9 个控件补充 `aria-label`，屏幕阅读器可读出参数名与单位，不再只读到「秒 / MB / 天」。
- 修复窄屏展开参数卡片时出现横向滚动：`?` 提示气泡隐藏时不再保留布局盒；提示改为悬浮/聚焦即时显示。
- Cursor 已实测范围更新为 3.28.x–3.31.17；控制台对 3.31.17 显示「已实测」，超出范围仍标记「未验证」。
- 同步 README、`docs/plugin-usage.md`（含适用版本与安装示例）与 `docs/promo-article.md` 中的适配范围与参数卡片描述。
- 兼容测试更新：实测用例加入 3.31.17；全量 123 项，118 通过、5 项按平台跳过。
- 版本号升至 0.2.36；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.35（Orca 接管改为持久配置）

- 修复 Windows 包装器标记识别：Windows 版包装器以 `rem Managed by Cursor Bridge` 写入，此前标记检查只认 POSIX 的 `# Managed by Cursor Bridge`，导致安装后显示「未安装」且无法移除；现两种注释形式都按桥接管理处理。
- 修复包装器身份依赖进程 PATH 的问题：后台服务（launchd/systemd）与控制台/setup 的 PATH 不同，会把桥接自己写入的 override 误判为用户自定义命令（关闭失效），或补写一个从未安装的 `<root>/bin/cursor-agent-bridge`。现改为按磁盘上带标记的包装器文件识别与实际安装位置，身份不再随进程环境漂移；包装器未安装时跳过注入，不写死路径。
- 修复 Orca 配置写入的跨进程临时文件冲突：临时文件名加入进程号，setup、控制台与 supervisor 并发写入不再互相截断或改名。
- 测试脚本 `manual-lifecycle.mjs` 使用 `CURSOR_BRIDGE_HOME` 隔离 Orca 配置，避免 live 测试改写真实用户目录。
- 「可编辑参数」改为四组多行布局（运行与引擎 / 接管与集成 / 模型与日志 / 数据保留）；9 项说明从常驻文字改为 `?` 悬浮提示，点击可固定、点击外部或 Esc 关闭，触屏同样可读。
- 「可编辑参数」新增「接管 Orca 聊天」下拉（开启=自动维持 / 关闭，默认开启），写入 `bridge-settings.json` 的 `orcaTakeover`；下方「Cursor CLI 接管」卡片的两个按钮同步回写同一意图，两处状态不再分叉。
- Orca 运行中切换不再报错：意图立即保存，`lib/orca.js` 新增 `reconcileOrca`，由 supervisor 在 Orca 退出后自动补写或移除 `agentCmdOverrides.cursor`（设置变更立即执行，其余每 30 秒重试一次）；实际写入或移除只记录一次日志。
- setup 读取同一设置：关闭后重跑 setup 不再无条件写回兜底配置；Orca 已配置自定义 cursor 命令时始终跳过。
- 关闭只停用 Orca 配置兜底，「官方入口」接管保持独立；控制台「Orca 聊天」状态会如实区分「已接管 / 等待 Orca 退出 / 已关闭 · 官方入口仍接管」。
- 测试：新增设置校验、`reconcileOrca` 分支与 supervisor 调度用例；全量 122 项，117 通过、5 项按平台跳过。
- 版本号升至 0.2.35；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.34（Orca 聊天接管与官方入口接管）

- 新增官方入口接管：setup 将 `~/.local/bin/cursor-agent` 替换为桥接包装器，官方入口保留为 `cursor-agent-official`；Orca 聊天、终端、脚本等所有直接调用 `cursor-agent` 的入口统一走桥接。控制台新增「官方入口」状态与「接管官方入口 / 恢复官方入口」按钮，`/api/cursor-agent` 新增 `entry` 状态与 `entry-install` / `entry-remove` 动作。
- 根因：Orca 的「启动聊天」直接 spawn `cursor-agent --list-models` / `cursor-agent acp`，不经过登录 shell，且忽略 Orca 自己的 `agentDefaultEnv` / `agentCmdOverrides`（实测其 ACP 进程只带 `CURSOR_CONFIG_DIR`，无 `HTTPS_PROXY`）。
- 新增 `lib/orca.js`：检测 `orca-data.json` 并写入 Orca 配置作为兜底（不会覆盖用户已有的自定义命令；Orca 运行中则跳过）。uninstall 同时恢复官方入口并清理 Orca 配置。
- 官方 CLI 自更新会重建 `cursor-agent` 入口；重跑 setup 或点控制台「接管官方入口」即可修复。Orca 的模型目录会持久缓存旧列表，接管后若仍显示官方模型，重启一次 Orca 即可。
- 测试：新增入口替换与 Orca 用例；全量 113 项，108 通过、5 项按平台跳过。
- 版本号升至 0.2.34；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.33（Cursor CLI 接管）

- 新增 Cursor CLI（`cursor-agent`）接管：CLI 与 IDE 使用同一套 `agent.v1` / `BidiAppend` 协议，共用原生桥接与 Magpie 模型目录，无需改动引擎。
- 新增 `lib/cursor-agent.js`：CLI 探测、`--version` 解析、`agent-env` 环境文件与 `cursor-agent-bridge` 包装器的生成/安装/移除；同名但非桥接生成的文件不会被覆盖或删除。
- supervisor 随 `status.json` 同步维护 `agent-env`：代理端口变化时原子重写，断开/停止时删除，包装器自动退回直连。
- 控制台新增「Cursor CLI 接管」卡片：CLI 版本与已实测标记、代理端口、环境文件、包装器状态，支持安装/移除包装器与复制启动命令；新增 `GET/POST /api/cursor-agent`。
- 「可编辑参数」新增「接管 Cursor CLI」开关（即时生效，**默认开启**）：在 `~/.zshrc` / `~/.bashrc` 写入带标记的同名 shell 函数，交互式 shell 直接输入 `cursor-agent` 即注入代理；仅替换标记块，可随时停用，Windows 不支持。setup 默认写入，uninstall 移除；折叠卡片保留详细状态与包装器操作。
- 新增 cursor-agent 独立版本门禁：已实测 `2026.11.19`，低于/高于范围分别提示升级或先验证。
- setup 自动安装包装器（优先 `~/.local/bin`），uninstall 仅移除带标记的包装器。
- 端到端实测：`--list-models` 返回 Magpie 模型、`-p` 对话、文件写入与 shell 工具回环均走本地引擎；调研与复现命令见 `docs/cursor-agent-takeover.md`。
- 测试：新增 13 项 cursor-agent 用例；全量 101 项，96 通过、5 项按平台跳过。
- 版本号升至 0.2.33；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.32（Cursor 3.31.3 兼容）

- Cursor 已实测范围更新为 3.28.x–3.31.3；控制台对 3.31.3 显示「已实测」，超出范围仍标记「未验证」。
- 同步 README、`docs/plugin-usage.md` 与 `docs/promo-article.md` 中的适配范围表述。
- 兼容测试更新：实测用例加入 3.31.3，超出范围用例改用 3.32.0（原 3.31.0-insider 已落入新范围内）。
- 推广文标题改用 cursor-bridge 简称，便于阅读。
- macOS 本机 88 项测试 83 通过、5 项按平台跳过。
- 版本号升至 0.2.32；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.31（停止按钮、3.30.20 兼容与 Magpie 图文教程）

- 控制台新增「停止」按钮：停止 supervisor 与原生引擎、还原 Cursor 代理设置，不卸载服务、不删除数据；再次点「启动」恢复。`POST /api/action` 新增 `stop`，并在停止后写入 `state: stopped` 状态。
- Cursor 已实测范围更新为 3.28.x–3.30.20；控制台对 3.30.20 显示「已实测」，超出范围仍标记「未验证」。
- 新增 `docs/plugin-usage.md` 图文教程：Magpie 基础概念、供应商维护、模型与路由组、两层可见性、Agent 连接、控制台入口（侧栏 / Agent 菜单 / 已安装插件）、数据库、最近调用、日志自检、更新与卸载。
- 教程包含 9 张真实截图：Magpie 添加供应商、Agents 页面、已安装插件行、侧栏「Cursor 桥接控制台」入口，以及控制台总览/模型/数据库/最近调用/日志诊断；本地路径、PID、模型名与敏感数据已脱敏或替换为示例。
- 新增 `docs/promo-article.md` 推广短文（292 字）：面向普通用户说明 Magpie + 桥接插件的作用与四步用法，含供应商、Agents 与控制台截图；图片与详细教程均使用 GitHub 绝对地址，开头/结尾附项目地址。
- 测试更新版本范围与示例版本；macOS 本机 88 项测试 83 通过、5 项按平台跳过。
- 版本号升至 0.2.31；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.30（折叠卡片状态文字对齐与 GitHub 入口修复）

- 控制台「模型显示名」「数据库管理」「最近调用」「日志与诊断」四张折叠卡片的状态文字（展开后编辑 / 展开时统计 / 展开时读取）改为与右侧展开箭头同组右对齐，不再停留在卡片中部。
- 修复 GitHub 入口在 Magpie WebView 中点击不跳转：`target="_blank"` 被 WebView 阻止；点击改由 `/api/open` 的 `github` 目标调用本机默认浏览器（macOS `open` / Windows `explorer` / Linux `xdg-open`），地址仍来自 `package.json`。
- macOS 本机 88 项测试 83 通过、5 项按平台跳过。
- 版本号升至 0.2.30；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.29（控制台 GitHub 入口）

- 控制台顶部「刷新页面」右侧新增 GitHub 仓库入口；地址从 `package.json` 的 `homepage` / `repository` 解析，未配置或非 GitHub 地址时自动隐藏。
- 链接地址由服务端以 JSON 注入页面，避免字符串拼接注入；使用 `target="_blank"` 与 `rel="noreferrer"` 在新标签页打开。
- 测试新增页面包含仓库地址、无 `__REPO_URL__` 残留的断言；macOS 本机 88 项测试 83 通过、5 项按平台跳过。
- 版本号升至 0.2.29；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.28（最近调用视图与更新检查）

- 新增「最近调用」卡片与 `GET /api/calls`：从 `llm_calls` 按 `created_at_ms` 索引读取最近 25/50/100 条，显示时间、模型、状态、耗时、输入/输出/总 token、HTTP 状态与错误摘要；支持「只看错误」，错误内容复用日志脱敏规则；旧版引擎缺少新遥测列时自动回退到基础字段。
- 新增更新检查 `GET /api/update`：读取 GitHub latest Release，与当前 `installation.json` 版本比较，返回当前/最新版本、Release 地址、安装方式（source/unknown）、是否可一键升级与手动命令；成功结果缓存 10 分钟。
- 新增一键升级 `POST /api/update`：仅在「干净源码 checkout + origin 指向本仓库 + 存在更新」时执行 `git fetch --tags`、`git merge --ff-only <tag>` 与 `setup.command`，要求 `confirm:true`；Magpie 托管或源码有未提交改动时返回明确的手动升级命令，不擅自改写。
- 控制台顶部新增「检查更新」，发现新版本时显示版本对比、Release 链接、升级/复制命令按钮；升级完成后提示刷新页面或重启 Magpie 加载新控制台。
- 测试新增最近调用字段/排序/错误脱敏/缺失数据库、版本比较；macOS 本机 88 项测试 83 通过、5 项按平台跳过。
- 版本号升至 0.2.28；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.27（Cursor 版本探测、分层自检与模型管理）

- 新增 Cursor 版本探测：从 macOS `Contents/Resources/app/package.json` 与 Windows/Linux `resources/app/package.json` 读取版本，与已实测范围 3.28.x–3.30.8 比较；控制台概览显示「已实测 / 未验证」，诊断包同步包含版本与兼容提示。
- 新增分层自检（`control/selftest.js`、`POST /api/selftest`）：依次检查插件版本、Magpie 连接、引擎 PID、代理端口 TCP、经本地代理到 `api2.cursor.sh` 的 TLS 握手与本机 CA、网关模型目录，以及可选的极短模型请求（默认勾选，可能计费）。结果以检查表显示失败层与耗时；它覆盖到模型层，Cursor Bidi/RunSSE 的原生往返仍由构建侧的 `magpie_smoke` 示例覆盖。
- 模型管理增强：`bridge-settings.json` 新增 `modelHidden`，控制台模型表格新增「菜单」勾选、搜索框与行内「测试」；「保存全部」一次保存名称、顺序与隐藏项。当前选中的模型即使被隐藏也始终保留，避免目录校验失败导致引擎停止。
- 新增 `POST /api/agent/test`：校验模型仍在 Magpie 目录后，发送一条 `max_tokens=8` 的极短请求并返回延迟与文本；受控制口令与 Host/Origin 校验保护。
- 测试新增 Cursor 兼容矩阵、版本文件读取、自检分层（含 CONNECT 拒绝、TCP 可达性）、模型隐藏/保留当前模型、模型测试接口；macOS 本机 86 项测试 81 通过、5 项按平台跳过。
- 版本号升至 0.2.27；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.26（数据库保留策略与日志诊断）

- 新增自动保留策略：`bridge-settings.json` 增加 `tracesRetentionDays`（默认 7 天）与 `sessionsRetentionDays`（默认 0=关闭）；supervisor 每 6 小时在后台分批删除过期调用日志/历史会话，不中断对话、不执行 VACUUM，轻量模式下跳过。删除按批提交并启用 busy timeout，失败时 1 小时后重试，结果写入 `retention.json`。
- 控制台「可编辑参数」新增两项保留天数；概览新增「自动清理」一栏，显示上次执行时间、删除的调用/会话数量或失败原因。
- 新增日志与诊断：控制台折叠卡片可读取 `engine.log` / `supervisor.log` / `supervisor-error.log` 尾部（100–1000 行），按证书、端口、网关、协议、连接停滞、启动超时、代理改动归类并给出操作建议；「导出诊断包」把状态、设置、版本、平台、保留结果与脱敏日志写入 `data/diagnostics/diagnostics-<时间>.json` 并返回路径，避免 WebView 下载限制。
- 日志脱敏统一覆盖 `Authorization: Bearer`、`sk-`、JSON/键值形式的 `key`/`token`/`secret`/`password`；诊断包不包含 Magpie 网关密钥。
- 新增 `control/diagnostics.js`（尾部读取/脱敏/归类）、`GET /api/logs`、`GET /api/diagnostics`；控制台数据库管理仍保持手动清理、备份与 `quick_check` 不变。
- 测试新增自动保留（在线分批、关闭范围、lite 跳过）、日志尾部与截断、脱敏、错误归类、日志 API 与诊断包凭据隔离；macOS 本机 76 项测试 71 通过、5 项按平台跳过。
- 版本号升至 0.2.26；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.25（CI 修复：Linux 单元文件测试按平台跳过）

- 修复 GitHub Actions Windows 作业失败：`linux service unit` 用例在 Windows 上仍会执行，`path.join` 生成反斜杠路径导致断言失败。该单元文件只在 Linux 安装路径生成，测试现与 `linux activation` 等用例一致，按 `IS_LINUX` 跳过；Linux CI 仍完整覆盖。
- 版本号升至 0.2.25；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.24（核心可靠性：supervisor 测试、三平台 CI、清理备份）

- 新增 `lib/supervisor.js`：把连接判定、引擎启停/重启、网关断线宽限、模式切换、模型目录热更新与代理恢复从 `bridge.js` 抽成依赖注入的状态机；`bridge.js` 保留锁、状态文件、日志轮转与信号处理。行为保持不变，所有副作用可测试。
- 新增 9 项 supervisor 测试：未连接、首次启动、网关短暂失败与恢复、运行模式重启、显示名热更新、外部代理改动暂停、引擎崩溃重启、先还原代理再终止引擎、启动即退出报错。
- 新增 `.github/workflows/test.yml`：macOS / Ubuntu / Windows 三平台运行语法检查与全部测试；Linux 额外安装 `sqlite3` 并校验 `source.patch` 与 `source-linux.patch` 可依次应用。
- 数据库清理新增备份与完整性检查：`VACUUM INTO` 在删除前生成一致快照（包含 WAL 已提交内容），默认目录 `data/backups`，保留最近 3 份；服务端默认仅对 `sessions` / `all` 备份；控制台按范围设置默认值（`sessions` / `all` 勾选，`traces` 不勾选），可手动调整。清理后执行 `PRAGMA quick_check`，结果随响应返回并在控制台提示。
- 控制台数据库清理卡片新增「清理前备份数据库」开关；确认文案与结果提示包含备份路径、大小与检查结果。
- 测试新增 supervisor 状态机与数据库备份/保留策略用例；macOS 本机 67 项测试 63 通过、4 项按平台跳过。
- 版本号升至 0.2.24；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.23（P0 止血：版本单一来源与安装复用）

- 修复控制台数据库清理前的等待竞态：`databasePending` 是 `{deep, promise}` 包装对象，之前 `await databasePending` 会立即返回，正在进行的统计读事务并未结束，VACUUM 仍可能与其抢锁；改为 `await databasePending.promise`，清理前真正等待统计读结束。
- 修复连接文件候选读取：`safeConnection` 之前遇到第一个“存在”的 `connection.json` 就停止，若该文件损坏（半写、旧路径），不会再尝试后续候选，控制台误报“未连接”。新增 `readConnection()` 逐个解析，损坏则继续；Windows/Linux 的双路径兜底真正生效。
- 新增 `version.js` 作为运行时版本单一来源：`agent.js`、`bridge.js` 与控制台 User-Agent 统一从它读取；`verifyPackage` 校验 `version.js`、`package.json`、`integrity.json` 与原生引擎版本一致，测试断言改为动态读取，避免发版漏改。
- 移除 `package.json` 中不存在的 `npm-shrinkwrap.json` 发布条目（项目无运行时 npm 依赖），README 的发版同步说明改为 `version.js` / `package.json` / `integrity.json` / 原生引擎四处。
- 安装器 release 复用：stage 前计算载荷、引擎摘要与运行时身份（size/mtime）指纹；同版本同内容直接复用已有 release，内容或运行时变化才新建。`release.json` 最后写入，作为完整落盘的标记；各平台 `pruneReleases` 只保留当前激活的 release。macOS 之前每次启动/重启/清理都会新增一份 100MB+ release 且从不清理，现已与 Windows/Linux 一致。
- Magpie 模型目录同步改为实时名称优先：网关返回的 `name` / `context_window` 覆盖 `connection.json` 里记录的旧副本，Magpie 中改名后无需重新连接即可在 Cursor 菜单看到；仅在网关缺字段时回退。
- `package.json` 增加 `engines.node >= 20`，明确 Node 与 Bun 的运行基线。
- 测试新增：release 复用与内容变化失效、release 剪枝、连接候选跳过损坏文件、网关名称实时优先与 User-Agent 版本；版本配对测试改为读取 `version.js`。macOS 本机 57 项测试 53 通过、4 项按平台跳过。
- 版本号升至 0.2.23；原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.22（模型显示名与排序增强）

- 「模型显示名」改为独立折叠卡片：默认收起，与「数据库管理」交互一致；展开时才读取模型目录并渲染表格。
- 新增操作列与单行保存：每个模型一行，行内「保存」只更新该模型的显示名，不影响其他模型、顺序或其他设置。
- 支持拖动行调整 Cursor 菜单顺序：拖动后自动保存到 `modelOrder`；拖到表格外自动恢复原顺序；底部「保存全部」一次保存名称与顺序。
- `bridge-settings.json` 新增 `modelOrder`（模型 ID 顺序数组）；未列出的模型按 Magpie 目录顺序追加。supervisor 在写入 `effective.json` 前先排序再应用显示名，引擎热更新目录，约 2–4 秒生效，无需重启。
- 模型列文字改为正常前景色；保存按钮位于卡片右侧；显示名与顺序只影响 Cursor 菜单，不改变模型 ID、路由与计费。
- 测试新增 `modelOrder` 校验、排序映射与 API 保存用例；版本号升至 0.2.22，原生引擎不变（`engineVersion` 仍为 0.2.15）。

## 0.2.21（模型显示名自定义）

- 控制台「可编辑参数」新增「模型显示名」：模型列表中的每个模型都有一个显示名输入框，留空使用 Magpie 原名；只覆盖写入 `effective.json` 的 `name`，模型 ID 不变，因此路由、计费与连接语义完全不受影响。
- 配置写入 `bridge-settings.json` 的 `modelNames`（模型 ID → 显示名），由 supervisor 在同步模型目录时应用。显示名变化会更新 `effective.json`，引擎热更新模型目录，**不需要重启引擎或中断当前对话**。
- 保存采用增量合并：只修改当前列出的模型，未展示模型（网关离线或目录未加载）的配置会保留；清空输入表示清除该模型的覆盖。
- 校验：显示名 trim 后最多 80 字符，最多 200 条；非法项在保存时返回 400 并指出具体模型；非严格读取时丢弃非法项并回退。
- 控制台保存后提示「Cursor 菜单将在数秒内刷新」，README 与 Agent notice 同步说明；测试新增显示名校验、映射与 API 保存用例。
- 版本号升至 0.2.21；原生引擎源码未改动，各平台引擎仍固定为 `engineVersion` 0.2.15。

## 0.2.20（macOS Intel x64 适配）

- 新增 macOS Intel x64 原生引擎 `bin/darwin-x64/cursor-magpie-bridge`，并在 `integrity.json` 增加 `platforms.darwin-x64` 摘要；arm64 保持历史布局 `bin/cursor-magpie-bridge`，`enginePathFor()` 在 darwin 上按架构分流，旧包仍可读取。
- 安装器解除 Intel Mac 限制：`darwin` 的 `arm64` 与 `x64` 均受支持，LaunchAgent、证书信任、控制台与卸载流程完全一致；不再要求 Intel Mac 自行构建。
- 新增 `scripts/build-native-macos-x64.sh`：在 Apple Silicon 上安装 `x86_64-apple-darwin` target 并交叉编译（`CMAKE_OSX_ARCHITECTURES=x86_64`），产出 Intel 引擎并更新分平台摘要；Rosetta 可用时直接执行 `--version` 自检，否则用 `strings` 校验版本常量。
- README 更新平台支持、前置条件、目录结构、构建流程与故障排查；测试新增 darwin x64 引擎路径断言。
- 版本号升至 0.2.20；原生引擎源码未改动，macOS / Windows / Linux 引擎仍固定为 `engineVersion` 0.2.15。

## 0.2.19（Linux 适配）

- 新增 Linux x64 / arm64 完整支持：随包原生引擎 `bin/linux-<arch>/cursor-magpie-bridge`、按架构分目录、纳入 `integrity.json` 的 `platforms.linux-x64|arm64` 摘要；`lib/platform.js` 的 `enginePathFor()` 与 `serviceSupported` 同步扩展。Linux 产物以 glibc 2.34（Debian 12 / Ubuntu 22.04）为基线，并以 vendored 方式静态链接 OpenSSL，不依赖目标系统的 `libssl` 版本；arm64 产物在 amd64 容器内交叉编译，无需拉取额外的 Docker 镜像。
- 新增 systemd 用户单元守护：安装器写入 `~/.config/systemd/user/local.magpie.cursor-bridge.service`（`Restart=on-failure`、`UMask=0077`、日志追加到 `supervisor.log` / `supervisor-error.log`），执行 `daemon-reload` 与 `enable --now`；停止、重启、卸载均走 `systemctl --user`，并等待 supervisor/引擎退出。
- 无 systemd 用户实例（容器、部分 WSL、精简发行版）时回退为**分离进程**立即启动，单元文件保留供下次登录接管；systemd 明确拒绝单元时自动 `disable`，避免每次登录重复失败。
- Linux 证书信任全程无需 root：把 CA 路径写入 Cursor 的 `~/.config/Cursor/argv.json`（`certificate-authority`，保留原文件注释），并在存在 `certutil` 时导入用户 NSS 库 `~/.pki/nssdb`；两条路径都会写入 `data/ca/trusted.json` 指纹标记，系统级 CA 仅打印可选命令提示。
- 新增 Linux 专属引擎补丁 `source-linux.patch`：`is_installed()` 在系统 anchor 之外同时接受 Cursor `argv.json` 与 NSS 导入标记，使其与零 root 安装方式一致；macOS / Windows 的引擎判定与二进制不受影响。
- 新增构建入口：`scripts/build-native-linux.sh`（Linux 主机原生构建）与 `scripts/build-native-linux-docker.sh`（在 macOS/Linux 上用 Docker 构建 x64 与 arm64，带 Cargo 缓存卷）；构建前依次应用 `source.patch` 与 `source-linux.patch`，并以 `integrity.json` 的 `engineVersion` 校验 `--version`。
- 控制台在 Linux 启用「启动 / 状态 / 重启」：安装入口统一为 `bash setup.command`，服务状态读取单元文件与 `supervisor.lock`，停止时调用 `systemctl --user stop` 并兜底终止残留进程；页脚、命令提示与 Agent notice 同步更新。
- Linux 每次 setup 后清理旧 release，只保留当前版本；卸载时删除 systemd 单元并 `daemon-reload`。
- 测试新增 Linux 路径、引擎布局、systemd 单元、`argv.json`（保留注释）、NSS 导入与信任标记用例；macOS 专属用例改为按平台跳过。验证结果：macOS 本机 46 项通过；Debian 12 容器内 45 项通过（5 项 Windows 专属跳过）；完成 `setup → argv.json/NSS → 无 systemd 回退 → 卸载` 端到端冒烟；arm64 产物经 QEMU 执行 `--version` 返回 0.2.15。
- 版本号升至 0.2.19；macOS / Windows 引擎构建不变（`engineVersion` 仍为 0.2.15），Linux 引擎由同一上游提交 + Linux 信任补丁构建。

## 0.2.18（易用性：控制台一键连接模型）

- 控制台新增「连接模型」卡片：未连接时直接列出 Magpie 模型目录（读取 `~/.config/magpie/gateway.json` 中的本机网关地址并请求 `/v1/models`，只访问 `127.0.0.1`），选择一个模型点「连接并启动」即可。后台未运行时自动先执行一次 setup，因此首次安装也能一键完成「安装 → 选择模型 → 引擎运行」。
- 连接通过 Magpie 自己的 CLI（`magpie cursor-bridge <model>`）完成，`magpie ls`、Magpie Agents 页面与 `connection.json` 保持一致；连接后控制台最多等待 20 秒，直接显示引擎是否已启动。
- 原生引擎状态区分「等待连接 / 启动中… / 启动失败 / 未运行」：未选择模型时显示「等待连接」而不是令人误解的「未运行」，并在提示中说明这是正常待机状态。
- 新增 `GET /api/agent/models` 与 `POST /api/agent/connect`，均受控制口令与 Host/Origin 校验保护；`createControlServer` 支持注入连接实现以便测试。
- README 补充「未连接 = 待机」说明与一键连接方式；版本号升至 0.2.18，原生引擎不变（仍固定为 0.2.15）。

## 0.2.17（Windows 连接修复）

- 修复 Windows 下「启动」后原生引擎始终未运行：Magpie 的 Agent 沙箱不暴露 `process`，`agent-platform.js` 因拿不到平台信息回退到 macOS 布局，`connection.json` 实际写入 `%USERPROFILE%\.config\magpie-cursor-bridge\`；而 supervisor 只轮询 `%APPDATA%\magpie-cursor-bridge\`，永远处于 `disconnected`，因此不会拉起引擎。现在 `lib/platform.js` 新增 `connectionFilesFor()`，supervisor 与控制台按顺序读取两个候选位置（`%APPDATA%` 优先，`~\.config` 兜底），macOS/Linux 仍只有原路径。
- 控制台概览的 `connection` 与 supervisor 使用同一组候选路径，连接状态不再误报「未连接」。
- 版本号升至 0.2.17；原生引擎未改动，仍由 `integrity.json` 的 `engineVersion` 固定为 0.2.15 并按 SHA-256 校验。

## 0.2.16（Windows 适配修复）

- 修复 Windows「启动」失败（控制台提示「命令退出码 1」）：`schtasks /SC ONLOGON` 需要管理员权限，普通账户只会得到「拒绝访问」。Windows 改为在用户启动文件夹写入隐藏窗口的 `.vbs` 启动器，并立即以分离进程启动 supervisor，安装与登录自启均无需提权；0.2.15 预览版留下的计划任务会在安装/卸载时自动删除。
- 修复证书信任：随包引擎只把 LocalMachine Root 中的证书视为受信任，之前的 `certutil -addstore -user Root` 永远无法通过引擎的 `requires an already trusted CA` 检查（引擎以退出码 1 结束）。现在先读取本机 Root，必要时通过一次 UAC 提权安装并回读验证；之后启动不再询问。取消授权时会给出明确提示。
- Windows 停止后台时同时终止 supervisor 与其派生的原生引擎：TerminateProcess 不会触发 Node/Bun 的退出清理，只杀 supervisor 会把引擎留成孤儿；终止前校验命令行，避免进程号被无关程序复用时误杀。
- Windows 下探测进程命令行、运行安装器与数据库 CLI 时统一隐藏窗口（`windowsHide`），避免状态轮询与「启动」操作闪出控制台窗口；该参数在 macOS/Linux 上无效果。
- `magpieConfigDirFor()` 在 Windows 改用 Magpie 实际使用的 `%USERPROFILE%\.config\magpie`（`magpie data` 报告的位置）。之前指向 `%APPDATA%\magpie`，安装器读不到 `plugins.json`，会重复登记插件，导致两个控制服务争用 3580 端口并反复输出 `EADDRINUSE`。检测到重复登记时会提示但不擅自删除。
- Windows 每次 setup 后清理旧 release（每份约 100–190 MB），只保留当前版本。
- 控制台在 Windows 改为读取启动文件夹与 `supervisor.lock` 判断后台状态，不再查询计划任务；「重启」提示与页脚同步更新。
- 数据库面板在缺少 `sqlite3` 可执行文件时自动改用 Magpie 内置 Bun 的 `bun:sqlite`（Windows 默认没有 sqlite3）；macOS 仍优先使用系统 sqlite3，行为不变。
- 测试适配 Windows：路径断言进入临时沙箱、跳过 Unix 文件权限断言、证书与激活用例按平台分支，数据库用例在无 sqlite3 时跳过。
- 版本号升至 0.2.16。原生桥接源码未改动，沿用已发布的 0.2.15 引擎构建；`integrity.json` 新增 `engineVersion` 单独固定随包引擎版本，插件版本与引擎版本分别校验（旧包缺少该字段时仍要求两者完全一致，macOS 行为不变）。

## 0.2.15（本地增强版）

- 新增 Windows x64 原生引擎：`bin/win32-x64/cursor-magpie-bridge.exe`，交叉编译产物为自包含 PE（仅依赖 Windows 系统 DLL），并纳入 `integrity.json` 的分平台摘要。
- `bridge.js` 按平台选择引擎（Windows 为 exe），Windows 下跳过 Unix `umask`。
- 安装器支持 Windows：证书信任改用 `certutil -addstore -user Root`，后台通过计划任务 `local.magpie.cursor-bridge`（登录自启 + 立即运行）守护，卸载时删除任务；`stage` 只携带当前平台的引擎与运行时。
- 控制台在 Windows 上启用「启动 / 重启」：通过宿主运行时执行 `install.js`，停止时结束计划任务并终止 supervisor/engine；状态查询走 `schtasks` + `supervisor.lock`。
- 修复 `source.patch` 中 `tokio::signal::unix` 缺少 `#[cfg(unix)]` 保护导致 Windows 编译失败的问题，改用跨平台的 termination future。
- 新增 `scripts/build-native-windows.sh`，在 macOS 上用 mingw-w64 交叉编译 Windows 产物并更新分平台摘要。
- 版本号升至 0.2.15，macOS 与 Windows 原生桥接按新版本号重建。

## 0.2.14（本地增强版）

- 修复 0.2.12 引入的插件加载回归：Magpie 的 agent 沙箱只解析 `agent.js` 同目录模块并拒绝 `node:` 内置模块，之前 `agent.js` 直接导入 `node:os` / `node:path` / `lib/platform.js`，导致插件清单加载失败、侧栏与 Agent 行异常。
- 平台路径计算移入无导入的 `agent-platform.js`（仅使用 `globalThis.process`，缺失时回退 macOS 默认值），`agent.js` 改为导入同目录模块。
- 修复 0.2.12 引入的稳定副本缺依赖问题：`setup.command` 注册的 `~/.local/share/magpie-cursor-bridge` 只复制了 `control`/`ui`，而 `control/host.js` 已依赖 `../lib/platform.js`；现在同时复制 `lib`、`vendor` 与 `agent-platform.js`。
- `lib/install.js` 的 payload 与 `package.json` 的 `files` 加入 `agent-platform.js`，确保发布包与 release 目录包含该文件。
- 版本号升至 0.2.14，原生桥接按新版本号重建并重算 `integrity.json` 摘要。

## 0.2.13（本地增强版）

- 数据库统计从三次全表扫描降为一次：`messages` 的行数、按天增长与会话分布共用一次 `GROUP BY`；实测 2.6GB 库从 3.0 秒降至 2.3 秒。
- 内容块（`blobs` / `blob_edges`）的体积改为按需统计：默认快速统计跳过逐行读取 blob 正文，控制台新增「精确统计」按钮补齐；实测精确统计 3.4 秒。
- 修复 `engine.log` 运行期不轮转的问题：改为按累计写入量轮转，不再依赖 supervisor 重启；超过上限时滚动到 `engine.log.1`。
- Cursor `settings.json` 按 mtime/size/inode 缓存解析结果，supervisor 每 2 秒的代理检查不再重复解析同一份 10–50KB JSONC。
- Magpie `plugins.json` 同样按文件标识缓存，2 秒端口轮询不再重复解析。
- 控制台状态接口增加 2 秒快照缓存，多面板并发轮询只执行一组 `ps`/`launchctl`。
- `/api/settings` 写操作串行化，避免两个面板同时保存时互相覆盖。
- 前端轮询在页面隐藏时退避到 30 秒。
- 原生 SQLite：WAL 下 `synchronous` 调整为 `NORMAL`（崩溃最多丢失最近事务，不损坏数据库），每连接缓存 8MB、mmap 64MB，改善多会话并发写入与读延迟。
- 版本号升至 0.2.13，原生桥接按新版本号重建并重算 `integrity.json` 摘要。

## 0.2.12（本地增强版）

- 新增 `lib/platform.js` 跨平台抽象层：配置/数据目录、Cursor 配置与安装目录、Magpie 配置目录、进程命令行探测、打开路径、`sqlite3` 与 `bash` 探测全部按平台解析；macOS 的路径与行为保持不变。
- Windows：配置与数据目录改用 `%APPDATA%` / `%LOCALAPPDATA%`，存在旧 `~/.config` 数据时自动沿用；进程探测改用 PowerShell；打开路径改用 `explorer`；`renameSync` 在目标文件被占用时短暂重试。
- Linux：配置与数据目录遵循 XDG，打开路径改用 `xdg-open`。
- 非 macOS 平台：安装器、证书信任与服务守护明确提示「仅 macOS」；控制台禁用「启动/重启」并显示原因，「状态」仍可读取 `status.json`。
- `package.json` 移除 `os: darwin` 与 `cpu: arm64` 的硬限制（原生引擎仍需对应平台构建产物）；`agent.js` 的 Cursor 目录与连接文件路径改为按平台计算。
- 新增 `test/platform.test.js` 覆盖 macOS / Linux / Windows 三套路径布局。
- 版本号升至 0.2.12，原生桥接按新版本号重建并重算 `integrity.json` 摘要。

## 0.2.11（本地增强版）

- 修复控制台在插件重载、端口切换或升级后提示「控制口令无效」的问题：收到 403 且错误为「控制口令无效」时自动重新加载页面以获取当前令牌；15 秒冷却避免异常环境下的重载循环，冷却期内改为明确提示手动刷新，不再误报「控制服务不可达」。
- 控制台头部新增「刷新页面」按钮（重新加载页面并获取当前口令）；原「刷新」按钮更名为「刷新状态」（仅重新读取运行状态，不更新口令），避免两者语义混淆。
- 版本号升至 0.2.11，原生桥接按新版本号重建并重算 `integrity.json` 摘要。

## 0.2.10（本地增强版）

- 控制台新增「数据库管理」卡片：按会话与消息、检查点、运行与工具调用、请求调用日志、内容存储（blob）、配置与系统六类展示 `bridge.db` 的表行数与内容体积，并给出数据库文件、WAL、索引与空闲页、页大小及最近写入时间。
- 新增最近会话与近 7 天消息增长视图，便于判断历史数据分布。
- 新增分级清理：调用日志（`llm_calls` / `cursor_run_traces`）、按天清理历史会话（blob 内容保留）、仅 VACUUM 压缩、清空全部运行数据（保留模型配置与服务设置）。清理前暂停桥接，完成后自动重启；全量清空需输入「清空全部」二次确认。
- 统计与清理通过系统自带 `/usr/bin/sqlite3` 执行，只读统计不持有长期连接；内容体积按 UTF-8 字节计算，避免中文文本被低估。
- 快捷入口新增「数据目录」。
- 版本号升至 0.2.10，原生桥接按新版本号重建并重算 `integrity.json` 摘要。

## 0.2.9（本地增强版）

- 修复通过 Magpie 插件页从 GitHub 安装后启动报 `Cannot find package 'jsonc-parser'` 的问题：`jsonc-parser` 以 ESM 运行时形式 vendored 到 `vendor/jsonc-parser`，不再依赖 `npm install`。
- staging 与安装校验改为读取 vendored 目录；移除 `package.json` 的 npm 依赖与 `npm-shrinkwrap.json`。
- 版本号升至 0.2.9，原生桥接重建并重算 `integrity.json` 摘要。

## 0.2.8（本地增强版）

- 控制台新增「子代理模式」：
  - `异步后台`（默认）：保持现状，子代理在后台运行，完成后由桥接唤醒父代理继续。
  - `同步阻塞`：原生层强制 Task 以 `run_in_background=false` 下发，客户端内联执行子代理，父代理等待其结果；同时 `is_background` 恒为 false，不进入后台唤醒逻辑。
  - 切换后 supervisor 在数秒内重启引擎，下一次 Task 调用生效。
- 原生层新增 `CURSOR_BRIDGE_SUBAGENT_MODE`（`async` / `sync`），仅在 `sync` 时改写 `SubagentArgs.run_in_background`。
- 版本号升至 0.2.8，原生桥接重建并重算 `integrity.json` 摘要。

## 0.2.7（本地增强版）

- 修复 Multitask 后台子代理完成后父代理不继续的问题：
  - 本地 Statsig bootstrap 显式启用 `long_running_jobs`。Cursor 未登录时上游 bootstrap 返回 401，客户端只有在 gate 开启时才会派发后台任务完成通知；缺失它时子代理即使跑完也不会唤醒父代理，这是本次的主因。
  - `is_background` 保留两条异步信号：模型显式 `run_in_background` 与客户端回报的 `SubagentBackgroundReason`，任一为真即按后台处理；只有两者都没有时才视为同步。异步模式语义不变。
  - 活跃流上收到 `BackgroundTaskCompletionAction` 不再被当作 unsupported action 丢弃：父 run 仍在输出时注入通知并打断当前 round；已结束时用完成通知重放父请求，开启新一轮模型调用。
  - 收到完成通知时把 `subagent_runs_by_parent_tool_call_id` 的状态从 `Backgrounded` 更新为 `Success / Error / Aborted` 并写入完成时间；界面不再停在 “Stopped”。
- 原生桥接启动时初始化 tracing，诊断日志走 stderr 进入 `engine.log`（默认 `cursor_server=info`，可用 `RUST_LOG` 覆盖）；stdout 仍只承载 supervisor 解析的 ready 事件。
- 同步阻塞模式（`run_in_background=false` 或客户端同步完成）路径不变。
- 版本号升至 0.2.7，原生桥接重建并重算 `integrity.json` 摘要。

## 0.2.6（本地增强版）

- 控制台新增「运行模式」：默认模式（现状）与轻量模式。轻量模式把整个 SQLite 放入引擎进程内存（sqlx shared-cache 内存库）：请求转发、会话、工具调用照常工作，但不再写入 `data/bridge.db`；引擎重启后会话历史清空。
- supervisor 每轮读取 `bridge-settings.json`；运行模式变化后自动重启原生引擎，当前对话可能中断一次。
- 接入此前声明但未生效的三个参数：模型目录同步间隔、网关断线容错、引擎日志上限现在由 `bridge.js` 实际读取（前两者下一轮生效，日志上限下次后台启动生效）。
- 控制台概览新增「运行模式」「数据库」：轻量模式显示「内存 · 不落盘」；`status.json` 增加 `mode` / `engineMode`，可区分已保存与已应用。
- 原生桥接读取 `CURSOR_BRIDGE_RUN_MODE=lite` 时改用 `Store::connect_lite()`；内存库保持共享缓存与常驻连接，避免空闲回收后丢失表结构。
- 版本号升至 0.2.6，原生桥接重建并重算 `integrity.json` 摘要。

## 0.2.5（本地增强版）

- Magpie Agent 行菜单新增「桥接控制台」入口（侧栏插件组同名页面）：打开本机控制台执行启动（`bash setup.command`）、状态（`bash setup.command status`）与重启（`launchctl bootout` + 终止进程 + `setup.command`），并展示运行概览、日志与目录快捷入口。代理卡片内部由 Magpie 内置 UI 渲染，插件无法直接插入控件。
- 新增可编辑参数 `~/.config/magpie-cursor-bridge/bridge-settings.json`：模型目录同步间隔（默认 15 秒）、网关断线容错（默认 60 秒）、引擎日志上限（默认 4 MiB）；控制台保存后下一轮生效（日志上限下次后台启动生效）。
- 控制服务由 Magpie 插件宿主拉起，仅监听 `127.0.0.1`（默认 3580），带每次启动随机口令并校验 `Host`/`Origin`；后台桥接停止时仍可启动。
- 修复控制台在 Magpie 沙箱页中 CSS/JS 被 CSP `'self'` 拦截的问题（沙箱为 opaque origin）：改为显式 `http://127.0.0.1:<port>` / `http://localhost:<port>` 源，样式与按钮恢复。
- Agent 行与侧栏插件页改用 Cursor 官方图标（`ui/cursor.svg`，`agent.icon` 内联 data URI）。
- 修复 `setup.command` 在插件按本地路径注册时误判未注册、重复注册本地描述符的问题。
- 版本号升至 0.2.5，原生桥接重建并重算 `integrity.json` 摘要。

## 0.2.4（本地增强版）

- 模型选择器显示名只保留第一段（如 `Opus`、`Sonnet`、`Fable`、`Qwen4-Max-Preview`），不再拼接 ` · routing group` 与模型 ID，避免三段长名挤占 Cursor 的模型列表。
- 短名规则：取 Magpie 模型名中第一个 `·` 之前的部分；名称为空时回退到模型 ID。

## 0.2.3（本地增强版）

- 修复 Cursor 3.29+ 无法发起对话：客户端新增 `bidi_append_binary_encoding_disabled` 开关（默认关闭），首个 `BidiAppend` 改用 `data_binary`（tag 4，原始 protobuf 字节）而不是 `data`（hex 字符串）。旧桥接直接拒绝 `data_binary`，返回 `InvalidArgument`，客户端标记为不可重试并空等 30 秒，最终提示 "Connection stalled"。现在 `decode` 同时接受两种编码。
- 解码失败时将原始二进制写入 `$TMPDIR/bidi-dump-<seqno>.bin`（原为 `.hex` 文本），便于继续对齐协议。
- 版本号升至 0.2.3，避免与上游 0.2.2 的 release 目录和校验摘要混淆。

## 0.2.2

- 修复 Cursor 3.27 起 Composer 完全不可用：Cursor 服务端会灰度下发 `agent_host_local_loop`（本地循环运行时），此后 `BidiAppend` 里装的是新的 `RunInferenceRunRequest` 报文，与桥接的 `AgentRunRequest` 不兼容，表现为 `protobuf decode error` → HTTP 502 → Composer 提示 "The server failed 4 times"。现在在 Statsig bootstrap 中显式关闭该开关，回退到桥接支持的经典 agent 循环。
- 兼容 `ConversationStateStructure.plan` 的 wire type 变化：该字段改为未知字段跳过，不再中断整包解析。
- 本机监听端口持久化到 `network_ports`：桥接重启不再换端口，Cursor 不需要跟着重启。
- Magpie 网关短暂不可用时不再立即断开（保留 60 秒宽限，状态里给出 `warning`），连续超时才回退到 Cursor 官方服务。
- 模型目录未变化时不再每 15 秒重写 `effective.json`。
- 原生桥接的诊断输出写入 `~/.config/magpie-cursor-bridge/engine.log`（0600，超过 4 MiB 轮转），便于排查协议变更。
- 监视器 lock 增加命令行校验，避免进程号复用导致启动被误判为"已有实例"。
- 服务 plist 增加 `LimitLoadToSessionType=Aqua`。
- 协议解码失败时把原始报文写到 `$TMPDIR/bidi-dump-<seqno>.hex`，供后续协议对齐。

## 0.2.1

- Hide Cursor Auto in the bridge model picker using Cursor's display configuration, including clearing cached Auto controls. Magpie models and route groups remain selectable.

## 0.2.0

- Standard Magpie Agent package with an explicit file allowlist and bundled JavaScript dependency.
- Independent, per-machine certificate initialization; no original Cursor BYOK installation needed.
- Explicit macOS certificate trust step with SSL trust verification; existing certificates preserved.
- Setup reuses Magpie's Bun and keeps a local runtime copy, removing the dependency on user-installed Node.
- Plugin/native version pairing and native SHA-256 verification.
- Complete version directories and rollback of launch configuration after failed service registration.
- Status reports the actual running version. Updating the plugin requires rerunning setup to activate the matching service.
- Apple Silicon macOS only; no installation lifecycle scripts and no credentials in the package.

## 0.1.1

- Return only Magpie's model catalogue, without appending Cursor subscription models.

## 0.1.0

- Cursor protocol bridge through Magpie, background lifecycle, and recoverable proxy settings.
