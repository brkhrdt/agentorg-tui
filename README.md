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

An empty organization is displayed as an empty tree. Press `n` to create its
root agent; with an agent selected, `n` creates a child.

## Standalone binary

Build with **Bun 1.4.3+**:

```sh
bun install --frozen-lockfile
bun run build                       # dist/org-tui
./dist/org-tui --help
./dist/org-tui --socket /absolute/path/server.sock
# Optional cross-compilation:
bun run build --target=bun-linux-x64
# Other examples: bun-linux-arm64, bun-darwin-arm64, bun-linux-x64-baseline
```

Distribute **only `dist/org-tui`**. It includes the runtime, dependencies, and
fallback terminal data; Bun, Node, `node_modules`, and this repository are not
needed on the destination. Build for the destination OS/CPU (`-baseline` for
older x64 CPUs). An interactive Unix terminal and a separately running compatible
organization server are still required; Windows is not supported. Socket/config
flags and environment defaults are unchanged.

`bun run test:binary` builds the binary, copies it outside the repository, and
runs the interactive UI test against it. Like the source UI test, it requires
`script` (util-linux) and `stty` on the development machine.

## Keys

### Agent tree (default)

| Key | Action |
| --- | --- |
| ↑ / ↓ | Select an agent (highlighted blue) |
| Enter | Open an interrupting prompt for the selected agent |
| c | Open the selected agent's chat |
| a | Agent lifecycle actions (create, modify, start/restart, stop, restart subtree, replace session, remove) |
| n | Create a root in an empty organization, otherwise a child of the selected agent |
| e | Modify the selected agent |
| s | Edit skills when the server advertises the skills plugin |
| v, then f | Configure tracked events |
| v, then l | Configure rendering levels |
| q / Ctrl+C | Quit the client, leaving server work running |

Rows show **name, status, model, latest tracked event**. Children are indented
by two additional cells per hierarchy level. Archived agents are hidden.
Latest events always use the summary strategy, regardless of chat levels.
Compatible message chunks are combined per agent, so the preview shows the
message rather than only its last streamed chunk. Assistant previews omit the
role label and use all available cells in the event column, truncating with `…`.
Event previews render Markdown styles and fold blocks into a single line;
clipping preserves styles and terminal-cell boundaries.
Both live and retained history events update the tree.

### Agent lifecycle: `a`, `n`, `e`

The editor has fields for name, harness, model, provider, working directory,
metadata, environment, harness options, and plugin extensions. Use ↑/↓ and
Enter to edit a field; Enter stages its value, Ctrl+U clears it, and Escape
discards that field edit.
Choose **Save changes** to apply the draft, or Escape from the editor to discard
it. Metadata, environment, options, and extensions are JSON objects; environment
values must be strings. Environment values are hidden in the field list but
visible while editing. Treat other settings and raw events as sensitive too.

Creation starts the agent immediately. Harness names depend on the server's
loaded plugins; there is no harness/model discovery API. Model is optional.
Press `n` with an agent selected to create its child; if selection is momentarily
missing while agents exist, the root is used as the parent rather than submitting
a duplicate root. Child drafts copy the parent's harness/model/provider; other
settings are not inherited. If the server's optional `cwd` plugin is enabled,
enter an existing strict subdirectory of the parent's cwd for each child.

Modification sends only changed fields and the revision captured when opened.
On `CONFLICT`, discard and reopen to refresh; it never overwrites automatically.
Launch-settings changes interrupt work and restart active agents, but do not
start stopped/failed agents. Use **Start / restart agent** for those (`agent.restart`
is the API's start operation). Blank scalar settings cannot unset existing values;
`{}` clears environment/options maps, while extension namespaces are replacement
values and omitted namespaces are preserved.

Start/restart, stop, restart subtree, replace session, and removal require
confirmation (Enter on Confirm, or `y`; Escape/`n` cancels). Stop/restart affect
only the selected agent. Subtree restart also starts stopped descendants.
Removal archives the selected agent **and all descendants**, without deleting
files; it cannot be undone. Replace session starts a fresh conversation.

Acceptance is not completion: the UI waits for the terminal operation result,
shows failures, and refreshes state even after partial failures. Lifecycle
mutations are never automatically retried after disconnect/timeout; inspect the
tree and retained operation events before retrying an unknown outcome.

### Skills: `s` (optional plugin)

The client discovers the plugin-owned descriptor in `organization.snapshot.capabilities.plugins.skills` (advertised endpoints and settings namespace); older or disabled servers show no skills action and receive no skills requests. Select an agent and press `s` to see the catalog, descriptions and its selection. ↑/↓ selects a skill; Space cycles states; `i` installs, `a` makes available for delegation, and `u` marks unavailable. **Enter saves the complete replacement** with the revision captured when the editor opened; Escape discards the draft. Active targets may restart. On revision conflict, Escape and reopen to refresh instead of overwriting another client's changes.

Press `+` in the skills editor to add a catalog skill using JSON, e.g. `{"name":"alpha","gitUrl":"https://github.com/org/alpha"}`. The root `SKILL.md` must declare that same name. Catalog additions can take a minute; disconnect/timeouts have unknown outcomes and are never retried automatically. Inspect the catalog before retrying.

Public-client installed/available grants add availability to ancestors without installing there. Removal/downgrade retains earlier grants and preserved working copies. Selected `installed` is not a guarantee of filesystem readiness: inspect operation errors and `skills.error` events. Selections live in `settings.extensions` under the discovered namespace. Legacy `settings.skills` migrates on servers with the plugin enabled; raw records are retained when disabled. See [the plugin-owned API contract](../agentorg-plugin-skills/README.md) and [generic client discovery](client_spec.md#14-optional-plugin-features).

### Event filters: `v f`

Use ↑ / ↓ to select a type and Space to toggle it. Checked types are displayed
in both the tree and chat. Escape returns to the tree. Changing a filter also
recalculates the tree's latest event from previously received types.

Filters are **local presentation filters**. The socket stays subscribed to all
events, so hiding state/operation events cannot freeze agent status. All built-in
event types are listed, plus unknown/plugin types as they arrive. By default,
`agent.message`, `prompt.queued`, `tool.call`, and `tool.result` are tracked;
other listed built-in events are hidden. New unknown/plugin types are tracked.
Existing saved filters are preserved.

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
must be started with `a` → **Start / restart agent** before they can receive messages.

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
live events, interrupting tree/chat prompts, Escape navigation, empty-tree root
creation, child creation, revision-fenced edits, conflicts, lifecycle confirmation,
and start/stop/restart/subtree/session/removal actions.
