# 命令行 `swarm`

`bin/swarm.mjs` 是 agy-agent-swarm 的命令行客户端。它不是第二套编排器：会话、规划、执行、
检查、裁决、取消与合入全部走 `127.0.0.1:3100` 上已有的 HTTP API 和 SSE。终端、网页、脚本
看到的是同一份任务表，不会出现「网页里一个状态、命令行里另一个状态」。

设计取舍：

- **瘦客户端**：CLI 只负责参数、渲染和事件流，没有复制 `server/orchestrator.ts` 的任何逻辑。
- **服务可独立启动**：`swarm up` 优先使用已安装的 systemd 单元，其次拉起 `dist/standalone/server.js`；
  其它命令发现服务没起来时会自动启动（`--no-autostart` 关闭）。
- **零依赖**：Node 22+ 原生 `fetch`、`ReadableStream`、`readline`，不需要编译，不需要 `tsx`。
- **一文件**：`bin/swarm.mjs`，安装时软链到 `~/.local/bin/swarm`，仓库是唯一真源。

## 安装

```bash
./install.sh              # 安装依赖，并把 bin/swarm.mjs 链到 ~/.local/bin/swarm
./install.sh --service    # 另外构建 standalone 并安装 systemd user 单元
```

安装后：

```bash
swarm --version
swarm status
```

`~/.local/bin` 需要在 `PATH` 里。没有安装成命令时也可以直接 `node bin/swarm.mjs ...`。

## 连接哪一份服务

默认 `http://127.0.0.1:3100`，可用 `--url` 或 `SWARM_URL` 指向别的实例：

```bash
swarm --url http://127.0.0.1:3100 status
SWARM_URL=http://127.0.0.1:3100 swarm tasks
```

服务没起来时，除 `status` / `down` / `serve` 外的命令会自动启动本地服务：

```bash
swarm down      # 停掉 systemd 单元或 CLI 启动的后台进程
swarm status    # 只查看，不启动
swarm tasks     # 发现服务没起来 → 自动启动 → 再查询
```

不想自动启动：

```bash
SWARM_NO_AUTOSTART=1 swarm tasks
swarm tasks --no-autostart
```

端口与后台进程：

- `swarm up` 默认优先 `systemctl --user start agy-agent-swarm`；单元不存在时用 standalone
  产物在后台启动，日志写 `data/cli/server-<端口>.log`，pid 写 `data/cli/server-<端口>.pid`。
- `swarm serve [--dev]` 前台运行，日志直接进终端，适合调试；`--dev` 走 `pnpm dev`。
- `swarm down` 先停 systemd 单元，再按 pid 文件停后台进程，最后确认端口不再响应。

## 会话：和编排器聊

```bash
swarm new --title "重构登录" --repo ~/proj     # 建空会话
swarm say "先看一下登录模块，给出拆分方案" --chat 451456ba

# 不指定会话时新建一个；--repo 绑定目标仓库
swarm say "解释一下这个仓库的构建方式" --repo ~/proj
swarm say --last "继续"                       # 最近一个会话
```

回复通过 SSE 流式打印。`swarm chat` 进入交互模式，行为与网页里的中心会话一致。

`--json` 时 stdout 只有最终 JSON，流式进度改走 stderr：

```bash
swarm say --chat 451456ba --json "只回复两个字：收到"
# {"chatId":"…","reply":{"role":"boss","text":"收到",…}}
```

## 执行：派发子代理

```bash
swarm run --repo ~/proj --goal "补 README，并跑通 npm test" -n 3
```

这条命令会：

1. 新建一个绑定 `~/proj` 的会话；
2. 让编排器在该会话里规划，按 `-n 3` 派发 3 个执行代理；
3. 在终端里跟随任务：计划 → 代理状态 → 合并 → 自动检查 → 验证器 → 裁决 → 汇总。

打印形如：

```
任务 0a2a6b00 已派发  1 个执行代理 · 会话 f6153ec5

任务  0a2a6b00  规划中  刚刚
目标  新增 hello.txt，内容为一行 hello swarm…
仓库  /data/scratch/…/repo

计划
  1. Atlas  在自身工作目录内完成…

18:58  状态  集群执行
  Atlas    完成  81.6k tokens · 2 个文件
18:59  状态  合并中
18:59  状态  验证中
18:59  检查  全部通过  2 项
  通过  契约检查: cat hello.txt  27ms  exit 0
18:59  验证器  完成  81.6k tokens
18:59  状态  完成

裁决  通过
  · …
──────────────────────────────────────────────
任务  0a2a6b00  完成
代理  1/1 结束  ·  200.7k tokens  ·  1 分 31 秒
…
```

参数：

| 参数 | 说明 |
|---|---|
| `--chat <id\|序号>` | 在已有会话里再执行一轮；省略则新建会话 |
| `--last` | 使用最近一个会话 |
| `--repo <路径>` | 目标仓库；不存在或不是 git 仓库时提示，执行时新建临时仓库 |
| `--goal <文本>` | 显式目标；省略时回退到会话最后一条用户消息 |
| `-n, --agents <1-8>` | 执行代理数，默认 3 |
| `--detach` | 只派发，不跟随 |

并行开多组：每次不带 `--chat` 的 `run` 都会新建会话，不同会话可以同时执行。

```bash
swarm run --repo ~/proj --goal "修登录报错" -n 2 --detach
swarm run --repo ~/proj --goal "补单元测试" -n 3 --detach
swarm tasks --live
swarm watch <任务id>
```

注意：同一个会话同时只能有一个活动任务；要并行就用不同会话。

## 查看与干预

```bash
swarm tasks                  # 任务表
swarm tasks --live           # 只看执行中
swarm show 0a2a6b00          # 目标、计划、代理、检查、裁决、汇总
swarm show 0a2a6b00 --full   # 追加规划原文、代理输出全文
swarm agents 0a2a6b00        # 执行代理清单（名称、状态、token、分支）
swarm logs 0a2a6b00          # 编排器与代理输出尾部
swarm logs 0a2a6b00 --agent Atlas --tail 3000
swarm diff 0a2a6b00          # 各 worktree 的只读改动快照
swarm cancel 0a2a6b00        # 中断 agy，未完成代理标为 cancelled
swarm watch 0a2a6b00         # 继续跟随；任务已结束则打印结果
swarm watch --timeout 600    # 最多等 10 分钟，之后返回（任务继续跑）
```

跟随过程中 `Ctrl-C` 只停止跟随，不取消任务；任务继续在后台运行。
要真正中断，使用 `swarm cancel`。

## 验证与合入

```bash
swarm show <任务id>          # 先看裁决与检查
swarm promote <任务id>       # 合入主干；交互环境会再确认
swarm promote <任务id> --yes # 非交互环境必须显式确认
swarm promote <任务id> --force --yes  # 验证未通过时强制合入
```

`promote` 调用的就是网页上的「合入 main」：基础仓库必须干净，失败会自动 `merge --abort`。

## 删除

```bash
swarm rm <任务id> --yes            # 删除已结束任务及其运行目录
swarm rm task <任务id> --yes       # 显式指定类型
swarm rm chat <会话id> --yes       # 删除会话，保留任务
swarm rm chat <会话id> --with-tasks --yes  # 连同任务与 runs 目录
```

删除不可逆。非 TTY 环境必须加 `--yes`，否则直接拒绝。活动任务不能删除，先 `cancel`。

## 交互模式

```bash
swarm                # 最近一个会话
swarm chat 451456ba  # 指定会话
```

```
swarm  http://127.0.0.1:3100
7 个会话  ·  6 个任务  ·  执行中 0 个
当前会话  你好  451456ba
直接输入与编排器对话；/run 派发执行；/help 查看命令。

swarm> 这个仓库的测试怎么跑
编排器
…
swarm> /run 3 补一个 CLI 参数解析并跑测试
```

斜杠命令：

| 命令 | 作用 |
|---|---|
| `/new [仓库]` | 新建会话并切换 |
| `/chats` | 列出会话；`/use <序号\|id>` 切换 |
| `/repo [路径]` | 查看或修改当前会话的目标仓库 |
| `/title <标题>` | 改会话标题 |
| `/run [代理数] [目标]` | 在当前会话执行；不写目标则用最后一条用户消息 |
| `/watch [任务id]` | 跟随任务；`Ctrl-C` 停止跟随 |
| `/tasks` `/show` `/logs` `/diff` | 查看 |
| `/cancel [任务id]` | 取消活动任务 |
| `/promote [任务id]` | 合入主干（斜杠命令视为显式确认） |
| `/status` `/quit` | 服务状态 / 退出 |

## 给自动化用的约定

`--json` 的所有命令都把最终结果写到 stdout，进度写到 stderr；失败时 stdout 是
`{"error":"…","status":…}`。常用组合：

```bash
TASK=$(swarm run --repo ~/proj --goal "…" -n 2 --detach --json | jq -r .task.id)
swarm watch "$TASK" --json | jq -r '.task.verdict.pass'
swarm show "$TASK" --json | jq -r '.task.verdict.reasons[]'
```

退出码：

| 码 | 含义 |
|---|---|
| `0` | 命令成功；任务结束且裁决通过 |
| `2` | 任务结束，但裁决未通过（`done` + `verdict.pass=false`） |
| `1` | 任务失败 / 取消 / 接口错误 / 删除未确认 |

跟随被 `Ctrl-C` 停止时按普通返回处理（任务继续在后台跑），不视为失败；要中断任务请 `cancel`。

`watch` 与 `run` 跟随到终态时按上表设置退出码；`run --detach` 派发成功即返回 0。

## 一个完整的「给目录 + 给目标」循环

```bash
# 1. 第一轮：确认能跑通，拿到 chatId
swarm run --repo ~/proj --goal "先补 README 和最小测试" -n 2
# 输出里有：任务 xxxxxxxx · 会话 yyyyyyyy

# 2. 看裁决与证据
swarm show xxxxxxxx --full
swarm logs xxxxxxxx --tail 3000

# 3. 和编排器讨论下一轮
swarm say --chat yyyyyyyy "检查命令太宽，下一轮只保留 npm test"

# 4. 在同一个会话里再执行一轮
swarm run --chat yyyyyyyy --goal "按收紧后的检查继续修" -n 2

# 5. 通过后合入
swarm promote xxxxxxxx --yes
```

多轮之间旧任务不会覆盖：`Chat.taskIds` 保留历史，`swarm tasks` 能按时间看到每一轮。

## 边界

- CLI 与网页一样只做 Origin 校验，没有 token；服务绑定 `127.0.0.1`，不要直接暴露到公网。
- `--json` 的 `run`（默认跟随到终态）只输出一个最终 JSON；中途进度在 stderr，适合日志不适合逐条解析。
- `swarm diff` 是只读工作区快照；代理已自行提交时显示落库的改动列表，不是逐行 patch。
- REPL 的 `/promote` 不再二次确认；其它入口的删除/合入都会要求确认或 `--yes`。
- 自动启动依赖 systemd user 会话或本地 Node 环境；没有 systemd 时退化为后台进程，日志在
  `data/cli/server-<端口>.log`。远程实例请用 `--url`，不要依赖 `up`。
