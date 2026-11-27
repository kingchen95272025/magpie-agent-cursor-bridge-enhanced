# Cursor · Magpie Bridge 插件使用教程

> 适用版本：`0.2.38`。本文控制台截图来自真实实例；本地路径、PID、模型名与部分列表已脱敏或替换为示例数据。

---

## 目录

1. [Magpie 是什么](#一magpie-是什么)
2. [先把供应商维护好](#二先把供应商维护好)
3. [安装前准备](#三安装前准备)
4. [安装插件](#四安装插件)
5. [控制台总览](#五控制台总览)
6. [可编辑参数](#六可编辑参数)
7. [模型显示名、顺序与隐藏](#七模型显示名顺序与隐藏)
8. [数据库管理](#八数据库管理)
9. [最近调用](#九最近调用)
10. [日志、自检与诊断包](#十日志自检与诊断包)
11. [更新与升级](#十一更新与升级)
12. [常见问题](#十二常见问题)
13. [卸载与还原](#十三卸载与还原)

---

## 一、Magpie 是什么

Magpie 是本机的**模型网关与路由层**：它把不同供应商的模型统一成一套本地接口，再交给 Cursor、Claude Code 等 Agent 使用。

```text
供应商（OpenAI / Anthropic / DeepSeek / …）
        │  API Key、Base URL、模型列表
        ▼
     Magpie
   ├─ 模型目录
   ├─ 路由组（多个模型合成 group/<id>，可排序 / 轮询 / 备用）
   └─ 本地网关 127.0.0.1:3425/v1（OpenAI 兼容）
        │
        ▼
Agent（Cursor · Magpie Bridge 等）
        │
        ▼
Cursor
```

对本插件来说，Magpie 是**上游**：Cursor Bridge 不保存任何供应商 Key，只使用 Magpie 分配给 Agent 的网关地址与 Key；模型路由、计费、配额与供应商配置都在 Magpie 中完成。

### 1.1 核心概念

| 概念 | 含义 | 在本插件中的对应 |
|---|---|---|
| **供应商 Provider** | 一个模型厂商及其 API Key / Base URL / 模型列表 | 上游；Bridge 不直接接触供应商 Key |
| **模型 Model** | 供应商提供的具体模型，标识为 `provider/model` | Cursor 菜单里的每个模型；Bridge 的模型目录同步自 Magpie |
| **路由组 Routing group** | 把多个模型合成一个 `group/<id>`，按策略选择或备用 | 在 Cursor 里表现为一个模型；选择它就是选择整个组 |
| **Agent** | 使用 Magpie 的应用，例如 Cursor Bridge、Claude Code | 在 Magpie → Agents 中连接本插件 |
| **网关 Gateway** | Magpie 的本机 OpenAI 兼容接口，通常是 `127.0.0.1:3425/v1` | Bridge 的 `connection.json` 指向它；所有对话请求都发往这里 |
| **可见模型 Visible** | Magpie 允许某个 Agent 看到的模型范围 | 与 Bridge 的「菜单勾选」是两层控制，见 2.5 |

### 1.2 推荐的基础使用顺序

1. 在 Magpie 添加至少一个供应商，填入 Key；
2. 测试供应商，确认模型列表可用；
3. 在 Magpie 选择/整理要用的模型，必要时给模型起显示名；
4. 如果有多家供应商或多个模型，建议创建一个路由组；
5. 在 Magpie → Agents 中选择 **Cursor · Magpie Bridge** 和模型/路由组；
6. 再安装、启动本插件，重启 Cursor。

---

## 二、先把供应商维护好

> 这一节是使用本插件的前提。供应商没配好，Bridge 即使显示「已连接」，模型请求也会失败。

### 2.1 第一次添加供应商

在 **Magpie → 供应商** 页面：

1. 点「添加供应商」；
2. 选择内置预设（OpenAI、Anthropic、DeepSeek、Qwen、Kimi 等），填入 API Key；
3. 或选择「自定义」，填写 Base URL、Key 与模型 ID；
4. 保存后点「测试」，确认返回正常；
5. 确认模型列表中至少有一个可用模型。

![Magpie 添加供应商](images/magpie-provider-add.png)

对应的 CLI 方式（可选）：

```sh
magpie presets                                  # 查看内置供应商预设
magpie provider add <preset> <你的 Key>          # 按预设添加
magpie provider add <name> base_url=... key=... models=...   # 自定义
magpie providers                                # 查看已有供应商、模型与使用者
magpie provider test <id>                       # 测试供应商
```

> Provider Key 只保存在本机 Magpie 配置中，不会写入本插件或 Cursor 的设置文件。请勿把 Key 填到 `bridge-settings.json`。

### 2.2 供应商日常维护

| 场景 | 做法 | 对 Bridge 的影响 |
|---|---|---|
| 更换 API Key | Magpie → 供应商 → 编辑 → 更新 Key → 测试 | 无需重装 Bridge；下一轮目录同步后继续可用 |
| 新增模型 | 在供应商的模型列表中添加模型 ID | 15 秒内同步到 Bridge；Cursor 菜单出现新模型 |
| 删除模型 | 从供应商或 Magpie 模型列表中移除 | 目录同步后 Cursor 菜单消失；若正在使用会被校验拒绝 |
| 供应商额度耗尽 | 更换 Key、切换供应商，或配置路由组备用模型 | 选择路由组时自动切换；单模型会直接报错 |
| 多账号 | 在 Magpie 中为同一供应商添加多个账号 | 可在路由组/策略中分配 |
| 临时停用 | 在 Magpie 中禁用或移除供应商 | 依赖它的模型从目录中消失 |

CLI 辅助：

```sh
magpie provider key <id>       # 查看/更新 Key（按命令提示）
magpie provider models <id>    # 查看模型列表
magpie provider fallback <id> <provider/model>…   # 配置备用模型
magpie accounts                # 查看各订阅/账号的额度与重置时间
```

### 2.3 模型标识与显示名

- Magpie 中模型的真实标识是 `provider/model`，例如 `openai/gpt-4.1`、`deepseek/deepseek-chat`；
- 路由组的标识是 `group/<id>`，例如 `group/opus`；
- **模型 ID 决定路由与计费，不能随意改**；想改 Cursor 菜单里的名字，请在 Bridge 的「模型显示名」中设置（见第七节）；
- 也可以先在 Magpie 中给模型设置全局显示名：

```sh
magpie model name <provider/model> "<显示名>"
magpie model name <provider/model> --reset
```

### 2.4 路由组（多模型时推荐）

当你有多个供应商或多个同类模型时，建议创建一个路由组：

1. Magpie → **路由组** → 新建；
2. 添加成员模型（可以是不同供应商）；
3. 选择路由策略：按顺序、轮询、按用量、按配额、最快、最便宜、权重、备用等；
4. 选择会话粘性（session / turn / auto / off）；
5. 保存后，在 Agents 中把 Cursor Bridge 连接到 `group/<id>`。

CLI 示例：

```sh
magpie groups
magpie group add fast models=provider/a,provider/b routing=order stays=session
magpie group <id>
```

Bridge 会把 `group/<id>` 当作一个普通模型同步到 Cursor 菜单；显示名、顺序与隐藏仍由 Bridge 控制。

### 2.5 两层模型可见性

模型「看不到」通常有两层原因，按顺序检查：

| 层 | 位置 | 作用 |
|---|---|---|
| **Magpie 可见性** | Magpie → Agent（Cursor · Magpie Bridge）的可见模型 / `magpie visible` | 决定这个 Agent 能拿到哪些模型；不在范围内的模型 Bridge 根本收不到 |
| **Bridge 菜单显示** | 控制台 → 模型显示名 → 「菜单」勾选 | 决定 Cursor 菜单里显示哪些模型；隐藏只影响展示，不改变路由 |

排查顺序：先在 Magpie 确认模型/路由组已分配给 Cursor Bridge，再检查 Bridge 的菜单勾选与搜索条件。

### 2.6 网关与运行状态

- Magpie 必须保持运行（主窗口、菜单栏或 `magpie web` 均可）；
- 网关地址通常为 `127.0.0.1:3425/v1`，可在 Magpie 左下角或设置中查看；
- Bridge 的 `connection.json` 保存网关地址与 Agent Key；控制台的「代理端口 / 后端端口」显示当前链路；
- Magpie 短暂不可达时，Bridge 保留正在运行的引擎并持续重试（状态仍为「运行中」，`status.json` 附带网关告警）；只有没有引擎在跑且持续不可达超过容错时间（默认 60 秒）才停止并交回 Cursor 自带后端；
- 控制台「日志与诊断 → 运行自检」会检查 Magpie 网关、模型目录与当前模型。

### 2.7 供应商故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `HTTP 401` / `unauthorized` | Key 无效、过期或复制不全 | 在 Magpie → 供应商更新 Key 并「测试」 |
| `HTTP 429` / 额度不足 | 配额耗尽、并发过高 | 更换 Key/账号，或使用路由组与备用模型 |
| 模型不在目录 | 模型 ID 拼写错误、供应商未启用该模型 | 在 Magpie 检查供应商模型列表，重新同步 |
| 连接超时 / TLS 错误 | Base URL 不可达、代理冲突、证书问题 | 在 Magpie 测试供应商；确认本机网络与代理设置 |
| Bridge 显示「网关不可用」 | Magpie 未运行或网关端口变化 | 启动 Magpie；在 Agents 中重新连接模型 |
| Cursor 菜单没有新模型 | 两层可见性之一未放开 | 先查 Magpie Agent 可见范围，再查 Bridge 菜单勾选 |

---

## 三、安装前准备

| 项目 | 要求 |
|---|---|
| Cursor | 3.28.x ～ 3.32.10 为已实测范围；更高版本控制台会标记「未验证」 |
| Magpie | 已安装、正在运行，且至少有一个可用模型 |
| 平台 | macOS（Apple Silicon / Intel）、Windows x64、Linux x64 / arm64 |
| 权限 | macOS 首次信任证书需系统授权；Windows 首次信任证书需一次管理员确认；Linux 无需 root |

不需要安装 Cursor BYOK、Rust 或 Node；插件运行在 Magpie 自带的 Bun 上。

---

## 四、安装插件

### 4.1 从 Magpie 插件页安装

在 **Magpie → Plugins** 添加快捷安装地址（固定版本）：

```text
github:<owner>/magpie-agent-cursor-bridge-enhanced#v0.2.38
```

完整地址见 README 顶部的安装地址，把末尾 tag 换成目标版本即可。

安装后在对应插件目录执行一次初始化：

```sh
bash "$HOME/.config/magpie/plugins/node_modules/magpie-agent-cursor-bridge/setup.command"
```

Windows 可直接打开 **Cursor · Magpie Bridge** 行菜单 →「桥接控制台」，点「启动」。

### 4.2 本机源码安装

```sh
cd <项目目录>
bash setup.command
```

初始化会完成：版本与 SHA-256 校验、生成本机 CA 并信任、stage 运行目录、注册 Magpie 插件、启动后台服务。之后在 **Magpie → Agents** 选择 **Cursor · Magpie Bridge** 和一个模型，重启 Cursor 即可。

> 未选择模型时原生引擎处于「等待连接」待机状态，这不是故障。

### 4.3 在 Magpie 连接模型

![Magpie Agents 页面中的 Cursor · Magpie Bridge](images/magpie-agents.png)

1. 打开 **Magpie → Agents**；
2. 找到 **Cursor · Magpie Bridge** 一行；
3. 在右侧下拉框选择模型或路由组（如 `group/<id>`），打开行尾开关；
4. 点「详情」可以展开模型列表、上下文窗口与连接文件；
5. 首次连接后重启 Cursor，让代理设置与模型菜单生效。

---

## 五、控制台总览

### 5.1 入口在哪里

Bridge 控制台的入口有三个位置，打开的是同一个本机页面 `http://127.0.0.1:3580`：

1. **Magpie 左侧栏 → 插件 → Cursor 桥接控制台**（下图红框）；
2. **Magpie → Agents → Cursor · Magpie Bridge 行菜单**中的「桥接控制台」；
3. 插件页「已安装」中的 `magpie-agent-cursor-bridge-enhanced`，其说明写明会「为侧栏添加一个页面」并「在 Agent 的菜单中添加菜单项」。

![左侧栏的 Cursor 桥接控制台入口](images/magpie-sidebar-console.png)

![已安装插件行](images/magpie-installed-bridge.png)

### 5.2 总览

打开 **Magpie → Cursor · Magpie Bridge → 桥接控制台**，或直接访问 `http://127.0.0.1:3580`。

![控制台总览](images/console-overview.png)

| 区域 | 说明 |
|---|---|
| 顶部按钮 | **启动 / 停止 / 状态 / 重启** 调用与命令行相同的安装入口；**停止** 会停止后台并还原 Cursor 代理，不卸载服务、不删除数据；**端口设置** 返回 Magpie 面板修改控制端口 |
| 右上角 | **刷新状态** 重新读取运行信息；**检查更新** 读取 GitHub 最新版本；**刷新页面** 获取新的控制口令；**GitHub** 通过本机默认浏览器打开项目仓库 |
| 状态卡片 | 插件版本、Cursor 版本与兼容提示、运行模式、模型目录模式、数据库大小、自动清理结果、后台监视器 / 引擎 PID、代理与后端端口、当前模型 |
| 可编辑参数 | 折叠卡片，默认收起；标题右侧显示当前运行模式。展开后为运行模式、子代理模式、同步间隔、断线容错、日志上限、调用日志 / 历史会话保留天数、接管 Orca、显示 Cursor 官方模型 |
| 折叠卡片 | 模型显示名、数据库管理、最近调用、日志与诊断；右侧文字与箭头对齐，展开后加载数据 |

> 控制台只监听 `127.0.0.1`，每次启动生成随机口令；插件重载或升级后若提示「控制口令无效」，点「刷新页面」即可。

---

## 六、可编辑参数

卡片默认收起，点击标题或右侧箭头展开；收起时标题右侧显示当前运行模式（如「默认模式 · 展开编辑」）。

| 参数 | 默认值 | 生效方式 |
|---|---:|---|
| 运行模式 | 默认模式 | 切换会重启引擎；轻量模式使用内存 SQLite，不写 `bridge.db` |
| 子代理模式 | 异步后台 | 切换会重启引擎；同步阻塞会强制 `run_in_background=false` |
| 显示 Cursor 官方模型 | 关闭 | 切换会重启引擎；开启后菜单同时显示官方模型与带 `MAGPIE` 角标的 Magpie 模型，官方模型按 Cursor 订阅计费，Auto 随官方目录恢复；关闭只显示 Magpie 模型 |
| 模型目录同步间隔 | 15 秒 | 下一轮循环生效 |
| 网关断线容错 | 60 秒 | 下一轮循环生效；短暂断线不会立刻切断代理 |
| 引擎日志上限 | 4 MiB | 下次后台启动生效 |
| 调用日志保留 | 7 天 | 由独立子进程后台分批清理，不占用主循环、不中断对话；`0` 表示不自动清理 |
| 历史会话保留 | 0（关闭） | 同上；开启后按天清理历史会话，blob 内容保留 |

保存后，设置写入 `~/.config/magpie-cursor-bridge/bridge-settings.json`。控制台的「可编辑参数」和「模型显示名」两个表单只提交各自字段，服务端会与现有配置合并，不会互相清空。

---

## 七、模型显示名、顺序与隐藏

展开「模型显示名」卡片：

![模型显示名与排序](images/console-models.png)

- **显示名**：留空使用 Magpie 原名；只改 Cursor 菜单标签，不改变模型 ID、路由与计费。
- **菜单勾选**：取消勾选后该模型从 Cursor 菜单隐藏；**当前选中的模型即使隐藏也始终保留**，避免路由失效。
- **拖动排序**：拖动行首 `⋮⋮` 调整 Cursor 菜单顺序。
- **搜索**：按模型 ID 或名称过滤。
- **测试**：向 Magpie 网关发送一条极短请求，按钮显示延迟，失败时给出错误。
- **保存**：行内「保存」只更新该行名称；名称、顺序与隐藏项由底部「保存全部」一起提交。

保存后约 2–4 秒写入引擎目录，无需重启引擎；重新打开 Cursor 模型菜单即可看到。

---

## 八、数据库管理

展开「数据库管理」卡片：

![数据库管理](images/console-database.png)

- 按「会话与消息 / 检查点 / 运行与工具调用 / 请求调用日志 / 内容存储 / 配置」分类展示行数与内容体积。
- 「精确统计」会扫描全部 blob 正文，耗时更长；快速统计不读取 blob 正文。
- 「最近会话」「近 7 天消息增长」帮助判断数据分布。
- **清理调用日志**：删除模型调用与 Cursor 请求追踪。
- **清理历史会话**：删除指定天数前未更新的会话、消息、检查点与运行记录；blob 内容保留。
- **压缩**：只执行 VACUUM，回收空闲页。
- **清空全部运行数据**：删除全部会话与调用数据，保留模型配置与服务设置；需输入「清空全部」确认。

清理默认会先暂停桥接，完成后自动重启；勾选「清理前备份数据库」时会用 `VACUUM INTO` 生成快照到 `data/backups`，保留最近 3 份。清理后执行 `PRAGMA quick_check` 并显示结果。自动保留策略只做在线分批删除、不执行 VACUUM，需要立即回收磁盘空间时仍使用本卡片的手动清理。

---

## 九、最近调用

展开「最近调用」卡片：

![最近调用](images/console-calls.png)

- 来自 `llm_calls`，按时间倒序读取最近 25 / 50 / 100 条。
- 展示时间、模型、状态、耗时、输入 / 输出 / 总 token、HTTP 状态与错误摘要。
- 勾选「只看错误」可过滤失败调用；错误内容已按日志规则脱敏。
- 只读查询走 `created_at_ms` 索引，不扫描请求正文，不影响桥接运行。

---

## 十、日志、自检与诊断包

展开「日志与诊断」卡片：

![日志与诊断](images/console-diagnostics.png)

### 10.1 日志尾部

- 选择 `engine.log` / `supervisor.log` / `supervisor-error.log`，读取最近 100–1000 行。
- 控制台会自动按证书、端口、网关、协议、连接停滞、启动超时、代理改动归类并给出建议。
- 日志内容在返回前统一脱敏（`Authorization`、`sk-`、JSON/键值形式的 key/token/secret/password）。

### 10.2 分层自检

点「运行自检」会依次检查：

1. 插件版本（`installation.json`）
2. Magpie 连接（模型、密钥、网关）
3. 后台监视器与原生引擎 PID
4. 代理端口 TCP 可达
5. 经本地代理到 `api2.cursor.sh` 的 TLS / MITM 证书链路
6. Magpie 网关模型目录与当前模型
7. 可选的一条极短模型请求（默认勾选，可能计费）

结果以检查表显示失败层与耗时。自检覆盖到模型层；Cursor `BidiAppend/RunSSE` 的完整原生往返仍由构建侧的 `magpie_smoke` 示例覆盖。

### 10.3 诊断包

点「导出诊断包」会把状态、设置、版本、平台、保留结果与脱敏日志写入：

```text
~/.config/magpie-cursor-bridge/data/diagnostics/diagnostics-<时间>.json
```

返回文件路径；不会包含 Magpie 网关密钥。

---

## 十一、更新与升级

点顶部「检查更新」：

- 读取 GitHub latest Release，与当前 `installation.json` 版本比较；结果缓存 10 分钟。
- **干净源码安装**（源码 checkout 无未提交改动、`origin` 指向本项目）：显示「升级并重启」，执行 `git fetch --tags` → `git merge --ff-only <tag>` → `setup.command`。
- **Magpie 托管安装或源码有改动**：显示手动升级命令，不自动改写源码。
- 升级完成后建议刷新页面或重启 Magpie，以加载新的控制台代码。

---

## 十二、常见问题

| 现象 | 处理 |
|---|---|
| 控制台提示「控制口令无效」 | 插件重载 / 升级后旧页面令牌过期；点「刷新页面」重新获取 |
| 点了「停止」后 Cursor 还能用吗 | 会还原 Cursor 代理，Cursor 回到原官方路径；再次点「启动」恢复桥接。停止不是卸载 |
| 原生引擎「等待连接」 | 尚未在 Magpie → Agents 选择模型；这是正常待机状态 |
| 启动失败，日志提到证书 | 重新运行 `setup.command`；Windows 确认一次管理员授权，Linux 检查 `argv.json` / NSS |
| 端口被占用 | 关闭重复的桥接实例；必要时在 Magpie 面板修改控制端口 |
| 日志出现协议解码失败 | Cursor 私有协议可能已变化；先运行分层自检，再升级桥接或回退 Cursor |
| 模型菜单没有某个模型 | 先查 Magpie Agent 可见范围，再查 Bridge「模型显示名」的菜单勾选与搜索条件 |
| 开启「显示 Cursor 官方模型」后仍只有 Magpie 模型 | Cursor 未登录或官方目录请求失败时会回退本地目录；确认 Cursor 已登录，并查看 `engine.log` 中的 upstream 日志 |
| 官方模型与 Magpie 模型如何区分计费 | 无角标为 Cursor 官方模型（按 Cursor 订阅计费）；带 `MAGPIE` 角标为 Magpie 模型（按 Magpie 计费） |
| 模型请求 401 / 429 | 在 Magpie → 供应商更新 Key 或切换账号；必要时使用路由组备用模型 |
| 磁盘占用持续增长 | 调低「调用日志保留」天数、开启「历史会话保留」，或使用数据库管理手动清理 / 压缩 |

---

## 十三、卸载与还原

```sh
bash setup.command uninstall
```

会停止后台服务、移除启动项、还原 Cursor 代理设置并移除 Magpie 插件登记；证书、数据与恢复记录保留。若从 Magpie 插件页安装，请同时在插件页移除该插件。

---

## 下一步

- 协议原理、版本适配与构建流程：见 [README](../README.md) 第二、四、五节。
- 变更记录：见 [CHANGELOG](../CHANGELOG.md)。
- 问题反馈：请附上控制台「日志与诊断」导出的脱敏诊断包与 Cursor 版本。
