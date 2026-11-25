export type AgentState = "queued" | "booting" | "working" | "done" | "failed";
export type TaskState = "planning" | "running" | "merging" | "verifying" | "rework" | "aggregating" | "done" | "failed";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  input?: number;
  output?: number;
  totalTokens2?: number;
}

export interface AgentRun {
  id: string;
  index: number;
  name: string;
  task: string;
  scope: string[];
  acceptance: string[];
  evidence: string[];
  dependsOn: string[];
  worktree: string;
  branch: string;
  state: AgentState;
  text: string;
  usage: Usage | null;
  // 累计花费（含返工重跑）；usage 只记录最近一轮
  spent?: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  changedFiles: string[];
}

export interface BossRun {
  state: "idle" | "planning" | "aggregating" | "done" | "failed";
  text: string;
  plan: string;
  planList: { name: string; task: string }[];
  contract: any | null;
  usage: Usage | null;
  summaryUsage: Usage | null;
}

export interface VerifierRun {
  state: "idle" | "working" | "done" | "failed";
  text: string;
  usage: Usage | null;
  error: string | null;
}

export interface MergeResult {
  name: string;
  branch: string;
  status: "merged" | "conflict" | "skipped";
  detail: string;
}

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number;
  output: string;
  ms: number;
}

export interface Verification {
  ok: boolean;
  integrationDir: string;
  integrationBranch: string;
  checks: CheckResult[];
  diffStat: string;
}

export interface Verdict {
  pass: boolean;
  reasons: string[];
  raw: string;
}

// 一轮返工：重跑失败的执行代理，或由修复代理直接在合并树上修
export interface ReworkRound {
  round: number;
  target: "agent" | "fixer";
  who: string;
  reason: string;
  detail: string;
  text: string;
  usage: Usage | null;
  ok: boolean;
}

export interface PromoteResult {
  at: number;
  target: string;
  ok: boolean;
  detail: string;
  commit?: string;
}

// 会话记录：目标是第一条 user 消息；之后是编排器回复与追问
export interface ChatMessage {
  id: string;
  role: "user" | "boss";
  text: string;
  at: number;
  kind?: "goal" | "reply";
  error?: boolean;
}

export interface Task {
  id: string;
  goal: string;
  repoPath: string | null;
  baseRepo: string | null;
  baseBranch?: string | null;
  state: TaskState;
  createdAt: number;
  finishedAt: number | null;
  boss: BossRun;
  agents: AgentRun[];
  totalUsage: number;
  summary: string;
  merge: MergeResult[];
  verification: Verification | null;
  verifier: VerifierRun | null;
  verdict: Verdict | null;
  rework: ReworkRound[];
  promote: PromoteResult | null;
  error: string | null;
  // 编排器会话：用户的目标与追问、编排器的回复
  messages?: ChatMessage[];
}

export type SwarmEvent =
  | { type: "task"; task: Task }
  | { type: "agent"; taskId: string; agent: AgentRun }
  | { type: "boss"; taskId: string; boss: BossRun }
  | { type: "chat"; taskId: string; message: ChatMessage }
  | { type: "log"; taskId: string; agentId?: string; text: string; at: number }
  | { type: "record"; enabled: boolean }
  | { type: "gateway"; stats: GatewayStats };

export interface GatewayCall {
  at: number;
  method: string;
  model: string;
  agentId: string | null;
  status: number;
  ms: number;
  promptTokens: number;
  candidateTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  recorded: boolean;
}

export interface GatewayStats {
  enabled: boolean;
  upstream: string;
  totalCalls: number;
  totalTokens: number;
  byAgent: Record<string, { calls: number; tokens: number }>;
  recent: GatewayCall[];
}
