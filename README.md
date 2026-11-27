# agy-agent-swarm

Antigravity Agent Swarm。一个保守的编排层，负责约束 agy（Antigravity CLI）的执行范围，用真实命令和独立验证器
校验产出，只把通过检查的结果合回主干。

`Next.js 16` · `pi SDK` · `agy ACP` · `bubblewrap` · `git worktree` · `SSE` · 深浅双主题

![控制台](docs/screenshots/console-light.png)

<sub>一个真实任务：目标与契约在左侧会话里，执行、自动检查、独立验证与汇总依次接在下面；右侧是执行代理、账本与网关。</sub>

## 技术栈

- **编排器**：pi SDK（TypeScript）→ DeepSeek；工具调用经 JSON-RPC 驱动子进程。
- **执行协议**：Agent Client Protocol（ACP，stdio JSON-RPC）。
- **隔离**：git worktree 负责分支与历史；bubblewrap（bubble sandbox）负责文件系统与命名空间。
- **控制台**：Next.js 16 App Router，API Route + SSE，单进程全栈。

## 问题

Antigravity 模型能力不弱，但默认行为倾向于一次性完成整个工程：自行扩大范围、跳过验证、把没有运行过的代码
当作已完成。直接把它接到真实项目上，通常得到一个能演示、但工程上不可合并的仓库。

这个系统在 agy 前面加一层保守的编排约束：

- **契约先行**：编排器先定义技术栈、目录布局、接口签名、完成定义与合并后的检查命令，再切分任务。
- **沙箱执行**：每个执行代理运行在独立的 git worktree 与 bubblewrap 沙箱中；根文件系统只读，只有工作区可写。
- **证据验证**：合并后执行真实检查命令，记录 exit code 与原始输出；再由独立验证器从最终代码出发自行复核。
- **分层返工**：执行级问题回给代理重跑；只有在合并树上才暴露的问题交给修复代理。
- **合并门**：验证未通过时拒绝合入，只保留显式的强制合入。

编排器不写代码。它的职责是约束、验证和裁决。

## 架构

```
Next.js 控制台 (3100)
  ├─ 任务提交 / SSE 事件流 / 对话式控制台
  ├─ 编排器（单例）
  │    ├─ 规划 / 裁决：@earendil-works/pi-coding-agent → work2api (8787) → deepseek-v4.1-flash
  │    ├─ 执行代理池：每个任务 spawn agy acp 进程
  │    │    cwd     = 独立 git worktree
  │    │    sandbox = bubblewrap：/ 只读，worktree 与 agy 状态目录可写
  │    │    usage   = ACP session/prompt 返回值
  │    ├─ 验证器 / 修复代理：同样走 agy acp，cwd 指向合并后的 integration 树
  │    └─ 合并、返工、判定、合回主干
  └─ /api/gateway ──► 录制网关 (9000)
                         ├─ Gemini 兼容入口（/v1beta/models/*）
                         ├─ 虚拟 key → agent 归账
                         └─ 上游：任意 Gemini Developer API key
```

## 快速开始

```bash
./install.sh          # 检查 node/pnpm/agy/bwrap/编排器模型，安装依赖，链入 swarm 命令
node tools/sandbox-check.mjs   # 沙箱自检：在 bubblewrap 里完成 ACP 握手，不调用模型
pnpm test             # 纯函数单测：规划解析/校验、状态机、用量记账、CLI 解析，不 spawn agy
pnpm dev              # http://localhost:3100
swarm status          # 命令行连当前服务；没起来会自动启动
```

命令行不是第二套编排器：它通过同一个 HTTP API 和 SSE 控制服务，完整用法见 [docs/cli.md](docs/cli.md)。
`./install.sh` 会把 `bin/swarm.mjs` 软链到 `~/.local/bin/swarm`。

生产部署走 standalone，不需要 `next start`，也不依赖开发服务器：

```bash
./install.sh --service   # 构建 dist/standalone + 安装并启动 systemd user 单元
```

`tools/standalone.sh` 负责构建：`next build`（`output: "standalone"`）→ 组装 `dist/standalone/`
（复制 `.next/static`、补齐 pnpm 外部包软链）→ 删除运行时目录。启动入口是 `dist/standalone/server.js`，
监听 `127.0.0.1:3100`；服务单元见 `deploy/agy-agent-swarm.service`，日志走 `journalctl --user -u agy-agent-swarm`。

脚本里没有写死任何人的家目录：`deploy/agy-agent-swarm.service` 是模板（`@APP_ROOT@`、`@NODE_BIN@`、
`@NODE_DIR@` 三个占位符，家目录用 systemd 的 `%h`），`install.sh --service` 按当前机器渲染后写到
`~/.config/systemd/user/agy-agent-swarm.service`，换用户或换 clone 路径都不用改文件。

`data/`、`dist/`、`.git/` 不会进入产物（`outputFileTracingExcludes`）；注意别在排除规则里写
`./server/**` 这类与 `.next/server` 同名的路径，Turbopack 会连 `.next/server/chunks` 一起剔掉。
`dist/standalone/node_modules` 是指回仓库 `node_modules` 的相对软链：`serverExternalPackages` 的追踪
只带 `package.json`，包内容仍需从仓库解析。

也可以直接手动跑：

```bash
PORT=3100 HOSTNAME=127.0.0.1 SWARM_APP_ROOT=$PWD node dist/standalone/server.js
```

可选：启动录制网关，让需要按 API 计量的代理走它。

```bash
cp <你的 key> data/upstream.key && chmod 600 data/upstream.key
pnpm gateway                                   # http://127.0.0.1:9000
SWARM_GATEWAY_URL=http://127.0.0.1:9000 SWARM_GATEWAY_KEY=vk-demo pnpm dev
```

## 执行沙箱

执行代理不是直接跑在宿主机上的。`server/acp.ts` 在 spawn agy 之前套一层 bubblewrap：

```
--ro-bind / /            根文件系统只读
--ro-bind /data /data    独立数据盘只读（存在时）
--dev-bind /dev /dev
--proc /proc
--tmpfs /tmp
--bind <worktree> <worktree>                    唯一可写的工作区
--bind ~/.cache/antigravity ~/.config/antigravity ~/.gemini ...
--die-with-parent --unshare-pid --unshare-ipc --unshare-uts --share-net
```

网络保持共享（模型 API 需要），PID / IPC / UTS 隔离，父进程退出时子进程一并回收。
这样即使代理在提示词层面越界，也无法改动工作区之外的仓库、其它任务或用户目录。

自动检查与契约 `verify` 也走同一个 `runSandboxedCommand`：异步 spawn、120 秒超时、取消时杀整个进程组，
不再是宿主机上的同步 `execFileSync`。没有 bwrap 时命令照常执行，但结果里会标注「隔离退化」。

- 默认启用；`SWARM_SANDBOX=off` 退回直接 spawn。
- 找不到 `bwrap` 时自动退回直接 spawn；`BWRAP_BIN` 可指定路径。
- 已在沙箱内完成真实代理任务验证：创建文件、`git status`、回读文件均正常。

## 控制台

界面是一个会话式工作台（项目 → 会话），不是仪表盘：

- **左：项目与会话**。按仓库分组列出历史会话；会话可以反复执行，侧栏按最近一次任务显示状态，历史任务仍保留在 `taskIds` 里。
- **中：编排器会话**。先聊天：用户说目标，编排器追问约束、给出拆分与检查方案，这一阶段不派发任何代理。
  确认后点「开始执行」，会话才变成任务，规划、执行、合并、检查、返工、独立验证与汇总按时间顺序接在同一条会话里。
  任务结束后可以继续对话，回复走同一个 pi 会话；也可以再执行一轮，旧任务不会被覆盖。
- **右：执行代理**。对话阶段为空；执行后列出每个代理的状态、分支、token、改动文件与实时输出。下方是账本与网关。

任务状态：规划中 → 集群执行 → 合并中 → 验证中 →（返工中）→ 汇总中 → 完成 / 失败 / 已取消。
状态只表示流程走到哪一步；成功与否以裁决为准，流程结束但裁决未通过时界面显示「未通过」，不显示「完成」。

主题默认跟随系统，左上角可切换；`⌘K` / `Ctrl+K` 聚焦输入框，`Esc` 关闭代理详情。

![深色主题](docs/screenshots/console-dark.png)

<sub>深色形态：中性近黑底、单一靛色强调，状态色只出现在小圆点上。</sub>

验证失败的形态：

![返工与判定](docs/screenshots/console-rework.png)

<sub>目标要求「不要修改任何 .py」，但仓库本身存在语法错误的 .py。卡片顶部直接给出失败项与错误首行；
修复代理复现后拒绝伪造，裁决如实 FAIL；返工开销（240.9k）在账本中单列，不混入执行代理花费。</sub>

## 命令行

界面之外，`swarm` 命令提供同一套能力的终端入口。它不直接跑编排逻辑，而是作为
`127.0.0.1:3100` 的瘦客户端：会话、执行、检查、裁决、取消、合入都走已有 API 与 SSE，
所以终端和网页看到的是同一份状态。服务没起来时，除 `status` / `down` 外的命令会自动启动它
（优先 systemd 单元，其次 standalone 后台进程）。

```bash
swarm                          # 交互式会话，默认连最近一个会话
swarm new --repo ~/proj --title "重构登录"
swarm say --chat 451456ba "先给拆分方案，不要动代码"
swarm run --repo ~/proj --goal "补 README 并跑通测试" -n 3
swarm watch 0a2a6b00           # 跟随进度；Ctrl-C 只停止跟随，不取消任务
swarm show 0a2a6b00 --full     # 计划、代理、检查、裁决、汇总
swarm agents 0a2a6b00          # 执行代理清单（名称、状态、token、分支）
swarm logs 0a2a6b00 --agent Atlas --tail 3000
swarm diff 0a2a6b00            # 各 worktree 的只读改动
swarm cancel 0a2a6b00
swarm promote 0a2a6b00 --yes   # 合回主干
swarm tasks --live
```

几条约定：

- `swarm run` 不带 `--chat` 时新建会话并直接派发；`-n` 是执行代理数。要并行跑多组，
  就发多条 `--detach` 的 `run`（不同会话），再用 `swarm watch` 分别看。
- `swarm say` 不带 `--chat` 时新建会话；`--last` 用最近一个会话。回复走 SSE 流式打印。
- `--json` 时最终结果写 stdout、进度写 stderr；`run --detach --json` 可直接拿 `task.id`。
- 退出码：`0` 成功或裁决通过，`2` 任务结束但未通过，`1` 失败/取消/接口错误。
- 删除与合入在非 TTY 环境要求 `--yes`；`swarm rm` 会先判断 id 属于会话还是任务。

详见 [docs/cli.md](docs/cli.md)。

## 编排契约

提示词集中在 `server/prompts.ts`，采用 orchestrator-worker 模式：

1. **共享契约**：编排器产出 `contract`（技术栈、目录布局、接口签名、完成定义、合并后的检查命令），
   所有执行代理在同一契约下工作。
2. **独立任务**：每个任务带 `scope`（只允许改动的路径）、`acceptance`（可执行验收项）、
   `evidence`（必须提交的证据）、`depends_on`（前置任务）。写作用域不允许重叠。
3. **分阶段推进**：执行器按 `depends_on` 分批；无依赖任务并行，依赖满足后进入下一批。
   有多个依赖时，先把它们合并成一个临时基准分支，再从该分支创建 worktree，打开目录即可看到全部上游产物。
4. **自证闭环**：执行代理必须运行测试、启动服务、使用浏览器截图，并声明「写到仓库外的产物视为未交付」。
5. **证据验证**：合并后在 integration 树上执行自动检查与契约中的 `verify` 命令。
6. **独立验证器**：合并完成后派一个 agy 验证代理，cwd 指向 integration 树。它看到最终完整代码，
   自行决定验证方式（起服务、截图、跑测试、curl），汇报中给出命令与原始证据。
   编排器裁决时，验证器的证据优先于执行代理的自述。

规划输出先过严格校验：任务数必须等于代理数，名称不能重复或为空，`depends_on` 必须指向真实任务且不能成环。
校验失败重试一次；仍失败则任务失败，不再编造任务凑数。

任务粒度约定为「新增一个功能 / 修一个明确缺陷」：1 到 3 个文件、十分钟内可完成、有可执行的验证方式。

## 合并与验证

所有执行代理从同一 base 仓库的同一提交出发，各自在 `swarm/<taskId>/aN` 分支的独立 worktree 中工作：

```
repo (main) ──●───────────────● integration
               \             /
                ├─ swarm/…/a1 ┘  merge --no-ff
                ├─ swarm/…/a2 ┘
                └─ swarm/…/a3 ┘
```

1. 代理结束后，编排器把 worktree 改动 commit 到**实际 HEAD 分支**（agy 可能自行切换过分支）。
2. 依次把各分支 `git merge --no-ff` 到 integration 分支。
3. 在 integration 树上自动探测并执行真实检查：`npm test`、`python3 -m py_compile`、`bash -n`、
   `node --check`、HTML 结构，加上契约中的 `verify` 命令；记录 exit code 与输出。
   检查命令在 bubblewrap 里异步执行，不阻塞 HTTP/SSE；`detectChecks` 一次遍历按扩展名分桶，
   并跳过 `.venv`、`target`、`vendor`、`coverage` 等目录。
4. 编排器拿到「合并结果 + diff 统计 + 检查输出 + 验证器报告 + 代理自述」，只依据前四项给出 `{pass, reasons}`。
   流程结束统一进入 `done`，成功与否只看 `verdict.pass`，界面据此显示「完成 / 未通过」。

合并后的完整代码就在 `data/runs/<taskId>/integration`，分支 `swarm/<short>/integration`，无需从沙箱复制。

提交时排除 `__pycache__`、`node_modules`、`.next`、`.venv`、`.swarm-verify` 等运行时缓存。

## 返工

自动检查失败、代理未跑完或分支冲突时，编排器把失败证据交回给**真正能修改的那一层**，
默认最多 2 轮（`SWARM_REWORK_ROUNDS`）：

| 问题 | 执行者 | 位置 |
|---|---|---|
| 执行代理失败 / 分支合并冲突 | 该代理重跑 | 新建 worktree，基点 = 当前 integration 提交 |
| 仅自动检查失败（多份改动叠加后才暴露） | 修复代理（agy） | 直接在 integration 树上修，由系统提交 |

每轮结束后重新合并、重跑全部检查，账本单独记录返工开销。
修复代理没有修改任何文件即视为**停滞**，不再开启下一轮，直接携带证据进入裁决。
返工用尽仍未通过，判定 FAIL，不伪造成功。

## 合回主干

验证通过后，面板提供「合入 main」，实际执行：

```
git -C <base repo> merge --no-ff swarm/<id>/integration
```

基础仓库工作区必须干净（存在未提交改动会被拒绝）；合并失败自动 `merge --abort` 回滚。
验证未通过时按钮禁用，只保留「强制合入」。

## 记账

token 有三个来源，按角色分账：

- **编排器**：pi SDK 的 message usage，按 session 增量取账。规划记 `boss.usage`，汇总与裁决增量累加到
  `boss.summaryUsage`；后一次追问不会覆盖前面的阶段用量。
- **执行代理 / 验证器 / 修复代理**：ACP `session/prompt` 返回的 usage（input/output/cached/thought/total）。
- **网关**（可选）：上游响应 usage，按虚拟 key 归到 agent，写入 `data/gateway/record-*.jsonl`。

代理重跑会累加到 `spent`，账本按累计花费展示；返工修复单列一行。

## 持久化

任务每次状态变化都会落盘到 `data/tasks/<id>.json`：tmp + rename 原子替换，400ms 尾随防抖，文本流不会打爆磁盘。
会话文件同样原子写。落盘前会截断超长文本（代理输出 20000 字符、汇总 8000、验证器 12000、裁决原文 4000、
返工记录 8000 等），内存与 SSE 仍保留全文；重启后看到的是最近一段输出，不是完整历史。
重启后历史任务自动恢复，面板与账本保留；重启时仍处于运行中的任务标记为「中断」，
不会留下假的「执行中」状态。worktree 与 integration 目录位于 `data/runs/`，重启后仍可补合主干。

## HTTP API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | 轻量探针：pid、运行时长、应用根目录；CLI 与部署脚本用它判断服务是否就绪 |
| GET | `/api/tasks` | 任务列表 |
| POST | `/api/tasks` | 已停用，固定返回 410；执行只能从会话触发 |
| GET | `/api/chats` | 会话列表 |
| GET | `/api/chats/:id` | 单个会话快照 |
| POST | `/api/chats` | 新建会话并发第一条消息：`{text, repoPath?}`（只对话，不执行） |
| PATCH | `/api/chats/:id` | 改会话标题或目标仓库：`{title?, repoPath?}`，`repoPath: null` 表示清空 |
| DELETE | `/api/chats/:id` | 删除会话；带 `?withTasks=1` 时一并清理其任务与运行目录 |
| POST | `/api/chats/:id/messages` | 继续对话：`{text}`，复用同一个 pi 会话 |
| POST | `/api/chats/:id/run` | 从会话执行：`{agents?, goal?}`，`goal` 为空时回退到最后一条用户消息；同一会话已有活动任务返回 409 |
| GET | `/api/tasks/:id` | 单个任务快照 |
| DELETE | `/api/tasks/:id` | 删除已结束任务及其运行目录，并从会话里摘掉引用；任务仍在执行或收尾时返回 409 |
| POST | `/api/tasks/:id/cancel` | 取消活动任务，中断 agy 并把未完成代理标为 `cancelled`；任务已结束时返回 409 |
| GET | `/api/tasks/:id/diff` | 各执行代理 worktree 的只读改动快照（`git --no-optional-locks`，不改 index） |
| POST | `/api/tasks/:id/promote` | 合回主干：`{force?}` |
| GET | `/api/stream` | SSE 事件流：首帧 snapshot，随后 task / agent / boss / session 与 agent-delta / session-delta / boss-delta 增量；每条带 id，断线可用 `Last-Event-ID` 补发 |
| GET/POST | `/api/gateway` | 网关状态；`{action:"record"\|"keys", payload}` |

会话与任务是一对多：`Chat.taskIds` 保留每次执行的 id，`Chat.taskId` 指向最近一次。
删除单个任务会同时从所有会话的 `taskIds` 里摘掉它，并把 `taskId` 回退到剩下最后一条；删除会话默认只删会话，
带 `withTasks=1` 才清理它名下的任务与 `data/runs/<taskId>`。

边界约定：`POST /api/tasks` 的 410 表示入口已收敛，客户端应改为先建会话再调用 `run`；
409 只表示「当前状态不允许」，包括会话仍有未结束任务时再次执行、删除仍在执行或收尾的任务、取消已结束任务、
删除仍有活动任务的会话。
`/api/*` 的非 GET/HEAD 请求经过 `middleware.ts` 的 Origin 校验：只接受本机来源或与请求 Host 同源的 Origin，
浏览器标记为 cross-site / same-site 的写请求直接 403。网关的 CORS 同样只为本机来源回显
`Access-Control-Allow-Origin`，其他来源拿不到任何允许头。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SWARM_URL` | `http://127.0.0.1:3100` | `swarm` 命令行连接的服务地址；等价于 `--url` |
| `SWARM_NO_AUTOSTART` | — | 设为 `1` 时命令行发现服务未运行只报错，不自动启动 |
| `SWARM_PORT` | `3100` | 命令行本地启动服务时使用的端口（`--url` 不含端口时才相关） |
| `BOSS_PROVIDER` / `BOSS_MODEL` | `1` / `deepseek-v4.1-flash` | 编排器模型，来自 `~/.pi/agent/models.json` |
| `AGY_BIN` | `~/.local/bin/agy` | Antigravity CLI |
| `SWARM_SANDBOX` | `bwrap` | `off` 关闭 bubblewrap 沙箱 |
| `BWRAP_BIN` | `/usr/bin/bwrap` | bubblewrap 路径 |
| `SWARM_APP_ROOT` | `process.cwd()` | 仓库根目录；standalone 下 `server.js` 会 chdir，必须显式指定 |
| `PORT` / `HOSTNAME` | `3000` / `0.0.0.0` | standalone server 监听地址（部署脚本用 3100 / 127.0.0.1） |
| `SWARM_ROOT` | `./data/runs` | 每个任务的 worktree 根目录 |
| `SWARM_AGENT_TIMEOUT_MS` | `600000` | 单个执行代理超时 |
| `SWARM_VERIFIER_TIMEOUT_MS` | `600000` | 独立验证器超时 |
| `SWARM_FIXER_TIMEOUT_MS` | `600000` | 修复代理超时 |
| `SWARM_REWORK_ROUNDS` | `2` | 检查失败后最多返工轮数（0 关闭） |
| `SWARM_TASKS_DIR` | `./data/tasks` | 任务持久化目录（默认相对 `process.cwd()`，standalone 下必须显式指定绝对路径） |
| `SWARM_CHATS_DIR` | `$SWARM_APP_ROOT/data/chats` | 会话持久化目录，旧任务的一次性迁移标记也存在这里 |
| `SWARM_GATEWAY_URL` / `SWARM_GATEWAY_KEY` | — | 设置后执行代理走录制网关 |
| `SWARM_GATEWAY_CONTROL` | `http://127.0.0.1:9000` | 面板查询网关用的地址 |
| `SWARM_GATEWAY_DIR` | `$SWARM_APP_ROOT/data/gateway` | 网关录制目录；写盘失败只记 `recordError`，不影响转发 |
| `GATEWAY_PORT` | `9000` | 网关端口 |
| `GATEWAY_RECORD` | `1` | 设为 `0` 关闭完整请求/响应录制 |
| `UPSTREAM_BASE_URL` | `https://generativelanguage.googleapis.com` | 网关上游 |
| `UPSTREAM_KEY` 或 `data/upstream.key` | — | 网关上游 key |

## 已验证的能力

- `agy acp` 可程序化驱动；`session/prompt` 返回完整 usage（input/output/thought/cached/total）
- bubblewrap 沙箱内 ACP 握手、文件写入、`git status` 与命令输出均正常
- **沙箱自检**：`tools/sandbox-check.mjs` 在 bubblewrap 里完成 ACP 握手，不调用模型、不产生 token
- **45 个单测**：`pnpm test`（`node --experimental-strip-types --test`）覆盖规划解析与 schema 校验
  （数量不符、重名、空名、未知依赖、自依赖、成环、字段类型）、任务状态机迁移、`usageDelta` 增量记账与
  `recount` 汇总，以及 CLI 参数解析、对象选择、状态展示与宽字符表格
- **命令行闭环**：`swarm run --repo <仓库> --goal <目标> -n 1` 实测完成规划 → 执行 → 合并 → 检查 →
  独立验证 → 裁决（200.7k tokens，1 分 31 秒，PASS）；`swarm promote --yes` 合入主干；
  `swarm cancel`、`swarm rm --yes`、REPL 管道输入、`swarm down` / 自动启动均实测
- **网关错误归类**：上游请求失败才记 502；录制写盘失败只落到 `recordError`，不改已经返回给客户端的状态码与响应
- **沙箱内真实任务**：1 个执行代理在 bubblewrap 中写完 README 与 evidence，自动检查通过，
  独立验证器 PASS（223.7k tokens，代理 112.8k，验证器 84.7k）
- 编排器经 pi SDK 派发，工具调用真实驱动独立 agy 进程
- 3 个执行代理并发、各自 worktree、互不干扰（实测 24.5s 全部完成）
- 网关按虚拟 key 把 token 归到 agent，可按开关录制完整请求/响应（`data/gateway/*.jsonl`）
- **返工闭环**：合并后 `python 语法` 检查失败 → 修复代理在 integration 树上复现 →
  因目标与缺陷冲突而拒绝伪造 → 判定 FAIL（762.9k tokens，返工 240.9k 单独入账）
- **依赖可见性**：下游代理的 worktree 直接基于上游提交创建，打开目录即可看到 `evidence/python-syntax.txt`
- **一键合主干**：`main` 拿到 `Merge branch 'swarm/…/integration'`（commit `aef2a15`），验证未通过的任务被拒绝合入
- **持久化**：重启后任务、账本、返工记录与合主干结果恢复（超长文本按落盘规则截断）
- **会话式追问**：任务结束后追问「为什么判定通过」，编排器在同一会话上下文里作答，消息落盘
- **对话与执行分离**：发「你好」只会得到一段回复，不创建任务、不派发代理；点「开始执行」才会进入集群流程
- **standalone 部署**：`dist/standalone/server.js` + systemd user 单元常驻 127.0.0.1:3100，
  页面、SSE、静态资源与会话追问接口均可用

## 当前边界

- 沙箱隔离的是文件系统与 PID/IPC/UTS，网络仍然共享（模型 API 需要）；需要断网隔离时自行加 `--unshare-net` 并配置代理。
- `bwrap` 依赖非特权 user namespace；不支持的环境下自动退回直接 spawn，隔离性随之消失。
- 执行代理默认走 agy 自身的 OAuth（账号由 `antigravity-tools switch` 管理），不经过 8045：
  `agy` 只认 Gemini 原生协议，8045 对外是 OpenAI 兼容协议，两者不通。
- 网关的虚拟 key 模式需要把 `SWARM_GATEWAY_URL` 指过去；没有有额度的上游 key 时会 429。
- 返工一轮只处理一类问题：先修执行代理/冲突，再修自动检查；冲突分支不会被静默跳过。
- 验证器的报告只作为裁决依据，不参与触发返工；触发返工的只有真实检查项。
- 「中断」的历史任务只恢复展示和合主干，不会自动续跑。
- 一个任务最多 8 个执行代理；单进程内存编排，未做多实例/队列。
- 只保存 diff 统计，不保存逐行 patch，因此界面无法展示内容级 diff。
- `/api/stream` 的 snapshot 仍是全量：新连接会一次拿到全部任务与会话，没有分页和按会话订阅；
  断线重连只有在同一个进程的最近 1000 条事件环内才能补发增量，否则退回 snapshot。
- 写接口只做 Origin 校验，没有 token。它能挡住同机浏览器里的跨站网页，挡不住本机的 curl、脚本或其它进程。
  `swarm` 命令行同样没有独立凭据，默认只连 `127.0.0.1:3100`；远程使用请自行加隧道与访问控制。
- 检查命令在 bubblewrap 中执行，但继承完整的 `process.env` 并共享网络；需要更严的隔离时自行收紧 bwrap 参数或断网。
- 旧任务到会话的迁移只执行一次（`data/chats/.tasks-migrated` 标记）；之后新建的孤立任务不会再次自动补会话。
- 落盘文本会被截断（见「持久化」），重启后只能看到最近一段输出；完整内容只在进程内存和当次 SSE 里。

## 目录

```
app/            页面、API 路由、主题启动脚本
bin/swarm.mjs   命令行客户端（瘦客户端，装到 ~/.local/bin/swarm）
middleware.ts   /api/* 写请求的 Origin 校验
components/
  chat/         会话式工作台：侧栏、会话流、输入框、执行确认、代理栏、任务差异
  console/      任务流、执行视图、验证、返工、账本、网关、代理详情
  ui/kit.tsx    基础组件（卡片、标签、按钮、展开、主题切换）
lib/types.ts    共享类型
DESIGN.md       视觉规范：6-3-1 配色预算、字号、间距、动效、禁止项
server/
  chats.ts         会话：对话、编排器回复、从会话启动任务、任务绑定维护
  orchestrator.ts  规划、派发、合并、返工、验证、裁决、取消、删除、合主干
  acp.ts           agy ACP 客户端 + bubblewrap 沙箱 + 沙箱内命令执行
  gateway.ts       Gemini 兼容录制网关
  prompts.ts       提示词契约
  store.ts         任务表 + 事件总线 + SSE 事件环 + 原子落盘恢复
tests/
  orchestrator.test.ts  纯函数单测（36 例）
  cli.test.mjs          命令行解析与展示单测（9 例）
docs/
  cli.md            命令行完整用法与自动化约定
  screenshots/      控制台截图（浅色 / 深色 / 返工）
tools/
  shot.mjs         控制台截图（主题、滚动、路径中性化）
  sandbox-check.mjs  bubblewrap + ACP 握手自检
  standalone.sh     构建 dist/standalone 产物
  worker-shot.mjs  给执行代理用的截图工具
deploy/
  agy-agent-swarm.service  systemd user 单元模板（由 install.sh 渲染安装）
data/           运行时数据（不入库）
  chats/<chatId>.json 会话记录（对话、taskIds 历史、最近一次 taskId）
  runs/<taskId>/   各代理 worktree、integration、orchestrator
  tasks/<taskId>.json  任务快照（落盘前截断长文本）
  gateway/*.jsonl  网关录制
```

## License

MIT
