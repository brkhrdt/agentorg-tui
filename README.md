# Agent Organization TUI

A standalone **Bun** terminal client for the Unix-socket API in
[`client_spec.md`](client_spec.md). No imports from or changes to the server repo.

## Run

Requires Bun and an interactive Unix terminal. Start the organization server
separately, then from this directory:

```sh
bun install
bun start --socket ../.org/server.sock
```

The socket defaults to `ORG_SOCKET`, or `.org/server.sock` relative to the
client's working directory. Use an absolute path when the server runs elsewhere.
The server and client must have compatible socket filesystem permissions.

```sh
bun start --socket /absolute/path/server.sock --config ./settings.json
bun start --help
```

An empty organization is displayed as an empty tree; create agents through the
server's existing client/API. This UI does not create or start agents.

## Keys

### Agent tree (default)

| Key | Action |
| --- | --- |
| ↑ / ↓ | Select an agent (highlighted blue) |
| Enter | Open an interrupting prompt for the selected agent |
| c | Open the selected agent's chat |
| v, then f | Configure tracked events |
| v, then l | Configure rendering levels |
| q / Ctrl+C | Quit the client, leaving server work running |

Rows show **name, status, model, latest tracked event**. Children are indented
by two additional cells per hierarchy level. Archived agents are hidden.
Latest events always use the summary strategy, regardless of chat levels.
Compatible message chunks are combined per agent, so the preview shows the
message rather than only its last streamed chunk. Assistant previews omit the
role label and use all available cells in the event column, truncating with `…`.
Both live and retained history events update the tree.

### Event filters: `v f`

Use ↑ / ↓ to select a type and Space to toggle it. Checked types are displayed
in both the tree and chat. Escape returns to the tree. Changing a filter also
recalculates the tree's latest event from previously received types.

Filters are **local presentation filters**. The socket stays subscribed to all
events, so hiding state/operation events cannot freeze agent status. All built-in
event types are listed, plus unknown/plugin types as they arrive. New types are
tracked by default. Initially `operation.changed`, `tool.update`, and
`agent.update` are hidden to reduce noise.

### Rendering levels: `v l`

Use ↑ / ↓ to select an event type. Choose a level with 1–4, or cycle with
← / →, Space, or Enter. Escape returns to the tree.

1. **Summary**: one line, truncated to terminal cell width.
2. **Extended**: at most two lines, with a truncation indicator.
3. **Full**: all available event text, with terminal Markdown rendering
   (headings, emphasis, lists, tables, fenced code, and links).
4. **Raw**: the complete event JSON envelope, pretty-printed and wrapped.

`agent.message`, `prompt.queued`, and `agent.plan` default to full;
`tool.result` defaults to extended; other events default to summary.

Filters and levels are saved automatically to
`$XDG_CONFIG_HOME/org-tui/settings.json`, or `~/.config/org-tui/settings.json`
when XDG_CONFIG_HOME is unset. `--config` overrides the path. Only presentation
settings are saved, not prompts, agent settings, or transcript data.

### Chat and prompts

The chat shows the selected agent's retained event history using the configured
levels. Compatible contiguous message chunks are combined for readable text;
raw mode preserves each original record. Thinking and user chunks are labeled
separately. Generation changes and intervening events prevent chunk merging.
Prompt result text is not appended again as an assistant response.

At the bottom, **`>`** is a single-line message input:

- **Enter** sends the message. Every send explicitly uses `queue: false`: it
  cancels queued prompts and interrupts active work before the new prompt runs.
- **Page Up / Page Down** scroll history and pause auto-follow.
- **Ctrl+Home** jumps to the top; **Ctrl+End** jumps to the bottom and resumes
  auto-follow.
- **Escape** returns to the tree without sending the input.

Direct API failures and asynchronous prompt failures are shown in the status
line. Acceptance is not reported as successful execution. Stopped/failed agents
must be started using the server API before they can receive messages.

## Connection and history behavior

The client buffers events while synchronizing a snapshot, then merges retained
history with the live stream by sequence number. State synchronization and
history coverage use separate cursors. Safe readiness queries retry `NOT_READY`.
Disconnects trigger backoff, reconnect, resnapshot, and history catch-up. A lower
snapshot sequence resets the old database's view. Retention gaps and truncated
payloads are explicitly marked; incomplete lifecycle data triggers a snapshot
refresh. Snapshots also refresh periodically to reconcile intermediate state.

Prompts are **never automatically retried** after disconnect/timeout, because
the server may already have accepted them. An unknown outcome is displayed as
such. This client does not respond to permission requests; they are visible as
events but require another client to resolve them.

"Full chat" means all available **server event history**, not the full native
harness transcript. The public API retains a bounded event log and lacks message
boundaries/session transcript downloads; missing text cannot be recovered by
this client. Received history is held in memory for the client session. Treat
raw output as sensitive: it can include settings, prompts, and tool arguments.

## Development

```sh
bun test
bun run typecheck
```

Tests use deterministic mock Unix servers (no model calls), including fragmented
UTF-8 JSONL, response/event races, history replay, database replacement,
filtering, rendering, and saved settings. The UI test launches the actual Bun CLI
in a pseudo-terminal via `script` (util-linux) and checks the rendered screen
using a headless terminal emulator, including selection highlight, `v f`, `v l`,
live events, interrupting tree/chat prompts, and Escape navigation.
