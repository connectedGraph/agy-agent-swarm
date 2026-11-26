// 服务端编排器纯函数回归测试：只覆盖规划解析/校验、状态机、用量记账。
// 不读写 data/、不 spawn agy、不访问网络；涉及环境变量的用例在测试内设置并恢复。
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parsePlan, validatePlan, transition, usageDelta, recount } from "../server/orchestrator.ts";
import type { Task, TaskState, Usage } from "../lib/types.ts";

/* ---------------- 测试夹具 ---------------- */

// 一条合法的规划任务项（字段名用下划线别名，顺带覆盖规范化）
function item(name: string, extra: Record<string, unknown> = {}) {
  return { name, task: `完成 ${name}`, scope: [], acceptance: [], evidence: [], depends_on: [], ...extra };
}

// 带 contract 的完整规划输出
function planJson(tasks: unknown[]) {
  return JSON.stringify({ contract: { stack: "next" }, tasks });
}

// 最小 Task：recount 只读取用量相关字段，其余字段给默认值
function makeTask(partial: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal: "测试目标",
    repoPath: null,
    baseRepo: null,
    state: "planning",
    createdAt: 0,
    finishedAt: null,
    boss: { state: "idle", text: "", plan: "", planList: [], contract: null, usage: null, summaryUsage: null },
    agents: [],
    totalUsage: 0,
    summary: "",
    merge: [],
    verification: null,
    verifier: null,
    verdict: null,
    rework: [],
    promote: null,
    error: null,
    ...partial,
  } as Task;
}

function usage(totalTokens: number): Usage {
  return { totalTokens };
}

// process.env.NODE_ENV 在 @types/node 里是只读字面量，测试内通过索引签名临时改写
function setNodeEnv(value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}

/* ---------------- parsePlan ---------------- */

describe("parsePlan：从模型输出里提取并解析规划 JSON", () => {
  test("```json 代码块里是合法规划时解析成功", () => {
    const text = ["这是规划：", "```json", planJson([item("A")]), "```", "完毕。"].join("\n");
    const res = parsePlan(text, 1);
    assert.equal(res.ok, true);
    assert.deepEqual(res.errors, []);
    assert.equal(res.tasks[0].name, "A");
    assert.deepEqual(res.contract, { stack: "next" });
  });

  test("纯数组输出（没有 contract 包裹）也能解析", () => {
    const text = JSON.stringify([item("A"), item("B")]);
    const res = parsePlan(text, 2);
    assert.equal(res.ok, true);
    assert.equal(res.tasks.length, 2);
    assert.equal(res.contract, null);
  });

  test("前后夹带说明文字与无关花括号时，平衡括号扫描仍取到正确数组", () => {
    const text = `先说结论：这里有个无关的 {花括号说明}，计划如下 ${JSON.stringify([item("A")])} 以上。`;
    const res = parsePlan(text, 1);
    assert.equal(res.ok, true);
    assert.equal(res.tasks[0].name, "A");
  });

  test("括号失配时找不到候选，返回明确错误", () => {
    const text = '这是坏输出 {"tasks": [ } 后面没有闭合';
    const res = parsePlan(text, 1);
    assert.equal(res.ok, false);
    assert.deepEqual(res.tasks, []);
    assert.match(res.errors.join("；"), /没有找到 JSON/);
  });

  test("完全不是 JSON 时返回错误而不是抛异常", () => {
    const res = parsePlan("抱歉，我无法完成这个规划。", 2);
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /没有找到 JSON/);
  });

  test("第一个候选解析失败时会继续尝试后续候选", () => {
    const text = `先看这个 {不是合法 JSON} 再看这个 ${JSON.stringify([item("A")])}`;
    const res = parsePlan(text, 1);
    assert.equal(res.ok, true);
    assert.equal(res.tasks[0].name, "A");
  });

  test("JSON 合法但校验不通过时透出第一条校验错误", () => {
    const res = parsePlan(JSON.stringify([item("A")]), 2);
    assert.equal(res.ok, false);
    assert.match(res.errors.join("；"), /数量为 1，与执行代理数 2 不一致/);
  });
});

/* ---------------- validatePlan ---------------- */

describe("validatePlan：规划契约校验与字段规范化", () => {
  test("合法输入通过，并保留 contract", () => {
    const res = validatePlan({ contract: { stack: "next" }, tasks: [item("A"), item("B")] }, 2);
    assert.equal(res.ok, true);
    assert.deepEqual(res.contract, { stack: "next" });
    assert.equal(res.tasks.length, 2);
  });

  test("任务数不等于代理数时拒绝", () => {
    const res = validatePlan([item("A"), item("B")], 3);
    assert.equal(res.ok, false);
    assert.match(res.errors.join("；"), /数量为 2，与执行代理数 3 不一致/);
  });

  test("重名任务被拒绝", () => {
    const res = validatePlan([item("A"), item("A")], 2);
    assert.equal(res.ok, false);
    assert.match(res.errors.join("；"), /「A」重复/);
  });

  test("空 name 被拒绝（纯空白的 name 也按空处理）", () => {
    const res = validatePlan([item("   ")], 1);
    assert.equal(res.ok, false);
    assert.match(res.errors.join("；"), /name 不能为空/);
  });

  test("空正文被拒绝", () => {
    const res = validatePlan([{ name: "A", task: "  " }], 1);
    assert.equal(res.ok, false);
    assert.match(res.errors.join("；"), /task 正文不能为空/);
  });

  test("未知依赖被拒绝", () => {
    const res = validatePlan([item("A", { depends_on: ["Z"] })], 1);
    assert.equal(res.ok, false);
    assert.match(res.errors.join("；"), /depends_on「Z」不存在/);
  });

  test("自依赖被拒绝", () => {
    const res = validatePlan([item("A", { depends_on: ["A"] })], 1);
    assert.equal(res.ok, false);
    assert.match(res.errors.join("；"), /不能依赖自己/);
  });

  test("依赖成环被拒绝并指出环上任务", () => {
    const res = validatePlan(
      [item("A", { depends_on: ["B"] }), item("B", { depends_on: ["A"] })],
      2,
    );
    assert.equal(res.ok, false);
    const all = res.errors.join("；");
    assert.match(all, /循环依赖/);
    assert.match(all, /A/);
    assert.match(all, /B/);
  });

  test("scope 不是字符串数组时拒绝", () => {
    const res = validatePlan([item("A", { scope: ["ok", 1] })], 1);
    assert.equal(res.ok, false);
    assert.match(res.errors.join("；"), /tasks\[0\]\.scope 必须是字符串数组/);
  });

  test("acceptance 不是数组时拒绝", () => {
    const res = validatePlan([item("A", { acceptance: "只看这一条" })], 1);
    assert.equal(res.ok, false);
    assert.match(res.errors.join("；"), /tasks\[0\]\.acceptance 必须是字符串数组/);
  });

  test("缺字段的列表按空数组处理", () => {
    const res = validatePlan([{ name: "A", task: "正文" }], 1);
    assert.equal(res.ok, true);
    assert.deepEqual(res.tasks[0].scope, []);
    assert.deepEqual(res.tasks[0].acceptance, []);
    assert.deepEqual(res.tasks[0].evidence, []);
    assert.deepEqual(res.tasks[0].dependsOn, []);
  });

  test("字段别名被规范化：codename/description/depends_on 与 dependsOn", () => {
    const res = validatePlan(
      [
        { codename: "A", description: "做 A", depends_on: ["B"] },
        { name: "B", task: "做 B", dependsOn: ["A2"] },
        { name: "A2", task: "做 A2" },
      ],
      3,
    );
    // dependsOn 别名被读到，但 A2 存在，因此整体应通过
    assert.equal(res.ok, true);
    assert.equal(res.tasks[0].name, "A");
    assert.equal(res.tasks[0].task, "做 A");
    assert.deepEqual(res.tasks[0].dependsOn, ["B"]);
    assert.deepEqual(res.tasks[1].dependsOn, ["A2"]);
  });

  test("顶层结构不对（缺 contract 的 tasks 对象）被拒绝", () => {
    const res = validatePlan({ tasks: [item("A")] }, 1);
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /顶层必须是/);
  });

  test("任务项不是对象时拒绝", () => {
    const res = validatePlan(["A"], 1);
    assert.equal(res.ok, false);
    assert.match(res.errors.join("；"), /tasks\[0\] 必须是对象/);
  });
});

/* ---------------- transition ---------------- */

describe("transition：任务状态机", () => {
  test("允许的迁移依次通过", () => {
    const task = makeTask({ state: "planning" });
    const path: TaskState[] = ["running", "merging", "verifying", "aggregating", "done"];
    for (const next of path) {
      transition(task, next);
      assert.equal(task.state, next);
    }
  });

  test("返工分支允许 verifying → rework → verifying", () => {
    const task = makeTask({ state: "verifying" });
    transition(task, "rework");
    assert.equal(task.state, "rework");
    transition(task, "verifying");
    assert.equal(task.state, "verifying");
  });

  test("同状态重复设置按幂等处理，不抛错", () => {
    const task = makeTask({ state: "running" });
    assert.doesNotThrow(() => transition(task, "running"));
    assert.equal(task.state, "running");
  });

  test("终态不能再迁移：开发环境直接抛错", () => {
    const prev = process.env.NODE_ENV;
    setNodeEnv("development");
    try {
      const task = makeTask({ state: "done" });
      assert.throws(() => transition(task, "running"), /非法状态迁移：done → running/);
      assert.equal(task.state, "done");
    } finally {
      setNodeEnv(prev);
    }
  });

  test("非法迁移：生产环境只告警并照常迁移", () => {
    const prevEnv = process.env.NODE_ENV;
    const prevWarn = console.warn;
    const warned: string[] = [];
    setNodeEnv("production");
    console.warn = (msg: unknown) => {
      warned.push(String(msg));
    };
    try {
      const task = makeTask({ state: "done" });
      assert.doesNotThrow(() => transition(task, "running"));
      assert.equal(task.state, "running");
      assert.equal(warned.length, 1);
      assert.match(warned[0], /非法状态迁移：done → running/);
    } finally {
      console.warn = prevWarn;
      setNodeEnv(prevEnv);
    }
  });

  test("跳过中间状态（planning → verifying）在开发环境抛错", () => {
    const prev = process.env.NODE_ENV;
    setNodeEnv("development");
    try {
      const task = makeTask({ state: "planning" });
      assert.throws(() => transition(task, "verifying"), /非法状态迁移/);
      assert.equal(task.state, "planning");
    } finally {
      setNodeEnv(prev);
    }
  });
});

/* ---------------- usageDelta ---------------- */

describe("usageDelta：按阶段取用量增量", () => {
  test("首次读取得到全部累计用量", () => {
    const session = {
      messages: [
        { usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18 } },
        { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } },
      ],
    };
    const d = usageDelta(session)!;
    assert.equal(d.input, 11);
    assert.equal(d.output, 6);
    assert.equal(d.cacheRead, 2);
    assert.equal(d.cacheWrite, 1);
    assert.equal(d.totalTokens, 20);
  });

  test("连续读取两次：第二次只得到新增部分", () => {
    const session = { messages: [{ usage: { input: 10, output: 5, totalTokens: 15 } }] as any[] };
    const first = usageDelta(session)!;
    assert.equal(first.totalTokens, 15);

    session.messages.push({ usage: { input: 3, output: 2, totalTokens: 5 } });
    const second = usageDelta(session)!;
    assert.equal(second.input, 3);
    assert.equal(second.output, 2);
    assert.equal(second.totalTokens, 5);
  });

  test("没有新消息时返回 null，而不是零值对象", () => {
    const session = { messages: [{ usage: { input: 1, output: 1, totalTokens: 2 } }] };
    assert.notEqual(usageDelta(session), null);
    assert.equal(usageDelta(session), null);
  });

  test("会话完全没有 usage 时返回 null", () => {
    assert.equal(usageDelta({ messages: [] }), null);
    assert.equal(usageDelta({ messages: [{ text: "无用量" }] }), null);
    assert.equal(usageDelta({}), null);
  });

  test("不同会话的累计快照互不干扰", () => {
    const a = { messages: [{ usage: { input: 7, output: 0, totalTokens: 7 } }] };
    const b = { messages: [{ usage: { input: 2, output: 0, totalTokens: 2 } }] };
    assert.equal(usageDelta(a)!.totalTokens, 7);
    assert.equal(usageDelta(b)!.totalTokens, 2);
  });
});

/* ---------------- recount ---------------- */

describe("recount：总用量汇总", () => {
  test("totalUsage = boss.usage + boss.summaryUsage + agents.spent + verifier + fixer", () => {
    const task = makeTask({
      boss: {
        state: "done",
        text: "",
        plan: "",
        planList: [],
        contract: null,
        usage: usage(100),
        summaryUsage: usage(50),
      },
      agents: [
        { spent: 200, usage: usage(999) } as any,
        { spent: 0, usage: usage(30) } as any,
      ],
      verifier: { state: "done", text: "", usage: usage(40), error: null },
      rework: [
        { round: 1, target: "fixer", who: "修复代理 #1", reason: "", detail: "", text: "", usage: usage(10), ok: true } as any,
      ],
    });
    recount(task);
    assert.equal(task.totalUsage, 100 + 50 + 200 + 30 + 40 + 10);
  });

  test("执行代理返工重跑不重复计算（spent 已累计，agent 级返工条目忽略）", () => {
    const task = makeTask({
      agents: [{ spent: 500, usage: usage(300) } as any],
      rework: [
        // 执行代理返工：usage 是最近一轮的值，已计入 spent，不能再加
        { round: 1, target: "agent", who: "A", reason: "", detail: "", text: "", usage: usage(300), ok: true } as any,
        { round: 2, target: "fixer", who: "修复代理 #2", reason: "", detail: "", text: "", usage: usage(20), ok: true } as any,
      ],
    });
    recount(task);
    assert.equal(task.totalUsage, 500 + 20);
  });

  test("agent 没有 spent 时回退到最近一轮 usage", () => {
    const task = makeTask({ agents: [{ usage: usage(70) } as any] });
    recount(task);
    assert.equal(task.totalUsage, 70);
  });

  test("全空任务总用量为 0", () => {
    const task = makeTask();
    recount(task);
    assert.equal(task.totalUsage, 0);
  });
});
