# T3 Code

T3 Code is a minimal web GUI for coding agents (currently Codex and Claude, more coming soon).

## Fork Scope

This fork carries substantial changes beyond `pingdotgg/t3code` upstream. The main differences are grouped below so the fork can be understood without reading the full commit history.

### Supported Providers

This fork is no longer just Codex/Claude SDK focused. It has a broader provider layer with multiple agent backends:

- **Codex**: still the primary baseline provider, using `codex app-server` for structured turn/session events. This fork adds stronger startup failure reporting, remote launch support, usage/status capture, and restart/reconnect handling.
- **Claude Agent**: Claude support through Anthropic's Claude Agent SDK for the standard structured integration path.
- **Claude PTY**: an experimental Claude Code provider that drives the interactive `claude` terminal UI through a real PTY, then reads Claude's JSONL transcript files for assistant text, tool calls, and tool results. This lets T3 use Claude Code's subscription-authenticated interactive mode while still rendering responses in the T3 chat UI. Claude imports are routed to Claude PTY.
- **Copilot**: first-class GitHub Copilot CLI provider support through the same provider/session system.
- **OpenCode**: OpenCode provider support for chat/session usage and for git text-generation routing.

### Codex Bar And Usage Controls

This fork includes a Codex bar/usage control in the sidebar so provider limits are visible without leaving the thread.

- The usage popover reads Codex account limits through `codexbar` and supplements them with `codex status` output when available.
- It shows the primary Codex usage window, weekly usage, GPT-5.3-Codex-Spark limits, reset text, remaining credits, login/source details, and CLI version.
- Claude usage is surfaced in the same dropdown as an additional provider, so Claude and Codex subscription state can be checked from one place.
- The control also shows the current thread context-window usage when that data is available, which helps decide when to compact, fork, or change strategy.
- The trigger changes tone as limits get low or usage becomes unavailable, making quota/account problems easier to spot before a long-running task stalls.

### Kairos-Style Auto Mode

This fork includes a Claude Code Kairos-inspired auto mode. The implementation is based on analysis of Claude Code's observed background-agent behavior and then ported into T3 Code's orchestration model rather than being a normal one-shot chat loop.

Auto mode lets a thread keep working without the user repeatedly pressing send:

- T3 injects hidden `<auto_tick>` prompts that ask the provider to inspect the latest repo state, recent errors, pending follow-ups, and unfinished work.
- If there is useful work to do, the agent continues the task. If the accepted plan still has unfinished actionable steps, auto mode explicitly tells the agent not to stop after a single step.
- The provider can return hidden control messages to manage its own cadence:
  - `<t3code:auto-noop />` when there is nothing useful to do right now.
  - `<t3code:auto-stop />` when the thread has reached a clean stopping point.
  - `<t3code:auto-defer preset="15m" />`, `<t3code:auto-defer preset="1h" />`, `<t3code:auto-defer preset="tomorrow-8am" />`, or an absolute defer timestamp when it should sleep until later.
- T3 tracks consecutive no-ops, deferred wake times, retry delays, sidebar status, and restart recovery so long-running jobs do not require a live browser tab.
- Context compaction and payload pruning keep very long sessions from becoming unusable as provider histories grow.

The practical goal is “set it running and let it keep making progress.” This mode is designed for multi-hour or multi-day agent work; it has been used for tasks running more than a day without constant supervision.

### SSH Remote Projects

This fork adds first-class SSH-backed projects. Instead of only opening local folders, you can add a project by SSH host, optional port, and remote repository path.

Remote projects allow:

- Running Codex, Claude PTY, terminals, git status, and workspace operations against code that lives on another machine.
- Keeping the T3 server/UI on one host while the actual repository and provider CLI run on a remote workstation or server.
- Using remote project paths as normal T3 projects, including branch/status UI, terminal sessions, provider sessions, and imported/resumed agent threads.
- Working from mobile or another browser against a single T3 instance while agents execute close to the repository and its dependencies.

Operationally, remote projects expect noninteractive SSH auth to work from the T3 server host. Provider CLIs such as `codex` or `claude` must also be installed and authenticated on the remote host when that provider executes remotely. See [REMOTE.md](./REMOTE.md) for remote access setup.

### UI And Rendering

The chat UI has been expanded to render much more than plain assistant text:

- Command/tool activity is rendered as structured work log entries instead of opaque transcript text.
- Claude PTY reads `tool_use` and `tool_result` blocks from JSONL so Claude Code tool calls can appear as T3 tool activity.
- Image-view outputs, Claude desktop-use screenshots, and other visual artifacts render as expandable previews.
- Context compaction entries, changed files, workspace diffs, git/PR actions, and provider status are surfaced in the timeline/sidebar.
- Thread forking from existing messages is supported, including compaction-aware history transfer.
- The composer and provider controls adapt to smaller viewports with compact controls and improved model/provider pickers.

### Mobile, PWA, Notifications, And Reconnects

This fork is optimized for using T3 from phones, tablets, and remote browsers:

- PWA/mobile layout and composer behavior have been hardened for touch use and constrained viewports.
- WebSocket reconnect, replay, and catch-up logic is more defensive so a browser can disconnect and later recover missed orchestration events.
- Stale “working” and send states are handled more carefully after provider exits, service restarts, and partial streams.
- Web push and thread-completion notification plumbing is present so long-running agent work can notify the user when it needs attention or finishes.
- The `scripts/rebounce.ts` workflow rebuilds and restarts the local service during development while preserving the operational model used by the always-on server.

## Installation

> [!WARNING]
> This fork currently supports Codex, Claude Agent, Claude PTY, Copilot, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://github.com/openai/codex) and run `codex login`
> - Claude: install Claude Code and run `claude auth login`
> - Copilot: install and authenticate GitHub Copilot CLI support if using the Copilot provider
> - OpenCode: install and authenticate OpenCode if using the OpenCode provider

### Run without installing

```bash
npx t3
```

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Observability guide: [docs/observability.md](./docs/observability.md)

## If you REALLY want to contribute still.... read this first

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
