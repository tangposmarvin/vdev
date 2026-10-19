# vdev

A local web UI for running a small team of Claude Code agents. You talk to a Manager, which breaks your request into tasks and delegates them to workers. Every member is a `claude -p` process that uses your own Claude login, and you can watch, interrupt, or message any of them directly.

## Quick start (macOS / Linux)

```sh
git clone <this repo>
cd vdev
bin/install
bin/server
```

Then open http://127.0.0.1:4321 and pick a workspace (a project folder under one of `workspaceRoots`).

`bin/install` installs [Bun](https://bun.sh) and the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI if they are missing, then logs you in to Claude Code. It is safe to run again. On Linux it needs `curl` and `unzip`.

Optional extras:

- Claude in Chrome extension, for workers with `"chrome": true`
- [rtk](https://github.com/rtk-ai/rtk), used for command output rewriting when it is installed

## Configuration

Edit `team.json`:

| Key | Purpose |
|---|---|
| `port` | HTTP port (default 4321) |
| `workspaceRoots` | Folders whose projects can be opened as workspaces |
| `idleMinutes` | Idle time before a member's process is stopped |
| `manager` | Model, effort, tools, and prompt for the Manager |
| `worker` | Shared settings for every worker (model, effort, budget, allowed tools, `chrome`) |
| `workers` | Worker names |

`worker.chrome` is off by default. Set it to `true` to let workers drive Chrome through the Claude in Chrome extension. The model IDs in `team.json` must be available on your plan.

Environment variables (e.g. `VDEV_PORT=5000 bin/server`):

- `VDEV_PORT`: overrides `port`
- `VDEV_DATABASE`: path to the SQLite database (default `./vdev.sqlite`)
- `CLAUDE_CONFIG_DIR`: Claude Code config directory (default `~/.claude`)

## Security

The server binds to `127.0.0.1` only. Agents run real commands in your workspace with your Claude account. Do not expose the port to a network.

The optional Anthropic API key fallback (set in the UI) is stored in plain text in `vdev.sqlite`.

## Token report

```sh
bun scripts/token-report.ts --days 7
```

Shows where tokens went per member and task, using the vdev database and Claude Code transcripts.
