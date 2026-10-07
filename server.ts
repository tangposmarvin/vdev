// vdev: local web UI for a team of Claude Code members.
// Each member is a `claude -p` stream-json process using your own Claude login.
// Run: bun server.ts   (config in team.json)

import { Database } from "bun:sqlite";
import type { ServerWebSocket, Subprocess } from "bun";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

type MemberConfig = {
  name: string;
  role: string;
  model: string;
  prompt: string;
  effort?: string;
  tools?: string[];
  allowedTools?: string[];
  permissionMode?: string;
  autocompact?: string;
  budget?: number;
  chrome?: boolean;
  // true: only the team MCP server, without your own MCP servers and claude.ai connectors.
  strictMcp?: boolean;
};

type TeamConfig = {
  port?: number;
  projectDir?: string;
  workspaceRoots?: string[];
  // Your own slash commands (~/.claude/commands/<name>.md) that members may use, e.g. ["cm", "br"].
  commands?: string[];
  idleMinutes?: number;
  members: MemberConfig[];
};

// threadId: the root event of the thread a user reply was sent in; the member's
// output for that turn is filed under the same thread.
type TurnOrigin = { kind: "user" | "task" | "handoff" | "command"; taskId?: number; threadId?: number };

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
  status: "asleep" | "starting" | "idle" | "working" | "compacting";
  contextTokens: number;
  contextWindow: number;
  taskSpent: number;
  warnedTaskId: number | null;
  totalSpent: number;
  lastActiveAt: number;
  pendingDelta: string;
  deltaTimer: Timer | null;
  stderrTail: string;
  restartPending: boolean;
  // Extra allow rules for this workspace only, on top of team.json's allowedTools.
  workspaceAllowedTools: string[];
  // Claude in Chrome override for this workspace; null = the member's team.json default.
  projectChrome: boolean | null;
  permissionRequests: PermissionRequest[];
  // Tool calls you denied in the UI; their denial needs no "add a rule" hint.
  deniedByUser: Set<string>;
};

// One set of member processes per workspace, so switching workspaces in the UI
// never interrupts the members working elsewhere.
type Team = {
  workspace: string;
  mcpToken: string;
  // Project settings: instructions and allow rules for every member in this workspace.
  instructions: string;
  allowedTools: string[];
  chrome: boolean;
  // "Always allow" saves the rule for every member here instead of only the one who asked.
  sharePermissions: boolean;
  runtimes: Map<string, MemberRuntime>;
  manager: MemberRuntime;
};

const DEFAULT_BUDGET = 150_000;
const DELTA_FLUSH_MS = 150;
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

// ---------------------------------------------------------------- shared slash commands

// Members run without your user settings, so your commands reach them as a small
// plugin. Plugin commands are namespaced ("/vdev-commands:cm"); sendTurn maps "/cm".
const COMMAND_PLUGIN_NAME = "vdev-commands";
const userCommandsDirectory = join(homedir(), ".claude", "commands");
const commandPluginDirectory = join(rootDirectory, ".member-plugin");

type SharedCommand = { name: string; description: string };

// Copied at startup; restart vdev after editing a command file.
function buildCommandPlugin(): SharedCommand[] {
  rmSync(commandPluginDirectory, { recursive: true, force: true });
  const sharedCommands: SharedCommand[] = [];
  for (const name of teamConfig.commands ?? []) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) continue;
    const sourcePath = join(userCommandsDirectory, `${name}.md`);
    if (!existsSync(sourcePath)) continue;
    mkdirSync(join(commandPluginDirectory, "commands"), { recursive: true });
    copyFileSync(sourcePath, join(commandPluginDirectory, "commands", `${name}.md`));
    sharedCommands.push({ name, description: commandDescription(readFileSync(sourcePath, "utf8")) });
  }
  if (sharedCommands.length === 0) return [];
  mkdirSync(join(commandPluginDirectory, ".claude-plugin"), { recursive: true });
  writeFileSync(join(commandPluginDirectory, ".claude-plugin", "plugin.json"), JSON.stringify({
    name: COMMAND_PLUGIN_NAME, version: "1.0.0", description: "Your slash commands, shared with vdev members",
  }));
  return sharedCommands;
}

// The frontmatter description, else the first heading.
function commandDescription(markdown: string): string {
  const frontmatterDescription = markdown.match(/^---\n[\s\S]*?^description:\s*(.+)$[\s\S]*?^---/m)?.[1];
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1];
  return (frontmatterDescription ?? heading ?? "").trim().replace(/^["']|["']$/g, "");
}

const sharedCommands = buildCommandPlugin();

// "/cm fix login" -> "/vdev-commands:cm fix login"; anything else is unchanged.
function expandSharedCommand(text: string): string {
  const match = text.match(/^\/([a-z0-9_-]+)(?=\s|$)/i);
  if (!match || !sharedCommands.some((command) => command.name === match[1])) return text;
  return `/${COMMAND_PLUGIN_NAME}:${match[1]}${text.slice(match[0].length)}`;
}

function sharedCommandsNote(): string {
  if (sharedCommands.length === 0) return "";
  const list = sharedCommands.map((command) => `- /${command.name}: ${command.description}`).join("\n");
  return `\n\nThe user's slash commands are available to you:\n${list}\n` +
    `When asked to run one (e.g. "/${sharedCommands[0].name}"), invoke it with the Skill tool as ` +
    `"${COMMAND_PLUGIN_NAME}:<name>" and follow its instructions.`;
}

function expandPath(path: string): string {
  return resolve(rootDirectory, path.trim().replace(/^~(?=\/|$)/, homedir()));
}

// Returns the canonical path, or throws with a message suitable for the UI.
// vdev's own directory (and anything inside or above it) is refused so members
// can never edit team.json or server.ts and widen their own permissions.
function validateWorkspace(path: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(expandPath(path));
  } catch {
    throw new Error(`Folder not found: ${path}`);
  }
  if (!statSync(canonicalPath).isDirectory()) throw new Error(`Not a folder: ${path}`);
  const insideVdev = canonicalPath === rootDirectory || canonicalPath.startsWith(rootDirectory + sep);
  const containsVdev = rootDirectory.startsWith(canonicalPath + sep);
  if (insideVdev || containsVdev) throw new Error("A workspace cannot be vdev itself, inside it, or a folder that contains it.");
  return canonicalPath;
}

const managerName = teamConfig.members.find((member) => member.role === "manager")?.name;
if (!managerName) throw new Error("team.json needs one member with role \"manager\"");

function isManagerConfig(memberConfig: MemberConfig): boolean {
  return memberConfig.name === managerName;
}

function workerConfigs(): MemberConfig[] {
  return teamConfig.members.filter((memberConfig) => !isManagerConfig(memberConfig));
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
  CREATE TABLE IF NOT EXISTS member_permissions (
    name TEXT NOT NULL, workspace TEXT NOT NULL, allowed_tools TEXT NOT NULL, PRIMARY KEY (name, workspace));
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
`);
for (const table of ["events", "tasks"]) {
  const columns = database.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === "workspace")) database.exec(`ALTER TABLE ${table} ADD COLUMN workspace TEXT`);
}
// Claude in Chrome per project: on for everyone, and a per-member override
// (NULL = use the member's own default from team.json).
for (const [table, definition] of [["project_settings", "INTEGER NOT NULL DEFAULT 0"], ["member_permissions", "INTEGER"]]) {
  const columns = database.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === "chrome")) database.exec(`ALTER TABLE ${table} ADD COLUMN chrome ${definition}`);
}
// On by default, including for projects saved before the setting existed.
if (!database.query<{ name: string }, []>("PRAGMA table_info(project_settings)").all().some((column) => column.name === "share_permissions")) {
  database.exec("ALTER TABLE project_settings ADD COLUMN share_permissions INTEGER NOT NULL DEFAULT 1");
}
database.exec("CREATE INDEX IF NOT EXISTS events_workspace_member_id ON events (workspace, member, id)");
// Thread replies point at their root event; NULL means the main conversation.
if (!database.query<{ name: string }, []>("PRAGMA table_info(events)").all().some((column) => column.name === "thread_id")) {
  database.exec("ALTER TABLE events ADD COLUMN thread_id INTEGER");
}

const queries = {
  readSetting: database.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?"),
  writeSetting: database.query("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2"),
  sessionFor: database.query<{ session_id: string | null }, [string, string]>(
    "SELECT session_id FROM member_sessions WHERE name = ? AND workspace = ?"),
  saveSession: database.query(
    "INSERT INTO member_sessions (name, workspace, session_id) VALUES (?1, ?2, ?3) " +
    "ON CONFLICT(name, workspace) DO UPDATE SET session_id = ?3"),
  insertEvent: database.query<{ id: number }, [string, string, string, string, number, number | null]>(
    "INSERT INTO events (workspace, member, kind, text, created_at, thread_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"),
  recentEvents: database.query<{ id: number; kind: string; text: string; created_at: number; thread_id: number | null }, [string, string, number]>(
    "SELECT * FROM (SELECT id, kind, text, created_at, thread_id FROM events WHERE workspace = ? AND member = ? " +
    "ORDER BY id DESC LIMIT ?) ORDER BY id"),
  threadRoot: database.query<{ id: number; text: string }, [number, string, string]>(
    "SELECT id, text FROM events WHERE id = ? AND workspace = ? AND member = ? AND kind = 'assistant' AND thread_id IS NULL"),
  insertTask: database.query<{ id: number }, [string, string, string, number, number]>(
    "INSERT INTO tasks (workspace, member, brief, status, budget, created_at) VALUES (?, ?, ?, 'running', ?, ?) RETURNING id"),
  findTask: database.query<{ id: number; member: string; brief: string; status: string; budget: number; spent: number }, [number]>(
    "SELECT id, member, brief, status, budget, spent FROM tasks WHERE id = ?"),
  finishTask: database.query("UPDATE tasks SET status = ?, spent = ?, result = ? WHERE id = ? AND status = 'running'"),
  insertUsage: database.query(
    "INSERT INTO usage (member, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
  deleteSessions: database.query("DELETE FROM member_sessions WHERE name = ?"),
  permissionsFor: database.query<{ allowed_tools: string; chrome: number | null }, [string, string]>(
    "SELECT allowed_tools, chrome FROM member_permissions WHERE name = ? AND workspace = ?"),
  savePermissions: database.query(
    "INSERT INTO member_permissions (name, workspace, allowed_tools, chrome) VALUES (?1, ?2, ?3, ?4) " +
    "ON CONFLICT(name, workspace) DO UPDATE SET allowed_tools = ?3, chrome = ?4"),
  deletePermissions: database.query("DELETE FROM member_permissions WHERE name = ?"),
  copyPermissions: database.query(
    "INSERT OR REPLACE INTO member_permissions (name, workspace, allowed_tools, chrome) " +
    "SELECT ?1, workspace, allowed_tools, chrome FROM member_permissions WHERE name = ?2"),
  projectSettingsFor: database.query<{ instructions: string; allowed_tools: string; chrome: number; share_permissions: number }, [string]>(
    "SELECT instructions, allowed_tools, chrome, share_permissions FROM project_settings WHERE workspace = ?"),
  saveProjectSettings: database.query(
    "INSERT INTO project_settings (workspace, instructions, allowed_tools, chrome, share_permissions) VALUES (?1, ?2, ?3, ?4, ?5) " +
    "ON CONFLICT(workspace) DO UPDATE SET instructions = ?2, allowed_tools = ?3, chrome = ?4, share_permissions = ?5"),
  totalSpent: database.query<{ total: number | null }, [string]>(
    "SELECT SUM(input_tokens + output_tokens + cache_write_tokens) AS total FROM usage WHERE member = ?"),
};

// Tasks left running by a previous server process can never finish.
database.exec("UPDATE tasks SET status = 'stopped' WHERE status = 'running'");

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
function candidateWorkspaces(): string[] {
  const candidates: string[] = [];
  for (const workspaceRoot of teamConfig.workspaceRoots ?? ["~/code"]) {
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
    chrome: Boolean(projectSettings?.chrome),
    sharePermissions: projectSettings ? Boolean(projectSettings.share_permissions) : true,
  } as Team;
  for (const memberConfig of teamConfig.members) addRuntime(team, memberConfig);
  team.manager = team.runtimes.get(managerName!)!;
  teams.set(workspace, team);
  teamsByMcpToken.set(team.mcpToken, team);
  return team;
}

function addRuntime(team: Team, memberConfig: MemberConfig) {
  const memberSettings = queries.permissionsFor.get(memberConfig.name, team.workspace);
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
    pendingDelta: "",
    deltaTimer: null,
    stderrTail: "",
    restartPending: false,
    permissionRequests: [],
    deniedByUser: new Set(),
    workspaceAllowedTools: parseRules(memberSettings?.allowed_tools),
    projectChrome: memberSettings?.chrome === null || memberSettings?.chrome === undefined ? null : Boolean(memberSettings.chrome),
  });
}

function usesChrome(runtime: MemberRuntime): boolean {
  return runtime.team.chrome || (runtime.projectChrome ?? Boolean(runtime.config.chrome));
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

function currentTask(runtime: MemberRuntime) {
  const origin = runtime.origins[0];
  if (origin?.kind !== "task" || origin.taskId === undefined) return null;
  return queries.findTask.get(origin.taskId);
}

function publicMember(runtime: MemberRuntime) {
  const task = currentTask(runtime);
  return {
    name: runtime.config.name,
    role: runtime.config.role,
    model: runtime.config.model,
    chrome: usesChrome(runtime),
    chromeDefault: Boolean(runtime.config.chrome),
    projectChrome: runtime.projectChrome,
    allowedTools: runtime.config.allowedTools ?? [],
    workspaceAllowedTools: runtime.workspaceAllowedTools,
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

function recordEvent(runtime: MemberRuntime, kind: string, text: string, threadId: number | null = null) {
  const createdAt = Date.now();
  const row = queries.insertEvent.get(runtime.team.workspace, runtime.config.name, kind, text, createdAt, threadId)!;
  broadcast({
    type: "event", workspace: runtime.team.workspace, member: runtime.config.name,
    event: { id: row.id, kind, text, created_at: createdAt, thread_id: threadId },
  });
}

// The thread the member's current turn belongs to, if it answers a thread reply.
function currentThreadId(runtime: MemberRuntime): number | null {
  return runtime.origins[0]?.threadId ?? null;
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

function rolePromptFor(memberConfig: MemberConfig, chrome: boolean): string {
  if (isManagerConfig(memberConfig)) {
    const roster = workerConfigs().map((worker) => `- ${worker.name}: ${worker.role}`).join("\n");
    return `${memberConfig.prompt}\n\nYour team (use these names with delegate_task):\n${roster}\n` +
      "The user can add members while you run; team_status always shows the current team, so check it before saying a member does not exist.\n\n" +
      "Each task starts the member from a clean context, so every brief must be self-contained " +
      "(goal, relevant files, acceptance criteria, what earlier tasks found). " +
      "Handoffs arrive as messages starting with [Handoff from <member>, task #N]. " +
      "Members can message you at any time ([Message from <member>]); answer with message_member when they need something, " +
      "and do not reply to plain acknowledgements. " +
      "Messages starting with [Task #N ...] are status notices from the system." +
      (sharedCommands.length > 0
        ? ` Members can run the user's slash commands (${sharedCommands.map((command) => `/${command.name}`).join(", ")}) when a brief or message asks them to.`
        : "");
  }
  const chromeNote = chrome
    ? "\n\nYou can use Claude in Chrome (the user's real browser, with their logins). Other members may use it at the same time: " +
      "always open your own tab with tabs_create_mcp, never act in tabs you did not create, and close your tabs when done."
    : "";
  return `${memberConfig.prompt}${chromeNote}${sharedCommandsNote()}\n\nYou are "${memberConfig.name}" on a team led by a Manager. ` +
    "Messages starting with [Task #N from Manager] are assignments. Finish each assignment with a short handoff: " +
    "Summary, Files changed, Open issues. Keep it under 15 lines; the Manager sees this final message automatically. " +
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
    "--model", memberConfig.model,
    "--append-system-prompt", systemPromptFor(runtime),
    // Include your user settings so members get the same permissions, hooks and plugins as your terminal.
    "--setting-sources", "user,project,local",
    "--mcp-config", JSON.stringify(mcpConfig),
    "--permission-mode", memberConfig.permissionMode ?? "acceptEdits",
    // Tool calls that need approval arrive as control requests on stdout and
    // wait for the user's answer in the UI (see handlePermissionRequest).
    "--permission-prompt-tool", "stdio",
  ];
  if (memberConfig.strictMcp) commandArguments.push("--strict-mcp-config");
  if (memberConfig.effort) commandArguments.push("--effort", memberConfig.effort);
  if (memberConfig.autocompact) commandArguments.push("--autocompact", memberConfig.autocompact);
  if (memberConfig.tools) commandArguments.push("--tools", memberConfig.tools.join(","));
  // Enabling Chrome also allows its tools, as when you run Claude in a terminal
  // with Chrome; the extension's own per-site permissions still apply.
  commandArguments.push(usesChrome(runtime) ? "--chrome" : "--no-chrome");
  if (sharedCommands.length > 0) commandArguments.push("--plugin-dir", commandPluginDirectory);
  const allowedTools = [
    ...(memberConfig.allowedTools ?? []),
    ...runtime.team.allowedTools,
    ...runtime.workspaceAllowedTools,
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
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  runtime.process = child;
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
  runtime.status = "asleep";
  broadcastMember(runtime);
}

function abandonPendingTurns(runtime: MemberRuntime, status: "stopped" | "over_budget") {
  for (const origin of runtime.origins.splice(0)) {
    if (origin.kind !== "task" || origin.taskId === undefined) continue;
    const task = queries.findTask.get(origin.taskId);
    if (!task || task.status !== "running") continue;
    queries.finishTask.run(status, runtime.taskSpent, null, task.id);
    notifyManager(runtime.team, `[Task #${task.id} for ${runtime.config.name} ${status.replace("_", " ")} after ${formatTokens(runtime.taskSpent)} tokens; no handoff was produced]`);
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

// threadRoot: for a thread reply, the message being answered; it is quoted to the member.
function sendTurn(runtime: MemberRuntime, text: string, origin: TurnOrigin, eventKind = "user", attachments: Attachment[] = [],
  threadRoot: { id: number; text: string } | null = null) {
  const child = ensureProcess(runtime);
  if (origin.kind === "task" && !runtime.origins.some((pending) => pending.kind === "task")) runtime.taskSpent = 0;
  runtime.origins.push(threadRoot ? { ...origin, threadId: threadRoot.id } : origin);
  if (runtime.status !== "compacting") runtime.status = "working";
  runtime.lastActiveAt = Date.now();
  // Only file names are stored; the file contents go to the member, not the database.
  const attachmentNote = attachments.length > 0 ? `\n\n[Attached: ${attachments.map((attachment) => attachment.name).join(", ")}]` : "";
  recordEvent(runtime, eventKind, text + attachmentNote, threadRoot?.id ?? null);
  const memberText = threadRoot ? `${threadQuote(threadRoot.text)}\n${text}` : expandSharedCommand(text);
  const content = attachments.length > 0 ? [...attachments.map(contentBlockFor), { type: "text", text: memberText }] : memberText;
  child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  child.stdin.flush();
  broadcastMember(runtime);
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
  runtime.origins.push({ kind: "command" });
  if (runtime.status !== "compacting") runtime.status = "working";
  runtime.contextTokens = 0;
  recordEvent(runtime, "system", note);
  child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "/clear" } }) + "\n");
  child.stdin.flush();
}

function notifyManager(team: Team, text: string) {
  sendTurn(team.manager, text, { kind: "handoff" }, "handoff");
}

// ---------------------------------------------------------------- stream-json handling

function handleLine(runtime: MemberRuntime, line: string) {
  let data: any;
  try {
    data = JSON.parse(line);
  } catch {
    return;
  }
  runtime.lastActiveAt = Date.now();

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
  if (!browser && coveredBySharedRule(runtime.team, toolName, input, rule)) {
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

  runtime.permissionRequests.push({
    requestId: String(data.request_id),
    toolName,
    input,
    summary: browser && request.description ? `${request.description}\n${summarizeToolUse(toolName, input)}` : summarizeToolUse(toolName, input),
    rule,
    browser,
    grantRules,
    toolUseId: request.tool_use_id ? String(request.tool_use_id) : null,
    createdAt: Date.now(),
  });
  broadcastMember(runtime);
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

// True when the rule vdev would suggest for this call is one already shared with every
// member. Only for a single plain command: a prefix rule like Bash(bundle exec rspec *)
// must never approve "bundle exec rspec; rm -rf tmp", which Claude Code itself would refuse.
function coveredBySharedRule(team: Team, toolName: string, input: Record<string, unknown>, rule: string): boolean {
  if (!team.sharePermissions || !team.allowedTools.includes(rule)) return false;
  if (toolName !== "Bash") return rule === toolName;
  return !/[;&|`$<>()\\\n]/.test(String(input.command ?? ""));
}

// Rules you wrote (member, Project settings, per member) that cover a Chrome
// action: its tool name, the CLI's suggested rule (e.g. ClaudeInChromeDomain(localhost)),
// ClaudeInChromeDomain(*) for every site, or mcp__claude-in-chrome for everything.
// The mcp__claude-in-chrome rule vdev adds itself for Chrome members does not count.
function browserActionAllowed(runtime: MemberRuntime, toolName: string, grantRules: string[]): boolean {
  const rules = new Set([...(runtime.config.allowedTools ?? []), ...runtime.team.allowedTools, ...runtime.workspaceAllowedTools]);
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

// "always" also saves the suggested rule, so later calls like it run without
// asking (now and after restarts): for this member in this workspace, or for
// Chrome sites, for every member in this workspace.
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
    if (request.browser || runtime.team.sharePermissions) saveProjectRule(runtime.team, request.rule);
    else saveMemberRule(runtime, request.rule);
  }
  writeControlResponse(runtime, { subtype: "success", request_id: requestId, response: allowResponse });
  if (decision === "allow") return recordEvent(runtime, "system", `Allowed once: ${summaryLine}`);
  const shared = request.browser || runtime.team.sharePermissions;
  recordEvent(runtime, "system", shared
    ? `Allowed: ${summaryLine}\nSaved rule ${request.rule} for all members in this workspace.`
    : `Allowed: ${summaryLine}\nSaved rule ${request.rule} for ${runtime.config.name} in this workspace.`);
  if (shared && !request.browser) allowPendingRequestsCoveredBy(runtime.team, request.rule);
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
      if (pending.browser || pending.rule !== rule) continue;
      if (!coveredBySharedRule(team, pending.toolName, pending.input, rule)) continue;
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
  queries.saveProjectSettings.run(team.workspace, team.instructions, JSON.stringify(team.allowedTools), team.chrome ? 1 : 0,
    team.sharePermissions ? 1 : 0);
  broadcast({ type: "projectSettings", workspace: team.workspace, ...projectSettingsFor(team) });
}

function saveMemberRule(runtime: MemberRuntime, rule: string) {
  if (runtime.workspaceAllowedTools.includes(rule)) return;
  runtime.workspaceAllowedTools = [...runtime.workspaceAllowedTools, rule];
  queries.savePermissions.run(runtime.config.name, runtime.team.workspace, JSON.stringify(runtime.workspaceAllowedTools),
    runtime.projectChrome === null ? null : runtime.projectChrome ? 1 : 0);
  broadcast({ type: "projectSettings", workspace: runtime.team.workspace, ...projectSettingsFor(runtime.team) });
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
  broadcast({ type: "delta", workspace: runtime.team.workspace, member: runtime.config.name, text: runtime.pendingDelta, threadId: currentThreadId(runtime) });
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
  const threadId = currentThreadId(runtime);
  for (const block of data.message?.content ?? []) {
    if (block.type === "text" && block.text?.trim() && !isSubagent) {
      flushDelta(runtime);
      recordEvent(runtime, "assistant", block.text, threadId);
    } else if (block.type === "tool_use") {
      recordEvent(runtime, "tool", summarizeToolUse(block.name, block.input ?? {}), threadId);
    }
  }
}

function summarizeToolUse(toolName: string, input: Record<string, unknown>): string {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.member ?? input.text ?? JSON.stringify(input);
  const label = toolName.replace(/^mcp__team__/, "");
  return `${label}  ${String(detail).replace(/\s+/g, " ").slice(0, 200)}`;
}

function handleResult(runtime: MemberRuntime, data: any) {
  flushDelta(runtime);
  const origin = runtime.origins.shift();
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
      "in Project settings (this workspace) or Edit member (every workspace).");
  }

  runtime.deniedByUser.clear();

  if (data.is_error && data.subtype !== "success") {
    recordEvent(runtime, "error", `Turn ended: ${data.subtype}${data.result ? `\n${data.result}` : ""}`);
  }

  if (origin?.kind === "task" && origin.taskId !== undefined) {
    const failed = Boolean(data.is_error);
    queries.finishTask.run(failed ? "failed" : "done", runtime.taskSpent, data.result ?? null, origin.taskId);
    const header = `[Handoff from ${runtime.config.name}, task #${origin.taskId}${failed ? ", FAILED" : ""}, ${formatTokens(runtime.taskSpent)} tokens]`;
    notifyManager(runtime.team, `${header}\n${data.result || "(no summary returned)"}`);
    runtime.taskSpent = 0;
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

function workerNames(): string[] {
  return workerConfigs().map((worker) => worker.name);
}

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
      "starting with [Handoff from <member>, task #N]. Tasks for the same member run in order.",
    inputSchema: {
      type: "object",
      properties: {
        member: memberNameSchema,
        brief: { type: "string", description: "What to do, acceptance criteria, and relevant files." },
        budget_tokens: { type: "integer", description: "Optional token budget. Defaults to the member's budget." },
      },
      required: ["member", "brief"],
      additionalProperties: false,
    },
  },
  {
    name: "team_status",
    description: "Every member's state, current task, queue length and tokens spent against budget.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
    notifyManager(team, `[Message from ${caller.config.name}]\n${text}`);
    return "Sent to the Manager. Continue your work; any answer arrives as a message.";
  }

  if (toolName === "team_status") {
    return workerConfigs().map((worker) => {
      const member = publicMember(team.runtimes.get(worker.name)!);
      const taskText = member.task
        ? `task #${member.task.id} (${formatTokens(member.task.spent)}/${formatTokens(member.task.budget)})`
        : "no task";
      return `${member.name}: ${member.status}, ${taskText}, ${member.queued} queued`;
    }).join("\n");
  }

  const runtime = team.runtimes.get(input?.member);
  if (!runtime || isManager(runtime)) throw new Error(`Unknown member. Use one of: ${workerNames().join(", ")}`);

  if (toolName === "message_member") {
    const text = String(input?.text ?? "").trim();
    if (!text) throw new Error("text is required");
    sendTurn(runtime, `[Message from ${caller.config.name}]\n${text}`, { kind: "handoff" }, "handoff");
    return `Sent to ${runtime.config.name}. Their reply, if any, arrives as a message.`;
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
    const taskId = queries.insertTask.get(team.workspace, runtime.config.name, brief, budget, Date.now())!.id;
    // Every task starts from a clean context; the brief must say everything needed.
    clearContext(runtime, `Context cleared for task #${taskId}.`);
    sendTurn(runtime, `[Task #${taskId} from Manager]\n${brief}`, { kind: "task", taskId }, "task");
    const position = runtime.origins.filter((origin) => origin.kind === "task").length - 1;
    return `Task #${taskId} assigned to ${runtime.config.name} (budget ${formatTokens(budget)} tokens` +
      `${position > 0 ? `, ${position} ahead in queue` : ""}). The handoff will arrive as a message.`;
  }
  throw new Error(`Unknown tool ${toolName}`);
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

// ---------------------------------------------------------------- member configuration

const MEMBER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MODEL_PATTERN = /^[A-Za-z0-9._\-\[\]]{1,80}$/;
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
const MAX_PROMPT_CHARACTERS = 20_000;

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

// Builds a clean MemberConfig from browser input. Throws with a message suitable for the UI.
function validateMemberConfig(raw: any, existingConfig: MemberConfig | undefined): MemberConfig {
  const name = existingConfig?.name ?? String(raw?.name ?? "").trim();
  if (!existingConfig) {
    if (!MEMBER_NAME_PATTERN.test(name)) throw new Error("Name must start with a letter and use only a-z, 0-9, - or _ (max 32).");
    if (teamConfig.members.some((memberConfig) => memberConfig.name === name)) throw new Error(`A member named "${name}" already exists.`);
  }

  const managing = existingConfig ? isManagerConfig(existingConfig) : false;
  const role = managing ? "manager" : String(raw?.role ?? "").trim();
  if (!role || role.length > 120) throw new Error("Role is required (max 120 characters).");
  if (!managing && role === "manager") throw new Error("There can only be one manager.");

  const model = String(raw?.model ?? "").trim();
  if (!MODEL_PATTERN.test(model)) throw new Error("Model is required, e.g. sonnet, opus, haiku or a full model ID.");

  const prompt = String(raw?.prompt ?? "").trim();
  if (!prompt) throw new Error("Prompt is required.");
  if (prompt.length > MAX_PROMPT_CHARACTERS) throw new Error("Prompt must be under 20,000 characters.");

  const effort = optionalText(raw?.effort);
  if (effort && !EFFORT_LEVELS.includes(effort)) throw new Error(`Effort must be one of: ${EFFORT_LEVELS.join(", ")}.`);

  const permissionMode = optionalText(raw?.permissionMode);
  if (permissionMode && !PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`Permission mode must be one of: ${PERMISSION_MODES.join(", ")}.`);
  }

  let budget: number | undefined;
  if (optionalText(raw?.budget)) {
    budget = Number(raw.budget);
    if (!Number.isInteger(budget) || budget < 1000) throw new Error("Budget must be a whole number of at least 1000 tokens.");
  }

  const autocompact = optionalText(raw?.autocompact);
  if (autocompact && autocompact.length > 40) throw new Error("Autocompact setting is too long.");

  const memberConfig: MemberConfig = { name, role, model, prompt };
  if (effort) memberConfig.effort = effort;
  if (permissionMode) memberConfig.permissionMode = permissionMode;
  if (budget) memberConfig.budget = budget;
  if (autocompact) memberConfig.autocompact = autocompact;
  if (raw?.chrome === true) memberConfig.chrome = true;
  const tools = toolList(raw?.tools, "Available tools");
  if (tools) memberConfig.tools = tools;
  const allowedTools = toolList(raw?.allowedTools, "Allowed tools");
  if (allowedTools) memberConfig.allowedTools = allowedTools;
  return memberConfig;
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

// The Manager's roster and delegate_task tool list are fixed at launch.
function restartManagers() {
  for (const team of teams.values()) requestRestart(team.manager);
}

// copyPermissionsFrom: for a new member made from a template, also copy the
// template's per-workspace permissions and Chrome overrides from Project settings.
function saveMember(raw: any, copyPermissionsFrom?: unknown) {
  const existingIndex = teamConfig.members.findIndex((memberConfig) => memberConfig.name === raw?.originalName);
  const existingConfig = existingIndex >= 0 ? teamConfig.members[existingIndex] : undefined;
  if (raw?.originalName && !existingConfig) throw new Error("That member no longer exists.");
  const memberConfig = validateMemberConfig(raw, existingConfig);

  if (existingConfig) teamConfig.members[existingIndex] = memberConfig;
  else teamConfig.members.push(memberConfig);
  saveTeamConfig();

  const template = teamConfig.members.find((candidate) => candidate.name === copyPermissionsFrom);
  if (!existingConfig && template && !isManagerConfig(template)) {
    queries.deletePermissions.run(memberConfig.name);
    queries.copyPermissions.run(memberConfig.name, template.name);
  }

  for (const team of teams.values()) {
    const runtime = team.runtimes.get(memberConfig.name);
    if (!runtime) {
      addRuntime(team, memberConfig);
      continue;
    }
    runtime.config = memberConfig;
    requestRestart(runtime);
  }
  if (!existingConfig || existingConfig.role !== memberConfig.role) restartManagers();
}

// Sidebar order is team.json's member order. The manager keeps its slot; only
// workers move. Order is cosmetic, so nothing restarts.
function reorderMembers(raw: unknown) {
  if (!Array.isArray(raw)) throw new Error("Member order must be a list of names.");
  const requestedOrder = raw.map(String);
  const currentWorkers = workerNames();
  const isPermutation = requestedOrder.length === currentWorkers.length &&
    new Set(requestedOrder).size === requestedOrder.length &&
    requestedOrder.every((name) => currentWorkers.includes(name));
  if (!isPermutation) throw new Error("The member list changed; reload and try again.");

  const configsByName = new Map(teamConfig.members.map((memberConfig) => [memberConfig.name, memberConfig]));
  const remainingWorkers = requestedOrder.map((name) => configsByName.get(name)!);
  teamConfig.members = teamConfig.members.map((memberConfig) =>
    isManagerConfig(memberConfig) ? memberConfig : remainingWorkers.shift()!
  );
  saveTeamConfig();
}

function removeMember(memberName: string) {
  const index = teamConfig.members.findIndex((memberConfig) => memberConfig.name === memberName);
  if (index < 0) throw new Error("That member no longer exists.");
  if (isManagerConfig(teamConfig.members[index])) throw new Error("The manager cannot be removed.");

  teamConfig.members.splice(index, 1);
  saveTeamConfig();
  // A member added later under the same name starts with a fresh session.
  queries.deleteSessions.run(memberName);
  queries.deletePermissions.run(memberName);
  for (const team of teams.values()) {
    const runtime = team.runtimes.get(memberName);
    if (!runtime) continue;
    stopSilently(runtime);
    team.runtimes.delete(memberName);
  }
  restartManagers();
}

// ---------------------------------------------------------------- browser websocket

function snapshot() {
  const recent = recentWorkspaces();
  const team = projectDirectory ? teamFor(projectDirectory) : null;
  return {
    type: "snapshot",
    workspace: projectDirectory,
    workspaceName: projectDirectory ? basename(projectDirectory) : null,
    recentWorkspaces: recent,
    candidateWorkspaces: candidateWorkspaces().filter((path) => !recent.includes(path)),
    activeWorkspaces: activeWorkspaces(),
    projectSettings: team ? projectSettingsFor(team) : null,
    memberConfigs: teamConfig.members,
    rateLimit,
    members: team
      ? teamConfig.members.map((memberConfig) => publicMember(team.runtimes.get(memberConfig.name)!))
      : [],
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
    }
  }
  const child = runtime.process;
  runtime.process = null;
  child?.kill();
  if (runtime.deltaTimer) clearTimeout(runtime.deltaTimer);
  Object.assign(runtime, {
    origins: [], status: "asleep", taskSpent: 0, warnedTaskId: null, pendingDelta: "", deltaTimer: null,
    restartPending: false, permissionRequests: [],
  });
}

function changeMembers(socket: ServerWebSocket<unknown>, message: any) {
  try {
    if (message.type === "saveMember") saveMember(message.config, message.copyPermissionsFrom);
    else removeMember(String(message.name ?? ""));
  } catch (error) {
    socket.send(JSON.stringify({ type: "memberError", message: (error as Error).message }));
    return;
  }
  socket.send(JSON.stringify({ type: "memberSaved" }));
  broadcast(snapshot());
}

// A full snapshot would wipe every browser's loaded histories and unread
// markers, so a reorder only sends the new order (or the unchanged one on error).
function reorderMembersFrom(socket: ServerWebSocket<unknown>, order: unknown) {
  try {
    reorderMembers(order);
  } catch (error) {
    socket.send(JSON.stringify({ type: "memberOrderError", message: (error as Error).message }));
    socket.send(JSON.stringify(memberOrderMessage()));
    return;
  }
  broadcast(memberOrderMessage());
}

function memberOrderMessage() {
  return { type: "memberOrder", order: teamConfig.members.map((memberConfig) => memberConfig.name) };
}

const MAX_RULES = 100;
const MAX_INSTRUCTION_CHARACTERS = 20_000;

function validateRules(value: unknown, label: string): string[] {
  const rules = toolList(value, label) ?? [];
  if (rules.length > MAX_RULES) throw new Error(`${label}: at most ${MAX_RULES} rules.`);
  return rules;
}

// Applies the Project settings page. Only members whose effective settings
// changed are restarted (idle ones now, busy ones after their current work).
function saveProjectSettings(socket: ServerWebSocket<unknown>, team: Team, message: any) {
  let instructions: string;
  let allowedTools: string[];
  const memberChanges = new Map<MemberRuntime, { allowedTools: string[]; chrome: boolean | null }>();
  try {
    instructions = String(message.instructions ?? "").trim();
    if (instructions.length > MAX_INSTRUCTION_CHARACTERS) throw new Error("Project rules must be under 20,000 characters.");
    allowedTools = validateRules(message.allowedTools, "Permissions for all members");
    for (const [memberName, memberSettings] of Object.entries<any>(message.members ?? {})) {
      const runtime = team.runtimes.get(memberName);
      if (!runtime) throw new Error(`Unknown member ${memberName}; reload the page.`);
      memberChanges.set(runtime, {
        allowedTools: validateRules(memberSettings?.allowedTools, `Permissions for ${memberName}`),
        // Left out means "not touched": keep inheriting (or keep the earlier override).
        chrome: typeof memberSettings?.chrome === "boolean" ? memberSettings.chrome : runtime.projectChrome,
      });
    }
  } catch (error) {
    socket.send(JSON.stringify({ type: "projectSettingsError", message: (error as Error).message }));
    return;
  }

  const signaturesBefore = new Map([...team.runtimes.values()].map((runtime) => [runtime, launchSignature(runtime)]));
  team.instructions = instructions;
  team.allowedTools = allowedTools;
  team.chrome = message.chrome === true;
  team.sharePermissions = message.sharePermissions !== false;
  queries.saveProjectSettings.run(team.workspace, instructions, JSON.stringify(allowedTools), team.chrome ? 1 : 0,
    team.sharePermissions ? 1 : 0);
  for (const [runtime, change] of memberChanges) {
    runtime.workspaceAllowedTools = change.allowedTools;
    runtime.projectChrome = change.chrome;
    queries.savePermissions.run(runtime.config.name, team.workspace, JSON.stringify(change.allowedTools),
      change.chrome === null ? null : change.chrome ? 1 : 0);
  }

  // Only members whose launch settings actually changed are restarted, but every
  // member is re-sent so the browser sees saved overrides that changed nothing yet.
  for (const runtime of team.runtimes.values()) {
    if (launchSignature(runtime) !== signaturesBefore.get(runtime)) {
      requestRestart(runtime);
      if (runtime.process) recordEvent(runtime, "system", "Project settings changed; restarting to apply them.");
    }
    broadcastMember(runtime);
  }

  broadcast({ type: "projectSettings", workspace: team.workspace, ...projectSettingsFor(team) });
  socket.send(JSON.stringify({ type: "projectSettingsSaved" }));
}

function projectSettingsFor(team: Team) {
  return { instructions: team.instructions, allowedTools: team.allowedTools, chrome: team.chrome, sharePermissions: team.sharePermissions };
}

// Everything from Project settings that a member process reads at launch.
function launchSignature(runtime: MemberRuntime): string {
  return JSON.stringify([usesChrome(runtime), runtime.team.instructions, runtime.team.allowedTools, runtime.workspaceAllowedTools]);
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
  if (message.type === "saveMember" || message.type === "removeMember") return changeMembers(socket, message);
  if (message.type === "reorderMembers") return reorderMembersFrom(socket, message.order);

  // Messages carry the workspace the browser was showing, so a send that races
  // a switch still reaches the right team. Only already-opened workspaces match.
  const workspace = message.workspace ?? projectDirectory;
  const team = workspace === projectDirectory && projectDirectory ? teamFor(projectDirectory) : teams.get(workspace);
  if (!team) {
    socket.send(JSON.stringify({ type: "sendError", message: "Pick a workspace first (bottom of the sidebar)." }));
    return;
  }
  if (message.type === "saveProjectSettings") return saveProjectSettings(socket, team, message);
  if (message.type === "allowAllPermissions") return allowAllPermissions(team);

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
      if (message.threadId === undefined || message.threadId === null) {
        sendTurn(runtime, text, { kind: text.startsWith("/") ? "command" : "user" }, "user", attachments);
        break;
      }
      const threadRoot = queries.threadRoot.get(Number(message.threadId), team.workspace, runtime.config.name);
      if (!threadRoot) {
        socket.send(JSON.stringify({ type: "sendError", message: "That thread no longer exists." }));
        break;
      }
      sendTurn(runtime, text, { kind: "user" }, "user", attachments, threadRoot);
      break;
    }
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
    if (fileName) return new Response(Bun.file(join(rootDirectory, "public", fileName)));
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
