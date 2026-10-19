#!/usr/bin/env bun
// Token usage report for vdev members.
//
// Reads the Claude Code transcripts that vdev members leave under ~/.claude/projects
// (every API call's usage, every tool call and its result) and the vdev database
// (task ids, members, outcomes), then shows where tokens go and what to change.
//
//   bun scripts/token-report.ts [--days 7] [--workspace ~/code/rs3] [--task 174] [--top 15] [--json]

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------- options

type Options = { days: number | null; workspace: string | null; taskId: number | null; top: number; json: boolean };

function parseOptions(argumentList: string[]): Options {
  const options: Options = { days: null, workspace: null, taskId: null, top: 15, json: false };
  for (let index = 0; index < argumentList.length; index++) {
    const argument = argumentList[index];
    const value = argumentList[index + 1];
    if (argument === "--json") options.json = true;
    else if (argument === "--days") { options.days = Number(value); index++; }
    else if (argument === "--workspace") { options.workspace = expandHome(value); index++; }
    else if (argument === "--task") { options.taskId = Number(value); index++; }
    else if (argument === "--top") { options.top = Number(value); index++; }
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: bun scripts/token-report.ts [--days N] [--workspace PATH] [--task ID] [--top N] [--json]");
      process.exit(0);
    }
  }
  return options;
}

function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

// ---------------------------------------------------------------- pricing

// USD per million tokens at API list prices. Cache writes cost 1.25x input (5 minute TTL)
// or 2x input (1 hour TTL). On a subscription this is a relative weight, not a bill.
type Price = { input: number; output: number; cacheRead: number };
const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};

function priceFor(model: string): Price {
  const key = Object.keys(PRICES).find((name) => model.startsWith(name));
  return key ? PRICES[key] : PRICES["claude-sonnet-5-5"];
}

// Tool results are measured in characters; this is the usual ratio for code and logs.
const CHARACTERS_PER_TOKEN = 4;
const IMAGE_TOKENS = 1600;

// ---------------------------------------------------------------- model

type ApiCall = {
  messageId: string;
  model: string;
  timestamp: number;
  inputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cost: number;
  segment: Segment;
  isSubagent: boolean;
};

type ToolCall = {
  id: string;
  name: string;
  label: string;
  family: string;
  resultTokens: number;
  callIndex: number; // index of the API call that requested it, within its context run
  laterCalls: number; // API calls that re-read the result before the context reset
  carriedCost: number;
  segment: Segment;
};

type Segment = {
  key: string;
  sessionId: string;
  workspace: string;
  member: string;
  role: "manager" | "worker";
  taskId: number | null;
  brief: string;
  status: string | null;
  budget: number | null;
  calls: ApiCall[];
  tools: ToolCall[];
  firstContextTokens: number | null;
  peakContextTokens: number;
  readPaths: Map<string, number>;
};

type TaskRow = { id: number; member: string; brief: string; status: string; budget: number; spent: number; workspace: string | null };

// ---------------------------------------------------------------- loading

const rootDirectory = join(import.meta.dir, "..");
const projectsDirectory = join(homedir(), ".claude", "projects");

function loadTasks(): Map<number, TaskRow> {
  const databasePath = process.env.VDEV_DATABASE ?? join(rootDirectory, "vdev.sqlite");
  const tasks = new Map<number, TaskRow>();
  if (!existsSync(databasePath)) return tasks;
  const database = new Database(databasePath, { readonly: true });
  const rows = database.query<TaskRow, []>("SELECT id, member, brief, status, budget, spent, workspace FROM tasks").all();
  for (const row of rows) tasks.set(row.id, row);
  database.close();
  return tasks;
}

function loadWorkspaces(options: Options): string[] {
  if (options.workspace) return [options.workspace];
  const databasePath = process.env.VDEV_DATABASE ?? join(rootDirectory, "vdev.sqlite");
  if (!existsSync(databasePath)) return [];
  const database = new Database(databasePath, { readonly: true });
  const rows = database.query<{ workspace: string }, []>(
    "SELECT workspace FROM member_sessions UNION SELECT workspace FROM tasks WHERE workspace IS NOT NULL").all();
  database.close();
  return rows.map((row) => row.workspace);
}

function projectDirectoryFor(workspace: string): string {
  return join(projectsDirectory, workspace.replace(/[^A-Za-z0-9]/g, "-"));
}

function readJsonLines(path: string): any[] {
  const records: any[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { /* partial line while a member is writing */ }
  }
  return records;
}

// vdev runs members with `claude -p`, which marks every record as sdk-cli.
function isVdevTranscript(path: string): boolean {
  const head = readFileSync(path, "utf8").slice(0, 20000);
  return head.includes('"entrypoint":"sdk-cli"');
}

// ---------------------------------------------------------------- parsing

const TASK_HEADER = /^\[Task #(\d+) from Manager\]/;

function userText(record: any): string {
  const content = record.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
}

function resultTokens(block: any): number {
  const content = block.content;
  if (typeof content === "string") return Math.ceil(content.length / CHARACTERS_PER_TOKEN);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const part of content) {
    if (part.type === "image") tokens += IMAGE_TOKENS;
    else if (typeof part.text === "string") tokens += Math.ceil(part.text.length / CHARACTERS_PER_TOKEN);
  }
  return tokens;
}

const TWO_WORD_COMMANDS = new Set(["bundle", "git", "npm", "npx", "bun", "yarn", "pnpm", "bin/rails", "rails", "rake",
  "python", "python3", "ruby", "twg", "docker", "gh", "rtk", "make", "cargo", "go", "kubectl", "psql", "mysql"]);

function bashFamily(command: string): string {
  // The first command that is not a `cd`, ignoring env assignments and the rtk wrapper.
  const commands = command.slice(0, 2000).split(/\s*(?:&&|\|\||;|\||\n)\s*/);
  let words: string[] = [];
  for (const candidate of commands) {
    words = candidate.trim().split(/\s+/).filter((word) => word && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    if (words[0] === "rtk") words = words.slice(1);
    if (words.length > 0 && words[0] !== "cd") break;
  }
  if (words.length === 0) return "(empty)";
  if (words[0] === "bundle" && words[1] === "exec") return words.slice(0, 3).join(" ");
  return TWO_WORD_COMMANDS.has(words[0]) && words[1] && !words[1].startsWith("-") ? words.slice(0, 2).join(" ") : words[0];
}

function describeTool(name: string, input: any): { label: string; family: string } {
  if (name === "Bash") {
    const command = String(input?.command ?? "");
    return { label: command.replace(/\s+/g, " ").slice(0, 110), family: `Bash: ${bashFamily(command)}` };
  }
  if (name === "Read" || name === "Edit" || name === "Write") {
    const path = String(input?.file_path ?? "");
    const range = input?.offset || input?.limit ? ` [${input.offset ?? 0}+${input.limit ?? "end"}]` : "";
    return { label: path + range, family: name };
  }
  if (name === "Grep" || name === "Glob") return { label: `${input?.pattern ?? ""} ${input?.path ?? ""}`.trim(), family: name };
  if (name === "Skill") return { label: String(input?.skill ?? ""), family: `Skill: ${input?.skill ?? ""}` };
  if (name === "Agent" || name === "Task") return { label: String(input?.description ?? ""), family: "Agent (subagent)" };
  if (name.startsWith("mcp__")) {
    const detail = input?.action ?? input?.url ?? input?.query ?? "";
    return { label: `${name} ${detail}`.trim().slice(0, 110), family: name.replace(/^mcp__/, "mcp:") };
  }
  return { label: JSON.stringify(input ?? {}).slice(0, 110), family: name };
}

type ParseContext = { tasks: Map<number, TaskRow>; segments: Segment[]; calls: ApiCall[]; tools: ToolCall[] };

function newSegment(sessionId: string, workspace: string, taskId: number | null, context: ParseContext, role: "manager" | "worker"): Segment {
  const task = taskId !== null ? context.tasks.get(taskId) : undefined;
  const segment: Segment = {
    key: taskId !== null ? `task:${taskId}` : `chat:${sessionId}:${context.segments.length}`,
    sessionId, workspace, role,
    member: task?.member ?? (role === "manager" ? "manager" : "(unknown)"),
    taskId,
    brief: task?.brief ?? "",
    status: task?.status ?? null,
    budget: task?.budget ?? null,
    calls: [], tools: [],
    firstContextTokens: null,
    peakContextTokens: 0,
    readPaths: new Map(),
  };
  context.segments.push(segment);
  return segment;
}

function parseTranscript(path: string, workspace: string, context: ParseContext, parentSegments: Segment[] | null): Segment[] {
  const records = readJsonLines(path);
  const sessionId = records.find((record) => record.sessionId)?.sessionId ?? path;
  const isSubagent = parentSegments !== null;
  const isManager = records.some((record) => record.type === "assistant" &&
    record.message?.content?.some?.((block: any) => block.type === "tool_use" && /delegate_task/.test(block.name)));
  const role = isManager ? "manager" : "worker";

  // A subagent's work belongs to whatever task its parent was on when it started.
  const firstTimestamp = Date.parse(records.find((record) => record.timestamp)?.timestamp ?? "");
  let segment: Segment | null = isSubagent
    ? [...parentSegments!].reverse().find((candidate) => (candidate.calls[0]?.timestamp ?? Infinity) <= firstTimestamp) ?? parentSegments![0] ?? null
    : null;
  const ownSegments: Segment[] = [];

  // Context runs end at a compaction or /clear: earlier tool results stop being re-read.
  let contextRun: { calls: ApiCall[]; tools: ToolCall[] } = { calls: [], tools: [] };
  const closeContextRun = () => {
    const totalCalls = contextRun.calls.length;
    for (const tool of contextRun.tools) {
      tool.laterCalls = Math.max(0, totalCalls - tool.callIndex - 1);
      const price = priceFor(contextRun.calls[tool.callIndex]?.model ?? "");
      tool.carriedCost = (tool.resultTokens * tool.laterCalls * price.cacheRead + tool.resultTokens * price.input * 2) / 1e6;
    }
    contextRun = { calls: [], tools: [] };
  };

  const callsByMessageId = new Map<string, ApiCall>();
  const pendingTools = new Map<string, ToolCall>();

  for (const record of records) {
    if (record.type === "system" && record.subtype === "compact_boundary") { closeContextRun(); continue; }

    if (record.type === "user" && !isSubagent) {
      const text = userText(record);
      if (/<command-name>\/clear<\/command-name>/.test(text)) closeContextRun();
      const taskMatch = text.match(TASK_HEADER);
      if (taskMatch) {
        segment = newSegment(sessionId, workspace, Number(taskMatch[1]), context, role);
        ownSegments.push(segment);
      } else if (!segment && text && !record.isMeta && !/^<(command|local-command)/.test(text)) {
        segment = newSegment(sessionId, workspace, null, context, role);
        ownSegments.push(segment);
      }
    }

    if (record.type === "user" && Array.isArray(record.message?.content)) {
      for (const block of record.message.content) {
        if (block.type !== "tool_result") continue;
        const tool = pendingTools.get(block.tool_use_id);
        if (!tool) continue;
        tool.resultTokens = resultTokens(block);
        pendingTools.delete(block.tool_use_id);
      }
    }

    if (record.type !== "assistant" || !record.message?.usage) continue;
    if (!segment) {
      segment = newSegment(sessionId, workspace, null, context, role);
      ownSegments.push(segment);
    }
    const message = record.message;
    if (message.model === "<synthetic>") continue;

    // One API response is written as several records (one per content block) with the same id.
    let call = callsByMessageId.get(message.id);
    if (!call) {
      const usage = message.usage;
      const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const cacheWriteTotal = usage.cache_creation_input_tokens ?? 0;
      call = {
        messageId: message.id,
        model: message.model,
        timestamp: Date.parse(record.timestamp),
        inputTokens: usage.input_tokens ?? 0,
        cacheWrite1hTokens: cacheWrite1h,
        cacheWrite5mTokens: Math.max(0, cacheWriteTotal - cacheWrite1h),
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        thinkingTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
        cost: 0,
        segment,
        isSubagent,
      };
      const price = priceFor(call.model);
      call.cost = (call.inputTokens * price.input + call.cacheWrite5mTokens * price.input * 1.25 +
        call.cacheWrite1hTokens * price.input * 2 + call.cacheReadTokens * price.cacheRead + call.outputTokens * price.output) / 1e6;
      callsByMessageId.set(message.id, call);
      contextRun.calls.push(call);
      context.calls.push(call);
      segment.calls.push(call);
      if (!isSubagent) {
        const contextTokens = call.inputTokens + call.cacheWrite5mTokens + call.cacheWrite1hTokens + call.cacheReadTokens;
        segment.firstContextTokens ??= contextTokens;
        segment.peakContextTokens = Math.max(segment.peakContextTokens, contextTokens);
      }
    } else if ((message.usage.output_tokens ?? 0) > call.outputTokens) {
      const price = priceFor(call.model);
      call.cost += ((message.usage.output_tokens - call.outputTokens) * price.output) / 1e6;
      call.outputTokens = message.usage.output_tokens;
    }

    for (const block of message.content ?? []) {
      if (block.type !== "tool_use") continue;
      const { label, family } = describeTool(block.name, block.input);
      const tool: ToolCall = {
        id: block.id, name: block.name, label, family,
        resultTokens: 0, callIndex: contextRun.calls.length - 1, laterCalls: 0, carriedCost: 0, segment,
      };
      pendingTools.set(block.id, tool);
      contextRun.tools.push(tool);
      context.tools.push(tool);
      segment.tools.push(tool);
      if (block.name === "Read" && !isSubagent) {
        const filePath = String(block.input?.file_path ?? "");
        segment.readPaths.set(filePath, (segment.readPaths.get(filePath) ?? 0) + 1);
      }
    }
  }
  closeContextRun();
  return ownSegments;
}

function loadAll(options: Options): ParseContext {
  const context: ParseContext = { tasks: loadTasks(), segments: [], calls: [], tools: [] };
  const cutoff = options.days ? Date.now() - options.days * 86_400_000 : 0;
  for (const workspace of loadWorkspaces(options)) {
    const projectDirectory = projectDirectoryFor(workspace);
    if (!existsSync(projectDirectory)) continue;
    for (const fileName of readdirSync(projectDirectory)) {
      if (!fileName.endsWith(".jsonl")) continue;
      const path = join(projectDirectory, fileName);
      if (statSync(path).mtimeMs < cutoff) continue;
      if (!isVdevTranscript(path)) continue;
      const sessionSegments = parseTranscript(path, workspace, context, null);
      const subagentDirectory = join(projectDirectory, fileName.replace(/\.jsonl$/, ""), "subagents");
      if (!existsSync(subagentDirectory)) continue;
      for (const subagentFile of readdirSync(subagentDirectory)) {
        if (subagentFile.endsWith(".jsonl")) parseTranscript(join(subagentDirectory, subagentFile), workspace, context, sessionSegments);
      }
    }
  }
  if (options.taskId !== null) {
    context.segments = context.segments.filter((segment) => segment.taskId === options.taskId);
    const kept = new Set(context.segments);
    context.calls = context.calls.filter((call) => kept.has(call.segment));
    context.tools = context.tools.filter((tool) => kept.has(tool.segment));
  }
  if (cutoff) {
    context.calls = context.calls.filter((call) => call.timestamp >= cutoff);
    const kept = new Set(context.calls.map((call) => call.segment));
    context.segments = context.segments.filter((segment) => kept.has(segment));
    context.tools = context.tools.filter((tool) => kept.has(tool.segment));
  }
  return context;
}

// ---------------------------------------------------------------- analysis

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    const group = groups.get(groupKey) ?? [];
    group.push(item);
    groups.set(groupKey, group);
  }
  return groups;
}

function tokenTotals(calls: ApiCall[]) {
  const price = (call: ApiCall) => priceFor(call.model);
  return {
    calls: calls.length,
    input: sum(calls, (call) => call.inputTokens),
    cacheWrite: sum(calls, (call) => call.cacheWrite5mTokens + call.cacheWrite1hTokens),
    cacheRead: sum(calls, (call) => call.cacheReadTokens),
    output: sum(calls, (call) => call.outputTokens),
    thinking: sum(calls, (call) => call.thinkingTokens),
    cost: sum(calls, (call) => call.cost),
    costCacheRead: sum(calls, (call) => call.cacheReadTokens * price(call).cacheRead) / 1e6,
    costCacheWrite: sum(calls, (call) => (call.cacheWrite5mTokens * 1.25 + call.cacheWrite1hTokens * 2) * price(call).input) / 1e6,
    costInput: sum(calls, (call) => call.inputTokens * price(call).input) / 1e6,
    costOutput: sum(calls, (call) => call.outputTokens * price(call).output) / 1e6,
  };
}

// A large cache write after the first call means the cached prefix was lost:
// the cache expired during a pause, or the session was resumed in a new process.
function cacheRebuilds(segments: Segment[]) {
  const rebuilds: { segment: Segment; tokens: number; gapMinutes: number; cost: number }[] = [];
  for (const segment of segments) {
    const mainCalls = segment.calls.filter((call) => !call.isSubagent);
    for (let index = 1; index < mainCalls.length; index++) {
      const call = mainCalls[index];
      const written = call.cacheWrite5mTokens + call.cacheWrite1hTokens;
      if (written < 20_000 || written < call.cacheReadTokens) continue;
      const price = priceFor(call.model);
      rebuilds.push({
        segment, tokens: written,
        gapMinutes: (call.timestamp - mainCalls[index - 1].timestamp) / 60_000,
        cost: (call.cacheWrite5mTokens * 1.25 + call.cacheWrite1hTokens * 2) * price.input / 1e6,
      });
    }
  }
  return rebuilds;
}

function analyze(context: ParseContext, options: Options) {
  const { calls, tools, segments } = context;
  const totals = tokenTotals(calls);

  const byMember = [...groupBy(calls, (call) => `${call.segment.member}${call.isSubagent ? " (subagents)" : ""}`)]
    .map(([member, memberCalls]) => ({ member, ...tokenTotals(memberCalls) }))
    .sort((first, second) => second.cost - first.cost);

  const byModel = [...groupBy(calls, (call) => call.model)]
    .map(([model, modelCalls]) => ({ model, ...tokenTotals(modelCalls) }))
    .sort((first, second) => second.cost - first.cost);

  const taskSegments = segments.filter((segment) => segment.calls.length > 0);
  const byTask = taskSegments.map((segment) => {
    const segmentTotals = tokenTotals(segment.calls);
    return {
      key: segment.key, taskId: segment.taskId, member: segment.member, status: segment.status,
      brief: firstLine(segment.brief), ...segmentTotals,
      peakContext: segment.peakContextTokens,
      startContext: segment.firstContextTokens ?? 0,
      toolCalls: segment.tools.length,
      costPerCall: segmentTotals.cost / Math.max(1, segmentTotals.calls),
    };
  }).sort((first, second) => second.cost - first.cost);

  const toolSummary = (groups: Map<string, ToolCall[]>) => [...groups]
    .map(([name, group]) => ({
      name, count: group.length,
      resultTokens: sum(group, (tool) => tool.resultTokens),
      averageResultTokens: Math.round(sum(group, (tool) => tool.resultTokens) / group.length),
      carriedTokens: sum(group, (tool) => tool.resultTokens * tool.laterCalls),
      carriedCost: sum(group, (tool) => tool.carriedCost),
    }))
    .sort((first, second) => second.carriedCost - first.carriedCost);

  const byTool = toolSummary(groupBy(tools, (tool) => tool.name.startsWith("mcp__") ? tool.family : tool.name));
  const byFamily = toolSummary(groupBy(tools, (tool) => tool.family));

  const biggestResults = [...tools].sort((first, second) => second.carriedCost - first.carriedCost).slice(0, options.top)
    .map((tool) => ({
      task: tool.segment.taskId ? `#${tool.segment.taskId}` : tool.segment.member,
      tool: tool.name, label: tool.label, resultTokens: tool.resultTokens, laterCalls: tool.laterCalls, carriedCost: tool.carriedCost,
    }));

  const repeatedReads = segments.flatMap((segment) => [...segment.readPaths]
    .filter(([, count]) => count >= 3)
    .map(([path, count]) => ({ task: segment.taskId ? `#${segment.taskId}` : segment.member, path, count })))
    .sort((first, second) => second.count - first.count).slice(0, options.top);

  const rebuilds = cacheRebuilds(segments);
  const startContexts = groupBy(taskSegments.filter((segment) => segment.firstContextTokens), (segment) => segment.role);
  const baseline = [...startContexts].map(([role, group]) => ({
    role, segments: group.length,
    averageStartContext: Math.round(sum(group, (segment) => segment.firstContextTokens ?? 0) / group.length),
  }));

  // The starting context is re-read by every later call of the task.
  const baselineReadCost = sum(calls.filter((call) => !call.isSubagent), (call) =>
    Math.min(call.segment.firstContextTokens ?? 0, call.cacheReadTokens) * priceFor(call.model).cacheRead) / 1e6;

  const longSessions = byTask.filter((task) => task.peakContext > 150_000).slice(0, 5);

  const statusSummary =[...groupBy(byTask.filter((task) => task.taskId !== null), (task) => task.status ?? "unknown")]
    .map(([status, group]) => ({ status, tasks: group.length, cost: sum(group, (task) => task.cost),
      averageCost: sum(group, (task) => task.cost) / group.length, averageCalls: Math.round(sum(group, (task) => task.calls) / group.length) }))
    .sort((first, second) => second.cost - first.cost);

  return { totals, byMember, byModel, byTask, byTool, byFamily, biggestResults, repeatedReads, rebuilds, baseline,
    baselineReadCost, longSessions, statusSummary };
}

type Analysis = ReturnType<typeof analyze>;

function recommendations(analysis: Analysis): string[] {
  const advice: string[] = [];
  const { totals } = analysis;
  const share = (part: number) => totals.cost ? part / totals.cost : 0;

  if (share(totals.costCacheRead) > 0.4) {
    advice.push(`Cache reads are ${percent(share(totals.costCacheRead))} of the cost: every call re-reads the whole context. ` +
      "Long-lived worker sessions and big tool outputs are the levers: start each task in a fresh session (or /clear) and keep outputs small.");
  }
  if (share(totals.costCacheWrite) > 0.3) {
    advice.push(`Cache writes are ${percent(share(totals.costCacheWrite))} of the cost. Workers write with the 1h TTL (2x input price), ` +
      "so every new token entering context is paid twice over a plain read. Shrink what enters context: tool outputs, skill files, CLAUDE.md.");
  }
  const rebuildCost = sum(analysis.rebuilds, (rebuild) => rebuild.cost);
  if (share(rebuildCost) > 0.05) {
    advice.push(`${analysis.rebuilds.length} cache rebuilds cost ${dollars(rebuildCost)} (${percent(share(rebuildCost))}). ` +
      "They happen when a member resumes after the cache expired or its process restarted; resuming a large session re-buys the whole context. " +
      "Prefer a fresh session for a new task over resuming a big one.");
  }
  const topFamily = analysis.byFamily[0];
  if (topFamily && share(topFamily.carriedCost) > 0.1) {
    advice.push(`"${topFamily.name}" outputs cost ~${dollars(topFamily.carriedCost)} (${percent(share(topFamily.carriedCost))}) ` +
      `once you count every later call that re-reads them (avg ${formatTokens(topFamily.averageResultTokens)} per result). Filter or cap that output (head, grep, --format progress, -q).`);
  }
  const imageTools = analysis.byTool.find((tool) => tool.name.includes("chrome"));
  if (imageTools && share(imageTools.carriedCost) > 0.05) {
    advice.push(`Chrome tools cost ~${dollars(imageTools.carriedCost)}: screenshots stay in context for the rest of the task. ` +
      "Prefer read_page/get_page_text or find over screenshots, and only enable chrome for workers whose tasks need it.");
  }
  const workerBaseline = analysis.baseline.find((entry) => entry.role === "worker");
  if (analysis.longSessions.length > 0) {
    const longest = analysis.longSessions[0];
    advice.push(`${analysis.longSessions.length} conversations grew past 150k tokens of context (largest: ${longest.taskId ? `task #${longest.taskId}` : `${longest.member} chat`}, ` +
      `${formatTokens(longest.peakContext)} peak, ${longest.calls} calls, ${dollars(longest.cost)}). Every call there re-reads all of it. ` +
      "Clear or compact the manager between features, and split long worker tasks.");
  }
  if (workerBaseline && workerBaseline.averageStartContext > 30_000) {
    advice.push(`Workers start each task with ~${formatTokens(workerBaseline.averageStartContext)} of context; re-reading that starting context costs ` +
      `${dollars(analysis.baselineReadCost)} (${percent(share(analysis.baselineReadCost))}) across all calls. ` +
      "It is the system prompt, tools (MCP servers, chrome), CLAUDE.md and memory. " +
      "Trim user-level CLAUDE.md/memory, drop MCP servers workers do not use (--setting-sources loads all of yours), or restrict --tools.");
  }
  const failed = analysis.statusSummary.filter((entry) => entry.status === "over_budget" || entry.status === "stopped");
  const failedCost = sum(failed, (entry) => entry.cost);
  if (share(failedCost) > 0.15) {
    advice.push(`Tasks that ended over_budget or stopped cost ${dollars(failedCost)} (${percent(share(failedCost))}) and produced no accepted handoff. ` +
      "Look at the top ones below: vague briefs, missing file pointers, or tasks too big for one worker.");
  }
  if (analysis.repeatedReads.length > 0) {
    advice.push(`Some files are read 3+ times in one task (e.g. ${analysis.repeatedReads[0].path}, ${analysis.repeatedReads[0].count}x). ` +
      "Put the relevant line ranges in the brief, or tell workers to read once with offset/limit.");
  }
  if (totals.output && totals.thinking / totals.output > 0.5) {
    advice.push(`Thinking is ${percent(totals.thinking / totals.output)} of output tokens. Lower worker effort for routine tasks.`);
  }
  return advice;
}

// ---------------------------------------------------------------- output

function formatTokens(tokens: number): string {
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(2)}B`;
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k`;
  return String(Math.round(tokens));
}
function dollars(amount: number): string { return `$${amount.toFixed(amount < 10 ? 2 : 0)}`; }
function percent(fraction: number): string { return `${Math.round(fraction * 100)}%`; }
function firstLine(text: string): string {
  return text.replace(TASK_HEADER, "").trim().split("\n").find((line) => line.trim())?.trim().slice(0, 70) ?? "";
}

function table(headers: string[], rows: (string | number)[][]): string {
  const cells = [headers, ...rows.map((row) => row.map(String))];
  const widths = headers.map((_, column) => Math.max(...cells.map((row) => row[column]?.length ?? 0)));
  const render = (row: string[]) => row.map((cell, column) =>
    column === row.length - 1 ? cell : cell.padEnd(widths[column])).join("  ");
  return [render(cells[0]), render(widths.map((width) => "-".repeat(width))), ...cells.slice(1).map(render)].join("\n");
}

function printReport(analysis: Analysis, options: Options) {
  const { totals } = analysis;
  const share = (part: number) => percent(totals.cost ? part / totals.cost : 0);
  const section = (title: string) => console.log(`\n== ${title}\n`);

  section("Overview (cost at API list prices; a relative weight if you are on a subscription)");
  console.log(table(["", "tokens", "est. cost", "share"], [
    ["cache read", formatTokens(totals.cacheRead), dollars(totals.costCacheRead), share(totals.costCacheRead)],
    ["cache write", formatTokens(totals.cacheWrite), dollars(totals.costCacheWrite), share(totals.costCacheWrite)],
    ["input (uncached)", formatTokens(totals.input), dollars(totals.costInput), share(totals.costInput)],
    ["output", formatTokens(totals.output), dollars(totals.costOutput), share(totals.costOutput)],
    ["total", "", dollars(totals.cost), `${totals.calls} API calls`],
  ]));

  section("By member");
  console.log(table(["member", "calls", "cache read", "cache write", "output", "est. cost", "share"],
    analysis.byMember.map((row) => [row.member, row.calls, formatTokens(row.cacheRead), formatTokens(row.cacheWrite),
      formatTokens(row.output), dollars(row.cost), share(row.cost)])));

  section("By model");
  console.log(table(["model", "calls", "output", "est. cost", "share"],
    analysis.byModel.map((row) => [row.model, row.calls, formatTokens(row.output), dollars(row.cost), share(row.cost)])));

  section("By task outcome");
  console.log(table(["status", "tasks", "avg calls", "avg cost", "total", "share"],
    analysis.statusSummary.map((row) => [row.status, row.tasks, row.averageCalls, dollars(row.averageCost), dollars(row.cost), share(row.cost)])));

  section("Starting context (system prompt + tools + CLAUDE.md + memory, paid on every call)");
  console.log(table(["role", "segments", "avg start context"],
    analysis.baseline.map((row) => [row.role, row.segments, formatTokens(row.averageStartContext)])));
  console.log(`\nRe-reading the starting context on every call: ${dollars(analysis.baselineReadCost)} (${share(analysis.baselineReadCost)} of all cost)`);

  section(`Most expensive tasks (top ${options.top})`);
  console.log(table(["task", "member", "status", "calls", "start ctx", "peak ctx", "est. cost", "brief"],
    analysis.byTask.slice(0, options.top).map((row) => [row.taskId ? `#${row.taskId}` : "chat", row.member, row.status ?? "",
      row.calls, formatTokens(row.startContext), formatTokens(row.peakContext), dollars(row.cost), row.brief])));

  section("Tools (carried cost = written to cache once + re-read by every later call until compaction)");
  console.log(table(["tool", "calls", "avg result", "result tokens", "carried tokens", "carried cost", "share"],
    analysis.byTool.slice(0, options.top).map((row) => [row.name, row.count, formatTokens(row.averageResultTokens),
      formatTokens(row.resultTokens), formatTokens(row.carriedTokens), dollars(row.carriedCost), share(row.carriedCost)])));

  section("Command families");
  console.log(table(["family", "calls", "avg result", "carried tokens", "carried cost", "share"],
    analysis.byFamily.slice(0, options.top).map((row) => [row.name, row.count, formatTokens(row.averageResultTokens),
      formatTokens(row.carriedTokens), dollars(row.carriedCost), share(row.carriedCost)])));

  section(`Costliest single tool results (top ${options.top})`);
  console.log(table(["task", "tool", "result", "re-read by", "carried cost", "call"],
    analysis.biggestResults.map((row) => [row.task, row.tool, formatTokens(row.resultTokens), `${row.laterCalls} calls`,
      dollars(row.carriedCost), row.label])));

  if (analysis.repeatedReads.length > 0) {
    section("Files read 3+ times in one task");
    console.log(table(["task", "reads", "path"], analysis.repeatedReads.map((row) => [row.task, row.count, row.path])));
  }

  const rebuildCost = sum(analysis.rebuilds, (rebuild) => rebuild.cost);
  section(`Cache rebuilds: ${analysis.rebuilds.length}, ${formatTokens(sum(analysis.rebuilds, (rebuild) => rebuild.tokens))} tokens, ${dollars(rebuildCost)} (${share(rebuildCost)})`);
  const worstRebuilds = [...analysis.rebuilds].sort((first, second) => second.cost - first.cost).slice(0, 5);
  if (worstRebuilds.length > 0) {
    console.log(table(["task", "member", "rewritten", "idle before", "cost"], worstRebuilds.map((rebuild) => [
      rebuild.segment.taskId ? `#${rebuild.segment.taskId}` : "chat", rebuild.segment.member, formatTokens(rebuild.tokens),
      `${Math.round(rebuild.gapMinutes)} min`, dollars(rebuild.cost)])));
  }

  section("Recommendations");
  const advice = recommendations(analysis);
  if (advice.length === 0) console.log("Nothing stands out.");
  advice.forEach((line, index) => console.log(`${index + 1}. ${line}\n`));
}

// ---------------------------------------------------------------- main

const options = parseOptions(process.argv.slice(2));
const context = loadAll(options);
if (context.calls.length === 0) {
  console.error("No vdev member transcripts found for the selected filters.");
  process.exit(1);
}
const analysis = analyze(context, options);
if (options.json) {
  console.log(JSON.stringify({ ...analysis, recommendations: recommendations(analysis),
    rebuilds: analysis.rebuilds.map((rebuild) => ({ ...rebuild, segment: rebuild.segment.key })) }, null, 2));
} else {
  printReport(analysis, options);
}
