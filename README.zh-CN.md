<div align="center">

**简体中文** · [English](README.md)

<img src="assets/logo.svg" alt="agy-dart logo" width="80" />

# agy-dart

**Google Antigravity 插件 — 省 token · 优化缓存命中 · 自动保持缓存温度 · 优化上下文额度 · 抢救崩掉的会话**

不用额外装依赖 · 装好自动在后台工作 · 自带右侧面板

[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg)](LICENSE)
[![Node.js 22.16+ (22.x) 或 24+](https://img.shields.io/badge/Node.js-22.16%2B_(22.x)_or_24%2B-38bdf8.svg)](package.json)
[![Security Policy](https://img.shields.io/badge/Security-Policy-818cf8.svg)](SECURITY.md)
[![Glama MCP](https://glama.ai/mcp/servers/zou172866/agy-dart/badges/score.svg)](https://glama.ai/mcp/servers/zou172866/agy-dart)
[![Clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/Antigravity-agy-dart.json)](https://github.com/zou172866/repo-traffic-archive)

[怎么安装](#怎么安装) · [更新日志](#更新日志) · [安全说明](SECURITY.md) · [开源致谢](THIRD_PARTY_NOTICES.md)

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.zh-CN.svg" />
    <source media="(prefers-color-scheme: light)" srcset="assets/architecture-light.zh-CN.svg" />
    <img alt="agy-dart 架构示意图" src="assets/architecture-dark.zh-CN.svg" width="860" />
  </picture>
</p>

<p align="center">
  <img alt="开启 agy-dart 前后对比" src="assets/demo-comparison.zh-CN.svg" width="860" />
</p>

---

## 这个 Google Antigravity 插件是干什么的？

`agy-dart` 是专为 **Google Antigravity** 打造的性能、缓存与上下文管理插件（同时支持通过 `--target` 安装到 DeepSeek Harness、Claude Code 与 Codex）：减少重复读取和过长的工具输出，查看缓存用量，会话占满上下文或卡住时可以把进度带到新对话。

装好之后在后台自动生效，不用记新命令，平时照常打字聊天就行：

### 1. 整合动作
AI 要搜好几个词时一次同时搜完，要改多个文件时一次改完并顺手跑完测试，少跑好几轮重复带上下文的请求。

### 2. 挡住废话
跑一次测试吐出 3000 行日志，插件只挑关键那几句给 AI（比如第 42 行报错，其余 199 个通过），完整原文存进本地备查。遇到几千行的大代码文件，先拉目录再读要改的那几十行。

### 3. 缓存监测与按需续温
插件在客户端侧稳定可控前缀，并减少短时间内重复读取未修改的文件；实际缓存命中率仍取决于宿主构造请求的方式及后端缓存行为（若排查动态代理分流影响，可固定单一出口作为有对照的排查实验）。自动续温和缓存到期桌面提醒默认关闭。首次开启续温时，每段对话最多自动请求 1 次，发新消息后重新计数。次数可在面板里调整。

### 4. 右侧面板与崩溃/卡死抢救
右侧边栏面板直接显示：上下文还有多少、缓存还剩几分钟过期、挡掉了多少废话。
多开项目窗口时，哪个后台窗口上下文快满了，或者一直转圈不出字，右下角会弹窗标明是哪个窗口、哪段对话，点一下弹窗直接切过去。会话真因为爆上下文崩掉或卡死时，在面板点一下复制当前进度摘要，贴到新对话接着往下做。

### 其他内置功能
1. **压缩对话（`/compact`）后恢复上下文线索**：后台记录本轮改过哪些文件、最近一次测试或打包过没过、存过哪些参考资料。跑完 `/compact` 后 AI 可以直接调出这份记录接着做。
2. **长文档与网页存本地检索**：几万字的开发文档或网页可以先按章节存进本地数据库，后面用到哪段按关键词搜哪段。
3. **大日志与大表格先在本地跑脚本筛选**：遇到几十 MB 的日志、CSV 或几万行 JSON，AI 可以在本地沙盒跑几行脚本先做统计（比如筛出报错最多的 5 个接口），只把算出来的结果发回对话；大 JSON 还会自动摘出报错的异常条。
4. **新对话自动附带目录结构**：刚开对话时自动给出一份精简的项目目录、脚本和核心文件清单。
5. **死循环提示**：AI 连续出现「改代码 → 报错 → 改回去 → 又报错」或反复调同一个工具没进展时，在聊天界面弹一行只给用户看的提示（不塞进模型上下文）。
6. **密钥打码、敏感文件与 Git 沙盒防护**：日志或网页里的 API Key、口令自动打码；可拦截 AI 误读 `.env` 等配置文件，并封堵陌生仓库 `.git/config` 挂载外部命令的入口。
7. **单次返回卡在 8.8 KB 以内（智能匀配额）**：Antigravity 工具单次返回超过约 10 KB 会自动落成临时文件让 AI 多读一轮；插件把返回内容控制在 8.8 KB 内，并自动把短检查省下的空间让给真正报错的长堆栈。
8. **面板细分统计与离线测算**：右侧面板能查看上下文花在读文件、终端输出还是子智能体上，以及最近 15 轮缓存命中走势和失效原因；可选开启大文件修改后只读改动行（默认关闭）；命令行支持拿历史记录测算缓存命中与自动续期账本。
9. **和各类 Skill 放心叠加，还能体检它们占了多少额度**：平时装的各类 Skill 照常管流程，插件在底层负责防盲读大文件、压刷屏日志和保缓存，互不打架；跑一句 `node bin/agy-dart.mjs audit skills`，就能一键查出本机装的所有 Skill 各自占了多少开场上下文、有没有把大段参考资料全塞进主说明里。

> Antigravity 官方更新很勤，可以点一下右上角 **Star** 方便跟进后续兼容更新。

---

## 怎么安装

使用 **Node.js 22.x 的 22.16.0 及以上版本，或 Node.js 24 及以上版本**。安装器会检查内置 SQLite 是否支持 FTS5 及其 trigram 分词器。插件只使用内置模块。

### 方法一：终端一行命令直装（免手动克隆）

**Windows（PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/zou172866/Antigravity-agy-dart/v1.7.8/install.ps1 | iex
```

**macOS / Linux：**

```bash
curl -fsSL https://raw.githubusercontent.com/zou172866/Antigravity-agy-dart/v1.7.8/install.sh | sh
```

### 方法二：直接发给 Antigravity 装

复制这句发给 Antigravity：

```text
请将 https://github.com/zou172866/Antigravity-agy-dart.git 的 v1.7.8 标签克隆到临时目录，运行其中的 scripts/install.mjs install 完成全局安装并跑 doctor 自检（Windows 如未安装 rg 请同时传 --install-rg）。
```

### 方法三：克隆仓库自定义安装

```powershell
git clone --branch v1.7.8 --depth 1 https://github.com/zou172866/Antigravity-agy-dart.git
cd Antigravity-agy-dart

# Windows PowerShell（加 -InstallRg 可顺手自动安装快速搜索工具 rg）
.\install.ps1 -InstallRg

# macOS / Linux
./install.sh
```

**其他命令：**

```bash
node scripts/install.mjs install                     # 全局安装（若本机存在 GEMINI_HOME 或 T3 ACP 目录会自动同步）
node scripts/install.mjs install --project /项目路径  # 只装到单个项目
node scripts/install.mjs doctor                      # 检查安装状态
node scripts/install.mjs uninstall                   # 卸载
```

装完重启或刷新一下 Antigravity 窗口，新开对话生效。升级重装时会自动保留插件目录下你自建的 `rules/*.local.md`。以前单独装过 `agy-fast` 或 `antigravity-plugin-context-mode` 的话，去插件列表关掉旧的。

索引内容和用量记录默认保存在本机 `~/.agy-dart/context.db`，卸载后会保留。卸载前可调用 `ctx_purge` 清理当前对话的索引。宿主未提供会话 ID 时，此操作会清理已确认工作区的匿名数据。如需清理所有项目的索引和历史记录，可用 `scope: "all"` 调用 `ctx_purge`。

全局卸载也会移除安装器有记录的 Gemini/T3 同步副本。遇到无法确认归属的旧副本时，安装器会列出路径和单独卸载该副本的命令。

---

## 设置调节

自动续温默认关闭。需要时，在右侧 **agy-dart Context** 面板给当前窗口打开“自动续温”，也可以随时点倒计时旁的「续温 1×」手动续一次。「全局续温」用来统一设置默认次数和间隔（支持 **动态（自动估算）**、**固定 4 / 9 / 15 分钟** 或 **自定义 1–60 分钟**）。关掉当前窗口的自动续温后，快过期和次数用完都不会再弹桌面提醒。任务卡死弹窗也默认关闭，可在面板里单独开启。每次续温都会让模型回一个 `OK` 并消耗一点输入额度，如果缓存已经失效，会重新处理整段历史。面板里也能调桌面提醒、暂停保护、清理旧记录和文件大小上限。

也可以用命令切拦截档位与工具加载方式：

```bash
node scripts/install.mjs mode host-45k              # 默认：普通代码 45 KB、补丁 128 KB 内直读，大日志超 16 KB 拦截
node scripts/install.mjs mode balanced-16k          # 超过 16 KB 先看目录挑重点读
node scripts/install.mjs mode fast-32k              # 普通文件放宽到 32 KB
node scripts/install.mjs mode strict-8k             # 超过 8 KB 拦截
node scripts/install.mjs mode no-read-hook          # 读文件不拦，只拦终端刷屏大日志

node scripts/install.mjs tool-loading fast-eager    # 默认：4 个高频 fast 工具直连预载，8 个 context 工具按需懒加载
node scripts/install.mjs tool-loading lazy          # 12 个工具全部按需懒加载
node scripts/install.mjs tool-loading eager         # 12 个工具全部预载
```

---

## 更新日志

### v1.7.8
- **新增可选「自动更新」静默升级开关（默认关闭）**：面板顶栏新增 `自动更新：关/开` 切换按钮（同时支持 `~/.agy-dart/config.json` `autoUpdateInstall` 与 `AGY_DART_AUTO_UPDATE_INSTALL` / `AGY_DART_DISABLE_AUTO_UPDATE_INSTALL` 环境变量）；开启后启动与每 6 小时后台检查仅对同主版本且带 SHA-256 校验 `.tgz` 资产的 Release 自动升级，自动避让在途保活请求、单版本失败熔断，并在面板重载后展示一次可关闭的升级完成提示。

### v1.7.7
- **原生适配 DeepSeek Harness（`--target dsh`）**：新增零依赖原生 Cordis 插件（`dsh/plugin.mjs`）与 `--target dsh` 一等宿主安装器（支持 `--profile <名称>` 与 `--mcp-only`），自动在 `cordis.patch.yml` 挂载双 MCP（含 180s/310s 超时配置）、通过 DSH 原生 `tools/pre-execute` / `tools/execute` / `tools/result` 护航 `read` / Windows `pwsh` / `bash` / `edit` / `write` / `apply_patch`，同步 `~/.dsh/skills/agy-dart/`，并新增 `node bin/agy-dart.mjs dashboard` 独立拉起浏览器诊断面板；Antigravity 端零破坏、0 Token 增量。
- **已归档对话自动停用保活守护**：自动识别已归档对话并暂停后台自动保活、手动预热与桌面弹窗，取消归档后自动恢复且不丢失会话状态。

### v1.7.6
- **面板新增一键在线更新与启动版本检查**（感谢 [@bestmulicc](https://github.com/bestmulicc) 贡献，[#5](https://github.com/zou172866/Antigravity-agy-dart/pull/5)）：右侧面板启动时会自动检查 GitHub 是否有新版本（可在 `~/.agy-dart/config.json` 设 `autoUpdateCheck: false` 或环境变量 `AGY_DART_DISABLE_AUTO_UPDATE_CHECK=1` 关闭），点顶栏「检查更新」/「立即更新」即可原地升级，不用再手动跑终端安装命令。
- **校验下载包、失败自动回滚并保留个人配置**：优先下载带 SHA-256 校验的 Release 压缩包再解包，遇到文件被占用会自动回滚恢复原版；升级后自动重载面板，同时保留本地 `rules/*.local.md`、工具加载模式、`--with-devtools` 工具和同步的 Gemini/T3 副本。

### v1.7.5
- **面板新增一键「续温 1×」按钮**：缓存倒计时旁边可以直接手动点一次续温。就算平时关着自动续温也能随时点，而且不扣自动续温次数（防连点，发送失败也不白算）。
- **快过期时不白续，倒计时统一**：缓存只剩最后十几秒、来不及送达时会自动放弃续温以免白花 token，改弹桌面提醒；同时面板、后台监控和弹窗提醒统一用同一个倒计时，不再两边对不上。如果缓存其实已经失效，也会及时停手不再空续。

### v1.7.4
- **交接指令话术更自然**：点「复制给当前窗口的交接指令」时，中英文模板加上了更亲切的开头称呼（中文「宝宝，」、英文 `Sweetie,`），并让 AI 生成的交接单直接按同样开头起笔，依然只吐正文、不带废话。

### v1.7.3
- **自动续温支持自选间隔**：全局和单个窗口都能选 **动态（自动估算）**、**固定 4 / 9 / 15 分钟** 或 **自定义（1–60 分钟）**，单窗口改完点「随全局」即可恢复默认；原有的省钱保护（次数上限、对话太短不续、缓存失效即停、跳过后台子任务）照常生效。
- **修好测试超时误报和面板误判通过**：命令只是跑超时了，不再误报“AI 在反复改错”；只跑过无关测试或单个用例，不会盖掉之前失败的完整测试；后台测试报错后就算改了别的文件也不会漏掉；测试日志太长被截断、看不清哪条没过时，面板会一直提醒重跑，不会当成已通过。
- **换新对话更好交接，缓存失效原因更清楚**：换窗或压缩前可一键复制更干净的进度摘要（自动打码密钥和口令），面板也能更准确标出为什么没命中缓存。

### v1.7.2
- **给插件自带说明「瘦身」，新增 Skills 体检命令**：把示例脚本和排错手册拆成用到再读，平时不白占开场上下文；新增 `node bin/agy-dart.mjs audit skills`，一键查出本机所有已装 Skill 各自占了多少开场额度、有没有把大段资料全塞进主说明里。
- **自带的两个轻量子助手更省输出**：内置的改代码助手（`dart-coder`）和审查助手（`dart-reviewer`）继续保持轻装上阵（不额外背一堆工具和全局规则），现在跑快速检查也会自动精简输出，减少把超长日志直接倒进对话。

### v1.7.1
- **修好面板「已挡废话」一直显示 0 的问题**：以前按段读代码、批量搜代码、精简检查输出省下来的字数没记进面板，现在按实际省下的大小如实统计，多开窗口也不会算串或重复计数。
- **后台子任务省下的额度汇总到主对话**：存长文档、批量查资料以及子任务省下来的 token，现在统一归到主对话里展示，账目更准。
- **修好 Windows 下部分命令没被精简的问题**：像 `npm --prefix`、`pnpm -C`、`yarn --cwd` 以及带 `--` 参数的命令，现在在 Windows / PowerShell 下也能正常过滤刷屏日志。

### v1.7.0
- **拦住整篇硬读大文件时，顺手把目录递给 AI**：AI 第一次想整篇读大代码文件被拦下时，插件会直接附上一份带行号的函数和类清单，AI 不用再多问一轮目录，直接挑要看的那几行去读。
- **新增统一命令行工具，支持装到 Claude Code 和 Codex**：用 `node bin/agy-dart.mjs` 可安装到 Antigravity、Claude Code 或 Codex，还能直接查看代码大纲、对比不同对话花了多少 token；同时内置了轻量的改代码 / 审查子助手，并加强了多项目隔离和 Node.js 环境检查。

### v1.6.0
- **常用 4 个工具改为直连，修好多文件修改偶发丢内容**：把最常用的 4 个功能（批量搜、看大纲、改文件、跑检查）改成直接预载，避开以前偶尔把多文件改动清空的坑；另外 8 个处理大日志的工具继续用到再加载，省开场额度。
- **修好自动续温偶尔失效，后台子任务不再乱续温**：更新插件后后台面板会自动重启，不再被旧进程卡住；`/boost`、浏览器、工作流派出去的后台子任务和已经关掉的旧对话，一律不再发续温请求，也不再挤占面板顶部状态栏。
- **后台子任务读文件直接放行，防止 AI 误改插件自身**：子任务读大文件或重读文件不再弹红字卡住；漏传路径误落进插件安装目录时直接拦住，防止误搜或误改插件自身。
- **支持终端一行命令直装**：不用手动克隆仓库，复制一行 PowerShell 或 Shell 命令就能装好。
- **其他优化**：短检查省下的输出额度会自动让给真正报错的长堆栈；限制 Git 只读查询，防止陌生仓库偷跑外部命令；修好 Windows 退出卡死；升级保留个人规则（`rules/*.local.md`），补齐安全说明与深浅色架构图。

### v1.5.4
- **点击提醒直达对应会话**：点右下角弹窗或右侧面板里的跨窗口告警，自动切出对应项目窗口并跳进那段对话；面板新增多窗口会话切换栏。
- **按需续温**。开启后，主对话会在缓存快到期前发送续温请求。面板可调整每段对话的次数，发新消息后重新计数。
- 把当前上下文用量、缓存倒计时和已拦废话量放大移到面板第一栏。

### v1.5.3
- **多窗口弹窗标明项目与对话标题**：右下角提醒和面板告警直接显示目录名（如 `work/agy-dart`）与会话短标题，不露聊天正文。
- **上下文快满了弹窗提醒**：接近上限时右下角提醒一次，跑完 `/compact` 自动重置。

### v1.5.2
- 加快读文件与新对话启动；支持提取几千行 `.html` / `.astro` 和 `.dart` 的代码目录；修 Windows 下 Python / PowerShell 中文乱码，面板切后台自动停刷。

### v1.5.1
- 补全中文面板漏译词；调准文件修改后的拦截建议。

### v1.5.0
- **读取模型实际缓存过期时间**：按近期使用记录读取当前模型的实际缓存过期时间（如 5 分钟或 15 分钟），新开对话直接沿用。
- 新增可选的缓存临期桌面提醒（过期前 1 分钟弹窗），命令行加入自动续期成本测算。

### v1.4.0
- **卡死检测与抢救摘要**：后台发现对话长时间转圈不出字时（避开长打包和电脑休眠），面板标红指出卡在哪一步，并自动生成进度摘要（改过的文件、最后执行的命令、当前步骤），可一键复制去新对话继续。

### v1.3.1
- 跑完 `/compact` 压缩后立即可重读文件；4 KB 以下小切片免拦截；长报错日志额外保留中段报错行。

### v1.3.0
- **分档放行读文件**：普通代码放宽到 45 KB（800 行）、`.patch` 补丁放宽到 128 KB 直读，刷屏日志维持 16 KB 拦截；超限重试一次放行，审补丁和子代理不再卡住。
- 支持列出 `.patch` 改动目录，精简 `git diff` 时保留上下文行。

### v1.2.2
- **长任务不断流**：去掉中途催用户 `/compact` 的旧规则，超过 1 分钟的测试、打包和后台服务直走原生后台通道。
- 挡住误读 `.env`、修 Windows 特殊符号与残留子进程等 42 项问题。

### v1.2.1
- 多文件同时修改出错自动回滚，修路径与命令参数等 76 项稳定性问题。

### v1.2.0
- 配置统一存进 `~/.agy-dart/config.json`；本地面板接口加安全校验；**超大 JSON 自动提取结构、首尾样本与报错项**；新增 `gh`、`kubectl`、`terraform`、`playwright` 输出精简与交接摘要。

### v1.1.0
- **终端输出自动瘦身**：自动清掉 `git`、测试、打包、安装命令里的进度条和刷屏内容，原文存本地备查。
- 同文件未改动防重复读取；AI 反复改错原地打转时给出界面提示；抓网页拦内网地址、日志密钥自动打码、面板一键清理旧数据。

---

## 本地自检命令

```bash
npm test                                    # 跑全套测试
npm run verify:pkg                          # 检查安装包文件完整性
npm run prefix:budget                       # 分别估算 Antigravity 配置的首轮占用和全部工具加载后的占用
npm run brief:check                         # 检查 AI_REVIEW_BRIEF.md 里的行数和测试数是不是最新的
node scripts/cache-audit.mjs --workspace . --no-live
node bin/agy-dart.mjs audit skills --workspace .   # 检查本机已装 Skills 的开场上下文占用和文件拆分情况
npm run cache:simulate
```

改了源码文件或增删测试后，记得顺手同步下面三处，不然本地自检会报错：
- **打包清单**（`scripts/install.mjs`）：新增或删除文件后，同步改 `RUNTIME_FILES`（默认安装的文件）或 `DEVTOOLS_FILES`（加 `--with-devtools` 才装的文件），否则 `npm run verify:pkg` 会拦截。
- **测试总数**（`tests/v1.2-hardening.test.mjs`）：增删用例后，把里面写死的 `computeBriefMetrics(ROOT).testCases` 数量改成和 `npm test` 一致。
- **审阅简报**（`AI_REVIEW_BRIEF.md`）：改完核心代码或测试后，跑一遍 `node scripts/gen-review-brief.mjs --write` 自动更新行数和测试数，再用 `npm run brief:check` 确认通过。

---

## 致谢与开源协议

感谢 `INK-Q/agy-fast` 的贡献者。批量编辑会在写文件前校验验证命令，搜索长行时会围绕命中位置截取片段，检查失败时会保留长日志的首尾。这三处实现都借鉴了该项目。[对应的上游源码与许可说明](THIRD_PARTY_NOTICES.md#11-ink-qagy-fast-mit-license)

`daoif/tokless` 为 v1.7 的代码大纲、读取大文件时的大纲提示、分角色工具权限、会话用量对比和多宿主安装提供了参考。结构化日志压缩借鉴了 `headroomlabs-ai/headroom` 的 SmartCrusher，定期清理过期数据的思路来自 `antigravity-panel`。[设计来源与本地实现](THIRD_PARTY_NOTICES.md#additional-design-references)

[MIT 协议](LICENSE) 开源。部分代码整合改造自同为 MIT 协议的 [INK-Q/agy-fast](https://github.com/INK-Q/agy-fast) 与 [Domush/antigravity-plugin-context-mode](https://github.com/Domush/antigravity-plugin-context-mode)，完整第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 命令行工具（支持 Antigravity / DeepSeek Harness / Claude Code / Codex）

用 `node bin/agy-dart.mjs` 默认装到 Antigravity，加上 `--target dsh`（可选 `--profile <名称>` / `--mcp-only`）、`--target claude` 或 `--target codex` 可以装到 DeepSeek Harness、Claude Code 或 Codex。装到 DeepSeek Harness 时会自动在 `cordis.patch.yml` 挂载双 MCP（`agy_dart_fast` 与 `agy_dart_context`）、零依赖原生 Cordis 守卫插件（`dsh/plugin.mjs`）并同步 `~/.dsh/skills/agy-dart/`；运行 `node bin/agy-dart.mjs dashboard` 可在浏览器独立打开实时诊断面板。平时也能直接用来查大文件目录（`outline <文件>`）、看某次对话花了多少 token（`session <ID>`），或对比两次对话的消耗（`compare <前> <后>`）。

装到 DeepSeek Harness、Claude Code 或 Codex 时，安装器会把改动记录存在 `~/.agy-dart/<宿主名>-install.json` 里，方便以后卸载时干净还原，不会弄乱你原本的配置。

```sh
git clone --branch v1.7.8 --depth 1 https://github.com/zou172866/Antigravity-agy-dart.git
cd Antigravity-agy-dart
node bin/agy-dart.mjs install
node bin/agy-dart.mjs doctor
```

---

## Star History

<a href="https://www.star-history.com/?repos=zou172866%2FAntigravity-agy-dart&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=zou172866/antigravity-agy-dart&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=zou172866/antigravity-agy-dart&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/image?repos=zou172866/antigravity-agy-dart&type=date&legend=top-left" />
  </picture>
</a>
