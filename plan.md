# Virtual Dev Team App: Raw Plan

## 1. Goal

A chat app where I talk mainly to a **Manager** agent. The Manager delegates work to role-based agents (Backend Rails, UI, Designer, QA, DevOps). I can see what each member is doing, step in directly, and keep token usage under control with budgets, compaction, pause, and stop.

---

## 2. Core Principles

1. **Orchestrator owns the loop.** My backend makes every API call, so it can enforce budgets. Agents never run unsupervised.
2. **Isolated contexts.** Each member keeps its own history. Members never see each other's raw transcripts.
3. **Handoff notes, not transcripts.** Finished work comes back as a short structured summary. The Manager only reads summaries.
4. **Hard limits in code.** Token caps are enforced by the orchestrator, not just requested in prompts.
5. **Everything is visible.** Every message, tool call, and token count is stored and streamed to the UI.

---

## 3. Stack (proposed)

| Layer | Choice |
|---|---|
| App | Rails 8 |
| UI | Hotwire (Turbo + Stimulus), Turbo Streams for live updates |
| Realtime | ActionCable |
| Background jobs | Solid Queue (or Sidekiq) |
| DB | PostgreSQL |
| LLM | Anthropic API via official Ruby SDK (tool use, streaming, prompt caching) |
| Sandbox (later) | Docker container per project for running commands and tests |

Alternative: run the agent loop with the Claude Agent SDK (TS/Python) as a sidecar service and keep Rails as the UI and control plane. Decide after Phase 1.

---

## 4. Data Model

```
Team
  - name

Member
  - team_id
  - name            ("Manager", "Backend")
  - role            (manager | backend | ui | designer | qa | devops)
  - model           (per-role model choice)
  - system_prompt
  - tools           (jsonb: enabled tool names)
  - status          (idle | working | waiting | blocked | paused | compacting)
  - default_budget  (tokens per task)
  - context_tokens  (current context size estimate)
  - lock_version    (prevents concurrent writes)

Task
  - team_id
  - member_id       (assignee)
  - parent_task_id  (Manager task → subtasks)
  - title
  - brief           (what the Manager asked for)
  - status          (queued | running | done | failed | stopped | over_budget)
  - token_budget
  - tokens_used
  - handoff_note    (final summary returned to the Manager)

Message
  - member_id
  - task_id
  - role            (user | assistant | tool_result | system_note)
  - content         (jsonb, API content blocks)
  - archived        (true after compaction)
  - compaction_id   (which compaction archived it)

ToolCall
  - message_id
  - name, input, output (truncated), full_output_path
  - duration_ms, status

UsageEvent
  - member_id, task_id
  - input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
  - model, created_at

Compaction
  - member_id
  - summary
  - tokens_before, tokens_after
  - instruction     ("keep the migration details")
  - triggered_by    (user | auto | budget)
```

---

## 5. Agent Loop (per member, per task)

Runs as a background job: `AgentTurnJob(member_id, task_id)`.

```
loop:
  check control flags   → paused? stopped? compaction queued?
  check budget          → over 100%? force summary turn, stop
                          over 70%? inject "wrap up" system note (once)
  build context         → system prompt (cached) + tools (cached)
                          + compaction note (if any) + active messages
  call API (streaming)  → broadcast tokens to UI
  record UsageEvent     → update task.tokens_used, member.context_tokens
  if tool_use:
      run tool, truncate output, save full output to file
      append tool_result
      continue
  if end_turn:
      if task done → produce handoff_note → notify Manager
      else → wait for input
      break
  check auto-compact threshold → queue compaction if context too large
```

**Turn boundary** = after the API response has finished and any tool results have been added. Queued commands (compact, pause) run only at turn boundaries.

---

## 6. Manager Tools

| Tool | Purpose |
|---|---|
| `delegate_task(member, title, brief, token_budget)` | Creates a Task and starts that member's loop |
| `get_status(member?)` | Status, current task, tokens used / budget |
| `get_result(task_id)` | Returns the handoff note only |
| `send_message(member, text)` | Follow-up instruction to a working member |
| `ask_user(question)` | Pauses and asks me in the main chat |
| `stop_task(task_id)` | Cancels a member's task |

## 7. Worker Tools (by role, phased)

| Role | Tools |
|---|---|
| Backend | read_file, write_file, list_files, search_code, run_command (sandbox), run_tests |
| UI | read_file, write_file, list_files, run_command |
| Designer | write_spec, read_file (no shell) |
| QA | read_file, run_tests, run_command (read-only intent), write_report |
| DevOps | read_file, write_file, run_command |
| All | `report_done(summary, files_changed, open_issues)` creates the handoff note |

Tool output rules: return at most N lines (head and tail) plus a pointer to the full output file.

---

## 8. Token Control

**Budgets**
- Default per-task budget per role (for example 100k–200k).
- Optional team-wide daily cap.
- 70% warning (system note injected into the member's context and a UI badge).
- 100% hard stop: one final forced turn asking for `report_done`, then the task is marked `over_budget`.

**Compaction**
- Manual: `/compact @member [instruction]`.
- Auto: when the context passes X tokens (configurable per member).
- Process:
  1. Acquire the member lock and wait for the turn boundary (or interrupt if forced).
  2. Make one API call asking the member to summarize: goal, decisions, files touched, current state, next steps, plus anything named in the instruction.
  3. Mark old messages `archived`, save a Compaction record.
  4. The new context becomes system prompt + task brief + summary.
  5. Resume if the member was working.
- Archived messages stay viewable in the UI.

**Cost reducers**
- Prompt caching on system prompts and tool definitions.
- Per-role model selection (cheaper model for QA and DevOps checks).
- Truncated tool outputs.
- Manager reads handoff notes only.

---

## 9. Chat Commands

| Command | Effect |
|---|---|
| `/compact` | Compact the Manager |
| `/compact @backend [keep X]` | Compact a member at the next turn boundary |
| `/compact! @backend` | Interrupt and compact now |
| `/pause @ui` / `/resume @ui` | Pause or resume a member's loop |
| `/stop @qa` | Stop the current task |
| `/budget @backend 200k` | Change the current task's budget |
| `/status` | Summary of all members |
| `@designer <message>` | Talk to a member directly, bypassing the Manager |

---

## 10. UI Layout

```
┌──────────────┬───────────────────────────────┬──────────────────┐
│ Team sidebar │  Main chat (me ↔ Manager)     │ Member detail    │
│              │                               │ (on click)       │
│ ● Manager    │  ...                          │ live transcript  │
│   idle  12k  │                               │ tool calls       │
│ ● Backend    │                               │ token meter      │
│   working    │                               │ compaction log   │
│   ▓▓▓▓░ 64%  │                               │ [compact][pause] │
│ ● QA         │                               │ [stop]           │
│   waiting    │                               │                  │
├──────────────┴───────────────────────────────┴──────────────────┤
│ Task board: queued | running | done | blocked                   │
└─────────────────────────────────────────────────────────────────┘
```

- Member cards: status dot, current task title, token meter (green → yellow at 70% → red).
- Activity feed of delegations, completions, compactions, and budget warnings.
- Usage page: tokens and estimated cost per member, task, and day.

---

## 11. Phases

**Phase 0: Skeleton (1–2 days)**
- Rails app, models, basic chat UI, a single agent (no tools) with streaming.
- UsageEvent recording plus a token meter.

**Phase 1: Manager + one worker (core loop)**
- Manager with `delegate_task`, `get_status`, `get_result`.
- Backend member with file tools on a local test repo.
- Budgets with the 70% warning and 100% hard stop.
- Handoff notes.
- Goal: the Manager delegates a small Rails task, gets the summary, and reports back to me.

**Phase 2: Control**
- `/compact` (queued and forced), `/pause`, `/stop`, `/budget`.
- Auto-compaction threshold.
- Member detail pane with live transcript and archived history.
- Direct `@member` chat.

**Phase 3: Full team**
- Add UI, Designer, QA, and DevOps with role prompts and tool sets.
- Task board and parent/subtask tree.
- Per-role model selection.

**Phase 4: Real execution**
- Docker sandbox per project, a git branch per task, run tests.
- Optional: open a PR via the GitHub API.
- Approval gates for risky commands.

**Phase 5: Polish**
- Usage dashboard and cost estimates.
- Team templates (save and load team configs).
- Prompt caching tuning, team-wide daily cap.

---

## 12. Risks / Watch-outs

- **Manager bloat:** enforce handoff-note-only returns, and auto-compact the Manager too.
- **Agents looping on failing tests:** cap retries per tool and count them against the budget.
- **Parallel members editing the same files:** give each task its own git branch, or lock files.
- **Bad summaries losing info:** archive (never delete) history, and allow a compaction instruction.
- **Runaway cost:** hard caps in code plus a global kill switch.
- **Shell safety:** sandbox only, with an allowlist or approval for destructive commands.

---

## 13. Open Questions

- Real codebase edits from day one, or spec/plan output first?
- Do members run in parallel, or one at a time to start?
- Single user only, or will others use it?
- Where do repos live (local machine vs server)?
- Hosted or local-only app?
