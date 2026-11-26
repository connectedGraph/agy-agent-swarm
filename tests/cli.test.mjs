import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cutW,
  displayState,
  displayWidth,
  fmtDuration,
  fmtTokens,
  isTerminal,
  padEndW,
  parseArgv,
  relTime,
  resolveRef,
} from "../bin/swarm.mjs";

test("parseArgv 解析位置参数、长短选项与布尔值", () => {
  const { pos, opts } = parseArgv([
    "run",
    "--repo",
    "~/proj",
    "-n",
    "2",
    "--goal=补 README",
    "--json",
    "--no-color",
  ]);
  assert.deepEqual(pos, ["run"]);
  assert.equal(opts.repo, "~/proj");
  assert.equal(opts.agents, "2");
  assert.equal(opts.goal, "补 README");
  assert.equal(opts.json, true);
  assert.equal(opts.color, false);
});

test("parseArgv 支持 -- 之后的纯位置参数", () => {
  const { pos, opts } = parseArgv(["say", "--", "--这不是选项", "-n"]);
  assert.deepEqual(pos, ["say", "--这不是选项", "-n"]);
  assert.equal(opts.n, undefined);
});

test("parseArgv 拒绝未知选项与缺失值", () => {
  assert.throws(() => parseArgv(["--nope"]), /未知选项/);
  assert.throws(() => parseArgv(["--repo"]), /需要一个值/);
});

test("resolveRef 支持完整 id、唯一前缀、别名与序号", () => {
  const list = [{ id: "aaaa1111" }, { id: "aaaa2222" }, { id: "bbbb3333" }];
  assert.equal(resolveRef(list, "aaaa2222", "会话").id, "aaaa2222");
  assert.equal(resolveRef(list, "bbbb", "会话").id, "bbbb3333");
  assert.equal(resolveRef(list, "last", "会话").id, "aaaa1111");
  assert.equal(resolveRef(list, "2", "会话").id, "aaaa2222");
  assert.throws(() => resolveRef(list, "aaaa", "会话"), /不唯一/);
  assert.throws(() => resolveRef(list, "cccc", "会话"), /找不到/);
});

test("displayState 不让 FAIL 伪装成完成", () => {
  assert.equal(displayState({ state: "done", verdict: { pass: false } }).label, "未通过");
  assert.equal(displayState({ state: "done", verdict: { pass: true } }).label, "完成");
  assert.equal(displayState({ state: "done", verdict: null, error: null }).label, "完成");
  assert.equal(displayState({ state: "cancelled" }).label, "已取消");
  assert.equal(displayState({ state: "running" }).label, "集群执行");
});

test("isTerminal 只认三种终态", () => {
  assert.equal(isTerminal("done"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("cancelled"), true);
  assert.equal(isTerminal("verifying"), false);
});

test("fmtTokens 与 fmtDuration", () => {
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(1500), "1.5k");
  assert.equal(fmtTokens(2_500_000), "2.50M");
  assert.equal(fmtDuration(1500), "2 秒");
  assert.equal(fmtDuration(90_000), "1 分 30 秒");
  assert.equal(fmtDuration(3_600_000), "1 小时");
});

test("relTime 按分钟/小时/跨天分档", () => {
  const now = new Date(2026, 10, 26, 12, 0, 0).getTime();
  assert.equal(relTime(now - 30_000, now), "刚刚");
  assert.equal(relTime(now - 5 * 60_000, now), "5 分钟前");
  assert.equal(relTime(now - 3 * 3_600_000, now), "09:00");
  assert.equal(relTime(now - 26 * 3_600_000, now).startsWith("昨天"), true);
});

test("CJK 宽度用于表格对齐与截断", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("中文"), 4);
  assert.equal(padEndW("中文", 6), "中文  ");
  assert.equal(cutW("abcdefgh", 5), "abcd…");
  assert.equal(displayWidth(cutW("中文中文", 5)), 5);
});
