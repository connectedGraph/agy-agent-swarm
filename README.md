# agent-swarm

Agent 集群编排站。一个包工头（pi SDK + DeepSeek）把目标拆成并行子任务，派给各自独立 worktree 里的
Antigravity 子代理（`agy acp`），合并、验收、返工、判定、合回主干全部在页面上看得见，
每一笔 token 都落到账本上。

`Next.js 16` · `React 19` · `pi SDK` · `agy acp` · `git worktree` · `SSE` · 深浅双主题

![控制台](docs/screenshots/console-light.png)

<sub>一个真实任务：两个工人各自实现并自测，合并后 5 条检查全部 PASS，独立验证者也通过了，最后合入主干。</sub>

## 它解决什么

- **隔离**：每个工人一个 git worktree / 一条分支，互相看不见，改动不串味。
- **可控**：包工头只定契约、切任务、验收；不碰代码。
- **可查**：token 按角色分账（包工头 / 每个工人 / 验证者 / 返工修复），不是一笔糊涂账。
- **可信**：验收跑的是真实命令的 exit code，不是模型的自述；失败会返工，返工不动就如实判 FAIL。

## 架构

```
Next.js 控制台 (3100)
  ├─ 任务提交 / 实时事件流 (SSE)
  ├─ 编排器单例
  │    ├─ 包工头：@earendil-works/pi-coding-agent → work2api (8787) → deepseek-v4.1-flash
  │    ├─ 工人池：每个任务 spawn 一个 agy acp 进程
  │    │    cwd = 独立 worktree，usage 来自 ACP session/prompt 返回值
  │    └─ 验证者 / 修复者：同样走 agy acp，cwd 指向合并后的 integration 树
  └─ /api/gateway ──► 录制网关 (9000)
                         ├─ Gemini 兼容入口（/v1beta/models/*）
                         ├─ 虚拟 key → agent 归账
                         └─ 上游：任意 Gemini Developer API key
```

## 快速开始

```bash
./install.sh          # 幂等：装依赖、检查 node/pnpm/agy/包工头模型配置
pnpm dev              # http://127.0.0.1:3100
```

可选：启动录制网关，让需要按 API 计量的 agent 走它。

```bash
cp <你的 key> data/upstream.key && chmod 600 data/upstream.key
pnpm gateway                                   # http://127.0.0.1:9000
SWARM_GATEWAY_URL=http://127.0.0.1:9000 SWARM_GATEWAY_KEY=vk-demo pnpm dev
```

生产模式：`pnpm build && pnpm start`（仍是 3100，`pnpm build` 之后改服务端代码要重新构建）。

## 控制台怎么用

顶部输入目标和工人数量，回车派发。三栏：

- **左：任务流**。每个任务显示状态和已花 token，点开切换。
- **中：舞台**。包工头的契约与任务清单 → 工人卡片（实时输出、token 构成、分支、改动文件）
  → 返工记录 → 合并与验收（每个检查的 exit code 和原始输出）→ 独立验证者 → 包工头汇总。
  点工人卡片可以看它的允许改动、验收标准和工作目录。
- **右：账本与网关**。账本按角色分账并画占比条；网关面板显示在线状态、调用数、上游 token，
  以及「录制完整 API 报文」开关。

任务状态：规划中 → 集群执行 → 合并中 → 验收中 →（返工中）→ 汇总中 → 完成/失败。

主题默认跟随系统，右上角可手动切换；`⌘K` / `Ctrl+K` 聚焦目标输入，`Esc` 关闭工人详情。

![深色主题](docs/screenshots/console-dark.png)

<sub>同一页面的深色形态：中性近黑底、单一靛色强调，状态色只出现在小圆点上。</sub>

验收失败的形态长这样：

![返工与判定](docs/screenshots/console-rework.png)

<sub>目标要求「不要修改任何 .py」，但仓库本身就有一个语法错误的 .py。修复者复现后拒绝改，
判定如实 FAIL；返工的开销（240.9k）在账本里单独一行，不混进工人花费。</sub>

## 提示词契约

提示词集中在 `server/prompts.ts`，采用 orchestrator-worker 的成熟写法：

1. **共享契约**：包工头先产出 `contract`（技术栈、目录布局、接口签名、完成定义、合并后的验收命令），
   所有工人在同一个契约下工作。
2. **独立任务**：每个任务带 `scope`（只允许改的路径）、`acceptance`（可执行验收项）、
   `evidence`（必须提交的证据）、`depends_on`（前置任务）。写作用域不允许重叠。
3. **分阶段推进**：执行器按 `depends_on` 分批，无依赖的并行，依赖满足后才跑下一批。
   有依赖的工人从**依赖方的最新提交**建 worktree，所以它打开目录就能看到上游写下的代码，
   而不是只拿到一句「上游已完成」。
4. **自证闭环**：工人提示词强制要求跑测试、启动服务、用浏览器截图，并声明
   「写到仓库外的产物一律视为没有交付」。
5. **证据验收**：合并后系统在 integration 树上执行自动检查 + 契约里的 `verify` 命令。
6. **独立验证者**：合并完成后，再派一个 agy 验证代理，cwd 指向 integration 树，
   它看到的是最终完整代码，自己决定怎么验（起服务、截图、跑测试、curl 都行），
   汇报里给出命令和原始证据。包工头判定时，验证者的证据优先于工人的自述。

任务粒度约定为「新增一个功能 / 修一个明确缺陷」：1 到 3 个文件、能在十分钟内做完、有可执行验证方式。

## 合并与验收

所有工人从同一个 base 仓库的同一提交出发，各在 `swarm/<taskId>/aN` 分支的独立 worktree 里工作：

```
repo (main) ──●───────────────● integration
               \             /
                ├─ swarm/…/a1 ┘  merge --no-ff
                ├─ swarm/…/a2 ┘
                └─ swarm/…/a3 ┘
```

流程：

1. 工人结束后，编排器把该 worktree 的改动 commit 到**实际 HEAD 分支**（子代理可能自己切过分支，记录的分支名不可信）
2. 依次把各分支 `git merge --no-ff` 到 integration 分支
3. 编排器在 integration 树上**自动探测并执行真实检查**：`npm test`、`python3 -m py_compile`、
   `bash -n`、`node --check`、HTML 结构，再加上契约里 `verify` 的命令，记录 exit code 与输出
4. 包工头拿到「合并结果 + diff stat + 检查输出 + 验证者报告 + 工人自述」，只依据前四项给出 `{pass, reasons}`

代码不需要从沙箱复制：integration worktree 就是合并后的完整代码，路径在
`data/runs/<taskId>/integration`，分支 `swarm/<short>/integration`。

提交时会排除 `__pycache__`、`node_modules`、`.next`、`.venv`、`.swarm-verify` 这类运行时缓存，
不会把工人跑出来的垃圾合进主干。

## 返工闭环

验收不是终点。合并后如果自动检查失败、或者某个工人自己没跑完、或者分支冲突，
编排器会把失败证据交回给**真正能改的那一层**，默认最多 2 轮（`SWARM_REWORK_ROUNDS`）：

| 问题 | 谁去修 | 在哪修 |
|---|---|---|
| 工人执行失败 / 分支合并冲突 | 该工人重跑 | 新建 worktree，基点 = 当前 integration 提交（这样它能看见别人已合入的代码） |
| 只剩验收命令失败（多份改动叠加后才暴露） | 修复者（agy） | 直接跑在 integration 树上，修完由系统提交到整合分支 |

每轮结束后重新合并、重跑全部验收命令，账本会单独记返工开销。
修复者一个文件都没动就结束，视为**停滞**，不再开下一轮，直接带着证据进入判定。
返工用尽仍不通过，就如实判 FAIL，不会假装成功。

## 合回主干

验收通过后，面板上有「合入 main」按钮，实际执行的是：

```
git -C <base repo> merge --no-ff swarm/<id>/integration
```

前提是基础仓库工作区干净（有未提交改动会被拒绝，避免覆盖你手上的活）；合并失败会自动
`merge --abort` 回滚。验收未通过时按钮禁用，只保留「强制合入」。

## 记账

token 有三个来源，全部按角色分开记：

- **包工头**：pi SDK 的 message usage，规划与汇总分开记。
- **工人 / 验证者 / 修复者**：ACP `session/prompt` 返回的 usage（input/output/cached/thought/total）。
- **网关**（可选）：上游响应里的 usage，按虚拟 key 归到 agent，写入 `data/gateway/record-*.jsonl`。

工人重跑会累加到 `spent`，账本按累计花费展示；返工修复者单列一行。

## 持久化

任务每次状态变化都会落盘到 `data/tasks/<id>.json`（原子写 + 400ms 防抖，文本流不会打爆磁盘）。
重启后历史任务自动恢复，面板和账本都还在；重启时仍处于运行中的任务会被标成「中断」，
不会留下假的「执行中」状态。worktree 和 integration 目录本来就在 `data/runs/` 下，
所以重启后历史任务仍然可以补合主干。

## HTTP 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/tasks` | 任务列表 |
| POST | `/api/tasks` | 派发任务：`{goal, agents?, repoPath?}` |
| GET | `/api/tasks/:id` | 单个任务快照 |
| GET | `/api/tasks/:id/diff` | 各工人 worktree 的改动统计 |
| POST | `/api/tasks/:id/promote` | 合回主干：`{force?}` |
| GET | `/api/stream` | SSE 事件流（snapshot / task / agent / boss） |
| GET/POST | `/api/gateway` | 网关状态；`{action:"record"\|"keys", payload}` |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BOSS_PROVIDER` / `BOSS_MODEL` | `1` / `deepseek-v4.1-flash` | 包工头模型，来自 `~/.pi/agent/models.json` |
| `AGY_BIN` | `~/.local/bin/agy` | Antigravity CLI |
| `SWARM_ROOT` | `./data/runs` | 每个任务的 worktree 根目录 |
| `SWARM_AGENT_TIMEOUT_MS` | `600000` | 单个工人超时 |
| `SWARM_VERIFIER_TIMEOUT_MS` | `600000` | 独立验证者超时 |
| `SWARM_FIXER_TIMEOUT_MS` | `600000` | 返工修复者超时 |
| `SWARM_REWORK_ROUNDS` | `2` | 验收失败后最多返工几轮（0 关闭） |
| `SWARM_TASKS_DIR` | `./data/tasks` | 任务持久化目录 |
| `SWARM_GATEWAY_URL` / `SWARM_GATEWAY_KEY` | — | 设置后工人走录制网关 |
| `SWARM_GATEWAY_CONTROL` | `http://127.0.0.1:9000` | 面板查询网关用的地址 |
| `GATEWAY_PORT` | `9000` | 网关端口 |
| `UPSTREAM_BASE_URL` | `https://generativelanguage.googleapis.com` | 网关上游 |
| `UPSTREAM_KEY` 或 `data/upstream.key` | — | 网关上游 key |

## 已验证的能力

- `agy acp` 可程序化驱动；`session/prompt` 返回完整 usage（input/output/thought/cached/total）
- 包工头经 pi SDK 派发，工具调用真实驱动独立 agy 进程
- 3 个工人并发、各自 worktree、互不干扰（实测 24.5s 全部完成）
- 网关按虚拟 key 把 token 归到 agent，可按开关录制完整请求/响应（`data/gateway/*.jsonl`）
- **返工闭环**：合并后 `python 语法` 检查失败 → 修复者在 integration 树上复现 → 因目标与缺陷冲突而拒绝伪造 → 判定 FAIL（762.9k tokens，返工 240.9k 单独入账）
- **依赖可见性**：下游工人的 worktree 直接基于上游提交创建，打开目录就能看到 `evidence/python-syntax.txt`
- **一键合主干**：`main` 拿到 `Merge branch 'swarm/…/integration'`（commit `aef2a15`），验收未通过的任务被拒绝合入
- **持久化**：重启后任务、账本、返工记录与合主干结果全部原样恢复

## 当前边界

- 工人默认走 agy 自身的 OAuth（账号由 `antigravity-tools switch` 统一管理），不经过 8045：
  `agy` 只认 Gemini 原生协议，8045 对外是 OpenAI 兼容协议，两者不通。
- 网关的虚拟 key 模式需要把 `SWARM_GATEWAY_URL` 指过去；没有有额度的上游 key 时会 429。
- 返工一轮只处理一类问题：先修工人/冲突，再修验收命令；冲突分支不会再被静默跳过。
- 合并冲突的兜底是让冲突方基于 integration 重做，不会做自动文本合并。
- 验证者的报告只作为判定依据，不参与触发返工；触发返工的只有真实检查项。
- 「中断」的历史任务只恢复展示和合主干，不会自动续跑。
- 一个任务最多 8 个工人；单进程内存编排，没做多实例/队列。

## 目录

```
app/            页面、API 路由、主题启动脚本
components/
  Console.tsx   状态、SSE 与三栏编排
  console/      任务流、舞台、验收、返工、账本、网关、工人详情
  ui/kit.tsx    基础组件（卡片、标签、按钮、展开、主题切换）
lib/types.ts    共享类型
DESIGN.md       视觉规范：6-3-1 配色预算、字号、间距、动效、禁止项
server/
  orchestrator.ts  规划、派发、合并、返工、验收、判定、合主干
  acp.ts           agy ACP 客户端
  gateway.ts       Gemini 兼容录制网关
  prompts.ts       提示词契约
  store.ts         任务表 + 事件总线 + 落盘恢复
tools/
  shot.mjs         控制台截图（含主题与路径中性化）
  worker-shot.mjs  给子代理用的截图工具
data/           运行时数据（不入库）
  runs/<taskId>/   各工人 worktree、integration、orchestrator
  tasks/<taskId>.json  任务快照
  gateway/*.jsonl  网关录制
docs/screenshots/  控制台截图（浅色 / 深色 / 返工）
```

## License

MIT

