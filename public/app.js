// vdev browser client: renders team state pushed over a WebSocket.

const state = {
  members: new Map(),
  order: [],
  selected: null,
  histories: new Map(),
  streaming: new Map(),
  // member -> root event id of the thread the streaming text belongs to (null = main chat)
  streamingThread: new Map(),
  // { member, rootId } of the thread shown in the side panel
  openThread: null,
  unreadThreads: new Set(),
  unread: new Set(),
  unreadWorkspaces: new Set(),
  memberConfigs: [],
  editingMember: null,
  pendingSelection: null,
  // name of the worker being dragged in the sidebar; list re-renders wait until the drop
  draggingMember: null,
  attachments: [],
  socket: null,
};

const ATTACHMENT_LIMIT = 10;
const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_BYTES_BY_KIND = { image: 5 * 1024 * 1024, pdf: 10 * 1024 * 1024, text: 1024 * 1024 };
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

const elements = {
  connection: document.querySelector(".js-connection"),
  memberList: document.querySelector(".js-member-list"),
  rateLimit: document.querySelector(".js-rate-limit"),
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
  layout: document.querySelector(".layout"),
  threadPanel: document.querySelector(".js-thread-panel"),
  threadMeta: document.querySelector(".js-thread-meta"),
  threadMessages: document.querySelector(".js-thread-messages"),
  threadComposer: document.querySelector(".js-thread-composer"),
  threadInput: document.querySelector(".js-thread-input"),
  closeThreadButton: document.querySelector(".js-close-thread"),
  composer: document.querySelector(".js-composer"),
  input: document.querySelector(".js-input"),
  attachButton: document.querySelector(".js-attach"),
  fileInput: document.querySelector(".js-file-input"),
  attachmentList: document.querySelector(".js-attachment-list"),
  composerError: document.querySelector(".js-composer-error"),
  compactButton: document.querySelector(".js-compact"),
  resetButton: document.querySelector(".js-reset"),
  stopButton: document.querySelector(".js-stop"),
  editMemberButton: document.querySelector(".js-edit-member"),
  permissionsButton: document.querySelector(".js-permissions"),
  chat: document.querySelector(".chat"),
  openSettingsButton: document.querySelector(".js-open-settings"),
  settingsPage: document.querySelector(".js-settings-page"),
  settingsPath: document.querySelector(".js-settings-path"),
  settingsForm: document.querySelector(".js-settings-form"),
  settingsMembers: document.querySelector(".js-settings-members"),
  settingsError: document.querySelector(".js-settings-error"),
  settingsStatus: document.querySelector(".js-settings-status"),
  closeSettingsButton: document.querySelector(".js-close-settings"),
  addMemberButton: document.querySelector(".js-add-member"),
  allowAllPermissionsButton: document.querySelector(".js-allow-all-permissions"),
  memberDialog: document.querySelector(".js-member-dialog"),
  memberForm: document.querySelector(".js-member-form"),
  memberFormTitle: document.querySelector(".js-member-form-title"),
  memberFormError: document.querySelector(".js-member-form-error"),
  removeMemberButton: document.querySelector(".js-remove-member"),
  cancelMemberButton: document.querySelector(".js-cancel-member"),
};

const AVATAR_COLOR_COUNT = 8;
const MESSAGE_GROUP_MS = 5 * 60 * 1000;
const BOT_NAME = "vdev";
const CARD_TITLES = { task: "Task", handoff: "Handoff", error: "Error" };
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
      state.order = message.members.map((member) => member.name);
      state.members = new Map(message.members.map((member) => [member.name, member]));
      state.memberConfigs = message.memberConfigs ?? [];
      state.histories.clear();
      state.streaming.clear();
      state.streamingThread.clear();
      state.unread.clear();
      state.unreadThreads.clear();
      closeThread();
      state.workspace = message;
      state.unreadWorkspaces.delete(message.workspace);
      renderWorkspace();
      renderActiveWorkspaces();
      if (message.workspace) toggleWorkspacePanel(false);
      else toggleWorkspacePanel(true);
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
      showComposerError(message.message);
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
      handleDelta(message.member, message.text, message.threadId ?? null);
      break;
    case "rate":
      renderRateLimit(message.rateLimit);
      break;
    case "workspaces":
      if (state.workspace) state.workspace.activeWorkspaces = message.activeWorkspaces;
      renderActiveWorkspaces();
      break;
    case "sendError":
      showComposerError(message.message);
      break;
    case "projectSettings":
      if (state.workspace) {
        state.workspace.projectSettings = {
          instructions: message.instructions, allowedTools: message.allowedTools, chrome: message.chrome, sharePermissions: message.sharePermissions,
        };
      }
      break;
    case "projectSettingsSaved":
      for (const checkbox of elements.settingsMembers.querySelectorAll(".js-settings-member-chrome")) {
        checkbox.dataset.initial = String(memberChromeValue(checkbox));
      }
      elements.settingsStatus.textContent = "Saved. Affected members restart to apply it (busy ones after their current work).";
      break;
    case "projectSettingsError":
      elements.settingsError.textContent = message.message;
      elements.settingsError.hidden = false;
      break;
    case "memberSaved":
      elements.memberDialog.close();
      break;
    case "memberError":
      elements.memberFormError.textContent = message.message;
      elements.memberFormError.hidden = false;
      break;
    case "workspaceError":
      elements.workspaceError.textContent = message.message;
      elements.workspaceError.hidden = false;
      break;
  }
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
  elements.openSettingsButton.disabled = !workspace.workspace;
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
  const history = state.histories.get(memberName);
  if (history) history.push(event);
  if (memberName !== state.selected) {
    if (event.kind === "tool") return;
    state.unread.add(memberName);
    renderMemberList();
    return;
  }

  const threadId = event.thread_id ?? null;
  if (threadId === null) {
    appendLiveEvent(views.main, event);
  } else {
    if (state.openThread?.rootId === threadId) appendLiveEvent(views.thread, event);
    else if (event.kind !== "tool") state.unreadThreads.add(threadId);
    renderThreadSummary(threadId);
  }
  renderStreamingBubbles();
}

function appendLiveEvent(view, event) {
  removeStreamingBubble(view);
  appendEvent(event, view);
  scrollToBottom(view);
}

function handleDelta(memberName, text, threadId) {
  if (state.streamingThread.get(memberName) !== threadId) state.streaming.delete(memberName);
  state.streamingThread.set(memberName, threadId);
  state.streaming.set(memberName, (state.streaming.get(memberName) ?? "") + text);
  if (memberName !== state.selected) return;
  renderStreamingBubbles();
}

// ---------------------------------------------------------------- member editor

function openMemberEditor(memberName) {
  const memberConfig = state.memberConfigs.find((config) => config.name === memberName);
  const fields = elements.memberForm.elements;
  state.editingMember = memberConfig?.name ?? null;
  elements.memberForm.reset();
  elements.memberFormTitle.textContent = memberConfig ? `Edit ${memberConfig.name}` : "Add member";
  elements.memberFormError.hidden = true;
  resetRemoveButton();
  renderTemplateOptions(memberConfig);

  const isManager = memberConfig?.role === "manager";
  fields.name.value = memberConfig?.name ?? "";
  fields.name.disabled = Boolean(memberConfig);
  fields.role.disabled = isManager;
  fillMemberFields(memberConfig);
  elements.removeMemberButton.hidden = !memberConfig || isManager;

  elements.memberDialog.showModal();
  (memberConfig ? fields.role.disabled ? fields.model : fields.role : fields.name).focus();
}

// Everything but the name, so a template fills a new member the same way.
function fillMemberFields(memberConfig) {
  const fields = elements.memberForm.elements;
  fields.role.value = memberConfig?.role ?? "";
  setModelField(memberConfig?.model ?? "sonnet");
  fields.effort.value = memberConfig?.effort ?? "";
  fields.permissionMode.value = memberConfig?.permissionMode ?? "";
  fields.budget.value = memberConfig?.budget ?? "";
  fields.prompt.value = memberConfig?.prompt ?? "";
  // New members start read-only; existing ones show exactly what team.json has.
  const allowedTools = memberConfig ? memberConfig.allowedTools ?? [] : ["Read", "Glob", "Grep"];
  fields.allowedTools.value = allowedTools.join("\n");
  fields.tools.value = (memberConfig?.tools ?? []).join("\n");
  fields.autocompact.value = memberConfig?.autocompact ?? "";
  fields.chrome.checked = Boolean(memberConfig?.chrome);
}

function renderTemplateOptions(editingConfig) {
  const templateField = elements.memberForm.querySelector(".js-template-field");
  const select = elements.memberForm.querySelector(".js-template-select");
  templateField.hidden = Boolean(editingConfig);
  const options = state.memberConfigs
    .filter((memberConfig) => memberConfig.role !== "manager")
    .map((memberConfig) => {
      const option = element("option", "", `${memberConfig.name} - ${memberConfig.role}`);
      option.value = memberConfig.name;
      return option;
    });
  const emptyOption = element("option", "", "Start empty");
  emptyOption.value = "";
  select.replaceChildren(emptyOption, ...options);
}

function applyTemplate(templateName) {
  const fields = elements.memberForm.elements;
  const template = state.memberConfigs.find((memberConfig) => memberConfig.name === templateName);
  fillMemberFields(template ?? null);
  if (!template) return;
  fields.name.value = nextFreeName(template.name);
  fields.name.focus();
  fields.name.select();
}

// qa -> qa2, qa2 -> qa3: the first numbered name not taken yet.
function nextFreeName(templateName) {
  const baseName = templateName.replace(/\d+$/, "");
  const takenNames = new Set(state.memberConfigs.map((memberConfig) => memberConfig.name));
  let number = 2;
  while (takenNames.has(`${baseName}${number}`)) number += 1;
  return `${baseName}${number}`;
}

// Known models show in the list; anything else (an older ID, say) shows as
// "Other model ID" with the value in the text box, so it is kept as is.
function setModelField(model) {
  const fields = elements.memberForm.elements;
  const known = [...fields.model.options].some((option) => option.value === model && option.value !== "custom");
  fields.model.value = known ? model : "custom";
  fields.customModel.value = known ? "" : model;
  syncCustomModelField();
}

function syncCustomModelField() {
  const fields = elements.memberForm.elements;
  const custom = fields.model.value === "custom";
  fields.customModel.hidden = !custom;
  fields.customModel.required = custom;
}

function memberFormValues() {
  const fields = elements.memberForm.elements;
  const lines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    originalName: state.editingMember,
    name: fields.name.value.trim(),
    role: fields.role.value.trim(),
    model: fields.model.value === "custom" ? fields.customModel.value.trim() : fields.model.value,
    effort: fields.effort.value,
    permissionMode: fields.permissionMode.value,
    budget: fields.budget.value,
    prompt: fields.prompt.value,
    allowedTools: lines(fields.allowedTools.value),
    tools: lines(fields.tools.value),
    autocompact: fields.autocompact.value.trim(),
    chrome: fields.chrome.checked,
  };
}

// ---------------------------------------------------------------- project settings

// Rendered once per opening so live member updates never wipe unsaved edits.
function openSettings(focusMemberName) {
  const projectSettings = state.workspace?.projectSettings;
  if (!projectSettings) return;
  const fields = elements.settingsForm.elements;
  fields.instructions.value = projectSettings.instructions;
  fields.allowedTools.value = projectSettings.allowedTools.join("\n");
  fields.chrome.checked = projectSettings.chrome;
  fields.sharePermissions.checked = projectSettings.sharePermissions !== false;
  elements.settingsPath.textContent = state.workspace.workspace;
  elements.settingsError.hidden = true;
  elements.settingsStatus.textContent = "";
  elements.settingsMembers.replaceChildren(...state.order.map((memberName) => settingsMemberRow(state.members.get(memberName))));
  syncMemberChromeSwitches();

  closeThread();
  elements.chat.hidden = true;
  elements.settingsPage.hidden = false;
  const focusField = focusMemberName && elements.settingsMembers.querySelector(`[data-member="${CSS.escape(focusMemberName)}"]`);
  if (focusField) {
    focusField.scrollIntoView({ block: "center" });
    focusField.focus();
  } else {
    fields.instructions.focus();
  }
}

function settingsMemberRow(member) {
  const row = element("div", "settings-member");
  const heading = element("div", "settings-member-heading");
  heading.append(element("span", "member-name", member.name), element("span", "member-role", member.role));

  const chromeChecked = member.projectChrome ?? member.chromeDefault;
  const chromeSwitch = element("label", "settings-member-chrome");
  const chromeCheckbox = element("input", "js-settings-member-chrome");
  chromeCheckbox.type = "checkbox";
  chromeCheckbox.dataset.member = member.name;
  chromeCheckbox.dataset.initial = String(chromeChecked);
  chromeCheckbox.dataset.own = String(chromeChecked);
  chromeCheckbox.checked = chromeChecked;
  chromeSwitch.title = member.projectChrome === null ? "Using this member's default (Edit member)" : "Set for this project";
  chromeSwitch.append(chromeCheckbox, element("span", "", "Claude in Chrome"));
  heading.append(chromeSwitch);

  const textarea = element("textarea", "form-input form-textarea form-mono js-settings-member-rules");
  textarea.rows = 3;
  textarea.spellcheck = false;
  textarea.dataset.member = member.name;
  textarea.placeholder = "Extra rules for this member, one per line";
  textarea.setAttribute("aria-label", `Extra permissions for ${member.name}`);
  textarea.value = (member.workspaceAllowedTools ?? []).join("\n");

  const baseRules = [...member.allowedTools, ...(member.chrome ? ["mcp__claude-in-chrome"] : [])];
  const base = element("pre", "permissions-base", baseRules.length > 0 ? baseRules.join("\n") : "(no rules of its own)");
  base.title = "Always allowed for this member (Edit member)";

  const columns = element("div", "settings-member-columns");
  columns.append(textarea, base);
  row.append(heading, columns);
  return row;
}

// "All members" wins: member switches show as on and locked, and get their
// own value back when it is turned off again.
function syncMemberChromeSwitches() {
  const allMembers = elements.settingsForm.elements.chrome.checked;
  for (const checkbox of elements.settingsMembers.querySelectorAll(".js-settings-member-chrome")) {
    if (allMembers && !checkbox.disabled) checkbox.dataset.own = String(checkbox.checked);
    checkbox.disabled = allMembers;
    checkbox.checked = allMembers || checkbox.dataset.own === "true";
  }
}

function memberChromeValue(checkbox) {
  return checkbox.disabled ? checkbox.dataset.own === "true" : checkbox.checked;
}

function closeSettings() {
  elements.settingsPage.hidden = true;
  elements.chat.hidden = false;
  elements.input.focus();
}

function ruleLines(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

// Removing takes two clicks instead of a blocking confirm() dialog.
function resetRemoveButton() {
  delete elements.removeMemberButton.dataset.armed;
  elements.removeMemberButton.textContent = "Remove member";
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
  elements.memberMeta.textContent = `${member.role} - ${member.model} - ${statusLabel(member)}${context} - ${formatTokens(member.totalSpent)} tokens total`;
  elements.stopButton.disabled = member.status === "asleep";
  elements.editMemberButton.disabled = false;
  elements.permissionsButton.disabled = false;
  const extraRules = member.workspaceAllowedTools?.length ?? 0;
  elements.permissionsButton.textContent = extraRules > 0 ? `Permissions (+${extraRules})` : "Permissions";

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
      request.browser || state.workspace?.projectSettings?.sharePermissions !== false
        ? ["always", "button", `Always allow ${request.rule}`, `Save ${request.rule} for all members in this workspace`]
        : ["always", "button", `Always allow ${request.rule}`, `Save ${request.rule} for ${member.name} in this workspace`],
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
    if ((event.thread_id ?? null) === null) appendEvent(event, views.main);
  }
  renderStreamingBubbles();
  scrollToBottom(views.main, true);
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
  return event.kind === "assistant" && (event.thread_id ?? null) === null && event.id !== undefined;
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
  state.openThread = { member: state.selected, rootId };
  state.unreadThreads.delete(rootId);
  renderThreadSummary(rootId);
  elements.threadPanel.hidden = false;
  elements.layout.classList.add("has-thread");
  renderThread();
  elements.threadInput.placeholder = `Reply to ${state.selected}...`;
  elements.threadInput.focus();
}

function closeThread() {
  state.openThread = null;
  elements.threadPanel.hidden = true;
  elements.layout.classList.remove("has-thread");
  elements.threadInput.value = "";
  resetView(views.thread);
}

function renderThread() {
  const thread = state.openThread;
  if (!thread) return;
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

function authorFor(event) {
  if (event.kind === "user") return { key: "you", name: "You" };
  if (event.kind === "assistant") return { key: state.selected, name: state.selected };
  if (event.kind === "task") {
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

// Light formatting for agent output: ``` code blocks, `inline code`, **bold**
// and # headings. Builds DOM nodes only; message text is never parsed as HTML.
function renderRichText(container, text) {
  text.split("```").forEach((part, index) => {
    if (index % 2 === 1) {
      container.append(element("pre", "rich-code", part.replace(/^[\w+.-]*\n/, "").replace(/\n$/, "")));
      return;
    }
    const trimmed = part.replace(/^\n+|\n+$/g, "");
    if (!trimmed) return;
    const paragraph = element("div", "rich-text");
    trimmed.split("\n").forEach((line, lineIndex) => {
      if (lineIndex > 0) paragraph.append("\n");
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) paragraph.append(element("strong", "rich-heading", heading[1]));
      else appendInlineText(paragraph, line);
    });
    container.append(paragraph);
  });
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
  const threadId = state.streamingThread.get(state.selected) ?? null;
  const showsInThread = threadId !== null && state.openThread?.member === state.selected && state.openThread.rootId === threadId;
  renderStreamingBubble(views.main, threadId === null);
  renderStreamingBubble(views.thread, showsInThread);
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

function renderRateLimit(rateLimit) {
  if (!rateLimit) return;
  const resetsAt = rateLimit.resetsAt ? new Date(rateLimit.resetsAt * 1000) : null;
  const window = String(rateLimit.rateLimitType ?? "").replace("_", "-");
  const resetText = resetsAt ? `, resets ${resetsAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
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

// ---------------------------------------------------------------- attachments

function attachmentKind(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (file.type.startsWith("image/")) return "image";
  return "text";
}

async function addFiles(files) {
  hideComposerError();
  for (const file of files) {
    if (state.attachments.length >= ATTACHMENT_LIMIT) {
      showComposerError(`Attach at most ${ATTACHMENT_LIMIT} files per message.`);
      break;
    }
    try {
      state.attachments.push(await readAttachment(file));
    } catch (error) {
      showComposerError(error.message);
    }
  }
  const totalBytes = state.attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    const removed = state.attachments.pop();
    showComposerError(`${removed.name}: attachments are limited to 24 MB per message.`);
  }
  renderAttachments();
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

function renderAttachments() {
  elements.attachmentList.hidden = state.attachments.length === 0;
  elements.attachmentList.replaceChildren(...state.attachments.map((attachment, index) => {
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

function clearAttachments() {
  for (const attachment of state.attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  state.attachments = [];
  renderAttachments();
}

function showComposerError(message) {
  elements.composerError.textContent = message;
  elements.composerError.hidden = false;
}

function hideComposerError() {
  elements.composerError.hidden = true;
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
  state.memberConfigs = [...state.memberConfigs].sort((first, second) => byPosition(first.name, second.name));
  renderMemberList();
}

elements.composer.addEventListener("submit", (submitEvent) => {
  submitEvent.preventDefault();
  const text = elements.input.value.trim();
  if ((!text && state.attachments.length === 0) || !state.selected) return;
  const attachments = state.attachments.map(({ name, kind, mediaType, data }) => ({ name, kind, mediaType, data }));
  const directMention = text.match(/^@(\S+)\s+([\s\S]+)/);
  if (directMention && state.members.has(directMention[1])) {
    send({ type: "send", member: directMention[1], text: directMention[2], attachments });
  } else {
    send({ type: "send", member: state.selected, text, attachments });
  }
  elements.input.value = "";
  hideComposerError();
  clearAttachments();
});

elements.messages.addEventListener("click", (clickEvent) => {
  const button = clickEvent.target.closest(".js-reply-thread");
  if (button) openThread(Number(button.dataset.threadId));
});

elements.threadComposer.addEventListener("submit", (submitEvent) => {
  submitEvent.preventDefault();
  const text = elements.threadInput.value.trim();
  if (!text || !state.openThread) return;
  send({ type: "send", member: state.openThread.member, text, threadId: state.openThread.rootId });
  elements.threadInput.value = "";
});

elements.threadInput.addEventListener("keydown", (keyEvent) => {
  if (keyEvent.key === "Escape") {
    closeThread();
    elements.input.focus();
    return;
  }
  if (keyEvent.key === "Enter" && !keyEvent.shiftKey && !keyEvent.isComposing) {
    keyEvent.preventDefault();
    elements.threadComposer.requestSubmit();
  }
});

elements.closeThreadButton.addEventListener("click", () => {
  closeThread();
  elements.input.focus();
});

elements.attachButton.addEventListener("click", () => elements.fileInput.click());

elements.fileInput.addEventListener("change", () => {
  addFiles([...elements.fileInput.files]);
  elements.fileInput.value = "";
});

elements.input.addEventListener("paste", (pasteEvent) => {
  const files = [...(pasteEvent.clipboardData?.files ?? [])];
  if (files.length === 0) return;
  pasteEvent.preventDefault();
  addFiles(files);
});

elements.composer.addEventListener("dragover", (dragEvent) => {
  if (!dragEvent.dataTransfer?.types.includes("Files")) return;
  dragEvent.preventDefault();
  elements.composer.classList.add("is-dragging");
});

elements.composer.addEventListener("dragleave", (dragEvent) => {
  if (!elements.composer.contains(dragEvent.relatedTarget)) elements.composer.classList.remove("is-dragging");
});

elements.composer.addEventListener("drop", (dropEvent) => {
  elements.composer.classList.remove("is-dragging");
  const files = [...(dropEvent.dataTransfer?.files ?? [])];
  if (files.length === 0) return;
  dropEvent.preventDefault();
  addFiles(files);
});

elements.attachmentList.addEventListener("click", (clickEvent) => {
  const removeButton = clickEvent.target.closest(".js-attachment-remove");
  if (!removeButton) return;
  const [removed] = state.attachments.splice(Number(removeButton.dataset.index), 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  renderAttachments();
});

elements.input.addEventListener("keydown", (keyEvent) => {
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

elements.addMemberButton.addEventListener("click", () => openMemberEditor(null));
elements.editMemberButton.addEventListener("click", () => openMemberEditor(state.selected));
elements.cancelMemberButton.addEventListener("click", () => elements.memberDialog.close());
elements.permissionsButton.addEventListener("click", () => openSettings(state.selected));
elements.openSettingsButton.addEventListener("click", () => openSettings());
elements.closeSettingsButton.addEventListener("click", closeSettings);
elements.settingsForm.elements.chrome.addEventListener("change", syncMemberChromeSwitches);

elements.settingsForm.addEventListener("submit", (submitEvent) => {
  submitEvent.preventDefault();
  elements.settingsError.hidden = true;
  elements.settingsStatus.textContent = "Saving...";
  const fields = elements.settingsForm.elements;
  const members = {};
  for (const textarea of elements.settingsMembers.querySelectorAll(".js-settings-member-rules")) {
    members[textarea.dataset.member] = { allowedTools: ruleLines(textarea.value) };
  }
  // A Chrome switch is only sent when changed, so untouched members keep following their default.
  for (const checkbox of elements.settingsMembers.querySelectorAll(".js-settings-member-chrome")) {
    const chrome = memberChromeValue(checkbox);
    if (String(chrome) !== checkbox.dataset.initial) members[checkbox.dataset.member].chrome = chrome;
  }
  send({
    type: "saveProjectSettings",
    workspace: currentWorkspace(),
    instructions: fields.instructions.value,
    allowedTools: ruleLines(fields.allowedTools.value),
    chrome: fields.chrome.checked,
    sharePermissions: fields.sharePermissions.checked,
    members,
  });
});

elements.memberForm.addEventListener("submit", (submitEvent) => {
  submitEvent.preventDefault();
  elements.memberFormError.hidden = true;
  const config = memberFormValues();
  if (!config.originalName) state.pendingSelection = config.name;
  const templateName = elements.memberForm.elements.template.value;
  send({ type: "saveMember", config, copyPermissionsFrom: config.originalName ? undefined : templateName || undefined });
});

elements.memberForm.elements.template.addEventListener("change", () => {
  applyTemplate(elements.memberForm.elements.template.value);
});

elements.memberForm.elements.model.addEventListener("change", () => {
  syncCustomModelField();
  if (elements.memberForm.elements.model.value === "custom") elements.memberForm.elements.customModel.focus();
});

elements.removeMemberButton.addEventListener("click", () => {
  if (!state.editingMember) return;
  if (!elements.removeMemberButton.dataset.armed) {
    elements.removeMemberButton.dataset.armed = "true";
    elements.removeMemberButton.textContent = `Click again to remove ${state.editingMember}`;
    return;
  }
  resetRemoveButton();
  send({ type: "removeMember", name: state.editingMember });
});

for (const option of elements.themeOptions) {
  option.addEventListener("click", () => applyTheme(option.dataset.themeChoice));
}
applyTheme(savedTheme());

connect();
