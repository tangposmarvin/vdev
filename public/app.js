// vdev browser client: renders team state pushed over a WebSocket.

const state = {
  members: new Map(),
  order: [],
  selected: null,
  histories: new Map(),
  streaming: new Map(),
  // member -> { threadId, itemId, origin } of the turn the streaming text belongs to
  streamingPlacement: new Map(),
  // { member, rootId, itemId } of the thread shown in the side panel: a reply thread
  // under a message (rootId) or a task summary item (itemId)
  openThread: null,
  unreadThreads: new Set(),
  // the Manager's task summary for this workspace, oldest first
  items: [],
  // work the Manager scheduled for later, soonest first
  schedules: [],
  // item id -> events filed under it, loaded the first time its thread opens
  itemEvents: new Map(),
  unreadItems: new Set(),
  // show everything in the Manager's chat, not only your conversation with it
  showActivity: false,
  unread: new Set(),
  unreadWorkspaces: new Set(),
  pendingSelection: null,
  // project allow rules the open Settings form has shown (see appendNewProjectRules)
  settingsShownRules: new Set(),
  // name of the worker being dragged in the sidebar; list re-renders wait until the drop
  draggingMember: null,
  // composer whose send the server's next sendError answers
  lastComposer: null,
  socket: null,
};

const ATTACHMENT_LIMIT = 10;
const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_BYTES_BY_KIND = { image: 5 * 1024 * 1024, pdf: 10 * 1024 * 1024, text: 1024 * 1024 };
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

// Every message box (main chat, thread panel) is built from one template and one
// factory, so attaching, pasting and dropping files work the same everywhere.
const mainComposer = createComposer(document.querySelector(".js-composer"));
const threadComposer = createComposer(document.querySelector(".js-thread-composer"));

const elements = {
  connection: document.querySelector(".js-connection"),
  memberList: document.querySelector(".js-member-list"),
  rateLimit: document.querySelector(".js-rate-limit"),
  apiFields: document.querySelector(".js-api-fields"),
  clearApiKeyField: document.querySelector(".js-clear-api-key-field"),
  apiFallbackStatus: document.querySelector(".js-api-fallback-status"),
  apiModeHint: document.querySelector(".js-api-mode-hint"),
  workspaceToggle: document.querySelector(".js-workspace-toggle"),
  workspaceName: document.querySelector(".js-workspace-name"),
  activeWorkspaces: document.querySelector(".js-active-workspaces"),
  workspacePanel: document.querySelector(".js-workspace-panel"),
  workspaceRecent: document.querySelector(".js-workspace-recent"),
  workspaceCandidates: document.querySelector(".js-workspace-candidates"),
  workspaceForm: document.querySelector(".js-workspace-form"),
  workspaceInput: document.querySelector(".js-workspace-input"),
  workspaceError: document.querySelector(".js-workspace-error"),
  memberName: document.querySelector(".js-member-name"),
  memberAvatar: document.querySelector(".js-member-avatar"),
  themeOptions: document.querySelectorAll(".js-theme-option"),
  memberMeta: document.querySelector(".js-member-meta"),
  taskBanner: document.querySelector(".js-task-banner"),
  permissionRequests: document.querySelector(".js-permission-requests"),
  messages: document.querySelector(".js-messages"),
  taskSummary: document.querySelector(".js-task-summary"),
  taskSummaryCounts: document.querySelector(".js-task-summary-counts"),
  taskSummaryList: document.querySelector(".js-task-summary-list"),
  scheduleSection: document.querySelector(".js-schedule-section"),
  scheduleList: document.querySelector(".js-schedule-list"),
  archiveDoneButton: document.querySelector(".js-archive-done"),
  archiveAllButton: document.querySelector(".js-archive-all"),
  toggleActivityButton: document.querySelector(".js-toggle-activity"),
  layout: document.querySelector(".layout"),
  threadPanel: document.querySelector(".js-thread-panel"),
  threadTitle: document.querySelector(".js-thread-title"),
  threadMeta: document.querySelector(".js-thread-meta"),
  threadMessages: document.querySelector(".js-thread-messages"),
  threadComposer: threadComposer.form,
  threadInput: threadComposer.input,
  closeThreadButton: document.querySelector(".js-close-thread"),
  threadResizeHandle: document.querySelector(".js-thread-resize"),
  composer: mainComposer.form,
  input: mainComposer.input,
  compactButton: document.querySelector(".js-compact"),
  resetButton: document.querySelector(".js-reset"),
  stopButton: document.querySelector(".js-stop"),
  removeWorkerButton: document.querySelector(".js-remove-worker"),
  chat: document.querySelector(".chat"),
  openSettingsButton: document.querySelector(".js-open-settings"),
  settingsPage: document.querySelector(".js-settings-page"),
  settingsPath: document.querySelector(".js-settings-path"),
  settingsForm: document.querySelector(".js-settings-form"),
  projectFields: document.querySelector(".js-project-fields"),
  settingsProjectName: document.querySelector(".js-settings-project-name"),
  settingsError: document.querySelector(".js-settings-error"),
  settingsStatus: document.querySelector(".js-settings-status"),
  closeSettingsButton: document.querySelector(".js-close-settings"),
  addWorkerButton: document.querySelector(".js-add-worker"),
  allowAllPermissionsButton: document.querySelector(".js-allow-all-permissions"),
};

const AVATAR_COLOR_COUNT = 8;
const MESSAGE_GROUP_MS = 5 * 60 * 1000;
const BOT_NAME = "vdev";
const CARD_TITLES = { task: "Task", handoff: "Handoff", error: "Error", item: "Update" };
const ITEM_STATUS_LABELS = { working: "working", needs_input: "needs input", done: "done", failed: "failed", stopped: "stopped" };
const ITEM_REPORT_FIELDS = [
  ["problem", "Problem"], ["fix", "Fix"], ["commit", "Commit"], ["specs", "Specs"],
  ["ui_verification", "UI verification"], ["notes", "Notes"],
];
// Events in an item's thread that flag the item as having something new for you.
const ITEM_ALERT_KINDS = new Set(["assistant", "item", "error"]);
const PAGE_TITLE = document.title;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// The main chat and the thread panel each keep their own message grouping.
const views = {
  main: { container: elements.messages, lastAuthor: null, lastMessageAt: 0, lastDay: null },
  thread: { container: elements.threadMessages, lastAuthor: null, lastMessageAt: 0, lastDay: null },
};

function connect() {
  const socket = new WebSocket(`ws://${location.host}/ws`);
  state.socket = socket;
  socket.addEventListener("open", () => setConnection("live"));
  socket.addEventListener("close", () => {
    setConnection("offline");
    setTimeout(connect, 1500);
  });
  socket.addEventListener("message", (message) => handleServerMessage(JSON.parse(message.data)));
}

function send(payload) {
  // Member messages name the workspace on screen, so they never land in another one.
  const scopedPayload = payload.member ? { ...payload, workspace: currentWorkspace() } : payload;
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(scopedPayload));
}

function currentWorkspace() {
  return state.workspace?.workspace ?? null;
}

function setConnection(connectionState) {
  elements.connection.dataset.state = connectionState;
  elements.connection.textContent = connectionState;
}

function handleServerMessage(message) {
  // A member message without a workspace cannot be placed safely, so drop it rather than show it in the wrong one.
  if (message.member !== undefined && message.workspace === undefined) return;
  if (message.workspace !== undefined && message.type !== "snapshot" && message.workspace !== currentWorkspace()) {
    handleOtherWorkspaceMessage(message);
    return;
  }
  switch (message.type) {
    case "snapshot":
      if (isOutdatedClient(message.clientVersion)) {
        location.reload();
        return;
      }
      state.order = message.members.map((member) => member.name);
      state.members = new Map(message.members.map((member) => [member.name, member]));
      state.histories.clear();
      state.streaming.clear();
      state.streamingPlacement.clear();
      state.unread.clear();
      state.unreadThreads.clear();
      state.items = message.items ?? [];
      state.schedules = message.schedules ?? [];
      state.itemEvents.clear();
      state.unreadItems.clear();
      closeThread();
      state.workspace = message;
      state.unreadWorkspaces.delete(message.workspace);
      renderWorkspace();
      renderActiveWorkspaces();
      if (message.workspace) toggleWorkspacePanel(false);
      else toggleWorkspacePanel(true);
      state.rateLimit = message.rateLimit;
      renderRateLimit(message.rateLimit);
      selectMember(
        [state.pendingSelection, state.selected, rememberedMember()].find((name) => state.members.has(name)) ??
        message.members.find((member) => member.isManager)?.name,
      );
      state.pendingSelection = null;
      renderMemberList();
      if (!elements.settingsPage.hidden) openSettings();
      break;
    case "memberOrder":
      applyMemberOrder(message.order);
      break;
    case "memberOrderError":
      mainComposer.showError(message.message);
      break;
    case "member":
      state.members.set(message.member.name, message.member);
      renderMemberList();
      if (message.member.name === state.selected) renderHeader();
      break;
    case "history":
      state.histories.set(message.member, message.events);
      if (message.member === state.selected) renderMessages();
      if (message.member === state.openThread?.member) renderThread();
      break;
    case "event":
      handleEvent(message.member, message.event);
      break;
    case "delta":
      handleDelta(message.member, message.text, message.placement ?? {});
      break;
    case "items":
      applyItems(message.items);
      break;
    case "schedules":
      state.schedules = message.schedules ?? [];
      renderTaskSummary();
      break;
    case "itemEvents":
      state.itemEvents.set(message.itemId, message.events);
      if (state.openThread?.itemId === message.itemId) renderThread();
      break;
    case "rate":
      state.rateLimit = message.rateLimit;
      renderRateLimit(message.rateLimit);
      break;
    case "apiSettings":
      if (state.workspace) state.workspace.apiSettings = message;
      renderRateLimit(state.rateLimit);
      if (!elements.settingsPage.hidden) renderApiFallbackStatus();
      break;
    case "workspaces":
      if (state.workspace) state.workspace.activeWorkspaces = message.activeWorkspaces;
      renderActiveWorkspaces();
      break;
    case "sendError":
      (state.lastComposer ?? mainComposer).showError(message.message);
      break;
    case "projectSettings":
      if (state.workspace) state.workspace.projectSettings = { instructions: message.instructions, allowedTools: message.allowedTools };
      if (!elements.settingsPage.hidden) appendNewProjectRules(message.allowedTools);
      break;
    case "teamSettings":
      if (state.workspace) state.workspace.teamSettings = { manager: message.manager, worker: message.worker };
      break;
    case "settingsSaved":
      elements.settingsStatus.textContent = "Saved. Affected members restart to apply it (busy ones after their current work).";
      break;
    case "settingsError":
      elements.settingsStatus.textContent = "";
      elements.settingsError.textContent = message.message;
      elements.settingsError.hidden = false;
      break;
    case "workerAdded":
      state.pendingSelection = message.name;
      break;
    case "workspaceError":
      elements.workspaceError.textContent = message.message;
      elements.workspaceError.hidden = false;
      break;
  }
}

// The first snapshot tells which page version this tab runs. After a server restart with
// changed client files, the reconnect brings a new version and the tab reloads to pick them up.
function isOutdatedClient(version) {
  if (!version) return false;
  state.clientVersion ??= version;
  return version !== state.clientVersion;
}

// Members in background workspaces keep working; only flag that something happened there.
function handleOtherWorkspaceMessage(message) {
  if (message.type !== "event" || message.event.kind === "tool") return;
  state.unreadWorkspaces.add(message.workspace);
  renderActiveWorkspaces();
}

// ---------------------------------------------------------------- workspace

function renderWorkspace() {
  const workspace = state.workspace;
  if (!workspace) return;
  elements.workspaceName.textContent = workspace.workspaceName ?? "none selected";
  elements.workspaceToggle.title = workspace.workspace ?? "Pick a folder for the team to work in";
  elements.input.disabled = !workspace.workspace;
  renderWorkspaceGroup(elements.workspaceRecent, "Recent", workspace.recentWorkspaces);
  renderWorkspaceGroup(elements.workspaceCandidates, "Repositories", workspace.candidateWorkspaces);
}

function renderWorkspaceGroup(container, title, paths) {
  if (!paths?.length) {
    container.replaceChildren();
    return;
  }
  const options = paths.map((path) => {
    const button = element("button", "workspace-option js-workspace-option");
    button.type = "button";
    button.dataset.path = path;
    button.title = path;
    button.setAttribute("aria-current", path === state.workspace.workspace ? "true" : "false");
    button.append(element("span", "workspace-option-name", path.split("/").pop()), element("span", "workspace-option-path", path));
    return button;
  });
  container.replaceChildren(element("div", "workspace-group-title", title), ...options);
}

function renderActiveWorkspaces() {
  const activeWorkspaces = state.workspace?.activeWorkspaces ?? [];
  elements.activeWorkspaces.hidden = activeWorkspaces.length === 0;
  if (activeWorkspaces.length === 0) {
    elements.activeWorkspaces.replaceChildren();
    return;
  }
  const rows = activeWorkspaces.map((workspace) => {
    const row = element("div", "sidebar-item active-workspace");
    row.setAttribute("aria-current", workspace.path === currentWorkspace() ? "true" : "false");

    const openButton = element("button", "active-workspace-open js-workspace-option");
    openButton.type = "button";
    openButton.dataset.path = workspace.path;
    openButton.title = workspace.path;
    openButton.append(
      element("span", `workspace-dot status-${workspace.working > 0 ? "working" : "idle"}`),
      element("span", "active-workspace-name", workspace.name),
      element("span", "active-workspace-status", workspace.working > 0 ? `${workspace.working} working` : "idle"),
    );
    if (workspace.waiting > 0) openButton.append(attentionBadge(workspace.waiting, `${workspace.waiting} member(s) waiting for your approval`));
    else if (state.unreadWorkspaces.has(workspace.path)) openButton.append(element("span", "unread-badge", "new"));

    const closeButton = element("button", "active-workspace-close js-close-workspace", "x");
    closeButton.type = "button";
    closeButton.dataset.path = workspace.path;
    closeButton.title = `Stop all members in ${workspace.name}`;
    closeButton.setAttribute("aria-label", closeButton.title);

    row.append(openButton, closeButton);
    return row;
  });
  elements.activeWorkspaces.replaceChildren(element("h2", "sidebar-section-title", "Active workspaces"), ...rows);
  renderPageTitle();
}

// "(2) vdev team" while members in any workspace wait for an approval.
function renderPageTitle() {
  const activeWorkspaces = state.workspace?.activeWorkspaces ?? [];
  const waiting = activeWorkspaces.reduce((total, workspace) => total + (workspace.waiting ?? 0), 0);
  document.title = waiting > 0 ? `(${waiting}) ${PAGE_TITLE}` : PAGE_TITLE;
}

function attentionBadge(count, title) {
  const badge = element("span", "attention-badge");
  badge.title = title;
  badge.setAttribute("aria-label", title);
  badge.append(bellIcon(), String(count));
  return badge;
}

function bellIcon() {
  const icon = document.createElementNS(SVG_NAMESPACE, "svg");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("aria-hidden", "true");
  icon.classList.add("bell-icon");
  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", "M8 1.5a1 1 0 0 1 1 1v.6a4.5 4.5 0 0 1 3.5 4.4v2.8l1.2 1.6a.6.6 0 0 1-.5 1H2.8a.6.6 0 0 1-.5-1l1.2-1.6V7.5A4.5 4.5 0 0 1 7 3.1v-.6a1 1 0 0 1 1-1ZM6.3 13.9h3.4a1.7 1.7 0 0 1-3.4 0Z");
  icon.append(path);
  return icon;
}

function toggleWorkspacePanel(open = elements.workspacePanel.hidden) {
  elements.workspacePanel.hidden = !open;
  elements.workspaceToggle.setAttribute("aria-expanded", String(open));
  elements.workspaceError.hidden = true;
}

function openWorkspace(path) {
  if (!path) return;
  elements.workspaceError.hidden = true;
  send({ type: "workspace", path });
}

function handleEvent(memberName, event) {
  if (event.kind === "assistant") state.streaming.delete(memberName);
  state.histories.get(memberName)?.push(event);
  const itemId = event.item_id ?? null;
  if (itemId !== null) noteItemEvent(itemId, event);
  if (memberName !== state.selected) {
    if (!isNoteworthy(memberName, event)) return;
    state.unread.add(memberName);
    renderMemberList();
    return;
  }

  const threadId = event.thread_id ?? null;
  if (isInOpenThread(memberName, event)) appendLiveEvent(views.thread, event);
  else if (threadId !== null && event.kind !== "tool") state.unreadThreads.add(threadId);
  if (threadId !== null) renderThreadSummary(threadId);
  if (showsInMain(memberName, event)) appendLiveEvent(views.main, event);
  renderStreamingBubbles();
}

function noteItemEvent(itemId, event) {
  state.itemEvents.get(itemId)?.push(event);
  if (state.openThread?.itemId === itemId || !ITEM_ALERT_KINDS.has(event.kind)) return;
  state.unreadItems.add(itemId);
  renderTaskSummary();
}

function isManagerName(memberName) {
  return Boolean(state.members.get(memberName)?.isManager);
}

function managerName() {
  return state.order.find(isManagerName) ?? null;
}

// The Manager's main chat is your conversation with it. What workers report, and what it
// writes while handling that, lives in the task summary item threads (or under "Show activity").
function showsInMain(memberName, event, showActivity = state.showActivity) {
  if ((event.thread_id ?? null) !== null) return false;
  if (!isManagerName(memberName) || showActivity) return true;
  if ((event.item_id ?? null) !== null) return false;
  if (event.kind === "user" || event.kind === "error") return true;
  if (event.kind !== "assistant") return false;
  return !event.origin || event.origin === "user" || event.origin === "command";
}

// Worth a "new" badge on a member you are not looking at.
function isNoteworthy(memberName, event) {
  if (event.kind === "tool") return false;
  if (!isManagerName(memberName)) return true;
  return event.kind === "item" || showsInMain(memberName, event, false);
}

function isInOpenThread(memberName, event) {
  const thread = state.openThread;
  if (!thread || thread.member !== memberName) return false;
  if (thread.itemId !== null) return event.item_id === thread.itemId && event.kind !== "tool";
  return (event.thread_id ?? null) === thread.rootId;
}

function appendLiveEvent(view, event) {
  removeStreamingBubble(view);
  appendEvent(event, view);
  scrollToBottom(view);
}

function handleDelta(memberName, text, placement) {
  const previous = state.streamingPlacement.get(memberName);
  const samePlacement = previous && ["threadId", "itemId", "origin"].every((key) => (previous[key] ?? null) === (placement[key] ?? null));
  if (!samePlacement) state.streaming.delete(memberName);
  state.streamingPlacement.set(memberName, placement);
  state.streaming.set(memberName, (state.streaming.get(memberName) ?? "") + text);
  if (memberName !== state.selected) return;
  renderStreamingBubbles();
}

// ---------------------------------------------------------------- settings

const MODEL_GROUPS = [
  ["Latest (updates automatically)", [["fable", "Fable (latest)"], ["opus", "Opus (latest)"], ["sonnet", "Sonnet (latest)"], ["haiku", "Haiku (latest)"]]],
  ["Pinned version", [["claude-fable-5-1", "Fable 5.1"], ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-4-5-20251001", "Haiku 4.5"]]],
];
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

function agentFieldset(agent) {
  return elements.settingsForm.querySelector(`.js-agent-fields[data-agent="${agent}"]`);
}

function optionElement(value, label) {
  const node = element("option", "", label);
  node.value = value;
  return node;
}

// "Your default" sends no --model / --effort, so the member uses the same as `claude` in a terminal.
function renderAgentSelects() {
  for (const select of elements.settingsForm.querySelectorAll(".js-model-select")) {
    const groups = MODEL_GROUPS.map(([label, models]) => {
      const group = element("optgroup");
      group.label = label;
      group.append(...models.map(([value, modelLabel]) => optionElement(value, modelLabel)));
      return group;
    });
    select.replaceChildren(optionElement("", "Your default"), ...groups, optionElement("custom", "Other model ID..."));
  }
  for (const select of elements.settingsForm.querySelectorAll(".js-effort-select")) {
    select.replaceChildren(optionElement("", "Your default"), ...EFFORT_LEVELS.map((level) => optionElement(level, level)));
  }
}

// Fills only the fields the fieldset has; the manager shows fewer than workers.
function fillAgentFields(fieldset, agentConfig) {
  const fields = fieldset.elements;
  setModelField(fieldset, agentConfig.model ?? "");
  fields.effort.value = agentConfig.effort ?? "";
  fields.prompt.value = agentConfig.prompt ?? "";
  if (fields.permissionMode) fields.permissionMode.value = agentConfig.permissionMode ?? "";
  if (fields.budget) fields.budget.value = agentConfig.budget ?? "";
  if (fields.allowedTools) fields.allowedTools.value = (agentConfig.allowedTools ?? []).join("\n");
  if (fields.chrome) fields.chrome.checked = Boolean(agentConfig.chrome);
}

function agentFieldValues(fieldset) {
  const fields = fieldset.elements;
  const values = {
    model: fields.model.value === "custom" ? fields.customModel.value.trim() : fields.model.value,
    effort: fields.effort.value,
    prompt: fields.prompt.value,
  };
  if (fields.permissionMode) values.permissionMode = fields.permissionMode.value;
  if (fields.budget) values.budget = fields.budget.value;
  if (fields.allowedTools) values.allowedTools = ruleLines(fields.allowedTools.value);
  if (fields.chrome) values.chrome = fields.chrome.checked;
  return values;
}

// Known models show in the list; anything else (an older ID, say) shows as
// "Other model ID" with the value in the text box, so it is kept as is.
function setModelField(fieldset, model) {
  const fields = fieldset.elements;
  const known = [...fields.model.options].some((modelOption) => modelOption.value === model && modelOption.value !== "custom");
  fields.model.value = known ? model : "custom";
  fields.customModel.value = known ? "" : model;
  syncCustomModelField(fieldset);
}

function syncCustomModelField(fieldset) {
  const fields = fieldset.elements;
  const custom = fields.model.value === "custom";
  fields.customModel.hidden = !custom;
  fields.customModel.required = custom;
}

// Rendered once per opening so live updates never wipe unsaved edits.
function openSettings() {
  const teamSettings = state.workspace?.teamSettings;
  if (!teamSettings) return;
  fillAgentFields(agentFieldset("worker"), teamSettings.worker);
  fillAgentFields(agentFieldset("manager"), teamSettings.manager);

  const projectSettings = state.workspace.projectSettings;
  const projectFields = elements.projectFields.elements;
  elements.projectFields.hidden = !projectSettings;
  elements.settingsProjectName.textContent = state.workspace.workspaceName ?? "";
  projectFields.instructions.value = projectSettings?.instructions ?? "";
  projectFields.allowedTools.value = (projectSettings?.allowedTools ?? []).join("\n");
  // Rules the form has already shown, so a rule the user deletes is not added back.
  state.settingsShownRules = new Set(projectSettings?.allowedTools ?? []);

  const apiSettings = state.workspace.apiSettings ?? {};
  const apiFields = elements.apiFields.elements;
  apiFields.apiKey.value = "";
  apiFields.apiKey.placeholder = apiSettings.apiKeyHint ? `Saved key ${apiSettings.apiKeyHint} (type to replace)` : "sk-ant-...";
  apiFields.clearApiKey.checked = false;
  elements.clearApiKeyField.hidden = !apiSettings.apiKeyHint;
  apiFields.apiMode.value = apiSettings.apiMode ?? "off";
  renderApiModeHint();
  renderApiFallbackStatus();

  elements.settingsPath.textContent = state.workspace.workspace ?? "";
  elements.settingsError.hidden = true;
  elements.settingsStatus.textContent = "";
  closeThread();
  elements.chat.hidden = true;
  elements.settingsPage.hidden = false;
  agentFieldset("worker").elements.model.focus();
}

function closeSettings() {
  elements.settingsPage.hidden = true;
  elements.chat.hidden = false;
  elements.input.focus();
}

// "Always allow" while Settings is open: add the saved rule to the open form so
// pressing Save keeps it, without wiping unsaved edits.
function appendNewProjectRules(allowedTools) {
  const rulesField = elements.projectFields.elements.allowedTools;
  const shownRules = new Set(ruleLines(rulesField.value));
  const newRules = (allowedTools ?? []).filter((rule) => !shownRules.has(rule) && !state.settingsShownRules.has(rule));
  if (newRules.length === 0) return;
  for (const rule of newRules) state.settingsShownRules.add(rule);
  rulesField.value = [...ruleLines(rulesField.value), ...newRules].join("\n");
}

function ruleLines(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

// Removing takes two clicks instead of a blocking confirm() dialog.
function resetRemoveButton() {
  delete elements.removeWorkerButton.dataset.armed;
  elements.removeWorkerButton.textContent = "Remove";
}

// ---------------------------------------------------------------- selection

function rememberedMember() {
  try {
    const name = localStorage.getItem("vdev.selected");
    return state.members.has(name) ? name : null;
  } catch {
    return null;
  }
}

function selectMember(memberName) {
  if (!memberName) return;
  if (state.openThread && state.openThread.member !== memberName) closeThread();
  state.selected = memberName;
  state.unread.delete(memberName);
  try {
    localStorage.setItem("vdev.selected", memberName);
  } catch {
    // storage unavailable; selection just is not remembered
  }
  const member = state.members.get(memberName);
  elements.input.placeholder = `Message ${member?.name ?? memberName}`;
  renderMemberList();
  renderHeader();
  renderTaskSummary();
  if (state.histories.has(memberName)) renderMessages();
  else {
    resetView(views.main);
    send({ type: "history", member: memberName });
  }
  elements.input.focus();
}

// ---------------------------------------------------------------- rendering

function renderMemberList() {
  // Replacing the list mid-drag would cancel the drag; the drop re-renders.
  if (state.draggingMember) return;
  const items = state.order.map((memberName) => {
    const member = state.members.get(memberName);
    const item = document.createElement("li");
    item.dataset.member = memberName;
    if (!member.isManager) {
      item.draggable = true;
      item.classList.add("js-draggable-member");
    }
    const button = element("button", "sidebar-item member js-member");
    button.type = "button";
    button.dataset.member = memberName;
    button.title = `${member.role} - ${member.model}${member.chrome ? " - Claude in Chrome" : ""}`;
    button.setAttribute("aria-current", memberName === state.selected ? "true" : "false");
    const unread = state.unread.has(memberName);
    button.classList.toggle("is-unread", unread);

    const avatar = avatarFor(memberName, "avatar-small");
    avatar.append(element("span", `presence status-${member.status}`));
    const label = element("span", "member-label");
    label.append(element("span", "member-name", memberName));
    if (member.task) label.append(meter("task", member.task.spent, member.task.budget));
    else if (member.contextWindow) label.append(meter("context", member.contextTokens, member.contextWindow));

    button.append(avatar, label);
    const waiting = member.permissionRequests?.length ?? 0;
    button.classList.toggle("is-waiting", waiting > 0);
    if (waiting > 0) button.append(attentionBadge(waiting, `${memberName} is waiting for your approval`));
    else if (unread) button.append(element("span", "unread-badge", "new"));
    else if (member.status !== "asleep" && member.status !== "idle") button.append(element("span", "member-status", statusLabel(member)));

    item.append(button);
    return item;
  });
  elements.memberList.replaceChildren(...items);
  renderAllowAllPermissions();
}

function renderAllowAllPermissions() {
  const pendingCount = [...state.members.values()].reduce((total, member) => total + (member.permissionRequests?.length ?? 0), 0);
  elements.allowAllPermissionsButton.hidden = pendingCount === 0;
  elements.allowAllPermissionsButton.disabled = false;
  elements.allowAllPermissionsButton.textContent = `Allow all (${pendingCount})`;
  elements.allowAllPermissionsButton.setAttribute("aria-label", `Allow all ${pendingCount} pending requests once`);
}

// A square initials avatar in a stable color per name, like a chat profile picture.
function avatarFor(name, sizeClass = "") {
  const avatar = element("span", `avatar ${sizeClass} avatar-color-${colorIndex(name)}`, initials(name));
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

function colorIndex(name) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % AVATAR_COLOR_COUNT;
}

function initials(name) {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 1).toUpperCase();
}

function meter(label, value, maximum) {
  const ratio = maximum ? Math.min(value / maximum, 1) : 0;
  const wrapper = element("span", "meter");
  wrapper.title = `${label} ${formatTokens(value)} / ${formatTokens(maximum)}`;
  const track = element("span", "meter-track");
  const fill = element("span", `meter-fill ${ratio >= 1 ? "is-over" : ratio >= 0.7 ? "is-warning" : ""}`);
  fill.style.width = `${Math.round(ratio * 100)}%`;
  track.append(fill);
  wrapper.append(track);
  return wrapper;
}

function statusLabel(member) {
  if (member.status === "working" && member.queued > 0) return `working +${member.queued}`;
  return member.status;
}

function renderHeader() {
  const member = state.members.get(state.selected);
  if (!member) return;
  elements.memberName.textContent = member.name;
  elements.memberAvatar.className = `avatar avatar-large avatar-color-${colorIndex(member.name)} js-member-avatar`;
  elements.memberAvatar.textContent = initials(member.name);
  const context = member.contextWindow ? ` - context ${formatTokens(member.contextTokens)}/${formatTokens(member.contextWindow)}` : "";
  elements.memberMeta.textContent = `${member.role} - ${member.model}${member.billing === "api" ? " (API key)" : ""} - ${statusLabel(member)}${context} - ${formatTokens(member.totalSpent)} tokens total`;
  elements.stopButton.disabled = member.status === "asleep";
  if (elements.removeWorkerButton.dataset.member !== member.name) resetRemoveButton();
  elements.removeWorkerButton.dataset.member = member.name;
  elements.removeWorkerButton.hidden = member.isManager;
  elements.toggleActivityButton.hidden = !member.isManager;
  renderActivityToggle();

  if (member.task) {
    elements.taskBanner.hidden = false;
    elements.taskBanner.textContent = `Task #${member.task.id}: ${member.task.brief}`;
  } else {
    elements.taskBanner.hidden = true;
  }
  renderPermissionRequests(member);
}

// Tool calls the member is blocked on until you answer, like the prompt in a terminal.
function renderPermissionRequests(member) {
  const requests = member.permissionRequests ?? [];
  elements.permissionRequests.hidden = requests.length === 0;
  const cards = requests.map((request) => {
    const card = element("div", "permission-request");
    const heading = element("div", "permission-request-heading");
    heading.append(bellIcon(), element("span", "", `${member.name} wants to use ${request.toolName}`));
    const detail = element("pre", "permission-request-detail", request.summary);

    const actions = element("div", "permission-request-actions");
    const buttons = [
      ["allow", "button button-primary", "Allow once", "Run this call only"],
      ["always", "button", `Always allow ${request.rule}`, `Save ${request.rule} for all members in this workspace`],
      ["deny", "button button-danger", "Deny", "Refuse this call; the member continues without it"],
    ].map(([decision, className, label, title]) => {
      const button = element("button", `${className} js-answer-permission`, label);
      button.type = "button";
      button.title = title;
      button.dataset.requestId = request.requestId;
      button.dataset.decision = decision;
      return button;
    });
    actions.append(...buttons);
    card.append(heading, detail, actions);
    return card;
  });
  elements.permissionRequests.replaceChildren(...cards);
}

// Thread replies stay out of the main chat; their root shows a reply count instead.
function renderMessages() {
  resetView(views.main);
  for (const event of state.histories.get(state.selected) ?? []) {
    if (showsInMain(state.selected, event)) appendEvent(event, views.main);
  }
  renderStreamingBubbles();
  scrollToBottom(views.main, true);
}

function renderActivityToggle() {
  elements.toggleActivityButton.textContent = state.showActivity ? "Hide activity" : "Show activity";
  elements.toggleActivityButton.setAttribute("aria-pressed", String(state.showActivity));
}

function savedShowActivity() {
  try {
    return localStorage.getItem("vdev.showActivity") === "true";
  } catch {
    return false;
  }
}

function setShowActivity(showActivity) {
  state.showActivity = showActivity;
  try {
    localStorage.setItem("vdev.showActivity", String(showActivity));
  } catch {
    // storage unavailable; the choice lasts until the page reloads
  }
  renderActivityToggle();
  renderMessages();
}

// ---------------------------------------------------------------- task summary

function itemById(itemId) {
  return state.items.find((item) => item.id === itemId) ?? null;
}

// Re-renders the open item's thread only when that item changed, so its scroll position survives other updates.
function applyItems(items) {
  const openItemId = state.openThread?.itemId ?? null;
  const openItemBefore = openItemId === null ? null : JSON.stringify(itemById(openItemId));
  state.items = items ?? [];
  renderTaskSummary();
  if (openItemId === null) return;
  if (JSON.stringify(itemById(openItemId)) !== openItemBefore) renderThread();
}

function renderTaskSummary() {
  const visible = isManagerName(state.selected) && (state.items.length > 0 || state.schedules.length > 0);
  elements.taskSummary.hidden = !visible;
  if (!visible) {
    elements.taskSummaryList.replaceChildren();
    elements.scheduleList.replaceChildren();
    return;
  }
  renderSchedules();
  const countFor = (status) => state.items.filter((item) => item.status === status).length;
  const counts = ["needs_input", "working", "done", "failed", "stopped"]
    .filter((status) => countFor(status) > 0)
    .map((status) => `${countFor(status)} ${ITEM_STATUS_LABELS[status]}`);
  elements.taskSummaryCounts.textContent = counts.join(" - ");
  elements.archiveDoneButton.hidden = countFor("done") === 0;
  elements.archiveAllButton.hidden = state.items.length === 0;
  elements.taskSummaryList.replaceChildren(...state.items.map((item, index) => taskSummaryRow(item, index + 1)));
}

function taskSummaryRow(item, number) {
  const row = element("li", "task-item js-open-item");
  row.dataset.itemId = String(item.id);
  row.classList.toggle("is-open", state.openThread?.itemId === item.id);

  const button = element("button", "task-item-button");
  button.type = "button";
  button.title = `Open the thread for ${item.title}`;
  button.append(
    element("span", "task-item-number", `${number}.`),
    element("span", "task-item-title", item.title),
    element("span", "task-item-member", item.member),
  );
  if (state.unreadItems.has(item.id)) button.append(element("span", "unread-badge", "new"));
  button.append(itemStatusBadge(item.status));

  const clearButton = element("button", "task-item-clear js-archive-item", "x");
  clearButton.type = "button";
  clearButton.title = `Remove ${item.title} from the list`;
  clearButton.setAttribute("aria-label", clearButton.title);
  const header = element("div", "task-item-header");
  header.append(button, clearButton);
  row.append(header);

  if (item.summary) row.append(element("div", "task-item-summary", item.summary));
  if (item.questions.length > 0) row.append(questionList(item.questions));
  return row;
}

function renderSchedules() {
  elements.scheduleSection.hidden = state.schedules.length === 0;
  elements.scheduleList.replaceChildren(...state.schedules.map(scheduleRow));
}

function scheduleRow(schedule) {
  const row = element("li", "task-item schedule-item t-schedule-item");
  row.dataset.scheduleId = String(schedule.id);
  row.title = schedule.instructions;

  const label = element("div", "task-item-button");
  label.append(
    element("span", "schedule-time", scheduleTimeLabel(new Date(schedule.runAt))),
    element("span", "task-item-title", schedule.title),
  );
  const cancelButton = element("button", "task-item-clear js-cancel-schedule", "x");
  cancelButton.type = "button";
  cancelButton.title = `Cancel ${schedule.title}`;
  cancelButton.setAttribute("aria-label", cancelButton.title);
  const header = element("div", "task-item-header");
  header.append(label, cancelButton);
  row.append(header);
  return row;
}

// "Today 9:00 AM", "Tomorrow 2:30 PM" or "Mon, Oct 19 9:00 AM".
function scheduleTimeLabel(date) {
  const startOfDay = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const dayOffset = Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (dayOffset === 0) return `Today ${time}`;
  if (dayOffset === 1) return `Tomorrow ${time}`;
  return `${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

function itemStatusBadge(status) {
  return element("span", `item-status item-status-${status}`, ITEM_STATUS_LABELS[status] ?? status);
}

// Clicking a question opens the thread with "q2: " ready to answer it.
function questionList(questions) {
  const list = element("ol", "question-list");
  list.append(...questions.map((question, index) => {
    const entry = element("li", "question js-answer-question");
    entry.dataset.questionNumber = String(index + 1);
    entry.title = "Answer this question";
    entry.append(element("span", "question-label", `q${index + 1}:`), element("span", "question-text", question));
    return entry;
  }));
  return list;
}

// The item as it stands, at the top of its thread.
function itemCard(item) {
  const card = element("div", "item-card");
  const header = element("div", "item-card-header");
  header.append(itemStatusBadge(item.status), element("span", "item-card-meta", `task #${item.id} - ${item.member}`));
  card.append(header);
  card.append(element("div", "item-card-summary", item.summary || "No summary yet."));
  const report = itemReport(item.report ?? {});
  if (report) card.append(report);
  if (item.questions.length > 0) card.append(questionList(item.questions));
  return card;
}

// Problem, fix, commit, specs and UI verification, as the Manager reported them.
function itemReport(report) {
  const rows = ITEM_REPORT_FIELDS.filter(([field]) => report[field]);
  if (rows.length === 0) return null;
  const list = element("dl", "item-report");
  for (const [field, label] of rows) {
    const value = element("dd", "item-report-value rich");
    renderRichText(value, report[field]);
    list.append(element("dt", "item-report-label", label), value);
  }
  return list;
}

// Consecutive messages from one author within a few minutes share a single
// name and avatar, and a divider marks each new day.
function resetView(view) {
  view.container.replaceChildren();
  view.lastAuthor = null;
  view.lastMessageAt = 0;
  view.lastDay = null;
}

function appendEvent(event, view) {
  const createdAt = new Date(event.created_at);
  const day = createdAt.toDateString();
  if (day !== view.lastDay) {
    view.container.append(dayDivider(createdAt));
    view.lastDay = day;
    view.lastAuthor = null;
  }

  if (event.kind === "tool" || event.kind === "system") {
    view.container.append(noteRow(event, createdAt));
    return;
  }

  // Handoffs are input for the agent, not part of the conversation with you,
  // so they collapse to one line and the agent's reply starts a fresh group.
  if (event.kind === "handoff") {
    view.container.append(handoffNote(event, createdAt));
    view.lastAuthor = null;
    return;
  }

  const author = authorFor(event);
  const continues = author.key === view.lastAuthor && event.created_at - view.lastMessageAt < MESSAGE_GROUP_MS;
  const row = messageRow(event.kind, event.text, author, createdAt, continues);
  if (view === views.main && isThreadRoot(event)) addThreadControls(row, event.id);
  view.container.append(row);
  view.lastAuthor = author.key;
  view.lastMessageAt = event.created_at;
}

// Only a member's own messages in the main chat can be answered in a thread.
function isThreadRoot(event) {
  return event.kind === "assistant" && (event.thread_id ?? null) === null && (event.item_id ?? null) === null && event.id !== undefined;
}

function addThreadControls(row, eventId) {
  const actions = element("div", "message-actions");
  const replyButton = element("button", "message-action js-reply-thread", "Reply in thread");
  replyButton.type = "button";
  replyButton.dataset.threadId = String(eventId);
  actions.append(replyButton);

  const summary = element("button", "thread-summary js-reply-thread js-thread-summary");
  summary.type = "button";
  summary.dataset.threadId = String(eventId);
  row.querySelector(".message-body").append(summary);
  row.append(actions);
  renderThreadSummary(eventId, summary);
}

function threadReplies(memberName, rootId) {
  return (state.histories.get(memberName) ?? []).filter((event) => event.thread_id === rootId);
}

// "3 replies  Last reply 10:42", hidden until the thread has a reply.
function renderThreadSummary(rootId, summary = views.main.container.querySelector(`.js-thread-summary[data-thread-id="${rootId}"]`)) {
  if (!summary) return;
  const replies = threadReplies(state.selected, rootId).filter((event) => event.kind === "user" || event.kind === "assistant");
  summary.hidden = replies.length === 0;
  if (replies.length === 0) return;
  const lastReply = replies[replies.length - 1];
  const unread = state.unreadThreads.has(rootId);
  summary.classList.toggle("is-unread", unread);
  summary.replaceChildren(
    element("span", "thread-summary-count", replies.length === 1 ? "1 reply" : `${replies.length} replies`),
    element("span", "thread-summary-time", unread ? "New reply" : `Last reply ${shortTime(new Date(lastReply.created_at))}`),
  );
}

// ---------------------------------------------------------------- threads

function openThread(rootId) {
  if (!state.selected) return;
  showThreadPanel({ member: state.selected, rootId, itemId: null });
  state.unreadThreads.delete(rootId);
  renderThreadSummary(rootId);
  renderThread();
  elements.threadInput.placeholder = `Reply to ${state.selected}...`;
  elements.threadInput.focus();
}

// Your replies in an item's thread go to the Manager, quoted with the item's open questions.
function openItemThread(itemId, questionNumber = null) {
  const manager = managerName();
  const item = itemById(itemId);
  if (!manager || !item) return;
  if (state.selected !== manager) selectMember(manager);
  if (state.openThread?.itemId !== itemId) {
    showThreadPanel({ member: manager, rootId: null, itemId });
    elements.threadInput.placeholder = `Reply about ${item.title}...`;
    if (!state.itemEvents.has(itemId)) send({ type: "itemEvents", member: manager, itemId });
  }
  state.unreadItems.delete(itemId);
  renderTaskSummary();
  renderThread();
  if (questionNumber !== null && !elements.threadInput.value.trim()) elements.threadInput.value = `q${questionNumber}: `;
  elements.threadInput.focus();
}

function showThreadPanel(thread) {
  if (state.openThread) threadComposer.clear();
  state.openThread = thread;
  elements.threadPanel.hidden = false;
  elements.layout.classList.add("has-thread");
}

function closeThread() {
  const hadItemThread = (state.openThread?.itemId ?? null) !== null;
  state.openThread = null;
  elements.threadPanel.hidden = true;
  elements.layout.classList.remove("has-thread");
  threadComposer.clear();
  resetView(views.thread);
  if (hadItemThread) renderTaskSummary();
}

function renderThread() {
  const thread = state.openThread;
  if (!thread) return;
  if (thread.itemId !== null) {
    renderItemThread(thread.itemId);
    return;
  }
  elements.threadTitle.textContent = "Thread";
  const history = state.histories.get(thread.member) ?? [];
  const root = history.find((event) => event.id === thread.rootId);
  if (!root) {
    closeThread();
    return;
  }
  elements.threadMeta.textContent = `with ${thread.member}`;
  resetView(views.thread);
  appendEvent(root, views.thread);
  const divider = element("div", "thread-divider");
  divider.append(element("span", "thread-divider-label", "Replies"));
  views.thread.container.append(divider);
  views.thread.lastAuthor = null;
  for (const event of threadReplies(thread.member, thread.rootId)) appendEvent(event, views.thread);
  renderStreamingBubbles();
  scrollToBottom(views.thread, true);
}

// The item as it stands, then its history: handoffs (collapsed), the Manager's updates, and your replies.
function renderItemThread(itemId) {
  const item = itemById(itemId);
  if (!item) {
    closeThread();
    return;
  }
  elements.threadTitle.textContent = item.title;
  elements.threadMeta.textContent = `with ${state.openThread.member} - ${ITEM_STATUS_LABELS[item.status] ?? item.status}`;
  resetView(views.thread);
  views.thread.container.append(itemCard(item));
  const divider = element("div", "thread-divider");
  divider.append(element("span", "thread-divider-label", "History"));
  views.thread.container.append(divider);
  const events = state.itemEvents.get(itemId);
  if (!events) views.thread.container.append(element("div", "note note-system", "Loading..."));
  for (const event of events ?? []) {
    if (event.kind !== "tool") appendEvent(event, views.thread);
  }
  renderStreamingBubbles();
  scrollToBottom(views.thread, true);
}

function threadEvents(thread) {
  if (thread.itemId !== null) return state.itemEvents.get(thread.itemId) ?? [];
  return threadReplies(thread.member, thread.rootId);
}

function authorFor(event) {
  if (event.kind === "user") return { key: "you", name: "You" };
  if (event.kind === "assistant") return { key: state.selected, name: state.selected };
  if (event.kind === "task" || event.kind === "item") {
    const manager = [...state.members.values()].find((member) => member.isManager)?.name ?? "manager";
    return { key: manager, name: manager };
  }
  return { key: BOT_NAME, name: BOT_NAME, isBot: true };
}

function messageRow(kind, text, author, createdAt, continues) {
  const row = element("article", `message message-${kind}${continues ? " is-continued" : ""}`);
  const gutter = element("div", "message-gutter");
  if (continues) gutter.append(element("time", "message-hover-time", shortTime(createdAt)));
  else gutter.append(author.key === "you" ? element("span", "avatar avatar-you", "Y") : avatarFor(author.name));

  const body = element("div", "message-body");
  if (!continues) {
    const header = element("header", "message-header");
    header.append(element("span", "message-author", author.name));
    if (author.isBot) header.append(element("span", "bot-badge", "APP"));
    header.append(element("time", "message-time", shortTime(createdAt)));
    body.append(header);
  }

  const cardTitle = CARD_TITLES[kind];
  if (cardTitle) {
    const { title, rest } = splitBracketHeader(text);
    const card = element("div", `message-card card-${kind}`);
    card.append(element("div", "message-card-title", title ?? cardTitle));
    const cardText = element("div", "rich");
    renderRichText(cardText, rest);
    card.append(cardText);
    body.append(card);
  } else {
    const content = element("div", "rich");
    renderRichText(content, text);
    body.append(content);
  }

  row.title = createdAt.toLocaleString();
  row.append(gutter, body);
  return row;
}

// "[Task #3 from Manager]\nbrief" -> title "Task #3 from Manager", rest "brief".
function splitBracketHeader(text) {
  const match = text.match(/^\[([^\]\n]+)\]\n?([\s\S]*)$/);
  if (!match) return { title: null, rest: text };
  return { title: match[1], rest: match[2] };
}

function noteRow(event, createdAt) {
  const row = element("div", `note note-${event.kind}`);
  row.title = createdAt.toLocaleString();
  row.append(element("span", "note-text", event.text));
  return row;
}

function handoffNote(event, createdAt) {
  const { title, rest } = splitBracketHeader(event.text);
  const note = element("details", "note note-handoff");
  note.title = createdAt.toLocaleString();
  note.append(element("summary", "note-handoff-summary", title ?? CARD_TITLES.handoff));
  if (rest.trim()) {
    const content = element("div", "rich note-handoff-body");
    renderRichText(content, rest);
    note.append(content);
  }
  return note;
}

function dayDivider(date) {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const label = date.toDateString() === today ? "Today"
    : date.toDateString() === yesterday ? "Yesterday"
    : date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  const divider = element("div", "day-divider");
  divider.append(element("span", "day-divider-label", label));
  return divider;
}

function shortTime(date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Light formatting for agent output: ``` code blocks, `inline code`, **bold**,
// # headings and | pipe | tables |. Builds DOM nodes only; message text is
// never parsed as HTML.
function renderRichText(container, text) {
  text.split("```").forEach((part, index) => {
    if (index % 2 === 1) {
      container.append(element("pre", "rich-code", part.replace(/^[\w+.-]*\n/, "").replace(/\n$/, "")));
      return;
    }
    const trimmed = part.replace(/^\n+|\n+$/g, "");
    if (!trimmed) return;
    const lines = trimmed.split("\n");
    let paragraphLines = [];
    const flushParagraph = () => {
      const content = paragraphLines.join("\n").replace(/^\n+|\n+$/g, "");
      paragraphLines = [];
      if (!content) return;
      const paragraph = element("div", "rich-text");
      content.split("\n").forEach((line, lineIndex) => {
        if (lineIndex > 0) paragraph.append("\n");
        const heading = line.match(/^#{1,6}\s+(.*)$/);
        if (heading) paragraph.append(element("strong", "rich-heading", heading[1]));
        else appendInlineText(paragraph, line);
      });
      container.append(paragraph);
    };
    let lineIndex = 0;
    while (lineIndex < lines.length) {
      if (!isTableStart(lines, lineIndex)) {
        paragraphLines.push(lines[lineIndex]);
        lineIndex += 1;
        continue;
      }
      flushParagraph();
      const tableLines = [lines[lineIndex]];
      lineIndex += 2;
      while (lineIndex < lines.length && isTableRow(lines[lineIndex])) {
        tableLines.push(lines[lineIndex]);
        lineIndex += 1;
      }
      container.append(renderTable(tableLines));
    }
    flushParagraph();
  });
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableStart(lines, index) {
  const separator = lines[index + 1];
  return isTableRow(lines[index]) && separator !== undefined && /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(separator);
}

// Splits "| a | `b|c` |" into ["a", "`b|c`"], ignoring pipes inside inline code.
function tableCells(line) {
  const cells = [];
  let current = "";
  let inCode = false;
  for (const character of line.trim().replace(/^\|/, "").replace(/\|$/, "")) {
    if (character === "`") inCode = !inCode;
    if (character === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function renderTable(tableLines) {
  const wrapper = element("div", "rich-table-wrap");
  const table = element("table", "rich-table");
  const [headerLine, ...bodyLines] = tableLines;
  const headerRow = element("tr");
  tableCells(headerLine).forEach((cell) => {
    const headerCell = element("th");
    appendInlineText(headerCell, cell);
    headerRow.append(headerCell);
  });
  table.append(element("thead"));
  table.tHead.append(headerRow);
  const tableBody = element("tbody");
  bodyLines.forEach((line) => {
    const row = element("tr");
    tableCells(line).forEach((cell) => {
      const dataCell = element("td");
      appendInlineText(dataCell, cell);
      row.append(dataCell);
    });
    tableBody.append(row);
  });
  table.append(tableBody);
  wrapper.append(table);
  return wrapper;
}

function appendInlineText(node, text) {
  let lastIndex = 0;
  for (const match of text.matchAll(/`[^`]+`|\*\*[^*]+\*\*/g)) {
    node.append(text.slice(lastIndex, match.index));
    const token = match[0];
    node.append(token.startsWith("`")
      ? element("code", "rich-inline-code", token.slice(1, -1))
      : element("strong", "", token.slice(2, -2)));
    lastIndex = match.index + token.length;
  }
  node.append(text.slice(lastIndex));
}

// Text being typed shows where it will land: in the open thread or the main chat.
function renderStreamingBubbles() {
  const placement = state.streamingPlacement.get(state.selected) ?? {};
  const pendingEvent = {
    kind: "assistant", thread_id: placement.threadId ?? null, item_id: placement.itemId ?? null, origin: placement.origin ?? null,
  };
  renderStreamingBubble(views.main, showsInMain(state.selected, pendingEvent));
  renderStreamingBubble(views.thread, isInOpenThread(state.selected, pendingEvent));
}

function renderStreamingBubble(view, visible) {
  removeStreamingBubble(view);
  const text = state.streaming.get(state.selected);
  if (!visible || !text) return;
  const author = { key: state.selected, name: state.selected };
  const continues = view.lastAuthor === state.selected && Date.now() - view.lastMessageAt < MESSAGE_GROUP_MS;
  const row = messageRow("assistant", text, author, new Date(), continues);
  row.classList.add("is-streaming", "js-streaming");
  view.container.append(row);
  scrollToBottom(view);
}

function removeStreamingBubble(view) {
  view.container.querySelector(".js-streaming")?.remove();
}

// ---------------------------------------------------------------- theme

function savedTheme() {
  try {
    const theme = localStorage.getItem("vdev.theme");
    return theme === "light" || theme === "dark" ? theme : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("vdev.theme", theme);
  } catch {
    // storage unavailable; the choice lasts until the page reloads
  }
  for (const option of elements.themeOptions) {
    option.setAttribute("aria-checked", String(option.dataset.themeChoice === theme));
  }
}

const API_MODE_HINTS = {
  off: "Members always use your Claude plan.",
  fallback: "Members that hit your Claude plan limit restart on the API key, continue their turn, and switch back when the limit resets.",
  always: "Every member runs on the API key instead of your Claude plan. Usage is billed to the key's Console account.",
};

function renderApiModeHint() {
  elements.apiModeHint.textContent = API_MODE_HINTS[elements.apiFields.elements.apiMode.value] ?? "";
}

function renderApiFallbackStatus() {
  const until = state.workspace?.apiSettings?.apiFallbackUntil;
  elements.apiFallbackStatus.hidden = !until;
  if (until) elements.apiFallbackStatus.textContent = `Plan limit reached: members use the API key until ${formatClockTime(until)}.`;
}

function formatClockTime(milliseconds) {
  return new Date(milliseconds).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderRateLimit(rateLimit) {
  const fallbackUntil = state.workspace?.apiSettings?.apiFallbackUntil;
  if (fallbackUntil) {
    elements.rateLimit.textContent = `Plan limit reached: on API key until ${formatClockTime(fallbackUntil)}`;
    elements.rateLimit.dataset.status = "api";
    return;
  }
  if (!rateLimit) return;
  const resetsAt = rateLimit.resetsAt ? new Date(rateLimit.resetsAt * 1000) : null;
  const window = String(rateLimit.rateLimitType ?? "").replace("_", "-");
  const resetText = resetsAt ? `, resets ${formatClockTime(resetsAt)}` : "";
  elements.rateLimit.textContent = `Plan limit (${window}): ${rateLimit.status}${resetText}`;
  elements.rateLimit.dataset.status = rateLimit.status;
}

function scrollToBottom(view, force = false) {
  const container = view.container;
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 160;
  if (force || nearBottom) container.scrollTop = container.scrollHeight;
}

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTokens(tokens) {
  if (!tokens) return "0";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

// ---------------------------------------------------------------- composers

function createComposer(form) {
  form.append(document.querySelector(".js-composer-template").content.cloneNode(true));
  const composer = {
    form,
    input: form.querySelector(".js-composer-input"),
    attachments: [],
    attachmentList: form.querySelector(".js-attachment-list"),
    error: form.querySelector(".js-composer-error"),
    fileInput: form.querySelector(".js-file-input"),
  };
  form.querySelector(".js-composer-hint").textContent = form.dataset.hint ?? "";

  composer.showError = (message) => {
    composer.error.textContent = message;
    composer.error.hidden = false;
  };
  composer.hideError = () => {
    composer.error.hidden = true;
  };
  composer.addFiles = (files) => addFiles(composer, files);
  composer.render = () => renderAttachments(composer);
  composer.clear = () => {
    composer.input.value = "";
    composer.hideError();
    for (const attachment of composer.attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    composer.attachments = [];
    composer.render();
  };
  // What the server needs: the preview URL stays in the browser.
  composer.payloadAttachments = () => composer.attachments.map(({ name, kind, mediaType, data }) => ({ name, kind, mediaType, data }));
  composer.isEmpty = () => !composer.input.value.trim() && composer.attachments.length === 0;

  form.querySelector(".js-attach").addEventListener("click", () => composer.fileInput.click());

  composer.fileInput.addEventListener("change", () => {
    composer.addFiles([...composer.fileInput.files]);
    composer.fileInput.value = "";
  });

  composer.input.addEventListener("paste", (pasteEvent) => {
    const files = [...(pasteEvent.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    pasteEvent.preventDefault();
    composer.addFiles(files);
  });

  form.addEventListener("dragover", (dragEvent) => {
    if (!dragEvent.dataTransfer?.types.includes("Files")) return;
    dragEvent.preventDefault();
    form.classList.add("is-dragging");
  });

  form.addEventListener("dragleave", (dragEvent) => {
    if (!form.contains(dragEvent.relatedTarget)) form.classList.remove("is-dragging");
  });

  form.addEventListener("drop", (dropEvent) => {
    form.classList.remove("is-dragging");
    const files = [...(dropEvent.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    dropEvent.preventDefault();
    composer.addFiles(files);
  });

  composer.attachmentList.addEventListener("click", (clickEvent) => {
    const removeButton = clickEvent.target.closest(".js-attachment-remove");
    if (!removeButton) return;
    const [removed] = composer.attachments.splice(Number(removeButton.dataset.index), 1);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    composer.render();
  });

  return composer;
}

function attachmentKind(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (file.type.startsWith("image/")) return "image";
  return "text";
}

async function addFiles(composer, files) {
  composer.hideError();
  for (const file of files) {
    if (composer.attachments.length >= ATTACHMENT_LIMIT) {
      composer.showError(`Attach at most ${ATTACHMENT_LIMIT} files per message.`);
      break;
    }
    try {
      composer.attachments.push(await readAttachment(file));
    } catch (error) {
      composer.showError(error.message);
    }
  }
  const totalBytes = composer.attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    const removed = composer.attachments.pop();
    if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    composer.showError(`${removed.name}: attachments are limited to 24 MB per message.`);
  }
  composer.render();
}

async function readAttachment(file) {
  const kind = attachmentKind(file);
  const name = file.name && file.name !== "image.png" ? file.name : `pasted-${Date.now()}.${(file.type.split("/")[1] || "png")}`;
  if (kind === "image" && !IMAGE_MEDIA_TYPES.includes(file.type)) {
    throw new Error(`${name}: only PNG, JPEG, GIF and WebP images are supported.`);
  }
  if (file.size > MAX_BYTES_BY_KIND[kind]) {
    throw new Error(`${name}: ${kind} files must be ${MAX_BYTES_BY_KIND[kind] / 1024 / 1024} MB or smaller.`);
  }
  const attachment = { name, kind, size: file.size, mediaType: kind === "pdf" ? "application/pdf" : file.type || "text/plain" };
  if (kind === "text") {
    attachment.data = await file.text();
    if (attachment.data.includes("\u0000")) throw new Error(`${name}: binary files are not supported.`);
  } else {
    attachment.data = await readAsBase64(file);
    if (kind === "image") attachment.previewUrl = URL.createObjectURL(file);
  }
  return attachment;
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(new Error(`${file.name}: could not be read.`));
    reader.readAsDataURL(file);
  });
}

function renderAttachments(composer) {
  composer.attachmentList.hidden = composer.attachments.length === 0;
  composer.attachmentList.replaceChildren(...composer.attachments.map((attachment, index) => {
    const item = element("li", "attachment");
    if (attachment.previewUrl) {
      const preview = element("img", "attachment-preview");
      preview.src = attachment.previewUrl;
      preview.alt = "";
      item.append(preview);
    } else {
      item.append(element("span", "attachment-kind", attachment.kind === "pdf" ? "PDF" : "TXT"));
    }
    item.append(element("span", "attachment-name", attachment.name), element("span", "attachment-size", formatBytes(attachment.size)));
    const removeButton = element("button", "attachment-remove js-attachment-remove", "x");
    removeButton.type = "button";
    removeButton.dataset.index = String(index);
    removeButton.setAttribute("aria-label", `Remove ${attachment.name}`);
    item.append(removeButton);
    return item;
  }));
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

// ---------------------------------------------------------------- input

elements.memberList.addEventListener("click", (clickEvent) => {
  const button = clickEvent.target.closest(".js-member");
  if (!button) return;
  if (!elements.settingsPage.hidden) closeSettings();
  selectMember(button.dataset.member);
});

// ---------------------------------------------------------------- worker reordering

// Workers are dragged (or moved with Alt+Up/Down) among themselves; the manager stays put.
elements.memberList.addEventListener("dragstart", (dragEvent) => {
  const item = dragEvent.target.closest?.(".js-draggable-member");
  if (!item) return;
  state.draggingMember = item.dataset.member;
  dragEvent.dataTransfer.effectAllowed = "move";
  dragEvent.dataTransfer.setData("text/plain", item.dataset.member);
  item.classList.add("is-dragging");
});

elements.memberList.addEventListener("dragover", (dragEvent) => {
  if (!state.draggingMember) return;
  const target = dragEvent.target.closest(".js-draggable-member");
  dragEvent.preventDefault();
  dragEvent.dataTransfer.dropEffect = "move";
  if (!target || target.dataset.member === state.draggingMember) return;
  const dragged = draggedMemberItem();
  if (!dragged) return;
  const bounds = target.getBoundingClientRect();
  const insertAfter = dragEvent.clientY > bounds.top + bounds.height / 2;
  target.parentElement.insertBefore(dragged, insertAfter ? target.nextSibling : target);
});

elements.memberList.addEventListener("drop", (dropEvent) => {
  if (!state.draggingMember) return;
  dropEvent.preventDefault();
  state.draggingMember = null;
  const domOrder = [...elements.memberList.children].map((item) => item.dataset.member);
  commitMemberOrder(domOrder);
});

// Without a drop first (Escape, released outside the list) the drag was
// cancelled: re-rendering from state puts the previewed move back.
elements.memberList.addEventListener("dragend", () => {
  if (!state.draggingMember) return;
  state.draggingMember = null;
  renderMemberList();
});

elements.memberList.addEventListener("keydown", (keyEvent) => {
  if (!keyEvent.altKey || (keyEvent.key !== "ArrowUp" && keyEvent.key !== "ArrowDown")) return;
  const button = keyEvent.target.closest(".js-member");
  if (!button || state.members.get(button.dataset.member)?.isManager) return;
  keyEvent.preventDefault();
  const memberName = button.dataset.member;
  const order = [...state.order];
  const index = order.indexOf(memberName);
  const swapIndex = keyEvent.key === "ArrowUp" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= order.length || state.members.get(order[swapIndex])?.isManager) return;
  [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
  commitMemberOrder(order);
  elements.memberList.querySelector(`.js-member[data-member="${CSS.escape(memberName)}"]`)?.focus();
});

function draggedMemberItem() {
  return elements.memberList.querySelector(`li[data-member="${CSS.escape(state.draggingMember)}"]`);
}

// Applied right away so the list does not jump back while the server saves.
function commitMemberOrder(order) {
  const unchanged = order.length === state.order.length && order.every((name, index) => name === state.order[index]);
  applyMemberOrder(order);
  if (unchanged) return;
  send({ type: "reorderMembers", order: order.filter((name) => !state.members.get(name)?.isManager) });
}

function applyMemberOrder(order) {
  const position = new Map(order.map((name, index) => [name, index]));
  const byPosition = (first, second) => (position.get(first) ?? Infinity) - (position.get(second) ?? Infinity);
  state.order = [...state.order].sort(byPosition);
  renderMemberList();
}

elements.composer.addEventListener("submit", (submitEvent) => {
  submitEvent.preventDefault();
  const text = elements.input.value.trim();
  if (mainComposer.isEmpty() || !state.selected) return;
  const attachments = mainComposer.payloadAttachments();
  state.lastComposer = mainComposer;
  const directMention = text.match(/^@(\S+)\s+([\s\S]+)/);
  if (directMention && state.members.has(directMention[1])) {
    send({ type: "send", member: directMention[1], text: directMention[2], attachments });
  } else {
    send({ type: "send", member: state.selected, text, attachments });
  }
  mainComposer.clear();
});

elements.messages.addEventListener("click", (clickEvent) => {
  const button = clickEvent.target.closest(".js-reply-thread");
  if (button) openThread(Number(button.dataset.threadId));
});

elements.taskSummaryList.addEventListener("click", (clickEvent) => {
  const row = clickEvent.target.closest(".js-open-item");
  if (!row) return;
  if (clickEvent.target.closest(".js-archive-item")) {
    send({ type: "archiveItem", workspace: currentWorkspace(), itemId: Number(row.dataset.itemId) });
    return;
  }
  const question = clickEvent.target.closest(".js-answer-question");
  openItemThread(Number(row.dataset.itemId), question ? Number(question.dataset.questionNumber) : null);
});

elements.scheduleList.addEventListener("click", (clickEvent) => {
  const cancelButton = clickEvent.target.closest(".js-cancel-schedule");
  if (!cancelButton) return;
  const row = cancelButton.closest("[data-schedule-id]");
  send({ type: "cancelSchedule", workspace: currentWorkspace(), scheduleId: Number(row.dataset.scheduleId) });
});

elements.threadMessages.addEventListener("click", (clickEvent) => {
  const question = clickEvent.target.closest(".js-answer-question");
  if (!question || (state.openThread?.itemId ?? null) === null) return;
  openItemThread(state.openThread.itemId, Number(question.dataset.questionNumber));
});

elements.archiveDoneButton.addEventListener("click", () => send({ type: "archiveDoneItems", workspace: currentWorkspace() }));
elements.archiveAllButton.addEventListener("click", () => send({ type: "archiveAllItems", workspace: currentWorkspace() }));
elements.toggleActivityButton.addEventListener("click", () => setShowActivity(!state.showActivity));

elements.threadComposer.addEventListener("submit", (submitEvent) => {
  submitEvent.preventDefault();
  const thread = state.openThread;
  if (threadComposer.isEmpty() || !thread) return;
  const target = thread.itemId !== null ? { itemId: thread.itemId } : { threadId: thread.rootId };
  state.lastComposer = threadComposer;
  send({ type: "send", member: thread.member, text: threadComposer.input.value.trim(), attachments: threadComposer.payloadAttachments(), ...target });
  threadComposer.clear();
});

elements.threadInput.addEventListener("keydown", (keyEvent) => {
  if (keyEvent.key === "Escape") {
    closeThread();
    elements.input.focus();
    return;
  }
  if (isRecallKey(keyEvent, elements.threadInput) && state.openThread) {
    keyEvent.preventDefault();
    recallLastMessage(elements.threadInput, lastSentText(threadEvents(state.openThread)));
    return;
  }
  if (keyEvent.key === "Enter" && !keyEvent.shiftKey && !keyEvent.isComposing) {
    keyEvent.preventDefault();
    elements.threadComposer.requestSubmit();
  }
});

// Arrow Up in an empty composer brings back your last message to edit and resend,
// like a shell history or Slack's "edit last message".
function isRecallKey(keyEvent, input) {
  if (keyEvent.key !== "ArrowUp" || keyEvent.isComposing) return false;
  if (keyEvent.shiftKey || keyEvent.altKey || keyEvent.ctrlKey || keyEvent.metaKey) return false;
  return input.value === "";
}

function lastSentText(events) {
  return events.findLast((event) => event.kind === "user")?.text ?? null;
}

function mainChatEvents(memberName) {
  return (state.histories.get(memberName) ?? []).filter((event) => (event.thread_id ?? null) === null && (event.item_id ?? null) === null);
}

function recallLastMessage(input, text) {
  if (!text) return;
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event("input"));
}

elements.closeThreadButton.addEventListener("click", () => {
  closeThread();
  elements.input.focus();
});

const threadWidthDefault = 400;
const threadWidthMinimum = 320;
const sidebarWidth = 260;
const mainColumnMinimum = 360;
const threadWidthKeyboardStep = 24;

function clampThreadWidth(width) {
  const maximum = Math.max(threadWidthMinimum, window.innerWidth - sidebarWidth - mainColumnMinimum);
  return Math.round(Math.min(Math.max(width, threadWidthMinimum), maximum));
}

function currentThreadWidth() {
  return elements.threadPanel.getBoundingClientRect().width || threadWidthDefault;
}

function applyThreadWidth(width) {
  const clampedWidth = clampThreadWidth(width);
  elements.layout.style.setProperty("--thread-width", `${clampedWidth}px`);
  elements.threadResizeHandle.setAttribute("aria-valuenow", String(clampedWidth));
  return clampedWidth;
}

function savedThreadWidth() {
  try {
    const width = Number(localStorage.getItem("vdev.threadWidth"));
    return width > 0 ? width : threadWidthDefault;
  } catch {
    return threadWidthDefault;
  }
}

function saveThreadWidth(width) {
  try {
    localStorage.setItem("vdev.threadWidth", String(width));
  } catch {
    // storage unavailable; the width lasts until the page reloads
  }
}

elements.threadResizeHandle.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = elements.threadResizeHandle;
  const startX = event.clientX;
  const startWidth = currentThreadWidth();
  let latestWidth = startWidth;
  handle.setPointerCapture(event.pointerId);
  handle.classList.add("is-dragging");
  elements.layout.classList.add("is-resizing-thread");

  const onMove = (moveEvent) => {
    latestWidth = applyThreadWidth(startWidth + (startX - moveEvent.clientX));
  };
  const onEnd = () => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onEnd);
    handle.removeEventListener("pointercancel", onEnd);
    handle.classList.remove("is-dragging");
    elements.layout.classList.remove("is-resizing-thread");
    saveThreadWidth(latestWidth);
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onEnd);
  handle.addEventListener("pointercancel", onEnd);
});

elements.threadResizeHandle.addEventListener("dblclick", () => {
  saveThreadWidth(applyThreadWidth(threadWidthDefault));
});

elements.threadResizeHandle.addEventListener("keydown", (event) => {
  const direction = { ArrowLeft: 1, ArrowRight: -1 }[event.key];
  if (!direction) return;
  event.preventDefault();
  saveThreadWidth(applyThreadWidth(currentThreadWidth() + direction * threadWidthKeyboardStep));
});

window.addEventListener("resize", () => applyThreadWidth(savedThreadWidth()));

elements.input.addEventListener("keydown", (keyEvent) => {
  if (isRecallKey(keyEvent, elements.input)) {
    keyEvent.preventDefault();
    recallLastMessage(elements.input, lastSentText(mainChatEvents(state.selected)));
    return;
  }
  if (keyEvent.key === "Enter" && !keyEvent.shiftKey && !keyEvent.isComposing) {
    keyEvent.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.compactButton.addEventListener("click", () => {
  const instruction = elements.input.value.trim();
  send({ type: "compact", member: state.selected, instruction });
  elements.input.value = "";
});

elements.workspaceToggle.addEventListener("click", () => toggleWorkspacePanel());

elements.workspacePanel.addEventListener("click", (clickEvent) => {
  const option = clickEvent.target.closest(".js-workspace-option");
  if (option) openWorkspace(option.dataset.path);
});

elements.activeWorkspaces.addEventListener("click", (clickEvent) => {
  const closeButton = clickEvent.target.closest(".js-close-workspace");
  if (closeButton) {
    send({ type: "closeWorkspace", path: closeButton.dataset.path });
    return;
  }
  const option = clickEvent.target.closest(".js-workspace-option");
  if (option) openWorkspace(option.dataset.path);
});

elements.workspaceForm.addEventListener("submit", (submitEvent) => {
  submitEvent.preventDefault();
  openWorkspace(elements.workspaceInput.value.trim());
  elements.workspaceInput.value = "";
});

elements.permissionRequests.addEventListener("click", (clickEvent) => {
  const button = clickEvent.target.closest(".js-answer-permission");
  if (!button) return;
  for (const answerButton of elements.permissionRequests.querySelectorAll(`[data-request-id="${CSS.escape(button.dataset.requestId)}"]`)) {
    answerButton.disabled = true;
  }
  send({ type: "answerPermission", member: state.selected, requestId: button.dataset.requestId, decision: button.dataset.decision });
});

elements.allowAllPermissionsButton.addEventListener("click", () => {
  elements.allowAllPermissionsButton.disabled = true;
  for (const answerButton of elements.permissionRequests.querySelectorAll(".js-answer-permission")) answerButton.disabled = true;
  send({ type: "allowAllPermissions", workspace: currentWorkspace() });
});

elements.resetButton.addEventListener("click", () => send({ type: "reset", member: state.selected }));
elements.stopButton.addEventListener("click", () => send({ type: "stop", member: state.selected }));

elements.addWorkerButton.addEventListener("click", () => send({ type: "addWorker" }));
elements.openSettingsButton.addEventListener("click", () => {
  if (elements.settingsPage.hidden) openSettings();
  else closeSettings();
});
elements.closeSettingsButton.addEventListener("click", closeSettings);
elements.apiFields.addEventListener("change", renderApiModeHint);

for (const select of elements.settingsForm.querySelectorAll(".js-model-select")) {
  select.addEventListener("change", () => {
    const fieldset = select.closest(".js-agent-fields");
    syncCustomModelField(fieldset);
    if (select.value === "custom") fieldset.elements.customModel.focus();
  });
}

elements.settingsForm.addEventListener("submit", (submitEvent) => {
  submitEvent.preventDefault();
  elements.settingsError.hidden = true;
  elements.settingsStatus.textContent = "Saving...";
  const projectFields = elements.projectFields.elements;
  send({
    type: "saveSettings",
    workspace: currentWorkspace(),
    worker: agentFieldValues(agentFieldset("worker")),
    manager: agentFieldValues(agentFieldset("manager")),
    instructions: projectFields.instructions.value,
    allowedTools: ruleLines(projectFields.allowedTools.value),
    apiKey: elements.apiFields.elements.apiKey.value,
    clearApiKey: elements.apiFields.elements.clearApiKey.checked,
    apiMode: elements.apiFields.elements.apiMode.value,
  });
});

elements.removeWorkerButton.addEventListener("click", () => {
  const workerName = elements.removeWorkerButton.dataset.member;
  if (!workerName) return;
  if (!elements.removeWorkerButton.dataset.armed) {
    elements.removeWorkerButton.dataset.armed = "true";
    elements.removeWorkerButton.textContent = `Click again to remove ${workerName}`;
    return;
  }
  resetRemoveButton();
  send({ type: "removeWorker", name: workerName });
});

for (const option of elements.themeOptions) {
  option.addEventListener("click", () => applyTheme(option.dataset.themeChoice));
}
renderAgentSelects();
applyTheme(savedTheme());
state.showActivity = savedShowActivity();
renderActivityToggle();
applyThreadWidth(savedThreadWidth());

connect();
