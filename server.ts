// vdev: local web UI for a team of Claude Code members.
// Each member is a `claude -p` stream-json process using your own Claude login.
// Run: bun server.ts   (config in team.json)

import { Database } from "bun:sqlite";
import type { ServerWebSocket, Subprocess } from "bun";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";

// Settings shared by every worker (or the manager). Anything left out falls back to
// what a plain `claude` in the workspace would use, e.g. your default model.
type AgentConfig = {
  model?: string;
  // Added to Claude Code's own system prompt; the worker default is none.
  prompt?: string;
  effort?: string;
  tools?: string[];
  allowedTools?: string[];
  permissionMode?: string;
  budget?: number;
  chrome?: boolean;
};

type MemberConfig = AgentConfig & { name: string };

type TeamConfig = {
  port?: number;
  projectDir?: string;
  workspaceRoots?: string[];
  idleMinutes?: number;
  watchdog?: WatchdogConfig;
  manager: AgentConfig;
  worker: AgentConfig;
  // Worker names, in sidebar order. Every worker runs with the same `worker` settings.
  workers: string[];
};

// When the server wakes the Manager about a worker's task. 0 turns a check off.
type WatchdogConfig = {
  // A tool call has waited this long for the user's approval.
  approvalMinutes?: number;
  // No output from the worker for this long (repeats at 2x, 4x, ...).
  silentMinutes?: number;
  // A progress check every this many minutes of work on one task.
  checkInMinutes?: number;
  // Show the Manager each approval a worker asks for, so it can send the worker a route
  // that needs none. On unless false.
  reviewApprovals?: boolean;
};

// Per turn, so each notice is sent once.
type WatchState = { approvalAlerts: Set<string>; silentAlerts: number; checkIns: number };

// threadId: the root event of the thread a user reply was sent in; the member's
// output for that turn is filed under the same thread.
// itemId: the task summary line the turn is about (Manager only); its output is filed under that item.
type TurnOrigin = { kind: "user" | "task" | "handoff" | "command"; taskId?: number; threadId?: number; itemId?: number };

// Where an event is filed, and which kind of turn produced it.
type EventPlacement = { threadId?: number | null; itemId?: number | null; origin?: TurnOrigin["kind"] | null };

type EventRow = {
  id: number; kind: string; text: string; created_at: number;
  thread_id: number | null; item_id: number | null; origin: string | null;
};
const EVENT_COLUMNS = "id, kind, text, created_at, thread_id, item_id, origin";

type TaskRow = {
  id: number; workspace: string | null; member: string; brief: string; status: string;
  budget: number; spent: number; item_id: number | null;
};

// Work the Manager set for later; at run_at the server wakes the Manager with its instructions.
type ScheduleRow = {
  id: number; workspace: string; title: string; instructions: string; run_at: number; status: string; created_at: number;
};

type ItemStatus = "working" | "needs_input" | "done" | "failed" | "stopped";
const ITEM_STATUSES_FOR_MANAGER: ItemStatus[] = ["working", "needs_input", "done", "failed"];

type ItemRow = {
  id: number; workspace: string; title: string; member: string; status: ItemStatus;
  summary: string; questions: string; report: string; archived: number; created_at: number; updated_at: number;
};

// A tool call waiting for the user's Allow / Deny in the UI.
type PermissionRequest = {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  rule: string;
  // Claude in Chrome actions are approved per site, by the CLI's own rules
  // such as ClaudeInChromeDomain(localhost), not by the allow list.
  browser: boolean;
  grantRules: string[];
  toolUseId: string | null;
  createdAt: number;
};

type Attachment = { name: string; kind: "image" | "pdf" | "text"; mediaType: string; data: string };

type MemberRuntime = {
  config: MemberConfig;
  team: Team;
  sessionId: string | null;
  process: Subprocess<"pipe", "pipe", "pipe"> | null;
  origins: TurnOrigin[];
  // Stdin lines for the turns queued behind origins[0], written one at a time as each turn ends.
  // Writing them at once lets the CLI fold several into one turn with one result, which would
  // shift origins and file replies in the wrong thread or task summary item.
  queuedInputs: string[];
  status: "asleep" | "starting" | "idle" | "working" | "compacting";
  contextTokens: number;
  contextWindow: number;
  taskSpent: number;
  warnedTaskId: number | null;
  totalSpent: number;
  lastActiveAt: number;
  // Last line the member's process wrote; unlike lastActiveAt, messages sent to it do not count.
  lastOutputAt: number;
  // When the turn at the front of origins started.
  turnStartedAt: number;
  watch: WatchState;
  // The Manager interrupted the current turn; its result does not end the task.
  interrupting: boolean;
  pendingDelta: string;
  deltaTimer: Timer | null;
  stderrTail: string;
  restartPending: boolean;
  permissionRequests: PermissionRequest[];
  // Tool calls you denied in the UI; their denial needs no "add a rule" hint.
  deniedByUser: Set<string>;
  // Chrome tabs opened minus tabs closed since the context was last cleared.
  openTabs: number;
  // How the running process is billed: your Claude plan, or the Anthropic API key from Settings.
  billing: "plan" | "api";
  // A rate_limit_event rejected the current turn: the plan limit is reached.
  planLimitHit: boolean;
};

// One set of member processes per workspace, so switching workspaces in the UI
// never interrupts the members working elsewhere.
type Team = {
  workspace: string;
  mcpToken: string;
  // Project settings: instructions and allow rules for every member in this workspace.
  // "Always allow" saves its rule here, for every member.
  instructions: string;
  allowedTools: string[];
  runtimes: Map<string, MemberRuntime>;
  manager: MemberRuntime;
};

const DEFAULT_BUDGET = 150_000;
const DELTA_FLUSH_MS = 150;
const WATCHDOG_INTERVAL_MS = 30_000;
// Workers compact themselves when an idle turn ends with context at or above this share of the window.
const WORKER_AUTO_COMPACT_RATIO = 0.8;
const HISTORY_LIMIT = 300;
const RECENT_WORKSPACE_LIMIT = 8;
const ATTACHMENT_LIMIT = 10;
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 1_000_000;
const MAX_SOCKET_PAYLOAD_BYTES = 32 * 1024 * 1024;
const CANDIDATE_WORKSPACE_LIMIT = 40;

const rootDirectory = realpathSync(import.meta.dir);
const teamFilePath = join(rootDirectory, "team.json");
const teamConfig: TeamConfig = await Bun.file(teamFilePath).json();
const port = Number(process.env.VDEV_PORT) || teamConfig.port || 4321;
const idleMilliseconds = (teamConfig.idleMinutes ?? 10) * 60_000;
const watchdogConfig = teamConfig.watchdog ?? {};
const approvalAlertMilliseconds = (watchdogConfig.approvalMinutes ?? 2) * 60_000;
const silentAlertMilliseconds = (watchdogConfig.silentMinutes ?? 5) * 60_000;
const checkInMilliseconds = (watchdogConfig.checkInMinutes ?? 15) * 60_000;
const reviewApprovals = watchdogConfig.reviewApprovals ?? true;

function expandPath(path: string, baseDirectory = rootDirectory): string {
  return resolve(baseDirectory, path.trim().replace(/^~(?=\/|$)/, homedir()));
}

// Returns the canonical path, or throws with a message suitable for the UI.
// A relative path is taken from the home folder, e.g. "Documents/my-app".
// vdev's own directory (and anything inside or above it) is refused so members
// can never edit team.json or server.ts and widen their own permissions.
function validateWorkspace(path: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(expandPath(path, homedir()));
  } catch {
    throw new Error(`Folder not found: ${path}`);
  }
  if (!statSync(canonicalPath).isDirectory()) throw new Error(`Not a folder: ${path}`);
  const insideVdev = canonicalPath === rootDirectory || canonicalPath.startsWith(rootDirectory + sep);
  const containsVdev = rootDirectory.startsWith(canonicalPath + sep);
  if (insideVdev || containsVdev) throw new Error("A workspace cannot be vdev itself, inside it, or a folder that contains it.");
  return canonicalPath;
}

const MANAGER_NAME = "manager";
teamConfig.manager ??= {};
teamConfig.worker ??= {};
teamConfig.workers ??= [];

function isManagerConfig(memberConfig: MemberConfig): boolean {
  return memberConfig.name === MANAGER_NAME;
}

function memberConfigFor(name: string): MemberConfig {
  return { ...(name === MANAGER_NAME ? teamConfig.manager : teamConfig.worker), name };
}

function memberNames(): string[] {
  return [MANAGER_NAME, ...teamConfig.workers];
}

// ---------------------------------------------------------------- storage

const database = new Database(process.env.VDEV_DATABASE ?? join(rootDirectory, "vdev.sqlite"), { create: true });
database.exec("PRAGMA journal_mode = WAL;");
database.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS member_sessions (
    name TEXT NOT NULL, workspace TEXT NOT NULL, session_id TEXT, PRIMARY KEY (name, workspace));
  CREATE TABLE IF NOT EXISTS project_settings (
    workspace TEXT PRIMARY KEY, instructions TEXT NOT NULL, allowed_tools TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, kind TEXT NOT NULL,
    text TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS events_member_id ON events (member, id);
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, brief TEXT NOT NULL,
    status TEXT NOT NULL, budget INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0,
    result TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL, created_at INTEGER NOT NULL);
  -- A line on the user's task summary. Its id is the id of the task that started it;
  -- follow-up tasks for the same work point at it through tasks.item_id.
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL, member TEXT NOT NULL,
    status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', questions TEXT NOT NULL DEFAULT '[]',
    archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS items_workspace_id ON items (workspace, archived, id);
  -- status: pending, fired or cancelled.
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL,
    run_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS schedules_status_run_at ON schedules (status, run_at);
`);

function ensureColumn(table: string, column: string, definition: string) {
  const columns = database.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!columns.some((existing) => existing.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn("events", "workspace", "TEXT");
ensureColumn("tasks", "workspace", "TEXT");
mergeMemberPermissions();
database.exec("CREATE INDEX IF NOT EXISTS events_workspace_member_id ON events (workspace, member, id)");
// Thread replies point at their root event; NULL means the main conversation.
ensureColumn("events", "thread_id", "INTEGER");
// The task summary line an event belongs to (Manager only), and the kind of turn that produced it.
ensureColumn("events", "item_id", "INTEGER");
ensureColumn("events", "origin", "TEXT");
ensureColumn("tasks", "item_id", "INTEGER");
// The item's full report as JSON: problem, fix, commit, specs, ui_verification, notes.
ensureColumn("items", "report", "TEXT NOT NULL DEFAULT '{}'");
database.exec("CREATE INDEX IF NOT EXISTS events_workspace_item_id ON events (workspace, item_id, id)");

const queries = {
  readSetting: database.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?"),
  writeSetting: database.query("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2"),
  sessionFor: database.query<{ session_id: string | null }, [string, string]>(
    "SELECT session_id FROM member_sessions WHERE name = ? AND workspace = ?"),
  saveSession: database.query(
    "INSERT INTO member_sessions (name, workspace, session_id) VALUES (?1, ?2, ?3) " +
    "ON CONFLICT(name, workspace) DO UPDATE SET session_id = ?3"),
  insertEvent: database.query<{ id: number }, [string, string, string, string, number, number | null, number | null, string | null]>(
    "INSERT INTO events (workspace, member, kind, text, created_at, thread_id, item_id, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"),
  recentEvents: database.query<EventRow, [string, string, number]>(
    `SELECT * FROM (SELECT ${EVENT_COLUMNS} FROM events WHERE workspace = ? AND member = ? ` +
    "ORDER BY id DESC LIMIT ?) ORDER BY id"),
  itemEvents: database.query<EventRow, [string, number, number]>(
    `SELECT * FROM (SELECT ${EVENT_COLUMNS} FROM events WHERE workspace = ? AND item_id = ? ` +
    "ORDER BY id DESC LIMIT ?) ORDER BY id"),
  threadRoot: database.query<{ id: number; text: string }, [number, string, string]>(
    "SELECT id, text FROM events WHERE id = ? AND workspace = ? AND member = ? AND kind = 'assistant' " +
    "AND thread_id IS NULL AND item_id IS NULL"),
  insertTask: database.query<{ id: number }, [string, string, string, number, number, number | null]>(
    "INSERT INTO tasks (workspace, member, brief, status, budget, created_at, item_id) VALUES (?, ?, ?, 'running', ?, ?, ?) RETURNING id"),
  assignTaskItem: database.query("UPDATE tasks SET item_id = ? WHERE id = ?"),
  findTask: database.query<TaskRow, [number]>(
    "SELECT id, workspace, member, brief, status, budget, spent, item_id FROM tasks WHERE id = ?"),
  finishTask: database.query("UPDATE tasks SET status = ?, spent = ?, result = ? WHERE id = ? AND status = 'running'"),
  runningTaskCount: database.query<{ count: number }, [number]>(
    "SELECT COUNT(*) AS count FROM tasks WHERE item_id = ? AND status = 'running'"),
  insertItem: database.query(
    "INSERT INTO items (id, workspace, title, member, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'working', ?5, ?5)"),
  findItem: database.query<ItemRow, [number, string]>("SELECT * FROM items WHERE id = ? AND workspace = ?"),
  visibleItems: database.query<ItemRow, [string, number]>(
    "SELECT * FROM (SELECT * FROM items WHERE workspace = ? AND archived = 0 ORDER BY id DESC LIMIT ?) ORDER BY id"),
  saveItem: database.query(
    "UPDATE items SET member = ?, status = ?, summary = ?, questions = ?, report = ?, archived = ?, updated_at = ? WHERE id = ?"),
  archiveDoneItems: database.query("UPDATE items SET archived = 1 WHERE workspace = ? AND status = 'done'"),
  archiveAllItems: database.query("UPDATE items SET archived = 1 WHERE workspace = ?"),
  archiveItem: database.query("UPDATE items SET archived = 1 WHERE id = ? AND workspace = ?"),
  insertSchedule: database.query<{ id: number }, [string, string, string, number, number]>(
    "INSERT INTO schedules (workspace, title, instructions, run_at, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id"),
  pendingSchedules: database.query<ScheduleRow, [string, number]>(
    "SELECT * FROM schedules WHERE workspace = ? AND status = 'pending' ORDER BY run_at, id LIMIT ?"),
  dueSchedules: database.query<ScheduleRow, [number, number]>(
    "SELECT * FROM schedules WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT ?"),
  // Returns the row only if it was still pending, so a schedule fires or is cancelled once.
  settleSchedule: database.query<ScheduleRow, [string, number, string]>(
    "UPDATE schedules SET status = ? WHERE id = ? AND workspace = ? AND status = 'pending' RETURNING *"),
  insertUsage: database.query(
    "INSERT INTO usage (member, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
  deleteSessions: database.query("DELETE FROM member_sessions WHERE name = ?"),
  projectSettingsFor: database.query<{ instructions: string; allowed_tools: string }, [string]>(
    "SELECT instructions, allowed_tools FROM project_settings WHERE workspace = ?"),
  saveProjectSettings: database.query(
    "INSERT INTO project_settings (workspace, instructions, allowed_tools) VALUES (?1, ?2, ?3) " +
    "ON CONFLICT(workspace) DO UPDATE SET instructions = ?2, allowed_tools = ?3"),
  totalSpent: database.query<{ total: number | null }, [string]>(
    "SELECT SUM(input_tokens + output_tokens + cache_write_tokens) AS total FROM usage WHERE member = ?"),
};

// Per-member rules from older versions become project rules for every member,
// so nothing approved earlier has to be approved again.
function mergeMemberPermissions() {
  const tableExists = database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'member_permissions'").get();
  if (!tableExists) return;
  const memberRows = database.query<{ workspace: string; allowed_tools: string }, []>(
    "SELECT workspace, allowed_tools FROM member_permissions").all();
  const rulesByWorkspace = new Map<string, Set<string>>();
  for (const memberRow of memberRows) {
    const rules = rulesByWorkspace.get(memberRow.workspace) ?? new Set<string>();
    for (const rule of parseRules(memberRow.allowed_tools)) rules.add(rule);
    rulesByWorkspace.set(memberRow.workspace, rules);
  }
  database.transaction(() => {
    for (const [workspace, memberRules] of rulesByWorkspace) {
      if (memberRules.size === 0) continue;
      const projectRow = database.query<{ instructions: string; allowed_tools: string }, [string]>(
        "SELECT instructions, allowed_tools FROM project_settings WHERE workspace = ?").get(workspace);
      const allowedTools = [...new Set([...parseRules(projectRow?.allowed_tools), ...memberRules])];
      database.query(
        "INSERT INTO project_settings (workspace, instructions, allowed_tools) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(workspace) DO UPDATE SET allowed_tools = ?3",
      ).run(workspace, projectRow?.instructions ?? "", JSON.stringify(allowedTools));
    }
    database.exec("DROP TABLE member_permissions");
  })();
}

// Tasks left running by a previous server process can never finish.
database.exec("UPDATE tasks SET status = 'stopped' WHERE status = 'running'");
database.exec("UPDATE items SET status = 'stopped' WHERE status = 'working'");

// ---------------------------------------------------------------- workspace

function initialWorkspace(): string | null {
  for (const candidate of [queries.readSetting.get("workspace")?.value, teamConfig.projectDir]) {
    if (!candidate) continue;
    try {
      return validateWorkspace(candidate);
    } catch (error) {
      console.warn(`Ignoring workspace ${candidate}: ${(error as Error).message}`);
    }
  }
  return null;
}

let projectDirectory: string | null = initialWorkspace();

function recentWorkspaces(): string[] {
  try {
    return JSON.parse(queries.readSetting.get("recent_workspaces")?.value ?? "[]");
  } catch {
    return [];
  }
}

// Git repositories one level below each workspace root, e.g. ~/code/*.
// Roots that do not exist on this machine are skipped.
function candidateWorkspaces(): string[] {
  const candidates: string[] = [];
  for (const workspaceRoot of teamConfig.workspaceRoots ?? ["~/code", "~/Projects", "~/Developer", "~/Documents"]) {
    let entries: string[];
    try {
      entries = readdirSync(expandPath(workspaceRoot));
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith(".")) continue;
      const path = join(expandPath(workspaceRoot), entry);
      try {
        statSync(join(path, ".git"));
        candidates.push(validateWorkspace(path));
      } catch {
        // not a git repository, or not allowed as a workspace
      }
      if (candidates.length >= CANDIDATE_WORKSPACE_LIMIT) return candidates;
    }
  }
  return candidates;
}

function saveSessionId(runtime: MemberRuntime, sessionId: string | null) {
  queries.saveSession.run(runtime.config.name, runtime.team.workspace, sessionId);
}

// ---------------------------------------------------------------- runtime state

const teams = new Map<string, Team>();
const teamsByMcpToken = new Map<string, Team>();

// Teams are created lazily; `workspace` must already be validated.
function teamFor(workspace: string): Team {
  const existingTeam = teams.get(workspace);
  if (existingTeam) return existingTeam;

  const projectSettings = queries.projectSettingsFor.get(workspace);
  const team = {
    workspace,
    mcpToken: crypto.randomUUID(),
    runtimes: new Map(),
    instructions: projectSettings?.instructions ?? "",
    allowedTools: parseRules(projectSettings?.allowed_tools),
  } as Team;
  for (const name of memberNames()) addRuntime(team, memberConfigFor(name));
  team.manager = team.runtimes.get(MANAGER_NAME)!;
  teams.set(workspace, team);
  teamsByMcpToken.set(team.mcpToken, team);
  return team;
}

function addRuntime(team: Team, memberConfig: MemberConfig) {
  team.runtimes.set(memberConfig.name, {
    config: memberConfig,
    team,
    sessionId: queries.sessionFor.get(memberConfig.name, team.workspace)?.session_id ?? null,
    process: null,
    origins: [],
    status: "asleep",
    contextTokens: 0,
    contextWindow: 0,
    taskSpent: 0,
    warnedTaskId: null,
    totalSpent: queries.totalSpent.get(memberConfig.name)?.total ?? 0,
    lastActiveAt: Date.now(),
    lastOutputAt: Date.now(),
    turnStartedAt: Date.now(),
    watch: newWatchState(),
    interrupting: false,
    queuedInputs: [],
    pendingDelta: "",
    deltaTimer: null,
    stderrTail: "",
    restartPending: false,
    permissionRequests: [],
    deniedByUser: new Set(),
    openTabs: 0,
    billing: "plan",
    planLimitHit: false,
  });
}

function usesChrome(runtime: MemberRuntime): boolean {
  return Boolean(runtime.config.chrome);
}

function parseRules(json: string | undefined): string[] {
  try {
    return JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
}

function isManager(runtime: MemberRuntime): boolean {
  return isManagerConfig(runtime.config);
}

function allRuntimes(): MemberRuntime[] {
  return [...teams.values()].flatMap((team) => [...team.runtimes.values()]);
}

let rateLimit: Record<string, unknown> | null = null;
let broadcast: (message: unknown) => void = () => {};

// ---------------------------------------------------------------- API usage (plan limit fallback)

// With an Anthropic API key saved, the API mode picks when members use it:
// "off" never, "always" for every process, or "fallback" like Claude's usage credits: members
// that hit your plan limit restart on the API key until the limit resets, then go back to the plan.
// The key lives only in the local database and is never sent to the browser.
type ApiMode = "off" | "fallback" | "always";
const API_MODES: ApiMode[] = ["off", "fallback", "always"];
const API_KEY_SETTING = "anthropic_api_key";
const API_MODE_SETTING = "api_mode";
// Before the three-way mode there was only an on/off fallback switch.
const LEGACY_API_FALLBACK_SETTING = "api_fallback";
const API_FALLBACK_UNTIL_SETTING = "api_fallback_until";
// Used when the limit event carries no reset time.
const API_FALLBACK_DEFAULT_MS = 60 * 60 * 1000;
const PLAN_LIMIT_PATTERN = /usage limit|hit your limit|limit reached/i;
const PLAN_LIMIT_CONTINUE_TEXT =
  "Your previous turn was cut off by a plan usage limit before you could finish. Continue it now from where you left off.";

let apiFallbackTimer: Timer | null = null;

function apiKey(): string {
  return queries.readSetting.get(API_KEY_SETTING)?.value ?? "";
}

function apiMode(): ApiMode {
  const savedMode = queries.readSetting.get(API_MODE_SETTING)?.value;
  if (API_MODES.includes(savedMode as ApiMode)) return savedMode as ApiMode;
  return queries.readSetting.get(LEGACY_API_FALLBACK_SETTING)?.value === "true" ? "fallback" : "off";
}

function apiFallbackUntil(): number {
  return Number(queries.readSetting.get(API_FALLBACK_UNTIL_SETTING)?.value ?? 0);
}

function apiFallbackAvailable(): boolean {
  return apiMode() === "fallback" && apiKey() !== "";
}

// New processes launch on the API key while this is true.
function apiFallbackActive(): boolean {
  return apiFallbackAvailable() && Date.now() < apiFallbackUntil();
}

function usesApiKey(): boolean {
  if (apiKey() === "") return false;
  return apiMode() === "always" || apiFallbackActive();
}

function apiSettings() {
  const key = apiKey();
  return {
    apiKeyHint: key ? `...${key.slice(-4)}` : null,
    apiMode: apiMode(),
    apiFallbackUntil: apiFallbackActive() ? apiFallbackUntil() : null,
  };
}

function broadcastApiSettings() {
  broadcast({ type: "apiSettings", ...apiSettings() });
}

function activateApiFallback() {
  const resetsAt = Number(rateLimit?.resetsAt ?? 0) * 1000;
  const until = resetsAt > Date.now() ? resetsAt : Date.now() + API_FALLBACK_DEFAULT_MS;
  queries.writeSetting.run(API_FALLBACK_UNTIL_SETTING, String(until));
  scheduleApiFallbackEnd();
  broadcastApiSettings();
}

// When the plan limit resets, members on the API key restart on the plan (busy ones after their work).
function scheduleApiFallbackEnd() {
  if (apiFallbackTimer) clearTimeout(apiFallbackTimer);
  apiFallbackTimer = null;
  if (!apiFallbackActive()) return;
  apiFallbackTimer = setTimeout(endApiFallback, apiFallbackUntil() - Date.now());
}

function endApiFallback() {
  apiFallbackTimer = null;
  queries.writeSetting.run(API_FALLBACK_UNTIL_SETTING, "0");
  restartMembersOnWrongBilling();
  broadcastApiSettings();
}

function restartMembersOnWrongBilling() {
  const billing = usesApiKey() ? "api" : "plan";
  for (const runtime of allRuntimes()) {
    if (!runtime.process || runtime.billing === billing) continue;
    requestRestart(runtime);
    recordEvent(runtime, "system", billing === "api" ? "Switching to your Anthropic API key." : "Switching back to your Claude plan.");
    broadcastMember(runtime);
  }
}

function processEnvironment(): Record<string, string | undefined> {
  if (!usesApiKey()) return process.env;
  return { ...process.env, ANTHROPIC_API_KEY: apiKey() };
}

// Throws with a message suitable for the UI. An empty key keeps the saved one.
function saveApiSettings(message: any) {
  const key = String(message.apiKey ?? "").trim();
  const mode = String(message.apiMode ?? "off") as ApiMode;
  if (!API_MODES.includes(mode)) throw new Error("Unknown API usage setting.");
  if (key && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error("That does not look like an Anthropic API key (sk-ant-...).");
  const keyAfterSave = message.clearApiKey ? "" : key || apiKey();
  if (mode !== "off" && keyAfterSave === "") throw new Error("Add an Anthropic API key to use the API.");
  if (message.clearApiKey) queries.writeSetting.run(API_KEY_SETTING, "");
  else if (key) queries.writeSetting.run(API_KEY_SETTING, key);
  queries.writeSetting.run(API_MODE_SETTING, mode);
  scheduleApiFallbackEnd();
  restartMembersOnWrongBilling();
  broadcastApiSettings();
}

// The turn hit the plan limit: rerun it on the API key in a fresh process that resumes the session.
// Returns false when there is no fallback, so the turn ends as a normal error.
function retryOnApiKey(runtime: MemberRuntime, data: any): boolean {
  const limitHit = runtime.planLimitHit || (data.is_error && PLAN_LIMIT_PATTERN.test(String(data.result ?? "")));
  runtime.planLimitHit = false;
  if (!limitHit || runtime.billing === "api" || runtime.interrupting || runtime.origins.length === 0) return false;
  if (!apiFallbackAvailable()) return false;
  if (!apiFallbackActive()) activateApiFallback();

  flushDelta(runtime);
  recordEvent(runtime, "system", "Plan limit reached; continuing on your Anthropic API key until it resets.");
  const child = runtime.process;
  runtime.process = null;
  runtime.permissionRequests = [];
  child?.kill();
  // The turn stays at the front of origins; its result now comes from the new process.
  const resume = () => {
    const nextChild = ensureProcess(runtime);
    nextChild.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: PLAN_LIMIT_CONTINUE_TEXT } }) + "\n");
    nextChild.stdin.flush();
    runtime.status = "working";
    broadcastMember(runtime);
  };
  if (child) child.exited.then(resume);
  else resume();
  restartMembersOnWrongBilling();
  return true;
}

// A fallback still running from before vdev restarted ends on time.
scheduleApiFallbackEnd();

function currentTask(runtime: MemberRuntime) {
  const origin = runtime.origins[0];
  if (origin?.kind !== "task" || origin.taskId === undefined) return null;
  return queries.findTask.get(origin.taskId);
}

function publicMember(runtime: MemberRuntime) {
  const task = currentTask(runtime);
  return {
    name: runtime.config.name,
    role: isManager(runtime) ? "manager" : "worker",
    model: runtime.config.model ?? "default model",
    chrome: usesChrome(runtime),
    billing: runtime.process ? runtime.billing : null,
    isManager: isManager(runtime),
    status: runtime.status,
    queued: Math.max(runtime.origins.filter((origin) => origin.kind !== "command").length - 1, 0),
    contextTokens: runtime.contextTokens,
    contextWindow: runtime.contextWindow,
    totalSpent: runtime.totalSpent,
    permissionRequests: runtime.permissionRequests,
    task: task ? { id: task.id, brief: task.brief.slice(0, 140), budget: task.budget, spent: runtime.taskSpent } : null,
  };
}

// Workspaces with at least one live member process, for the sidebar's "Active" list.
function activeWorkspaces() {
  return [...teams.values()]
    .filter((team) => [...team.runtimes.values()].some((runtime) => runtime.process))
    .map((team) => {
      const teamRuntimes = [...team.runtimes.values()];
      return {
        path: team.workspace,
        name: basename(team.workspace),
        working: teamRuntimes.filter((runtime) => runtime.status === "working" || runtime.status === "compacting").length,
        running: teamRuntimes.filter((runtime) => runtime.process).length,
        waiting: teamRuntimes.filter((runtime) => runtime.permissionRequests.length > 0).length,
      };
    });
}

function broadcastMember(runtime: MemberRuntime) {
  broadcast({ type: "member", workspace: runtime.team.workspace, member: publicMember(runtime) });
  broadcast({ type: "workspaces", activeWorkspaces: activeWorkspaces() });
}

function recordEvent(runtime: MemberRuntime, kind: string, text: string, placement: EventPlacement = {}) {
  const createdAt = Date.now();
  const threadId = placement.threadId ?? null;
  const itemId = placement.itemId ?? null;
  const origin = placement.origin ?? null;
  const row = queries.insertEvent.get(runtime.team.workspace, runtime.config.name, kind, text, createdAt, threadId, itemId, origin)!;
  broadcast({
    type: "event", workspace: runtime.team.workspace, member: runtime.config.name,
    event: { id: row.id, kind, text, created_at: createdAt, thread_id: threadId, item_id: itemId, origin },
  });
}

function placementFor(origin: TurnOrigin | undefined): EventPlacement {
  return { threadId: origin?.threadId ?? null, itemId: origin?.itemId ?? null, origin: origin?.kind ?? null };
}

// Where the member's current turn files its output: a thread it answers, a task summary item, or the main chat.
function currentPlacement(runtime: MemberRuntime): EventPlacement {
  return placementFor(runtime.origins[0]);
}

// ---------------------------------------------------------------- processes

function systemPromptFor(runtime: MemberRuntime): string {
  const instructions = runtime.team.instructions.trim();
  const projectRules = instructions ? `\n\nProject rules for this workspace (set by the user; follow them):\n${instructions}` : "";
  return rolePromptFor(runtime.config, usesChrome(runtime)) + workspaceSkillsNote(runtime) + THREAD_NOTE + projectRules;
}

// Skills and commands Claude Code loads for this workspace (project, then user level).
// Read when the member process starts; members pick up new skills on their next restart.
function workspaceSkillNames(workspace: string): string[] {
  const names = new Set<string>();
  for (const claudeDirectory of [join(workspace, ".claude"), join(homedir(), ".claude")]) {
    const skillsDirectory = join(claudeDirectory, "skills");
    if (existsSync(skillsDirectory)) {
      for (const entry of readdirSync(skillsDirectory)) {
        if (existsSync(join(skillsDirectory, entry, "SKILL.md"))) names.add(entry);
      }
    }
    const commandsDirectory = join(claudeDirectory, "commands");
    if (existsSync(commandsDirectory)) {
      for (const entry of readdirSync(commandsDirectory)) {
        if (entry.endsWith(".md")) names.add(entry.slice(0, -".md".length));
      }
    }
  }
  return [...names].sort();
}

function workspaceSkillsNote(runtime: MemberRuntime): string {
  const skillNames = workspaceSkillNames(runtime.team.workspace);
  const skillList = skillNames.length > 0 ? skillNames.map((name) => `/${name}`).join(", ") : "(none)";
  if (isManagerConfig(runtime.config)) {
    return `\n\nA message that starts with /<name> is a slash command (a Claude Code skill), not something to search the code for. ` +
      `Skills installed in this workspace: ${skillList}. You cannot run skills yourself: delegate the whole message verbatim, ` +
      "starting with the /<name>, to the most suitable member, and say in the brief that it is a skill to run with the Skill tool. " +
      "If the name is not in the list, tell the user it is not installed in this workspace instead of searching for it.";
  }
  return `\n\nSkills installed in this workspace: ${skillList}. When a message or brief asks you to run /<name>, ` +
    "invoke that skill with the Skill tool and follow its instructions; do not search the code for the name.";
}

const THREAD_NOTE = "\n\nThe user may answer one of your earlier messages in a thread; such messages start with " +
  "[Thread reply to your message: \"...\"] quoting what they answer. Users often answer several questions one thread reply " +
  "at a time, and the next answer is usually already being typed. If a reply answers only some of your open questions, " +
  "your whole reply is one short acknowledgement such as \"Noted: PostgreSQL.\" Do not ask, repeat or mention the remaining " +
  "questions, and do not start the work, until they are all answered or the user says to go ahead.";
const THREAD_QUOTE_CHARACTERS = 800;

const TASK_SUMMARY_NOTE = "The user follows the team's work on a task summary: one numbered item per delegated task, in the order " +
  "requested, each with its status, a one-line summary and its open questions. Give every delegate_task a short title (the " +
  "ticket key or a few words). More work on an existing item (a fix, a follow-up after the user answers) goes through " +
  "delegate_task with follows_up set to one of its task numbers, so it stays on the same line.\n" +
  "The user does not see handoffs, worker messages, watchdog notices, or anything you write while handling them. " +
  "Report to the user only with update_item: a one-line summary when an item is done or failed, or status needs_input with " +
  "one short question per decision the user must make. This replaces reporting back or asking questions in chat. " +
  "When an item is done or failed, also fill its report from the handoff: problem, fix, commit, specs and ui_verification. " +
  "Say plainly when something was not done (specs 'not run', commit 'not committed') rather than leaving it out; " +
  "if the handoff lacks a fact, ask the worker with message_member before reporting. " +
  "Your plain replies are shown only when you answer the user's own messages in the main chat; keep those to a line or two " +
  "and never repeat item summaries there.\n" +
  "The user answers an item in its thread; those messages start with [Thread reply about item #N ...] quoting its open " +
  "questions as q1, q2, .... Act on the answer (message_member, or delegate_task with follows_up), and once the item's " +
  "questions are settled, call update_item with the remaining questions (or questions: []) and the new status.";

// Workers get only what the team needs on top of Claude Code's own prompt, so they
// know exactly what a plain `claude` in the workspace knows.
function rolePromptFor(memberConfig: MemberConfig, chrome: boolean): string {
  const ownPrompt = memberConfig.prompt?.trim() ? `${memberConfig.prompt.trim()}\n\n` : "";
  if (isManagerConfig(memberConfig)) {
    return `${ownPrompt}Your workers (use these names with delegate_task): ${teamConfig.workers.join(", ") || "(none yet)"}.\n` +
      "Every worker is the same general-purpose Claude Code engineer with the same tools and settings, so pick any idle " +
      "worker and spread independent tasks across several of them. " +
      "The user can add workers while you run; team_status always shows the current team, so check it before saying a worker does not exist.\n\n" +
      "Each task starts the member from a clean context, so every brief must be self-contained " +
      "(goal, relevant files, acceptance criteria, what earlier tasks found). " +
      "Handoffs arrive as messages starting with [Handoff from <member>, task #N]. " +
      "Members can message you at any time ([Message from <member>]); answer with message_member when they need something, " +
      "and do not reply to plain acknowledgements. " +
      "Messages starting with [Task #N ...] are status notices from the system.\n\n" +
      "You supervise running work actively; you are never limited to waiting for handoffs. " +
      "The server watches every running task and wakes you with a [Watchdog] notice when a worker is blocked on the user's approval, " +
      "has gone silent, or has worked a long time without a handoff. On a notice, or whenever the user asks how things are going, " +
      "check team_status and member_activity, then act: tell the user about approvals only they can give, " +
      "use interrupt_member to unstick or redirect a worker right away (message_member only arrives after its current turn), " +
      "or stop_member and reassign the work. If the worker is making progress, leave it alone and say nothing to the user.\n\n" +
      "When a worker asks the user to approve a tool call, you get an [Approval request <id> from <member>] notice with the call " +
      "and the rules that run without asking. Check whether the same result is reachable without approval; if so, call " +
      "redirect_approval with the exact route. If not, do nothing and do not tell the user yet: the request stays in their UI, " +
      "and a [Watchdog] notice follows if it waits long. Never send a route that does less than the worker needs.\n\n" +
      "When the user wants work done later (\"tomorrow at 9\", \"in 2 hours\", \"after the deploy window\"), use schedule_work " +
      "instead of delegating now; check list_scheduled for the current time first if you need it. A [Scheduled work #N] message " +
      "arrives when it is due; delegate it then. Use cancel_scheduled when the user calls it off. The user sees scheduled work " +
      "in their task summary, so do not repeat it in chat beyond a one-line confirmation.\n\n" +
      "You keep the team's long-term memory for this workspace with save_memory, the same memory Claude Code loads in every " +
      "session here (the user's own sessions too). Save what a future session could not work out from the code or git history: " +
      "gotchas and root causes from handoffs (their Learnings line), corrections and preferences the user states, how to run " +
      "or verify things here, and project context such as deadlines or decisions. One fact per memory. Call list_memories " +
      "first and update an existing memory (same name) rather than adding a duplicate; delete_memory one that proved wrong. " +
      "Do not save what only matters to the current task. Workers may not have the newest memories loaded, so put the ones " +
      "relevant to a task in its brief.\n\n" +
      TASK_SUMMARY_NOTE;
  }
  const chromeNote = chrome
    ? "\n\nOther members may use Claude in Chrome at the same time: " +
      "always open your own tab with tabs_create_mcp and never act in tabs you did not create. " +
      "Before your handoff, close every tab you opened with tabs_close_mcp."
    : "";
  return `${ownPrompt}You are "${memberConfig.name}", a worker on a team led by a Manager.${chromeNote}\n\n` +
    "Messages starting with [Task #N from Manager] are assignments. Finish each assignment with a short handoff with these lines: " +
    "Problem (what was wrong and the root cause), Fix (what changed, main files), Commit (SHA and branch, or 'not committed'), " +
    "Specs (command and result, or 'not run' and why), UI verification (what you checked in the browser and the result, " +
    "or 'not done' and why), Open issues, Learnings (gotchas or non-obvious facts about this codebase a future task " +
    "should know, or 'none'). Keep it under 20 lines; the Manager sees this final message automatically. " +
    "To reach the Manager at any other time (a question, a blocker, or when the user asks you to report), use the message_manager tool. " +
    "Messages starting with [Message from <manager>] come from the Manager; reply with message_manager if an answer is needed.";
}

function argumentsFor(runtime: MemberRuntime): string[] {
  const memberConfig = runtime.config;
  // Every member gets the team tools; the URL tells the server who is calling.
  const mcpUrl = `http://127.0.0.1:${port}/mcp/${runtime.team.mcpToken}/${encodeURIComponent(memberConfig.name)}`;
  const mcpConfig = { mcpServers: { team: { type: "http", url: mcpUrl } } };
  const commandArguments = [
    "claude", "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose", "--include-partial-messages",
    "--append-system-prompt", systemPromptFor(runtime),
    // The same settings, CLAUDE.md, skills, commands, hooks, plugins and MCP servers as your terminal;
    // the team server is added on top.
    "--setting-sources", "user,project,local",
    "--mcp-config", JSON.stringify(mcpConfig),
    "--permission-mode", memberConfig.permissionMode ?? "acceptEdits",
    // Tool calls that need approval arrive as control requests on stdout and
    // wait for the user's answer in the UI (see handlePermissionRequest).
    "--permission-prompt-tool", "stdio",
  ];
  // Unset model and effort follow your Claude Code defaults, like `claude` in a terminal.
  if (memberConfig.model) commandArguments.push("--model", memberConfig.model);
  if (memberConfig.effort) commandArguments.push("--effort", memberConfig.effort);
  if (memberConfig.tools) commandArguments.push("--tools", memberConfig.tools.join(","));
  // Enabling Chrome also allows its tools; the extension's own per-site permissions still apply.
  // Off leaves your own Claude in Chrome setting in charge.
  if (usesChrome(runtime)) commandArguments.push("--chrome");
  const allowedTools = [
    ...(memberConfig.allowedTools ?? []),
    ...runtime.team.allowedTools,
    "mcp__team",
    // Project skills ship helper scripts (e.g. .claude/skills/verify-rsu/scripts/*.sh); running them is part of the skill.
    ...skillScriptRules(runtime.team.workspace),
    ...(usesChrome(runtime) ? ["mcp__claude-in-chrome"] : []),
  ];
  allowedTools.push(...rtkRulesFor([...allowedTools, ...projectAllowRules(runtime.team.workspace)]));
  if (allowedTools.length > 0) commandArguments.push("--allowedTools", allowedTools.join(","));
  if (runtime.sessionId) {
    commandArguments.push("--resume", runtime.sessionId);
  } else {
    runtime.sessionId = crypto.randomUUID();
    saveSessionId(runtime, runtime.sessionId);
    commandArguments.push("--session-id", runtime.sessionId);
  }
  return commandArguments;
}

// The rtk PreToolUse hook (from your user settings) rewrites Bash commands before the
// permission check, e.g. "git diff" -> "rtk git diff", so allow rules must exist in both forms.
const rtkAvailable = Bun.which("rtk") !== null;
const RTK_REWRITE_MARKER = "__VDEV_ARGUMENTS__";
// rtk wrappers for commands Claude Code already treats as read-only (cat/head/tail -> rtk read).
// rtk find is left out: it passes -exec and -delete through.
const RTK_READ_ONLY_COMMANDS = ["rtk grep", "rtk rg", "rtk ls", "rtk read", "rtk tree"];
const rtkRewriteCache = new Map<string, string | null>();

function rtkRulesFor(rules: string[]): string[] {
  if (!rtkAvailable) return [];
  const rtkRules = new Set(RTK_READ_ONLY_COMMANDS.flatMap((command) => [`Bash(${command})`, `Bash(${command} *)`]));
  for (const rule of rules) {
    const rtkRule = rtkRuleFor(rule);
    if (rtkRule) rtkRules.add(rtkRule);
  }
  return [...rtkRules];
}

// "Bash(git diff *)" -> "Bash(rtk git diff *)", using rtk's own rewrite table; null when rtk leaves it alone.
function rtkRuleFor(rule: string): string | null {
  const match = rule.match(/^Bash\((.+?)( \*|:\*)?\)$/);
  if (!match || match[1].startsWith("rtk ")) return null;
  const [, prefix, wildcard] = match;
  if (!rtkRewriteCache.has(prefix)) {
    const result = Bun.spawnSync(["rtk", "hook", "check", `${prefix} ${RTK_REWRITE_MARKER}`]);
    const rewritten = result.stdout.toString().trim();
    const suffix = ` ${RTK_REWRITE_MARKER}`;
    const rewrittenPrefix = rewritten.startsWith("rtk ") && rewritten.endsWith(suffix) ? rewritten.slice(0, -suffix.length) : null;
    rtkRewriteCache.set(prefix, rewrittenPrefix);
  }
  const rewrittenPrefix = rtkRewriteCache.get(prefix);
  if (!rewrittenPrefix) return null;
  return wildcard ? `Bash(${rewrittenPrefix} *)` : `Bash(${rewrittenPrefix})`;
}

// Allow rules from the workspace's own Claude settings; the CLI applies them itself,
// vdev only reads them to add their rtk forms.
function projectAllowRules(workspace: string): string[] {
  return ["settings.json", "settings.local.json"].flatMap((fileName) => {
    try {
      const settings = JSON.parse(readFileSync(join(workspace, ".claude", fileName), "utf8"));
      const allowRules = settings?.permissions?.allow;
      return Array.isArray(allowRules) ? allowRules.filter((rule: unknown): rule is string => typeof rule === "string") : [];
    } catch {
      return [];
    }
  });
}

// Run directly or through python/ruby, by relative or absolute path.
function skillScriptRules(workspace: string): string[] {
  const skillDirectories = [".claude/skills", join(workspace, ".claude", "skills")];
  const runners = ["", "python ", "python3 ", "ruby "];
  return skillDirectories.flatMap((skillDirectory) => runners.map((runner) => `Bash(${runner}${skillDirectory}/*)`));
}

function ensureProcess(runtime: MemberRuntime): Subprocess<"pipe", "pipe", "pipe"> {
  if (runtime.process) return runtime.process;

  const child = Bun.spawn(argumentsFor(runtime), {
    cwd: runtime.team.workspace,
    env: processEnvironment(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  runtime.process = child;
  runtime.billing = usesApiKey() ? "api" : "plan";
  runtime.planLimitHit = false;
  runtime.restartPending = false;
  runtime.status = "starting";
  runtime.stderrTail = "";
  readLines(child.stdout, (line) => {
    if (runtime.process === child) handleLine(runtime, line);
  });
  readLines(child.stderr, (line) => {
    runtime.stderrTail = (runtime.stderrTail + line + "\n").slice(-2000);
  });
  child.exited.then((exitCode) => handleExit(runtime, child, exitCode));
  broadcastMember(runtime);
  return child;
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) onLine(line);
    }
  }
}

function handleExit(runtime: MemberRuntime, child: Subprocess, exitCode: number | null) {
  if (runtime.process !== child) return;
  runtime.process = null;
  flushDelta(runtime);

  const resumeFailed = /no conversation found/i.test(runtime.stderrTail);
  if (resumeFailed) {
    runtime.sessionId = null;
    saveSessionId(runtime, null);
    recordEvent(runtime, "error", "Previous session could not be resumed; the next message starts a new one.");
  } else if (exitCode !== 0 && exitCode !== null && runtime.origins.length > 0) {
    const detail = runtime.stderrTail.trim().split("\n").slice(-3).join("\n");
    recordEvent(runtime, "error", `Process exited with code ${exitCode}${detail ? `:\n${detail}` : ""}`);
  }

  abandonPendingTurns(runtime, "stopped");
  runtime.permissionRequests = [];
  runtime.openTabs = 0;
  runtime.status = "asleep";
  broadcastMember(runtime);
}

function abandonPendingTurns(runtime: MemberRuntime, status: "stopped" | "over_budget") {
  runtime.queuedInputs = [];
  for (const origin of runtime.origins.splice(0)) {
    if (origin.kind !== "task" || origin.taskId === undefined) continue;
    const task = queries.findTask.get(origin.taskId);
    if (!task || task.status !== "running") continue;
    queries.finishTask.run(status, runtime.taskSpent, null, task.id);
    settleItem(runtime.team, task.item_id, status === "stopped" ? "stopped" : "failed");
    notifyManager(runtime.team,
      `[Task #${task.id} for ${runtime.config.name} ${status.replace("_", " ")} after ${formatTokens(runtime.taskSpent)} tokens; no handoff was produced]`,
      task.item_id);
  }
  runtime.taskSpent = 0;
}

function stopMember(runtime: MemberRuntime, reason: "stopped" | "over_budget" = "stopped") {
  if (!runtime.process) return;
  const child = runtime.process;
  abandonPendingTurns(runtime, reason);
  recordEvent(runtime, "system", reason === "over_budget" ? "Stopped: task budget exhausted." : "Stopped.");
  child.kill();
}

// quote: for a thread reply, what is being answered; the member sees it above the text, the UI does not.
function sendTurn(runtime: MemberRuntime, text: string, origin: TurnOrigin, eventKind = "user", attachments: Attachment[] = [],
  quote: string | null = null) {
  const child = ensureProcess(runtime);
  if (origin.kind === "task" && !runtime.origins.some((pending) => pending.kind === "task")) runtime.taskSpent = 0;
  if (runtime.origins.length === 0) startTurn(runtime);
  runtime.origins.push(origin);
  if (runtime.status !== "compacting") runtime.status = "working";
  runtime.lastActiveAt = Date.now();
  // Only file names are stored; the file contents go to the member, not the database.
  const attachmentNote = attachments.length > 0 ? `\n\n[Attached: ${attachments.map((attachment) => attachment.name).join(", ")}]` : "";
  recordEvent(runtime, eventKind, text + attachmentNote, placementFor(origin));
  const memberText = quote ? `${quote}\n${text}` : text;
  const content = attachments.length > 0 ? [...attachments.map(contentBlockFor), { type: "text", text: memberText }] : memberText;
  writeTurnInput(runtime, child, JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  broadcastMember(runtime);
}

// Call after pushing the turn's origin: the line goes out now if it is the only turn, else when the turns ahead end.
function writeTurnInput(runtime: MemberRuntime, child: Subprocess<"pipe", "pipe", "pipe">, line: string) {
  if (runtime.origins.length > 1) {
    runtime.queuedInputs.push(line);
    return;
  }
  child.stdin.write(line);
  child.stdin.flush();
}

function writeNextQueuedInput(runtime: MemberRuntime) {
  const line = runtime.queuedInputs.shift();
  if (line === undefined || !runtime.process) return;
  runtime.process.stdin.write(line);
  runtime.process.stdin.flush();
}

function threadQuote(rootText: string): string {
  const quoted = rootText.length > THREAD_QUOTE_CHARACTERS ? `${rootText.slice(0, THREAD_QUOTE_CHARACTERS)}...` : rootText;
  return `[Thread reply to your message: "${quoted.trim()}"]`;
}

function contentBlockFor(attachment: Attachment) {
  if (attachment.kind === "image") {
    return { type: "image", source: { type: "base64", media_type: attachment.mediaType, data: attachment.data } };
  }
  if (attachment.kind === "pdf") {
    return { type: "document", title: attachment.name, source: { type: "base64", media_type: "application/pdf", data: attachment.data } };
  }
  return { type: "text", text: `<file name="${attachment.name.replace(/"/g, "'")}">\n${attachment.data}\n</file>` };
}

function base64Bytes(data: string): number {
  return Math.floor(data.length * 3 / 4);
}

// Throws with a message suitable for the UI.
function validateAttachments(rawAttachments: unknown): Attachment[] {
  if (rawAttachments === undefined || rawAttachments === null) return [];
  if (!Array.isArray(rawAttachments)) throw new Error("Invalid attachments.");
  if (rawAttachments.length > ATTACHMENT_LIMIT) throw new Error(`Attach at most ${ATTACHMENT_LIMIT} files per message.`);

  return rawAttachments.map((rawAttachment: any) => {
    const name = String(rawAttachment?.name ?? "file").slice(0, 200);
    const data = String(rawAttachment?.data ?? "");
    const mediaType = String(rawAttachment?.mediaType ?? "");
    switch (rawAttachment?.kind) {
      case "image":
        if (!IMAGE_MEDIA_TYPES.has(mediaType)) throw new Error(`${name}: only PNG, JPEG, GIF and WebP images are supported.`);
        if (base64Bytes(data) > MAX_IMAGE_BYTES) throw new Error(`${name}: images must be 5 MB or smaller.`);
        return { name, kind: "image", mediaType, data };
      case "pdf":
        if (base64Bytes(data) > MAX_PDF_BYTES) throw new Error(`${name}: PDFs must be 10 MB or smaller.`);
        return { name, kind: "pdf", mediaType: "application/pdf", data };
      case "text":
        if (data.length > MAX_TEXT_CHARACTERS) throw new Error(`${name}: text files must be under 1M characters.`);
        return { name, kind: "text", mediaType: "text/plain", data };
      default:
        throw new Error(`${name}: unsupported file type.`);
    }
  });
}

// Queues /clear like any other turn, so it runs after work already queued.
function clearContext(runtime: MemberRuntime, note: string) {
  const child = ensureProcess(runtime);
  if (runtime.origins.length === 0) startTurn(runtime);
  runtime.origins.push({ kind: "command" });
  if (runtime.status !== "compacting") runtime.status = "working";
  runtime.contextTokens = 0;
  // After /clear the member no longer knows which tabs were its own.
  runtime.openTabs = 0;
  recordEvent(runtime, "system", note);
  writeTurnInput(runtime, child, JSON.stringify({ type: "user", message: { role: "user", content: "/clear" } }) + "\n");
}

function newWatchState(): WatchState {
  return { approvalAlerts: new Set(), silentAlerts: 0, checkIns: 0 };
}

function startTurn(runtime: MemberRuntime) {
  runtime.turnStartedAt = Date.now();
  runtime.lastOutputAt = Date.now();
  runtime.watch = newWatchState();
}

// itemId files the notice, and the Manager's handling of it, under that task summary item.
function notifyManager(team: Team, text: string, itemId: number | null = null) {
  sendTurn(team.manager, text, itemId === null ? { kind: "handoff" } : { kind: "handoff", itemId }, "handoff");
}

// ---------------------------------------------------------------- task summary items

const MAX_ITEM_TITLE_CHARACTERS = 80;
const MAX_ITEM_SUMMARY_CHARACTERS = 500;
const MAX_ITEM_QUESTIONS = 10;
const MAX_ITEM_QUESTION_CHARACTERS = 1000;
const VISIBLE_ITEM_LIMIT = 100;
const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  working: "working", needs_input: "needs input", done: "done", failed: "failed", stopped: "stopped",
};

function parseQuestions(json: string): string[] {
  try {
    const questions = JSON.parse(json);
    return Array.isArray(questions) ? questions.map(String) : [];
  } catch {
    return [];
  }
}

// The details shown when the user opens an item, in display order.
const ITEM_REPORT_FIELDS = [
  ["problem", "Problem"], ["fix", "Fix"], ["commit", "Commit"], ["specs", "Specs"],
  ["ui_verification", "UI verification"], ["notes", "Notes"],
] as const;
type ItemReport = Partial<Record<(typeof ITEM_REPORT_FIELDS)[number][0], string>>;
const MAX_ITEM_REPORT_FIELD_CHARACTERS = 2000;

function parseReport(json: string): ItemReport {
  try {
    const report = JSON.parse(json);
    return report && typeof report === "object" && !Array.isArray(report) ? report : {};
  } catch {
    return {};
  }
}

// Fields sent replace the stored ones; an empty string removes a field.
function mergedReport(item: ItemRow, rawReport: unknown): ItemReport {
  const report = parseReport(item.report);
  if (rawReport === undefined) return report;
  if (!rawReport || typeof rawReport !== "object" || Array.isArray(rawReport)) throw new Error("report must be an object.");
  for (const [field] of ITEM_REPORT_FIELDS) {
    if (!Object.hasOwn(rawReport, field)) continue;
    const value = String((rawReport as Record<string, unknown>)[field] ?? "").trim().slice(0, MAX_ITEM_REPORT_FIELD_CHARACTERS);
    if (value) report[field] = value;
    else delete report[field];
  }
  return report;
}

function reportText(report: ItemReport): string {
  // **Label:** renders bold in the chat, so each field stands out in the item's history.
  const lines = ITEM_REPORT_FIELDS.filter(([field]) => report[field]).map(([field, label]) => `**${label}:** ${report[field]}`);
  return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
}

function publicItem(item: ItemRow) {
  return {
    id: item.id, title: item.title, member: item.member, status: item.status, summary: item.summary,
    questions: parseQuestions(item.questions), report: parseReport(item.report),
    createdAt: item.created_at, updatedAt: item.updated_at,
  };
}

function itemsFor(team: Team) {
  return queries.visibleItems.all(team.workspace, VISIBLE_ITEM_LIMIT).map(publicItem);
}

function broadcastItems(team: Team) {
  broadcast({ type: "items", workspace: team.workspace, items: itemsFor(team) });
}

function itemIdForTask(taskId: number | undefined): number | null {
  if (taskId === undefined) return null;
  return queries.findTask.get(taskId)?.item_id ?? null;
}

function saveItem(team: Team, item: ItemRow) {
  queries.saveItem.run(item.member, item.status, item.summary, item.questions, item.report, item.archived, Date.now(), item.id);
  broadcastItems(team);
}

// When the item's last running task ends, an item still marked working takes the task's outcome.
// A status the Manager set (needs input, done, failed) is left alone.
function settleItem(team: Team, itemId: number | null, outcome: "done" | "failed" | "stopped") {
  if (itemId === null) return;
  const item = queries.findItem.get(itemId, team.workspace);
  if (!item || item.status !== "working") return;
  if ((queries.runningTaskCount.get(itemId)?.count ?? 0) > 0) return;
  saveItem(team, { ...item, status: outcome });
}

// "Item #12 rsu-23" plus a one-line title derived from the brief when the Manager gave none.
function itemTitleFrom(title: unknown, brief: string): string {
  const text = String(title ?? "").trim() || brief.split("\n").find((line) => line.trim())?.trim() || "Task";
  return text.length > MAX_ITEM_TITLE_CHARACTERS ? `${text.slice(0, MAX_ITEM_TITLE_CHARACTERS - 3)}...` : text;
}

// The item a follow-up task continues, or null for new work (or an unknown task number).
function followUpItemFor(team: Team, rawTaskId: unknown): ItemRow | null {
  const itemId = Number.isInteger(rawTaskId) ? itemIdForTask(rawTaskId as number) : null;
  return itemId === null ? null : queries.findItem.get(itemId, team.workspace) ?? null;
}

// A follow-up puts its item back to working and clears the questions it answers.
function reopenItem(team: Team, item: ItemRow, memberName: string): ItemRow {
  const reopenedItem = { ...item, member: memberName, status: "working" as ItemStatus, questions: "[]", archived: 0 };
  saveItem(team, reopenedItem);
  return reopenedItem;
}

function createItem(team: Team, taskId: number, memberName: string, brief: string, title: unknown): ItemRow {
  queries.insertItem.run(taskId, team.workspace, itemTitleFrom(title, brief), memberName, Date.now());
  queries.assignTaskItem.run(taskId, taskId);
  broadcastItems(team);
  return queries.findItem.get(taskId, team.workspace)!;
}

// The Manager's report on an item: the only way its updates reach the user's task summary.
function updateItem(team: Team, input: any): string {
  const taskId = Number(input?.task);
  const itemId = Number.isInteger(taskId) ? itemIdForTask(taskId) : null;
  const item = itemId === null ? null : queries.findItem.get(itemId, team.workspace);
  if (!item) throw new Error("Unknown task. Pass the number of a task you delegated (any task on the item).");

  const status = input?.status === undefined ? item.status : String(input.status) as ItemStatus;
  if (!ITEM_STATUSES_FOR_MANAGER.includes(status) && status !== item.status) {
    throw new Error(`status must be one of: ${ITEM_STATUSES_FOR_MANAGER.join(", ")}`);
  }
  const summary = input?.summary === undefined
    ? item.summary
    : String(input.summary).replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_SUMMARY_CHARACTERS);
  let questions = parseQuestions(item.questions);
  if (input?.questions !== undefined) {
    if (!Array.isArray(input.questions)) throw new Error("questions must be a list of strings.");
    questions = input.questions.map((question: unknown) => String(question).trim()).filter(Boolean);
    if (questions.length > MAX_ITEM_QUESTIONS) throw new Error(`Ask at most ${MAX_ITEM_QUESTIONS} questions per item.`);
    questions = questions.map((question) => question.slice(0, MAX_ITEM_QUESTION_CHARACTERS));
  }
  if (status === "needs_input" && questions.length === 0) throw new Error("needs_input requires at least one question.");
  const report = mergedReport(item, input?.report);

  saveItem(team, { ...item, status, summary, questions: JSON.stringify(questions), report: JSON.stringify(report) });
  const questionText = questions.length > 0 ? `\n\n${questions.map((question, index) => `q${index + 1}: ${question}`).join("\n")}` : "";
  recordEvent(team.manager, "item",
    `[${item.title}: ${ITEM_STATUS_LABELS[status]}]\n${summary}${reportText(report)}${questionText}`, { itemId: item.id });
  return `Item #${item.id} (${item.title}) updated: ${ITEM_STATUS_LABELS[status]}.`;
}

// Quoted to the Manager above a reply the user sent in an item's thread.
function itemQuote(item: ItemRow): string {
  const questions = parseQuestions(item.questions);
  const questionText = questions.length > 0
    ? ` Open questions:\n${questions.map((question, index) => `q${index + 1}: ${question}`).join("\n")}`
    : "";
  return `[Thread reply about item #${item.id} "${item.title}" (${ITEM_STATUS_LABELS[item.status]}, ${item.member}).${questionText}]`;
}

// ---------------------------------------------------------------- scheduled work

const MAX_SCHEDULE_INSTRUCTION_CHARACTERS = 20_000;
const MAX_SCHEDULE_DELAY_MILLISECONDS = 366 * 24 * 60 * 60_000;
const VISIBLE_SCHEDULE_LIMIT = 100;
const DUE_SCHEDULE_BATCH = 20;
const SCHEDULE_SWEEP_INTERVAL_MS = 15_000;
// A schedule that comes due this much later than planned (the server was down) says so.
const LATE_SCHEDULE_MILLISECONDS = 2 * 60_000;

function formatLocalTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("en-US", {
    weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

function currentTimeNote(): string {
  return `Current time: ${formatLocalTime(Date.now())} (${new Date().toISOString()}).`;
}

function publicSchedule(schedule: ScheduleRow) {
  return { id: schedule.id, title: schedule.title, instructions: schedule.instructions, runAt: schedule.run_at, createdAt: schedule.created_at };
}

function schedulesFor(team: Team) {
  return queries.pendingSchedules.all(team.workspace, VISIBLE_SCHEDULE_LIMIT).map(publicSchedule);
}

function broadcastSchedules(team: Team) {
  broadcast({ type: "schedules", workspace: team.workspace, schedules: schedulesFor(team) });
}

// run_at (an ISO 8601 time; without an offset it is the server's local time) or delay_minutes from now.
function scheduledTimeFrom(input: any, now: number): number {
  const hasRunAt = input?.run_at !== undefined && String(input.run_at).trim() !== "";
  const hasDelay = input?.delay_minutes !== undefined;
  if (hasRunAt === hasDelay) throw new Error(`Pass exactly one of run_at or delay_minutes. ${currentTimeNote()}`);
  const runAt = hasRunAt
    ? new Date(String(input.run_at).trim()).getTime()
    : now + Number(input.delay_minutes) * 60_000;
  if (!Number.isFinite(runAt)) throw new Error(`run_at must be an ISO 8601 time such as 2026-10-17T09:00. ${currentTimeNote()}`);
  if (runAt <= now) throw new Error(`That time is not in the future. ${currentTimeNote()}`);
  if (runAt - now > MAX_SCHEDULE_DELAY_MILLISECONDS) throw new Error("Schedule at most a year ahead.");
  return runAt;
}

function scheduleWork(team: Team, input: any): string {
  const instructions = String(input?.instructions ?? "").trim();
  if (!instructions) throw new Error("instructions is required");
  if (instructions.length > MAX_SCHEDULE_INSTRUCTION_CHARACTERS) throw new Error("instructions must be under 20,000 characters.");
  const now = Date.now();
  const runAt = scheduledTimeFrom(input, now);
  const title = itemTitleFrom(input?.title, instructions);
  const scheduleId = queries.insertSchedule.get(team.workspace, title, instructions, runAt, now)!.id;
  broadcastSchedules(team);
  return `Scheduled #${scheduleId} "${title}" for ${formatLocalTime(runAt)}. At that time you get a [Scheduled work #${scheduleId}] ` +
    `message with these instructions; delegate it then. ${currentTimeNote()}`;
}

function listScheduled(team: Team): string {
  const schedules = queries.pendingSchedules.all(team.workspace, VISIBLE_SCHEDULE_LIMIT);
  const lines = schedules.map((schedule) =>
    `#${schedule.id} ${formatLocalTime(schedule.run_at)}: ${schedule.title}\n  ${schedule.instructions.replace(/\s+/g, " ").slice(0, ACTIVITY_EVENT_CHARACTERS)}`);
  return [currentTimeNote(), ...(lines.length > 0 ? lines : ["No scheduled work."])].join("\n");
}

function cancelSchedule(team: Team, rawScheduleId: unknown): ScheduleRow {
  const schedule = queries.settleSchedule.get("cancelled", Number(rawScheduleId), team.workspace);
  if (!schedule) throw new Error(`No pending scheduled work #${rawScheduleId} in this workspace.`);
  broadcastSchedules(team);
  return schedule;
}

// Wakes each due schedule's Manager once. Schedules missed while the server was down fire on the first sweep.
function runDueSchedules() {
  const now = Date.now();
  for (const dueSchedule of queries.dueSchedules.all(now, DUE_SCHEDULE_BATCH)) {
    let workspace: string;
    try {
      workspace = validateWorkspace(dueSchedule.workspace);
    } catch (error) {
      queries.settleSchedule.run("cancelled", dueSchedule.id, dueSchedule.workspace);
      console.warn(`Dropping scheduled work #${dueSchedule.id}: ${(error as Error).message}`);
      continue;
    }
    const schedule = queries.settleSchedule.get("fired", dueSchedule.id, dueSchedule.workspace);
    if (!schedule) continue;
    const team = teamFor(workspace);
    const lateNote = now - schedule.run_at >= LATE_SCHEDULE_MILLISECONDS
      ? ` (due ${formatLocalTime(schedule.run_at)}; the server was not running then)`
      : "";
    notifyManager(team, `[Scheduled work #${schedule.id} "${schedule.title}", set for ${formatLocalTime(schedule.run_at)}${lateNote}]\n` +
      `${schedule.instructions}\n\nDo it now: delegate it with delegate_task (title "${schedule.title}").`);
    broadcastSchedules(team);
  }
}

// ---------------------------------------------------------------- memories

// The workspace's Claude Code memory: one Markdown file per memory plus a MEMORY.md index,
// which Claude Code loads at the start of every session in the workspace.
const MEMORY_TYPES = ["user", "feedback", "project", "reference"];
const MEMORY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MEMORY_INDEX_FILE = "MEMORY.md";
const MAX_MEMORY_DESCRIPTION_CHARACTERS = 200;
const MAX_MEMORY_CONTENT_CHARACTERS = 5_000;
// Claude Code only loads the start of a long index.
const MEMORY_INDEX_WARNING_LINES = 150;

function memoryDirectoryFor(workspace: string): string {
  const claudeDirectory = process.env.CLAUDE_CONFIG_DIR ? expandPath(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
  return join(claudeDirectory, "projects", workspace.replace(/[^A-Za-z0-9]/g, "-"), "memory");
}

function memoryNameFrom(rawName: unknown): string {
  const name = String(rawName ?? "").trim();
  if (!MEMORY_NAME_PATTERN.test(name) || name === "memory") {
    throw new Error("name must be a short kebab-case slug, e.g. rspec-needs-redis.");
  }
  return name;
}

function singleLine(value: unknown, limit: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function writeFileAtomically(path: string, contents: string) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, contents);
  renameSync(temporaryPath, path);
}

function readMemoryIndex(memoryDirectory: string): string[] {
  const indexPath = join(memoryDirectory, MEMORY_INDEX_FILE);
  if (!existsSync(indexPath)) return [];
  return readFileSync(indexPath, "utf8").split("\n").filter((line) => line.trim());
}

function indexLinesWithout(indexLines: string[], name: string): string[] {
  return indexLines.filter((line) => !line.includes(`](${name}.md)`));
}

function saveMemory(team: Team, input: any): string {
  const name = memoryNameFrom(input?.name);
  const type = String(input?.type ?? "");
  if (!MEMORY_TYPES.includes(type)) throw new Error(`type must be one of: ${MEMORY_TYPES.join(", ")}`);
  const title = singleLine(input?.title, MAX_ITEM_TITLE_CHARACTERS) || name;
  const description = singleLine(input?.description, MAX_MEMORY_DESCRIPTION_CHARACTERS);
  if (!description) throw new Error("description is required");
  const content = String(input?.content ?? "").trim();
  if (!content) throw new Error("content is required");
  if (content.length > MAX_MEMORY_CONTENT_CHARACTERS) throw new Error("content must be under 5,000 characters; keep one fact per memory.");

  const memoryDirectory = memoryDirectoryFor(team.workspace);
  mkdirSync(memoryDirectory, { recursive: true });
  const memoryPath = join(memoryDirectory, `${name}.md`);
  const updating = existsSync(memoryPath);
  // JSON strings are valid YAML scalars, so any description is safe in the frontmatter.
  writeFileAtomically(memoryPath, [
    "---", `name: ${name}`, `description: ${JSON.stringify(description)}`, "metadata:", `  type: ${type}`,
    `  modified: ${new Date().toISOString()}`, "  savedBy: vdev manager", "---", "", content, "",
  ].join("\n"));

  const indexLines = [...indexLinesWithout(readMemoryIndex(memoryDirectory), name), `- [${title}](${name}.md) - ${description}`];
  writeFileAtomically(join(memoryDirectory, MEMORY_INDEX_FILE), indexLines.join("\n") + "\n");
  recordEvent(team.manager, "system", `${updating ? "Updated" : "Saved"} memory: ${title} - ${description}`);
  const sizeWarning = indexLines.length > MEMORY_INDEX_WARNING_LINES
    ? ` The index has ${indexLines.length} lines; Claude Code loads only the start of it, so merge or delete stale memories.`
    : "";
  return `${updating ? "Updated" : "Saved"} memory ${name} (${type}). New sessions in this workspace load it.${sizeWarning}`;
}

function listMemories(team: Team): string {
  const indexLines = readMemoryIndex(memoryDirectoryFor(team.workspace));
  return indexLines.length > 0 ? indexLines.join("\n") : "No memories saved for this workspace yet.";
}

function readMemory(team: Team, rawName: unknown): string {
  const memoryPath = join(memoryDirectoryFor(team.workspace), `${memoryNameFrom(rawName)}.md`);
  if (!existsSync(memoryPath)) throw new Error(`No memory named ${rawName}. list_memories shows the saved ones.`);
  return readFileSync(memoryPath, "utf8");
}

function deleteMemory(team: Team, rawName: unknown): string {
  const name = memoryNameFrom(rawName);
  const memoryDirectory = memoryDirectoryFor(team.workspace);
  const memoryPath = join(memoryDirectory, `${name}.md`);
  const indexLines = readMemoryIndex(memoryDirectory);
  const remainingLines = indexLinesWithout(indexLines, name);
  if (!existsSync(memoryPath) && remainingLines.length === indexLines.length) throw new Error(`No memory named ${name}.`);
  if (existsSync(memoryPath)) unlinkSync(memoryPath);
  writeFileAtomically(join(memoryDirectory, MEMORY_INDEX_FILE), remainingLines.length > 0 ? remainingLines.join("\n") + "\n" : "");
  recordEvent(team.manager, "system", `Deleted memory: ${name}`);
  return `Deleted memory ${name}.`;
}

// ---------------------------------------------------------------- stream-json handling

// Lines that show the model or a tool moved on; system notices (status, hooks, background
// task progress) keep arriving while a member is stuck, so they do not count.
const PROGRESS_LINE_TYPES = new Set(["stream_event", "assistant", "user", "result"]);

function handleLine(runtime: MemberRuntime, line: string) {
  let data: any;
  try {
    data = JSON.parse(line);
  } catch {
    return;
  }
  runtime.lastActiveAt = Date.now();
  if (PROGRESS_LINE_TYPES.has(data.type)) runtime.lastOutputAt = Date.now();

  switch (data.type) {
    case "system":
      handleSystem(runtime, data);
      break;
    case "stream_event":
      if (!data.parent_tool_use_id) handleStreamEvent(runtime, data.event);
      break;
    case "assistant":
      handleAssistant(runtime, data);
      break;
    case "rate_limit_event":
      rateLimit = data.rate_limit_info ?? null;
      if (rateLimit?.status === "rejected") runtime.planLimitHit = true;
      broadcast({ type: "rate", rateLimit });
      break;
    case "result":
      handleResult(runtime, data);
      break;
    case "control_request":
      handleControlRequest(runtime, data);
      break;
    case "control_cancel_request":
      dropPermissionRequest(runtime, data.request_id);
      break;
  }
}

function handleControlRequest(runtime: MemberRuntime, data: any) {
  const request = data.request ?? {};
  if (request.subtype !== "can_use_tool") {
    writeControlResponse(runtime, { subtype: "error", request_id: data.request_id, error: `Unsupported request: ${request.subtype}` });
    return;
  }
  const toolName = String(request.tool_name ?? "tool");
  const input = request.input ?? {};
  const suggestions: any[] = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
  const suggestedRules = suggestions
    .filter((suggestion) => suggestion?.type === "addRules" && suggestion.behavior === "allow")
    .flatMap((suggestion) => suggestion.rules ?? [])
    .map((rule: any) => rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : String(rule.toolName));
  const browser = request.tool_kind === "browser" || toolName.startsWith("mcp__claude-in-chrome__");
  // The CLI only suggests a site rule the first time; later requests name the site in their reason.
  const site = String(request.decision_reason ?? "").match(/^Claude in Chrome action on (\S+)$/)?.[1];
  const siteRule = site ? `ClaudeInChromeDomain(${site})` : null;
  const grantRules = [...new Set([...suggestedRules, ...(siteRule ? [siteRule] : [])])];

  if (toolName === "Bash" && isReadOnlyRtkFind(String(input.command ?? ""))) {
    writeControlResponse(runtime, { subtype: "success", request_id: data.request_id, response: { behavior: "allow", updatedInput: input } });
    return;
  }

  const rule = browser ? siteRule ?? suggestedRules[0] ?? toolName : suggestedRule(toolName, input);
  // A rule another member saved after this process launched; the CLI only reads rules at launch.
  if (!browser && coveredBySharedRule(runtime.team, toolName, input)) {
    writeControlResponse(runtime, {
      subtype: "success", request_id: data.request_id,
      response: { behavior: "allow", updatedInput: input, updatedPermissions: sessionGrants([rule]) },
    });
    return;
  }

  if (browser && browserActionAllowed(runtime, toolName, grantRules)) {
    writeControlResponse(runtime, {
      subtype: "success", request_id: data.request_id,
      response: { behavior: "allow", updatedInput: input, updatedPermissions: sessionGrants(grantRules) },
    });
    return;
  }

  const permissionRequest: PermissionRequest = {
    requestId: String(data.request_id),
    toolName,
    input,
    summary: browser && request.description ? `${request.description}\n${summarizeToolUse(toolName, input)}` : summarizeToolUse(toolName, input),
    rule,
    browser,
    grantRules,
    toolUseId: request.tool_use_id ? String(request.tool_use_id) : null,
    createdAt: Date.now(),
  };
  runtime.permissionRequests.push(permissionRequest);
  broadcastMember(runtime);
  if (reviewApprovals && !browser && !isManager(runtime)) askManagerToReview(runtime, permissionRequest);
}

const REVIEW_RULE_LIMIT = 60;

// The Manager often knows a route that needs no approval (the Read tool instead of cat, a
// command without a cd prefix or pipe). It can only send the worker that way, never approve:
// the request stays in the UI for the user until one of them answers it.
function askManagerToReview(runtime: MemberRuntime, request: PermissionRequest) {
  const task = currentTask(runtime);
  const label = task ? `${runtime.config.name} (task #${task.id})` : runtime.config.name;
  const allowRules = [...new Set([
    ...(runtime.config.allowedTools ?? []),
    ...runtime.team.allowedTools,
    ...projectAllowRules(runtime.team.workspace),
  ])];
  const shownRules = allowRules.slice(0, REVIEW_RULE_LIMIT).join(", ") || "(none)";
  const moreRules = allowRules.length > REVIEW_RULE_LIMIT ? ` and ${allowRules.length - REVIEW_RULE_LIMIT} more` : "";
  notifyManager(runtime.team,
    `[Approval request ${request.requestId} from ${label}]\n` +
    `Waits for the user's approval: ${request.summary}\n` +
    `Allowed without asking: ${shownRules}${moreRules}\n` +
    "If the same result is reachable without approval, call redirect_approval with this request id and the exact route. " +
    "If it is not, do nothing: the request stays with the user.",
    task?.item_id ?? null);
}

// Denies the call with the Manager's route as its result; the worker reads it and goes on in the same turn.
function redirectApproval(runtime: MemberRuntime, requestId: string, text: string): string {
  const request = runtime.permissionRequests.find((pending) => pending.requestId === requestId);
  if (!request) {
    throw new Error(`${runtime.config.name} no longer waits for approval ${requestId}: the user answered it or the step ended. Do nothing.`);
  }
  if (request.toolUseId) runtime.deniedByUser.add(request.toolUseId);
  dropPermissionRequest(runtime, requestId);
  writeControlResponse(runtime, {
    subtype: "success", request_id: requestId,
    response: { behavior: "deny", message: `The Manager answered this instead of asking the user. Do not retry the same call. ${text}` },
  });
  recordEvent(runtime, "system", `Redirected by the Manager: ${request.summary.split("\n").pop()}\n${text}`);
  return `Redirected ${runtime.config.name}; it continues with your route now.`;
}

// The rtk hook turns every find into "rtk find", which no allow rule can safely cover
// because find also runs and deletes files. A single find without those actions, pipes,
// redirects or substitutions only lists files, so it needs no approval.
const FIND_ACTION_FLAGS = /(^|\s)-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)(\s|$)/;
function isReadOnlyRtkFind(command: string): boolean {
  if (!/^rtk find(\s|$)/.test(command)) return false;
  if (/[;&|`$<>()\\\n]/.test(command)) return false;
  return !FIND_ACTION_FLAGS.test(command);
}

// True when a rule shared with every member covers this call, e.g. Bash(rtk ls *) covers
// "rtk ls captures". Only for a single plain command: a prefix rule like Bash(bundle exec rspec *)
// must never approve "bundle exec rspec; rm -rf tmp", which Claude Code itself would refuse.
function coveredBySharedRule(team: Team, toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== "Bash") return team.allowedTools.includes(toolName);
  const command = String(input.command ?? "").trim();
  if (/[;&|`$<>()\\\n]/.test(command)) return false;
  return team.allowedTools.some((rule) => bashRuleCovers(rule, command));
}

// "Bash(git diff *)" and "Bash(git diff:*)" cover "git diff" and "git diff HEAD"; "Bash(git diff)" only "git diff".
function bashRuleCovers(rule: string, command: string): boolean {
  const match = rule.match(/^Bash\((.+?)( \*|:\*)?\)$/);
  if (!match) return false;
  const [, prefix, wildcard] = match;
  if (prefix.includes("*")) return false;
  if (!wildcard) return command === prefix;
  return command === prefix || command.startsWith(`${prefix} `);
}

// Rules you wrote (worker settings, project permissions) that cover a Chrome
// action: its tool name, the CLI's suggested rule (e.g. ClaudeInChromeDomain(localhost)),
// ClaudeInChromeDomain(*) for every site, or mcp__claude-in-chrome for everything.
// The mcp__claude-in-chrome rule vdev adds itself for Chrome members does not count.
function browserActionAllowed(runtime: MemberRuntime, toolName: string, grantRules: string[]): boolean {
  const rules = new Set([...(runtime.config.allowedTools ?? []), ...runtime.team.allowedTools]);
  if (rules.has("mcp__claude-in-chrome") || rules.has("mcp__claude-in-chrome__*") || rules.has(toolName)) return true;
  if (grantRules.length === 0) return false;
  return grantRules.every((rule) => rules.has(rule) || (rule.startsWith("ClaudeInChromeDomain(") && rules.has("ClaudeInChromeDomain(*)")));
}

// Applied for the rest of this session only, so the CLI stops asking for the same site.
function sessionGrants(grantRules: string[]) {
  if (grantRules.length === 0) return [];
  return [{ type: "addRules", rules: grantRules.map(ruleValueFor), behavior: "allow", destination: "session" }];
}

function dropPermissionRequest(runtime: MemberRuntime, requestId: string) {
  const remaining = runtime.permissionRequests.filter((request) => request.requestId !== requestId);
  if (remaining.length === runtime.permissionRequests.length) return;
  runtime.permissionRequests = remaining;
  broadcastMember(runtime);
}

function writeControlResponse(runtime: MemberRuntime, response: Record<string, unknown>) {
  if (!runtime.process) return;
  runtime.process.stdin.write(JSON.stringify({ type: "control_response", response }) + "\n");
  runtime.process.stdin.flush();
}

// "always" also saves the suggested rule for every member in this workspace, so
// later calls like it run without asking (now and after restarts).
function answerPermission(runtime: MemberRuntime, requestId: string, decision: "allow" | "always" | "deny") {
  const request = runtime.permissionRequests.find((pending) => pending.requestId === requestId);
  if (!request) return;
  dropPermissionRequest(runtime, requestId);

  if (decision === "deny") {
    if (request.toolUseId) runtime.deniedByUser.add(request.toolUseId);
    writeControlResponse(runtime, {
      subtype: "success", request_id: requestId,
      response: { behavior: "deny", message: "The user denied this tool call. Do not retry it; continue without it or explain what you need." },
    });
    recordEvent(runtime, "system", `Denied: ${request.summary}`);
    return;
  }

  const allowResponse: Record<string, unknown> = { behavior: "allow", updatedInput: request.input };
  const summaryLine = request.summary.split("\n").pop();
  if (decision === "always") {
    allowResponse.updatedPermissions = request.browser && request.grantRules.length > 0
      ? sessionGrants(request.grantRules)
      : [{ type: "addRules", rules: [ruleValueFor(request.rule)], behavior: "allow", destination: "session" }];
    saveProjectRule(runtime.team, request.rule);
  }
  writeControlResponse(runtime, { subtype: "success", request_id: requestId, response: allowResponse });
  if (decision === "allow") return recordEvent(runtime, "system", `Allowed once: ${summaryLine}`);
  recordEvent(runtime, "system", `Allowed: ${summaryLine}\nSaved rule ${request.rule} for all members in this workspace.`);
  if (!request.browser) allowPendingRequestsCoveredBy(runtime.team, request.rule);
}

// One click for a whole team blocked on approvals: each pending call runs once,
// like pressing "Allow once" on every card. No rules are saved.
function allowAllPermissions(team: Team) {
  for (const runtime of team.runtimes.values()) {
    for (const pending of [...runtime.permissionRequests]) answerPermission(runtime, pending.requestId, "allow");
  }
}

// Other members often wait on the same approval (e.g. several QA members running specs).
function allowPendingRequestsCoveredBy(team: Team, rule: string) {
  for (const otherRuntime of team.runtimes.values()) {
    for (const pending of [...otherRuntime.permissionRequests]) {
      if (pending.browser) continue;
      if (!coveredBySharedRule(team, pending.toolName, pending.input)) continue;
      dropPermissionRequest(otherRuntime, pending.requestId);
      writeControlResponse(otherRuntime, {
        subtype: "success", request_id: pending.requestId,
        response: { behavior: "allow", updatedInput: pending.input, updatedPermissions: sessionGrants([rule]) },
      });
      recordEvent(otherRuntime, "system", `Allowed by shared rule ${rule}: ${pending.summary.split("\n").pop()}`);
    }
  }
}

// "Bash(bundle exec rspec *)" -> { toolName: "Bash", ruleContent: "bundle exec rspec *" }
function ruleValueFor(rule: string): { toolName: string; ruleContent?: string } {
  const match = rule.match(/^([^(]+)\((.*)\)$/);
  if (!match) return { toolName: rule };
  return { toolName: match[1], ruleContent: match[2] };
}

function saveProjectRule(team: Team, rule: string) {
  if (team.allowedTools.includes(rule)) return;
  team.allowedTools = [...team.allowedTools, rule];
  queries.saveProjectSettings.run(team.workspace, team.instructions, JSON.stringify(team.allowedTools));
  broadcast({ type: "projectSettings", workspace: team.workspace, ...projectSettingsFor(team) });
}

function handleSystem(runtime: MemberRuntime, data: any) {
  // /clear starts a new session inside the same process; keep resuming the new one.
  if (data.subtype === "init" && data.session_id && data.session_id !== runtime.sessionId) {
    runtime.sessionId = data.session_id;
    saveSessionId(runtime, data.session_id);
  }
  if (data.subtype === "init" && runtime.status === "starting") {
    runtime.status = runtime.origins.length > 0 ? "working" : "idle";
    broadcastMember(runtime);
  } else if (data.subtype === "status") {
    if (data.status === "compacting") runtime.status = "compacting";
    else if (runtime.status === "compacting") runtime.status = runtime.origins.length > 0 ? "working" : "idle";
    broadcastMember(runtime);
  } else if (data.subtype === "compact_boundary") {
    const metadata = data.compact_metadata ?? {};
    runtime.contextTokens = metadata.post_tokens ?? runtime.contextTokens;
    recordEvent(runtime, "system",
      `Compacted (${metadata.trigger ?? "manual"}): ${formatTokens(metadata.pre_tokens ?? 0)} -> ${formatTokens(metadata.post_tokens ?? 0)} tokens`);
    broadcastMember(runtime);
  }
}

function handleStreamEvent(runtime: MemberRuntime, event: any) {
  if (!event) return;
  if (event.type === "message_start") {
    const usage = event.message?.usage ?? {};
    const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    runtime.contextTokens = inputTokens + (usage.cache_read_input_tokens ?? 0);
    addTaskSpend(runtime, inputTokens);
  } else if (event.type === "message_delta") {
    addTaskSpend(runtime, event.usage?.output_tokens ?? 0);
  } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
    runtime.pendingDelta += event.delta.text;
    runtime.deltaTimer ??= setTimeout(() => flushDelta(runtime), DELTA_FLUSH_MS);
  }
}

function flushDelta(runtime: MemberRuntime) {
  if (runtime.deltaTimer) clearTimeout(runtime.deltaTimer);
  runtime.deltaTimer = null;
  if (!runtime.pendingDelta) return;
  broadcast({
    type: "delta", workspace: runtime.team.workspace, member: runtime.config.name, text: runtime.pendingDelta,
    placement: currentPlacement(runtime),
  });
  runtime.pendingDelta = "";
}

function addTaskSpend(runtime: MemberRuntime, tokens: number) {
  runtime.taskSpent += tokens;
  const task = currentTask(runtime);
  if (task) {
    if (runtime.taskSpent >= task.budget) return stopMember(runtime, "over_budget");
    if (runtime.taskSpent >= task.budget * 0.7 && runtime.warnedTaskId !== task.id) {
      runtime.warnedTaskId = task.id;
      recordEvent(runtime, "system", `Task #${task.id} passed 70% of its ${formatTokens(task.budget)} token budget.`);
    }
  }
  broadcastMember(runtime);
}

function handleAssistant(runtime: MemberRuntime, data: any) {
  const isSubagent = Boolean(data.parent_tool_use_id);
  const placement = currentPlacement(runtime);
  for (const block of data.message?.content ?? []) {
    if (block.type === "text" && block.text?.trim() && !isSubagent) {
      flushDelta(runtime);
      recordEvent(runtime, "assistant", block.text, placement);
    } else if (block.type === "tool_use") {
      recordEvent(runtime, "tool", summarizeToolUse(block.name, block.input ?? {}), toolPlacement(block, placement));
      countTabs(runtime, block.name);
    }
  }
}

// An update_item call is filed under the item it updates, whichever item or thread the turn is about.
function toolPlacement(block: any, turnPlacement: EventPlacement): EventPlacement {
  if (block.name !== "mcp__team__update_item") return turnPlacement;
  const taskId = Number(block.input?.task);
  const itemId = Number.isInteger(taskId) ? itemIdForTask(taskId) : null;
  if (itemId === null) return turnPlacement;
  return { threadId: null, itemId, origin: turnPlacement.origin };
}

function summarizeToolUse(toolName: string, input: Record<string, unknown>): string {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.member ?? input.text ?? JSON.stringify(input);
  const label = toolName.replace(/^mcp__team__/, "");
  return `${label}  ${String(detail).replace(/\s+/g, " ").slice(0, 200)}`;
}

function countTabs(runtime: MemberRuntime, toolName: string) {
  if (toolName === "mcp__claude-in-chrome__tabs_create_mcp") runtime.openTabs += 1;
  if (toolName === "mcp__claude-in-chrome__tabs_close_mcp") runtime.openTabs = Math.max(runtime.openTabs - 1, 0);
}

// A worker that hands off with its tabs still open gets one more turn to close them,
// unless other work is queued: the next task's /clear would make it forget which tabs were its own.
function closeLeftoverTabs(runtime: MemberRuntime, taskId: number) {
  if (isManager(runtime) || runtime.openTabs === 0) return;
  const tabCount = runtime.openTabs;
  runtime.openTabs = 0;
  if (runtime.origins.length > 0) {
    recordEvent(runtime, "error", `Task #${taskId} ended with ${tabCount} Chrome tab(s) still open; close them in Chrome.`);
    return;
  }
  sendTurn(runtime,
    `[System] Task #${taskId} is handed off, but you left ${tabCount} Chrome tab(s) open. ` +
    "Close every tab you opened with tabs_close_mcp now. Do nothing else, and reply with one line when done.",
    { kind: "handoff" }, "system");
}

function handleResult(runtime: MemberRuntime, data: any) {
  if (retryOnApiKey(runtime, data)) return;
  flushDelta(runtime);
  const origin = runtime.origins.shift();
  if (runtime.origins.length > 0) startTurn(runtime);
  writeNextQueuedInput(runtime);
  const interrupted = runtime.interrupting;
  runtime.interrupting = false;
  const usage = data.usage ?? {};
  queries.insertUsage.run(runtime.config.name, usage.input_tokens ?? 0, usage.output_tokens ?? 0,
    usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0, Date.now());
  runtime.totalSpent += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const modelUsage = Object.values(data.modelUsage ?? {})[0] as { contextWindow?: number } | undefined;
  if (modelUsage?.contextWindow) runtime.contextWindow = modelUsage.contextWindow;

  for (const denial of data.permission_denials ?? []) {
    if (runtime.deniedByUser.has(denial.tool_use_id)) continue;
    recordEvent(runtime, "error",
      `Permission denied: ${summarizeToolUse(denial.tool_name ?? "tool", denial.tool_input ?? {})}\n` +
      `To allow it, add a rule such as ${suggestedRule(denial.tool_name ?? "tool", denial.tool_input ?? {})} ` +
      "under Settings, in this project's permissions or the worker settings (every project).");
  }

  runtime.deniedByUser.clear();

  if (interrupted) {
    recordEvent(runtime, "system", "Interrupted by the Manager.");
  } else if (data.is_error && data.subtype !== "success") {
    recordEvent(runtime, "error", `Turn ended: ${data.subtype}${data.result ? `\n${data.result}` : ""}`);
  }

  // An interrupted task goes on in the Manager's follow-up turn, which brings the handoff.
  if (origin?.kind === "task" && origin.taskId !== undefined && !interrupted) {
    const failed = Boolean(data.is_error);
    queries.finishTask.run(failed ? "failed" : "done", runtime.taskSpent, data.result ?? null, origin.taskId);
    const itemId = itemIdForTask(origin.taskId);
    settleItem(runtime.team, itemId, failed ? "failed" : "done");
    const header = `[Handoff from ${runtime.config.name}, task #${origin.taskId}${failed ? ", FAILED" : ""}, ${formatTokens(runtime.taskSpent)} tokens]`;
    notifyManager(runtime.team, `${header}\n${data.result || "(no summary returned)"}`, itemId);
    runtime.taskSpent = 0;
    closeLeftoverTabs(runtime, origin.taskId);
  }

  runtime.status = runtime.origins.length > 0 ? "working" : "idle";
  runtime.lastActiveAt = Date.now();
  broadcastMember(runtime);
  if (runtime.restartPending && runtime.origins.length === 0) {
    runtime.process?.kill();
    return;
  }
  // Skipped after a command turn, so a /compact that frees too little does not loop.
  if (origin?.kind !== "command") compactIfNearlyFull(runtime);
}

function compactIfNearlyFull(runtime: MemberRuntime) {
  if (isManagerConfig(runtime.config)) return;
  if (runtime.status !== "idle" || !runtime.process) return;
  if (runtime.contextWindow === 0) return;
  if (runtime.contextTokens < runtime.contextWindow * WORKER_AUTO_COMPACT_RATIO) return;

  const percentUsed = Math.round(runtime.contextTokens / runtime.contextWindow * 100);
  recordEvent(runtime, "system", `Context at ${percentUsed}% (${formatTokens(runtime.contextTokens)}); compacting.`);
  sendTurn(runtime, "/compact", { kind: "command" }, "system");
}

// A starting point for the user, e.g. "bundle exec rspec spec/a_spec.rb" -> Bash(bundle exec rspec *).
function suggestedRule(toolName: string, input: Record<string, unknown>): string {
  if (toolName !== "Bash" || typeof input.command !== "string") return toolName;
  const words = input.command.trim().split(/\s+/);
  const prefix = [words[0]];
  for (const word of words.slice(1)) {
    if (prefix.length >= 3 || !/^[a-z][a-z0-9:_-]*$/.test(word)) break;
    prefix.push(word);
  }
  return `Bash(${prefix.join(" ")} *)`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

// ---------------------------------------------------------------- MCP server (team tools)

const messageTextSchema = { type: "string", description: "The message. Be specific and brief." };
// No enum: Claude Code caches tool schemas at launch, so an enum would reject members
// added while the Manager is running. callMcpTool checks the name against the live roster.
const memberNameSchema = {
  type: "string",
  description: "A team member's name. Members can be added while you run; team_status lists the current team.",
};

const workerMcpTools = () => [
  {
    name: "message_manager",
    description: "Send a message to the Manager at any time: a question, a blocker, a progress note, or a report the user asked for. " +
      "Returns at once; the Manager's answer, if any, arrives later as a message starting with [Message from <manager>]. " +
      "Your final handoff still reaches the Manager by itself, so do not repeat it here.",
    inputSchema: {
      type: "object",
      properties: { text: messageTextSchema },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

const managerMcpTools = () => [
  {
    name: "message_member",
    description: "Send a message to a team member at any time, e.g. to answer their question or add context to a running task. " +
      "It is not a task: no budget, no handoff. It reaches the member after their current turn. Use delegate_task for new work.",
    inputSchema: {
      type: "object",
      properties: { member: memberNameSchema, text: messageTextSchema },
      required: ["member", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "delegate_task",
    description: "Assign a task to a team member. Returns at once; the member's handoff arrives later as a message " +
      "starting with [Handoff from <member>, task #N]. Tasks for the same member run in order. " +
      "While it runs, [Watchdog] notices report a blocked or stalled worker; member_activity shows its progress at any time.",
    inputSchema: {
      type: "object",
      properties: {
        member: memberNameSchema,
        brief: { type: "string", description: "What to do, acceptance criteria, and relevant files." },
        title: {
          type: "string",
          description: "Short label for the user's task summary, e.g. the ticket key (RSU-23) or a few words (Airbrake NoMethodError in checkout).",
        },
        follows_up: {
          type: "integer",
          description: "Task number this continues (a fix, a follow-up after the user's answer). Keeps it on that task's summary item " +
            "instead of adding a new one, and clears the item's open questions.",
        },
        budget_tokens: { type: "integer", description: "Optional token budget. Defaults to the member's budget." },
      },
      required: ["member", "brief", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_item",
    description: "Update an item on the user's task summary, the list of everything they asked for, in order. " +
      "This is how your reports reach the user: they do not see handoffs, worker messages, watchdog notices or your replies to them. " +
      "Use it when an item is done or failed (a one-line summary), when it needs the user's decision (status needs_input with " +
      "one question per decision), or when the user's answers settle its questions (questions: []).",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "integer", description: "Any task number on the item (the first task or a follow-up)." },
        status: { type: "string", enum: ITEM_STATUSES_FOR_MANAGER, description: "Leave out to keep the current status." },
        summary: { type: "string", description: "One line the user reads in the list, e.g. 'Fixed; spec added in spec/models/rsu_spec.rb'." },
        report: {
          type: "object",
          description: "The full details the user sees when they open the item. Fill every field that applies when an item is " +
            "done or failed; fields you send replace earlier ones, and an empty string removes one.",
          properties: {
            problem: { type: "string", description: "What the bug or request was, and its root cause." },
            fix: { type: "string", description: "What was changed, with the main files." },
            commit: { type: "string", description: "Commit SHA(s) and branch, or 'not committed'." },
            specs: { type: "string", description: "Spec status: command run and result (e.g. 'passed: bin/rspec spec/models/rsu_spec.rb, 14 examples'), or 'not run' and why." },
            ui_verification: { type: "string", description: "UI verification status: what was checked in the browser and the result, or 'not done' and why." },
            notes: { type: "string", description: "Anything else the user should know: follow-ups, risks, open issues." },
          },
          additionalProperties: false,
        },
        questions: {
          type: "array",
          items: { type: "string" },
          description: "Replaces the item's open questions. Each is one decision the user must make, short and self-contained. [] clears them.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_work",
    description: "Set work to start later. At the chosen time you receive a [Scheduled work #N] message with the instructions, " +
      "and delegate it then (pick an idle worker at that time). The user sees pending scheduled work on their task summary. " +
      "Times without an offset are the server's local time; the result shows the current time.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short label for the user's task summary, as for delegate_task." },
        instructions: {
          type: "string",
          description: "What to do when it is due: everything you will need then (goal, files, acceptance criteria, which worker if it matters).",
        },
        run_at: { type: "string", description: "When to start, ISO 8601, e.g. 2026-10-17T09:00 or 2026-10-17T09:00:00-07:00." },
        delay_minutes: { type: "number", description: "Or: start this many minutes from now. Pass run_at or delay_minutes, not both." },
      },
      required: ["title", "instructions"],
      additionalProperties: false,
    },
  },
  {
    name: "list_scheduled",
    description: "The current time and the scheduled work that has not started yet, soonest first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cancel_scheduled",
    description: "Cancel scheduled work that has not started yet.",
    inputSchema: {
      type: "object",
      properties: { schedule: { type: "integer", description: "The number from schedule_work or list_scheduled." } },
      required: ["schedule"],
      additionalProperties: false,
    },
  },
  {
    name: "save_memory",
    description: "Save or update a long-term memory for this workspace: a learning, gotcha, user preference or project fact " +
      "that future sessions should know. It goes into Claude Code's memory for the workspace, which every new session here " +
      "loads (yours, the workers', and the user's own). Saving an existing name replaces that memory.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Kebab-case slug, also the file name, e.g. rspec-needs-redis." },
        title: { type: "string", description: "Short title for the index, e.g. 'Specs need Redis running'." },
        description: { type: "string", description: "One line used to judge relevance later, e.g. 'bin/rspec fails with ECONNREFUSED unless redis-server runs'." },
        type: {
          type: "string", enum: MEMORY_TYPES,
          description: "user: who the user is and how they work. feedback: a correction or confirmed approach. " +
            "project: ongoing work, decisions, deadlines (absolute dates). reference: where to find things outside the repo.",
        },
        content: {
          type: "string",
          description: "The fact. For feedback and project memories, follow it with **Why:** and **How to apply:** lines.",
        },
      },
      required: ["name", "title", "description", "type", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "list_memories",
    description: "The workspace's memory index: one line per saved memory, with its name (the .md file) and description.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_memory",
    description: "The full text of one saved memory.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The memory's name, as in list_memories." } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_memory",
    description: "Delete a memory that turned out to be wrong or no longer applies.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The memory's name, as in list_memories." } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "team_status",
    description: "Every member's state, current task, queue length and tokens spent against budget.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "member_activity",
    description: "What a member has been doing: current task, how long it has run, time since its last output, " +
      "approvals it waits for, and its most recent tool calls and messages. Use it to judge whether a worker is progressing, " +
      "looping, or stuck, instead of waiting for the handoff.",
    inputSchema: {
      type: "object",
      properties: {
        member: memberNameSchema,
        limit: { type: "integer", description: `How many recent events to show (default ${ACTIVITY_DEFAULT_LIMIT}, at most ${ACTIVITY_MAX_LIMIT}).` },
      },
      required: ["member"],
      additionalProperties: false,
    },
  },
  {
    name: "interrupt_member",
    description: "Interrupt what a member is doing right now (a hung command, a wrong approach, a tool call waiting for approval) " +
      "and give it new instructions at once. Its current task stays open and the handoff still arrives as usual. " +
      "Unlike message_member, it does not wait for the current turn to end.",
    inputSchema: {
      type: "object",
      properties: { member: memberNameSchema, text: messageTextSchema },
      required: ["member", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "redirect_approval",
    description: "Answer an [Approval request] from a worker with a route that needs no approval, e.g. the Read, Grep or Glob tool " +
      "instead of cat, grep or find; the command without a cd prefix, pipe or && chain; or a command an allow rule already covers. " +
      "The call is denied and the worker gets your text as its result at once and carries on. " +
      "You cannot approve calls: when no such route exists, leave the request for the user.",
    inputSchema: {
      type: "object",
      properties: {
        member: memberNameSchema,
        request: { type: "string", description: "The request id from the [Approval request <id> ...] notice." },
        text: { type: "string", description: "The exact route to take instead, e.g. the command or tool call to run." },
      },
      required: ["member", "request", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_member",
    description: "Stop a member's current and queued work.",
    inputSchema: {
      type: "object",
      properties: { member: memberNameSchema },
      required: ["member"],
      additionalProperties: false,
    },
  },
];

function mcpToolsFor(caller: MemberRuntime) {
  return isManager(caller) ? managerMcpTools() : workerMcpTools();
}

function callMcpTool(caller: MemberRuntime, toolName: string, input: any): string {
  const team = caller.team;
  if (!mcpToolsFor(caller).some((tool) => tool.name === toolName)) throw new Error(`Unknown tool ${toolName}`);

  if (toolName === "message_manager") {
    const text = String(input?.text ?? "").trim();
    if (!text) throw new Error("text is required");
    notifyManager(team, `[Message from ${caller.config.name}]\n${text}`, currentTask(caller)?.item_id ?? null);
    return "Sent to the Manager. Continue your work; any answer arrives as a message.";
  }

  if (toolName === "team_status") {
    return teamConfig.workers.map((workerName) => statusLineFor(team.runtimes.get(workerName)!)).join("\n");
  }

  if (toolName === "update_item") return updateItem(team, input);
  if (toolName === "schedule_work") return scheduleWork(team, input);
  if (toolName === "list_scheduled") return listScheduled(team);
  if (toolName === "save_memory") return saveMemory(team, input);
  if (toolName === "list_memories") return listMemories(team);
  if (toolName === "read_memory") return readMemory(team, input?.name);
  if (toolName === "delete_memory") return deleteMemory(team, input?.name);
  if (toolName === "cancel_scheduled") {
    const schedule = cancelSchedule(team, input?.schedule);
    return `Cancelled scheduled work #${schedule.id} "${schedule.title}".`;
  }

  const runtime = team.runtimes.get(input?.member);
  if (!runtime || isManager(runtime)) throw new Error(`Unknown member. Use one of: ${teamConfig.workers.join(", ")}`);

  if (toolName === "message_member") {
    const text = String(input?.text ?? "").trim();
    if (!text) throw new Error("text is required");
    sendTurn(runtime, `[Message from ${caller.config.name}]\n${text}`, { kind: "handoff" }, "handoff");
    return `Sent to ${runtime.config.name}. Their reply, if any, arrives as a message.`;
  }

  if (toolName === "member_activity") {
    return activityReportFor(runtime, input?.limit);
  }

  if (toolName === "interrupt_member") {
    const text = String(input?.text ?? "").trim();
    if (!text) throw new Error("text is required");
    return interruptMember(runtime, caller, text);
  }

  if (toolName === "redirect_approval") {
    const text = String(input?.text ?? "").trim();
    if (!text) throw new Error("text is required");
    return redirectApproval(runtime, String(input?.request ?? ""), text);
  }

  if (toolName === "stop_member") {
    stopMember(runtime);
    return `${runtime.config.name} stopped.`;
  }
  if (toolName === "delegate_task") {
    const brief = String(input.brief ?? "").trim();
    if (!brief) throw new Error("brief is required");
    const budget = Number.isInteger(input.budget_tokens) && input.budget_tokens > 0
      ? input.budget_tokens
      : runtime.config.budget ?? DEFAULT_BUDGET;
    const followUpItem = followUpItemFor(team, input.follows_up);
    if (input.follows_up !== undefined && !followUpItem) throw new Error(`follows_up: no task #${input.follows_up} in this workspace.`);
    const taskId = queries.insertTask.get(team.workspace, runtime.config.name, brief, budget, Date.now(), followUpItem?.id ?? null)!.id;
    const item = followUpItem
      ? reopenItem(team, followUpItem, runtime.config.name)
      : createItem(team, taskId, runtime.config.name, brief, input.title);
    // Every task starts from a clean context; the brief must say everything needed.
    clearContext(runtime, `Context cleared for task #${taskId}.`);
    sendTurn(runtime, `[Task #${taskId} from Manager]\n${brief}`, { kind: "task", taskId }, "task");
    const position = runtime.origins.filter((origin) => origin.kind === "task").length - 1;
    return `Task #${taskId} assigned to ${runtime.config.name} (budget ${formatTokens(budget)} tokens` +
      `${position > 0 ? `, ${position} ahead in queue` : ""}), on summary item #${item.id} "${item.title}". ` +
      "The handoff will arrive as a message.";
  }
  throw new Error(`Unknown tool ${toolName}`);
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return `${Math.max(Math.floor(milliseconds / 1000), 0)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

// "worker3: working, task #12 (40k/250k), 14m on this turn, last output 3m ago, waits 4m for approval: Bash ..., 0 queued"
function statusLineFor(runtime: MemberRuntime): string {
  const member = publicMember(runtime);
  const parts = [member.status];
  parts.push(member.task ? `task #${member.task.id} (${formatTokens(member.task.spent)}/${formatTokens(member.task.budget)})` : "no task");
  if (runtime.origins.length > 0) {
    const now = Date.now();
    parts.push(`${formatDuration(now - runtime.turnStartedAt)} on this turn`, `last output ${formatDuration(now - runtime.lastOutputAt)} ago`);
    const oldestRequest = runtime.permissionRequests[0];
    if (oldestRequest) {
      parts.push(`waits ${formatDuration(now - oldestRequest.createdAt)} for the user's approval: ${oldestRequest.summary.split("\n").pop()}`);
    }
  }
  parts.push(`${member.queued} queued`);
  return `${member.name}: ${parts.join(", ")}`;
}

const ACTIVITY_DEFAULT_LIMIT = 15;
const ACTIVITY_MAX_LIMIT = 50;
const ACTIVITY_EVENT_CHARACTERS = 300;

function recentActivity(runtime: MemberRuntime, limit: number) {
  return queries.recentEvents.all(runtime.team.workspace, runtime.config.name, limit);
}

function lastToolCall(runtime: MemberRuntime): string | null {
  const lastTool = recentActivity(runtime, 10).findLast((event) => event.kind === "tool");
  return lastTool ? lastTool.text.slice(0, ACTIVITY_EVENT_CHARACTERS) : null;
}

function activityReportFor(runtime: MemberRuntime, rawLimit: unknown): string {
  const limit = Number.isInteger(rawLimit) && (rawLimit as number) > 0
    ? Math.min(rawLimit as number, ACTIVITY_MAX_LIMIT)
    : ACTIVITY_DEFAULT_LIMIT;
  const now = Date.now();
  const lines = [statusLineFor(runtime)];
  const task = currentTask(runtime);
  if (task) lines.push(`Task #${task.id} brief: ${task.brief.replace(/\s+/g, " ").slice(0, ACTIVITY_EVENT_CHARACTERS)}`);
  for (const request of runtime.permissionRequests) {
    lines.push(`Waiting ${formatDuration(now - request.createdAt)} for the user's approval: ${request.summary.replace(/\s+/g, " ")}`);
  }
  lines.push("", "Recent events, oldest first:");
  for (const event of recentActivity(runtime, limit)) {
    const text = event.text.replace(/\s+/g, " ");
    const shortText = text.length > ACTIVITY_EVENT_CHARACTERS ? `${text.slice(0, ACTIVITY_EVENT_CHARACTERS)}...` : text;
    lines.push(`${formatDuration(now - event.created_at)} ago [${event.kind}] ${shortText}`);
  }
  return lines.join("\n");
}

// Stops the current turn at once (the CLI cancels the running tool) and sends the text as the next turn.
// The follow-up takes over the interrupted turn's origin, so an interrupted task ends with the follow-up's handoff.
function interruptMember(runtime: MemberRuntime, caller: MemberRuntime, text: string): string {
  const name = runtime.config.name;
  const origin = runtime.origins[0];
  if (!runtime.process || !origin) throw new Error(`${name} is not working on anything. Use message_member or delegate_task.`);
  if (origin.kind === "command") throw new Error(`${name} is clearing or compacting its context; try again in a moment.`);
  if (runtime.interrupting) throw new Error(`${name} is already being interrupted; your earlier message reaches it first.`);
  // The follow-up runs after anything already queued, so a queued task (with its /clear) would run first.
  if (runtime.origins.slice(1).some((queued) => queued.kind === "task" || queued.kind === "command")) {
    throw new Error(`${name} has tasks queued behind the current one, which would run before your message. ` +
      "Use stop_member and delegate again instead.");
  }

  for (const request of [...runtime.permissionRequests]) {
    if (request.toolUseId) runtime.deniedByUser.add(request.toolUseId);
    dropPermissionRequest(runtime, request.requestId);
    writeControlResponse(runtime, {
      subtype: "success", request_id: request.requestId,
      response: { behavior: "deny", message: "The Manager interrupted this step; new instructions follow." },
    });
  }
  runtime.interrupting = true;
  runtime.process.stdin.write(JSON.stringify({
    type: "control_request", request_id: `interrupt-${crypto.randomUUID()}`, request: { subtype: "interrupt" },
  }) + "\n");
  runtime.process.stdin.flush();

  const followUpOrigin: TurnOrigin = origin.kind === "task" ? { kind: "task", taskId: origin.taskId } : { kind: "handoff" };
  const taskNote = origin.kind === "task" ? ` Task #${origin.taskId} is still yours: finish it with the usual handoff.` : "";
  sendTurn(runtime, `[Message from ${caller.config.name}, interrupting your last step]${taskNote}\n${text}`, followUpOrigin, "handoff");
  return `Interrupted ${name} and sent your message; it acts on it now.`;
}

// The Manager only runs when a message reaches it, so the server watches running tasks and
// wakes it with one [Watchdog] notice per sweep when a worker is blocked, silent or slow.
// A sweep about a single task summary item is filed under that item.
function watchTeam(team: Team) {
  const watched = teamConfig.workers
    .map((workerName) => team.runtimes.get(workerName))
    .filter((runtime): runtime is MemberRuntime => Boolean(runtime?.process))
    .map((runtime) => ({ note: watchNoteFor(runtime, Date.now()), itemId: currentTask(runtime)?.item_id ?? null }))
    .filter((entry): entry is { note: string; itemId: number | null } => entry.note !== null);
  if (watched.length === 0) return;
  const itemIds = new Set(watched.map((entry) => entry.itemId));
  const itemId = itemIds.size === 1 ? watched[0].itemId : null;
  notifyManager(team, `[Watchdog]\n${watched.map((entry) => entry.note).join("\n")}`, itemId);
}

function watchNoteFor(runtime: MemberRuntime, now: number): string | null {
  const task = currentTask(runtime);
  if (!task) return null;
  const watch = runtime.watch;
  const label = `${runtime.config.name} (task #${task.id})`;

  if (approvalAlertMilliseconds > 0) {
    const newlyStuck = runtime.permissionRequests.filter((request) =>
      now - request.createdAt >= approvalAlertMilliseconds && !watch.approvalAlerts.has(request.requestId));
    if (newlyStuck.length > 0) {
      for (const request of newlyStuck) watch.approvalAlerts.add(request.requestId);
      const waits = newlyStuck.map((request) => request.summary.split("\n").pop()).join("; ");
      return `${label} is blocked: it has waited ${formatDuration(now - newlyStuck[0].createdAt)} for the user to approve ${waits}. ` +
        "Only the user can approve it in the vdev UI. Tell the user, or use interrupt_member to have the worker take another route.";
    }
  }
  // Already reported; the worker is waiting for the user, not stalling.
  if (runtime.permissionRequests.length > 0) return null;

  const silentFor = now - runtime.lastOutputAt;
  if (silentFor < silentAlertMilliseconds) watch.silentAlerts = 0;
  if (silentAlertMilliseconds > 0 && silentFor >= silentAlertMilliseconds * 2 ** watch.silentAlerts) {
    watch.silentAlerts += 1;
    const lastTool = lastToolCall(runtime);
    return `${label} has produced no output for ${formatDuration(silentFor)}` +
      `${lastTool ? `; its last tool call was: ${lastTool}` : ""}. It may be stuck on a long or hung command. ` +
      "Check member_activity, then wait, interrupt_member to redirect it, or stop_member and reassign.";
  }

  const workingFor = now - runtime.turnStartedAt;
  if (checkInMilliseconds > 0 && workingFor >= checkInMilliseconds * (watch.checkIns + 1)) {
    watch.checkIns = Math.floor(workingFor / checkInMilliseconds);
    return `${label} has worked ${formatDuration(workingFor)} without a handoff, ` +
      `${formatTokens(runtime.taskSpent)}/${formatTokens(task.budget)} tokens spent. ` +
      "Check member_activity to see whether it is progressing; act only if it is looping or off track.";
  }
  return null;
}

function handleMcpMessage(caller: MemberRuntime, message: any) {
  if (message?.id === undefined || message?.id === null) return null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "vdev-team", version: "0.1.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: mcpToolsFor(caller) });
    case "tools/call":
      try {
        const text = callMcpTool(caller, message.params?.name, message.params?.arguments ?? {});
        return reply({ content: [{ type: "text", text }] });
      } catch (error) {
        return reply({ content: [{ type: "text", text: (error as Error).message }], isError: true });
      }
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  }
}

async function handleMcpRequest(caller: MemberRuntime, request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  const replies = (Array.isArray(body) ? body : [body]).map((message) => handleMcpMessage(caller, message)).filter(Boolean);
  if (replies.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}

// ---------------------------------------------------------------- team configuration

const WORKER_NAME_PREFIX = "worker";
const MODEL_PATTERN = /^[A-Za-z0-9._\-\[\]]{1,80}$/;
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
const MAX_PROMPT_CHARACTERS = 20_000;
const MAX_RULES = 100;
const MAX_INSTRUCTION_CHARACTERS = 20_000;

function optionalText(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function toolList(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  const tools = value.map((tool) => String(tool).trim()).filter(Boolean);
  if (tools.some((tool) => tool.length > 200)) throw new Error(`${label}: each entry must be under 200 characters.`);
  return tools.length > 0 ? tools : undefined;
}

function validateRules(value: unknown, label: string): string[] {
  const rules = toolList(value, label) ?? [];
  if (rules.length > MAX_RULES) throw new Error(`${label}: at most ${MAX_RULES} rules.`);
  return rules;
}

function assignOptional<Key extends keyof AgentConfig>(agentConfig: AgentConfig, key: Key, value: AgentConfig[Key] | undefined) {
  if (value === undefined) delete agentConfig[key];
  else agentConfig[key] = value;
}

// Applies only the fields the settings page sent, so fields it does not show
// (e.g. the manager's tools) keep their team.json value. Throws with a message suitable for the UI.
function validateAgentConfig(raw: any, existingConfig: AgentConfig, label: string): AgentConfig {
  if (!raw || typeof raw !== "object") throw new Error(`${label} settings are missing.`);
  const sent = (field: string) => Object.hasOwn(raw, field);
  const agentConfig: AgentConfig = { ...existingConfig };

  if (sent("model")) {
    const model = optionalText(raw.model);
    if (model && !MODEL_PATTERN.test(model)) throw new Error(`${label} model must be an alias like sonnet or a full model ID.`);
    assignOptional(agentConfig, "model", model);
  }
  if (sent("effort")) {
    const effort = optionalText(raw.effort);
    if (effort && !EFFORT_LEVELS.includes(effort)) throw new Error(`${label} effort must be one of: ${EFFORT_LEVELS.join(", ")}.`);
    assignOptional(agentConfig, "effort", effort);
  }
  if (sent("permissionMode")) {
    const permissionMode = optionalText(raw.permissionMode);
    if (permissionMode && !PERMISSION_MODES.includes(permissionMode)) {
      throw new Error(`${label} permission mode must be one of: ${PERMISSION_MODES.join(", ")}.`);
    }
    assignOptional(agentConfig, "permissionMode", permissionMode);
  }
  if (sent("budget")) {
    const budgetText = optionalText(raw.budget);
    const budget = budgetText ? Number(budgetText) : undefined;
    if (budget !== undefined && (!Number.isInteger(budget) || budget < 1000)) {
      throw new Error(`${label} task budget must be a whole number of at least 1000 tokens.`);
    }
    assignOptional(agentConfig, "budget", budget);
  }
  if (sent("prompt")) {
    const prompt = optionalText(raw.prompt);
    if (prompt && prompt.length > MAX_PROMPT_CHARACTERS) throw new Error(`${label} instructions must be under 20,000 characters.`);
    assignOptional(agentConfig, "prompt", prompt);
  }
  if (sent("allowedTools")) assignOptional(agentConfig, "allowedTools", toolList(raw.allowedTools, `${label} allowed tools`));
  if (sent("chrome")) assignOptional(agentConfig, "chrome", raw.chrome === true ? true : undefined);
  return agentConfig;
}

// Written to a temporary file first so a crash never leaves a half-written team.json.
function saveTeamConfig() {
  const temporaryPath = `${teamFilePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(teamConfig, null, 2) + "\n");
  renameSync(temporaryPath, teamFilePath);
}

// A process only reads its settings at launch: idle ones restart now (resuming
// their session), busy ones restart once their queued turns are done.
function requestRestart(runtime: MemberRuntime) {
  if (!runtime.process) return;
  if (runtime.origins.length === 0) runtime.process.kill();
  else runtime.restartPending = true;
}

// The Manager's worker list is fixed at launch.
function restartManagers() {
  for (const team of teams.values()) requestRestart(team.manager);
}

// worker1, worker2, ...: the first numbered name not taken yet.
function addWorker(): string {
  const takenNames = new Set(memberNames());
  let number = 1;
  while (takenNames.has(`${WORKER_NAME_PREFIX}${number}`)) number += 1;
  const name = `${WORKER_NAME_PREFIX}${number}`;

  teamConfig.workers.push(name);
  saveTeamConfig();
  // A worker that once had this name may have left a session behind.
  queries.deleteSessions.run(name);
  for (const team of teams.values()) addRuntime(team, memberConfigFor(name));
  restartManagers();
  return name;
}

// Sidebar order is team.json's worker order; the manager always comes first.
// Order is cosmetic, so nothing restarts.
function reorderWorkers(raw: unknown) {
  if (!Array.isArray(raw)) throw new Error("Member order must be a list of names.");
  const requestedOrder = raw.map(String);
  const isPermutation = requestedOrder.length === teamConfig.workers.length &&
    new Set(requestedOrder).size === requestedOrder.length &&
    requestedOrder.every((name) => teamConfig.workers.includes(name));
  if (!isPermutation) throw new Error("The member list changed; reload and try again.");
  teamConfig.workers = requestedOrder;
  saveTeamConfig();
}

function removeWorker(workerName: string) {
  if (workerName === MANAGER_NAME) throw new Error("The manager cannot be removed.");
  const index = teamConfig.workers.indexOf(workerName);
  if (index < 0) throw new Error("That worker no longer exists.");

  teamConfig.workers.splice(index, 1);
  saveTeamConfig();
  // A worker added later under the same name starts with a fresh session.
  queries.deleteSessions.run(workerName);
  for (const team of teams.values()) {
    const runtime = team.runtimes.get(workerName);
    if (!runtime) continue;
    stopSilently(runtime);
    team.runtimes.delete(workerName);
  }
  restartManagers();
}

// ---------------------------------------------------------------- browser websocket

function snapshot() {
  const recent = recentWorkspaces();
  const team = projectDirectory ? teamFor(projectDirectory) : null;
  return {
    type: "snapshot",
    clientVersion: clientVersion(),
    workspace: projectDirectory,
    workspaceName: projectDirectory ? basename(projectDirectory) : null,
    recentWorkspaces: recent,
    candidateWorkspaces: candidateWorkspaces().filter((path) => !recent.includes(path)),
    activeWorkspaces: activeWorkspaces(),
    projectSettings: team ? projectSettingsFor(team) : null,
    teamSettings: teamSettings(),
    apiSettings: apiSettings(),
    rateLimit,
    members: team ? memberNames().map((name) => publicMember(team.runtimes.get(name)!)) : [],
    items: team ? itemsFor(team) : [],
    schedules: team ? schedulesFor(team) : [],
  };
}

// Only changes which workspace the UI shows; members elsewhere keep running.
function switchWorkspace(socket: ServerWebSocket<unknown>, requestedPath: string) {
  let nextWorkspace: string;
  try {
    nextWorkspace = validateWorkspace(requestedPath);
  } catch (error) {
    socket.send(JSON.stringify({ type: "workspaceError", message: (error as Error).message }));
    return;
  }

  projectDirectory = nextWorkspace;
  queries.writeSetting.run("workspace", nextWorkspace);
  const recent = [nextWorkspace, ...recentWorkspaces().filter((path) => path !== nextWorkspace)];
  queries.writeSetting.run("recent_workspaces", JSON.stringify(recent.slice(0, RECENT_WORKSPACE_LIMIT)));
  broadcast(snapshot());
}

// Stops every member of a workspace without pinging its Manager about it.
// Sessions are kept, so the next message there resumes where it left off.
function closeWorkspace(requestedPath: string) {
  const team = teams.get(requestedPath);
  if (!team) return;
  for (const runtime of team.runtimes.values()) {
    if (!runtime.process) continue;
    stopSilently(runtime);
    recordEvent(runtime, "system", "Stopped (workspace closed).");
    broadcastMember(runtime);
  }
}

// Kills a member and marks its tasks stopped without pinging the Manager.
function stopSilently(runtime: MemberRuntime) {
  for (const origin of runtime.origins) {
    if (origin.kind === "task" && origin.taskId !== undefined) {
      queries.finishTask.run("stopped", runtime.taskSpent, null, origin.taskId);
      settleItem(runtime.team, itemIdForTask(origin.taskId), "stopped");
    }
  }
  const child = runtime.process;
  runtime.process = null;
  child?.kill();
  if (runtime.deltaTimer) clearTimeout(runtime.deltaTimer);
  Object.assign(runtime, {
    origins: [], status: "asleep", taskSpent: 0, warnedTaskId: null, pendingDelta: "", deltaTimer: null,
    restartPending: false, permissionRequests: [], openTabs: 0,
  });
}

function changeMembers(socket: ServerWebSocket<unknown>, message: any) {
  try {
    if (message.type === "addWorker") socket.send(JSON.stringify({ type: "workerAdded", name: addWorker() }));
    else removeWorker(String(message.name ?? ""));
  } catch (error) {
    socket.send(JSON.stringify({ type: "sendError", message: (error as Error).message }));
    return;
  }
  broadcast(snapshot());
}

// A full snapshot would wipe every browser's loaded histories and unread
// markers, so a reorder only sends the new order (or the unchanged one on error).
function reorderWorkersFrom(socket: ServerWebSocket<unknown>, order: unknown) {
  try {
    reorderWorkers(order);
  } catch (error) {
    socket.send(JSON.stringify({ type: "memberOrderError", message: (error as Error).message }));
    socket.send(JSON.stringify(memberOrderMessage()));
    return;
  }
  broadcast(memberOrderMessage());
}

function memberOrderMessage() {
  return { type: "memberOrder", order: memberNames() };
}

// Applies the Settings page: worker and manager settings (every project, team.json)
// and, when a workspace is open, its project rules. Only members whose launch
// settings changed are restarted (idle ones now, busy ones after their current work).
function saveSettings(socket: ServerWebSocket<unknown>, team: Team | undefined, message: any) {
  let managerConfig: AgentConfig;
  let workerConfig: AgentConfig;
  let instructions = "";
  let allowedTools: string[] = [];
  try {
    managerConfig = validateAgentConfig(message.manager, teamConfig.manager, "Manager");
    workerConfig = validateAgentConfig(message.worker, teamConfig.worker, "Worker");
    if (team) {
      instructions = String(message.instructions ?? "").trim();
      if (instructions.length > MAX_INSTRUCTION_CHARACTERS) throw new Error("Project rules must be under 20,000 characters.");
      allowedTools = validateRules(message.allowedTools, "Project permissions");
    }
    saveApiSettings(message);
  } catch (error) {
    socket.send(JSON.stringify({ type: "settingsError", message: (error as Error).message }));
    return;
  }

  const runtimes = allRuntimes();
  const signaturesBefore = new Map(runtimes.map((runtime) => [runtime, launchSignature(runtime)]));
  teamConfig.manager = managerConfig;
  teamConfig.worker = workerConfig;
  saveTeamConfig();
  for (const runtime of runtimes) runtime.config = memberConfigFor(runtime.config.name);
  if (team) {
    team.instructions = instructions;
    team.allowedTools = allowedTools;
    queries.saveProjectSettings.run(team.workspace, instructions, JSON.stringify(allowedTools));
    broadcast({ type: "projectSettings", workspace: team.workspace, ...projectSettingsFor(team) });
  }

  for (const runtime of runtimes) {
    if (launchSignature(runtime) === signaturesBefore.get(runtime)) continue;
    requestRestart(runtime);
    if (runtime.process) recordEvent(runtime, "system", "Settings changed; restarting to apply them.");
    broadcastMember(runtime);
  }
  broadcast({ type: "teamSettings", ...teamSettings() });
  socket.send(JSON.stringify({ type: "settingsSaved" }));
}

function teamSettings() {
  return { manager: teamConfig.manager, worker: teamConfig.worker };
}

function projectSettingsFor(team: Team) {
  return { instructions: team.instructions, allowedTools: team.allowedTools };
}

// Everything from Settings that a member process reads at launch.
function launchSignature(runtime: MemberRuntime): string {
  return JSON.stringify([runtime.config, runtime.team.instructions, runtime.team.allowedTools]);
}

function handleClientMessage(socket: ServerWebSocket<unknown>, raw: string | Buffer) {
  let message: any;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (message.type === "workspace") return switchWorkspace(socket, String(message.path ?? ""));
  if (message.type === "closeWorkspace") return closeWorkspace(String(message.path ?? ""));
  if (message.type === "addWorker" || message.type === "removeWorker") return changeMembers(socket, message);
  if (message.type === "reorderMembers") return reorderWorkersFrom(socket, message.order);

  // Messages carry the workspace the browser was showing, so a send that races
  // a switch still reaches the right team. Only already-opened workspaces match.
  const workspace = message.workspace ?? projectDirectory;
  const team = workspace === projectDirectory && projectDirectory ? teamFor(projectDirectory) : teams.get(workspace);
  if (message.type === "saveSettings") return saveSettings(socket, team, message);
  if (!team) {
    socket.send(JSON.stringify({ type: "sendError", message: "Pick a workspace first (top of the sidebar)." }));
    return;
  }
  if (message.type === "allowAllPermissions") return allowAllPermissions(team);
  if (message.type === "archiveDoneItems") {
    queries.archiveDoneItems.run(team.workspace);
    return broadcastItems(team);
  }
  if (message.type === "archiveAllItems") {
    queries.archiveAllItems.run(team.workspace);
    return broadcastItems(team);
  }
  if (message.type === "cancelSchedule") {
    try {
      const schedule = cancelSchedule(team, message.scheduleId);
      recordEvent(team.manager, "system", `You cancelled scheduled work #${schedule.id} "${schedule.title}".`);
    } catch (error) {
      socket.send(JSON.stringify({ type: "sendError", message: (error as Error).message }));
    }
    return;
  }
  if (message.type === "archiveItem") {
    queries.archiveItem.run(Number(message.itemId), team.workspace);
    return broadcastItems(team);
  }

  const runtime = team.runtimes.get(message.member);
  if (!runtime) return;

  switch (message.type) {
    case "history":
      socket.send(JSON.stringify({
        type: "history",
        workspace: team.workspace,
        member: runtime.config.name,
        events: queries.recentEvents.all(team.workspace, runtime.config.name, HISTORY_LIMIT),
      }));
      break;
    case "send": {
      let attachments: Attachment[];
      try {
        attachments = validateAttachments(message.attachments);
      } catch (error) {
        socket.send(JSON.stringify({ type: "sendError", message: (error as Error).message }));
        break;
      }
      const typedText = String(message.text ?? "").trim();
      if (!typedText && attachments.length === 0) break;
      const text = typedText || "See the attached file(s).";
      if (message.itemId !== undefined && message.itemId !== null) {
        const item = isManager(runtime) ? queries.findItem.get(Number(message.itemId), team.workspace) : null;
        if (!item) {
          socket.send(JSON.stringify({ type: "sendError", message: "That task summary item no longer exists." }));
          break;
        }
        sendTurn(runtime, text, { kind: "user", itemId: item.id }, "user", attachments, itemQuote(item));
        break;
      }
      if (message.threadId === undefined || message.threadId === null) {
        sendTurn(runtime, text, { kind: text.startsWith("/") ? "command" : "user" }, "user", attachments);
        break;
      }
      const threadRoot = queries.threadRoot.get(Number(message.threadId), team.workspace, runtime.config.name);
      if (!threadRoot) {
        socket.send(JSON.stringify({ type: "sendError", message: "That thread no longer exists." }));
        break;
      }
      sendTurn(runtime, text, { kind: "user", threadId: threadRoot.id }, "user", attachments, threadQuote(threadRoot.text));
      break;
    }
    case "itemEvents":
      socket.send(JSON.stringify({
        type: "itemEvents",
        workspace: team.workspace,
        member: runtime.config.name,
        itemId: Number(message.itemId),
        events: queries.itemEvents.all(team.workspace, Number(message.itemId), HISTORY_LIMIT),
      }));
      break;
    case "compact": {
      const instruction = String(message.instruction ?? "").trim();
      sendTurn(runtime, `/compact${instruction ? ` ${instruction}` : ""}`, { kind: "command" });
      break;
    }
    case "stop":
      stopMember(runtime);
      break;
    case "answerPermission": {
      const decision = message.decision;
      if (decision !== "allow" && decision !== "always" && decision !== "deny") break;
      answerPermission(runtime, String(message.requestId ?? ""), decision);
      break;
    }
    case "reset":
      stopMember(runtime);
      runtime.sessionId = null;
      runtime.contextTokens = 0;
      saveSessionId(runtime, null);
      recordEvent(runtime, "system", "New session started; previous context dropped.");
      broadcastMember(runtime);
      break;
  }
}

// ---------------------------------------------------------------- server

const staticFiles: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/theme.js": "theme.js",
  "/style.css": "style.css",
};

// Open tabs reconnect on their own after a restart and would keep running the old page;
// the snapshot carries this version, and a tab that loaded another one reloads itself.
function clientVersion(): string {
  const contents = Object.values(staticFiles).map((fileName) => {
    try {
      return readFileSync(join(rootDirectory, "public", fileName), "utf8");
    } catch {
      return "";
    }
  });
  return Bun.hash(contents.join("\n")).toString(36);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (bunServer.upgrade(request)) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    if (url.pathname.startsWith("/mcp/")) {
      const [mcpToken, memberName] = url.pathname.slice("/mcp/".length).split("/");
      const team = teamsByMcpToken.get(mcpToken);
      const caller = memberName ? team?.runtimes.get(decodeURIComponent(memberName)) : team?.manager;
      if (!caller) return new Response("Unknown team or member", { status: 404 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      return handleMcpRequest(caller, request);
    }
    const fileName = staticFiles[url.pathname];
    if (fileName) {
      return new Response(Bun.file(join(rootDirectory, "public", fileName)), { headers: { "Cache-Control": "no-cache" } });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    maxPayloadLength: MAX_SOCKET_PAYLOAD_BYTES,
    open(socket) {
      socket.subscribe("team");
      socket.send(JSON.stringify(snapshot()));
    },
    message: handleClientMessage,
    close(socket) {
      socket.unsubscribe("team");
    },
  },
});
broadcast = (message) => server.publish("team", JSON.stringify(message));

setInterval(() => {
  for (const team of teams.values()) watchTeam(team);
}, WATCHDOG_INTERVAL_MS);

setInterval(runDueSchedules, SCHEDULE_SWEEP_INTERVAL_MS);
runDueSchedules();

// Idle members are put to sleep to free memory; the next message resumes their session.
setInterval(() => {
  for (const runtime of allRuntimes()) {
    const idleFor = Date.now() - runtime.lastActiveAt;
    if (runtime.process && runtime.origins.length === 0 && idleFor > idleMilliseconds) runtime.process.kill();
  }
}, 30_000);

function shutdown() {
  for (const runtime of allRuntimes()) runtime.process?.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`vdev running at http://127.0.0.1:${port}  (workspace: ${projectDirectory ?? "none, pick one in the UI"})`);
