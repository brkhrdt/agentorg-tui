# Agent Organization TUI

A standalone **Bun** terminal client for the Agent Organization Unix-socket API. No runtime imports from the server repo.

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

For unattended synthetic server load, use the separate
[harness benchmark runner](../agentorg-plugin-harness-bench/README.md). It creates a
real agent tree without model credentials; attach this TUI to the socket it prints
to watch streaming activity. Its optional `--tui-probe` measures this TUI's actual
session/store/tree renderer during agent creation/removal, without terminal painting.
State refreshes request only nonterminal operations; completed prompt output is
normally replayed from paged event history rather than downloaded in snapshots.

For current state and **new events only**, skip historical chat loading:

```sh
bun start --socket /tmp/bench/server.sock --no-history
```

This does not change server recovery or re-execute old prompts/tools. It simply
omits historical chat, including after reconnect; the server still loads its tree
and persisted sessions from SQLite. A reproducible server-recovery timing procedure
is documented in the benchmark's [RECOVERY.md](../agentorg-plugin-harness-bench/RECOVERY.md).

For unattended model/render measurements against a running server:

```sh
bun run bench:probe --socket /tmp/bench/server.sock --duration 30 --output /tmp/tui-probe.json
```

The probe uses `Session`, `Store` and `renderTable`, schedules frames every 16ms
at 120 cells by default, skips historical chat, and records row additions/removals,
event-to-render delay, render CPU duration, event-loop lag and disconnects. Percentiles
use the latest 4096 samples. It does **not** measure Blessed/terminal painting or
keyboard latency. `--duration 0` runs until SIGINT/SIGTERM; `--width` and `--frame-ms`
control the recorded workload. Initial snapshot rows are counted as added but have
no live-event latency; fast transitions coalesced into a frame are reported separately.

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

Press **`?`** in any navigation screen for its contextual key menu. Press a
shown key to act immediately; Escape returns to the same selection. The bottom
footer shows the current mode's keys. Menus are disabled while entering text;
`?`, `q`, and lifecycle keys are ordinary input there.

### Agent tree (default)

| Key | Action |
| --- | --- |
| ↑ / ↓ | Select an agent (highlighted blue) |
| Enter | Open an interrupting prompt for the selected agent |
| c | Open the selected agent's chat |
| a | Key-labelled lifecycle actions (arrow navigation remains optional) |
| r / x | Start/restart / stop selected agent (confirmation required) |
| R / p / d | Restart subtree / replace session / remove subtree (confirmation required) |
| f / l | Event filters / rendering levels directly |
| n | Create a root in an empty organization, otherwise a child of the selected agent |
| e | Modify the selected agent |
| s | Edit skills when the server advertises the skills plugin |
| v, then s | Organization / plugin server settings (when supported) |
| v, then t | Choose and reorder table fields (client only) |
| v, then f | Configure tracked events (client only) |
| v, then l | Configure rendering levels |
| q / Ctrl+C | Quit the client, leaving server work running |

Rows default to **name, status, model, latest tracked event**. Use `v`, then
`t` to choose visible table fields: Space toggles a field, Left/Right moves it,
`1`–`9` / `0` assigns its position (`0` = 10), and `z` restores defaults. At least
one field must remain visible. Changes are saved in the client config. The first
shown field always carries the tree indentation. Available fields include status,
launch settings, error, session number, and revision. Metadata columns fit their
contents up to sensible caps; **Event gets the remaining width** and priority
when space is tight. Short values such as harness `pi` only need a compact column
wide enough for the header. Columns recalculate on resize and live updates.
Child connectors sit directly beneath their parent's name; names are indented
by two cells per hierarchy level. Archived agents are hidden.
Latest events always use the summary strategy, regardless of chat levels.
Compatible message chunks are combined per agent, so the preview shows the
message rather than only its last streamed chunk. Assistant previews omit the
role label and use all available cells in the event column, truncating with `…`.
Event previews render Markdown styles and fold blocks into a single line;
clipping preserves styles and terminal-cell boundaries.
Both live and retained history events update the tree.

### Settings: `v`

The settings menu separates **server-wide organization/plugin configuration**
from **client-only event filters and rendering levels**. Press `s` for server
settings on compatible servers. Organization facts (paths, harnesses, loaded
plugins) are read-only; plugins without declarations are listed as read-only.
Older servers retain client preferences without calling unavailable APIs.

Open a declared group to edit its public fields. Enter stages a scalar (booleans
toggle); collections reuse add/edit/remove and typed JSON entry editors. `d`
inside a list removes its selected entry; an empty list is distinct from reset.
`z` resets the selected field to its startup/operator default **in the draft**.
`S`, or the save row, opens an explicit **server-wide** confirmation. Changes
apply to everyone connected to that server, persist there (not in `--config`),
and never automatically restart agents. Secrets are not part of these forms.

Rows show saved/default/draft state and the field effect. Restart-only settings
show the desired value and `RESTART REQUIRED`, with the current effective value;
they take effect only after the server restarts. Core exposes runtime limits.
The Podman plugin declares **Container configurations** as a reusable record-list
form, alongside global defaults. Add/edit/delete entries, choose server-discovered
local images/volumes, and choose network from `pasta`, `slirp4netns`, or `none`.
Unregistered volumes prompt for a container destination. The top-level defaults
now use the same four **RO/RW directory** and **RO/RW volume** lists as configurations,
with volume pickers on **a**. They seed new configurations and new root-agent
drafts for review, without a server restart or changes to existing agents.
Legacy destination policies remain preserved but are omitted from the normal
form. **S** stages the entry,
then the list; the normal server-wide Save confirmation still commits the draft.
Use **n / e → Container** to select one when creating or editing an agent. Image,
runtime, cwd, and configured mounts are copied into the draft for review and then
snapshotted on the agent; later catalog edits/removal don't alter existing snapshots.
Root drafts select **Default**; child drafts inherit their parent's image/runtime
and configured mounts unless another container is selected. Extra per-agent grants
do not inherit. Stale selections return a conflict rather than silently using updated defaults.
Provider/model fields are still manual until in-container capability discovery is
implemented. Removing volume defaults does not delete host volumes or identity
pins. Other plugins remain read-only until they opt in. See the
[server contract](../agentorg/SERVER_SETTINGS.md).

Saves are revision-fenced. Other clients' changes refresh the catalog but do not
overwrite your draft. Conflicts keep the draft and are never automatically
retried; `r` explicitly discards it and reloads current values. Escape discards a
field/collection edit or the whole group draft, depending on the current view.

### Agent lifecycle: `a`, `n`, `e`

The editor has fields for name, harness, provider, model, working directory,
metadata, environment, harness options, and plugin extensions. Use ↑/↓ and
Enter to edit a field; Enter stages its value, Ctrl+U clears it, and Escape
discards that field edit.
Press **S**, or choose **Save changes**, to apply the draft, or Escape from the editor to discard
it. Metadata, environment, options, and extensions open reusable key/value
editors, not JSON prompts. Use `a` to add, `e`/Enter to edit, `d` to remove,
`S` to stage the collection, and Escape to discard it. The agent's own **Save**
is still required to apply changes. Names and values have separate entry steps;
metadata/options/extensions offer string, number, boolean, null, and explicit
advanced JSON value types. Invalid entries remain editable.

Typing starts filtering (action keys are reserved in navigation); `/` explicitly
enters filter mode so **every** key is text. ↑/↓ selects matching entries, Enter
edits, Escape returns to actions, and Ctrl+U clears the filter. Environment
filters match names only. Environment values are masked in lists and hidden in
the agent field list, but visible in their entry form. `J` explicitly opens
validated raw JSON as an advanced fallback; errors preserve the input. Treat
other settings and raw events as sensitive too.

When the server advertises the Podman plugin, the editor includes **Container**
(if configurations are available), `readOnlyDirs`, and `readWriteDirs`, not a separate
image picker. Servers advertising volume discovery also add `readOnlyVolumes` and
`readWriteVolumes`: use add/edit/remove, type to fuzzy-filter server-reported names,
↑/↓ to select, Tab to complete, Enter to stage and Escape to cancel.
Destination/description hints distinguish choices. Any existing plain local host
volume is discoverable without plugin configuration or a server restart. If it has
no destination yet, the editor asks for an absolute container path (e.g.
`/home/pi/.pi`) and registers it through the trusted client endpoint; this alone
grants no agent access. No local Podman installation or JSON entry is needed.
Discovery/registration errors preserve drafts. Volumes are persistent shared
stores (including any credentials), not private per-agent sessions; RO prevents
writes, not reads.

Directory grants use the same reusable list editor. Empty lists request no extra
grants; configured mounts remain mandatory. Add/edit shows server directory
suggestions: ↑/↓ selects, Tab inserts/descends, Space/Enter stages the current path,
and Escape discards the entry. Grants must be existing directories; unlike cwd,
accepting a grant never creates directories. Completion uses the captured
parent/server startup base, including relative paths and `~/`, never the client's
filesystem. Older servers retain manual path entry with server validation at save.
The configured mounts plus any extra directory grants must cover cwd.

Saving a container selection that changes the image asks whether to update this
node only, descendants inheriting its image, or all descendants (including explicit
overrides). These scopes propagate images, not configuration snapshots. The
client-only `podman.modify` endpoint reports partial failures; refresh rather than
blindly retrying. See the [Podman plugin](../agentorg-plugin-podman/README.md).

Creation starts the agent immediately. Harness choices come from the server's
loaded plugins. For discovery-capable harnesses, Enter on provider opens its
available providers; select a provider before opening the model picker. The
model picker lists only that provider's models and saves their exact IDs.
Changing harness clears provider/model; changing provider clears model.
Catalog queries use the draft cwd, environment, and harness options. Pickers
support manual entry, and older servers/unsupported harnesses use text fields.
Escape returns without selecting; discovery errors retain the draft. Press `m` in a harness/provider/model picker for manual entry. Image-scope
choices also support `1`, `2`, and `3`. Model is
optional on creation (omit it to use the harness default).
Press `n` with an agent selected to create its child; if selection is momentarily
missing while agents exist, the root is used as the parent rather than submitting
a duplicate root. Child drafts copy the parent's harness/model/provider; other
settings are not inherited, except cwd's browsing default.

On servers advertising path completion, cwd starts at the parent's cwd for a
child, or the server startup cwd for a root. Editing cwd raises the input and
shows up to **five directory suggestions below it**. Typing fuzzy-filters the
last path component; ↑/↓ selects, **Tab inserts the selected directory with `/`**
and lists its children. **Space or Enter stages the current path** (not merely
the highlighted suggestion); Escape discards the field edit. Ctrl+U clears it.
Relative paths, `../`, absolute paths, `~/`, and directory symlinks work against
the server filesystem. Dot-directories appear when the last component starts
with `.`. Directories containing spaces can be inserted with Tab. Submitting a nonexistent
path creates the requested directories recursively. Older servers retain manual entry.

If the server's optional `cwd` plugin is enabled, the parent's prefilled cwd is
only a browsing starting point: choose an existing **strict subdirectory** before
saving a child. The server still enforces containment (including symlinks).
Composer/chat path completion is not enabled.

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

### Plugin-advertised settings fields

The server can advertise `capabilities.settingsEditors[namespace].fields` from a
plugin's `registerSettings({ namespace, validate, ui: { fields } })`. The TUI
adds those fields to the agent editor automatically—no client plugin code or
endpoint-specific UI is needed. Supported editors are text, number, boolean,
string/object maps, string lists, single directories/file paths, and directory/
file-path lists. Fields bind to top-level keys in `settings.extensions[namespace]`.

For example, `{ key: "inputs", label: "Input files", editor: "paths" }` reuses
the list editor and server file suggestions. Tab inserts files **without** a
trailing slash; directories descend as in cwd. `sensitive: true` masks values in
lists and the agent editor. Complex map values show counts until explicitly
opened. Numbers/booleans validate before staging; errors retain the input.

Only edited fields are sent, as a complete namespace replacement preserving
unexposed siblings and the revision captured at open. Untouched absent fields
are not silently added. Do not edit the same namespace through both advertised
fields and raw extensions in one draft; ambiguous saves are rejected. Unknown
editor kinds are ignored; old servers retain the structured extensions editor.
Podman keeps its specialized image-scope confirmation and avoids duplicate grant
fields. See the [server contract](../agentorg/EXTENSIONS.md#reusable-client-settings-editors).

### Skills: `s` (optional plugin)

The client discovers the plugin-owned descriptor in `organization.snapshot.capabilities.plugins.skills` (advertised endpoints and settings namespace); older or disabled servers show no skills action and receive no skills requests. Select an agent and press `s` to see the catalog, descriptions and its selection. ↑/↓ selects a skill; Space cycles states; `i` installs, `a` makes available for delegation, and `u` marks unavailable. **Enter saves the complete replacement** with the revision captured when the editor opened; Escape discards the draft. Active targets may restart. On revision conflict, Escape and reopen to refresh instead of overwriting another client's changes.

Press `+` in the skills editor to add a catalog skill using JSON, e.g. `{"name":"alpha","gitUrl":"https://github.com/org/alpha"}`. The root `SKILL.md` must declare that same name. Catalog additions can take a minute; disconnect/timeouts have unknown outcomes and are never retried automatically. Inspect the catalog before retrying.

Public-client installed/available grants add availability to ancestors without installing there. Removal/downgrade retains earlier grants and preserved working copies. Selected `installed` is not a guarantee of filesystem readiness: inspect operation errors and `skills.error` events. Selections live in `settings.extensions` under the discovered namespace. Legacy `settings.skills` migrates on servers with the plugin enabled; raw records are retained when disabled. See [the plugin-owned API contract](../agentorg-plugin-skills/README.md) for plugin-owned skill behavior.

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
and start/stop/restart/subtree/session/removal actions. Additional PTY tests cover
contextual key discovery and immediate invocation, text/shortcut isolation,
masked environment filtering/forms, collection stage/save/cancel and validation,
Podman directory grant completion, stale suggestions, and a future fixture
plugin's advertised lists, file paths, sensitive fields, and typed scalars.
