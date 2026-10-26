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
loaded on demand from paged event history rather than downloaded in snapshots.

For current state and **new events only at startup**, skip the recent-history download:

```sh
bun start --socket /tmp/bench/server.sock --no-history
```

This does not change server recovery or re-execute old prompts/tools. It simply
omits automatic history loading, including after reconnect; explicitly opening chat can still fetch history. The server still loads its tree
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
| ↑ / ↓ | Select a visible agent (metadata highlighted; configurable colors) |
| Tab | Collapse / expand the selected agent's branch (when it has children) |
| Enter | Open an interrupting prompt for the selected agent |
| c | Open the selected agent's chat |
| z | Open the selected agent's raw events from currently loaded chat history |
| a | Key-labelled agent info, editing and lifecycle actions |
| i | View all information about the selected agent (read-only) |
| r / x | Start/restart / stop selected agent (confirmation required) |
| R / p / d | Restart subtree / replace session / remove subtree (confirmation required) |
| l | Open event visibility / rendering level selector |
| n | Create a root in an empty organization, otherwise a child of the selected agent |
| e | Modify the selected agent |

| Skills field | In the ordinary `n` create / `e` modify form when the server advertises the skills plugin |
| v, then s | Organization / plugin server settings (when supported) |
| v, then t | Configure TUI colors (client only) |
| v, then b | Choose and reorder table fields (client only) |
| v, then l | Configure event visibility / rendering levels |
| v, then h | Configure history cache limits and idle expiry (client only) |
| q / Ctrl+C | Quit the client, leaving server work running |

Collapsing hides every descendant; expanding restores the branch, including nested
branches. Collapse choices are local to this TUI instance, survive chat and Escape,
and reset when the TUI is reopened. In the prompt composer, Tab remains reserved
for mention completion and does not collapse the tree.

Rows default to **name, status, model, latest visible event**. Use `v`, then
`b` to choose visible table fields: Space toggles a field, Left/Right moves it,
`1`–`9` / `0` assigns its position (`0` = 10), and `z` restores defaults. At least
one field must remain visible. Changes are saved in the client config. The first
shown field always carries the tree indentation. Available fields include status,
launch settings, error, session number, and revision. Metadata columns fit their
contents up to sensible caps; **Event gets the remaining width** and priority
when space is tight. Short values such as harness `pi` only need a compact column
wide enough for the header. Columns recalculate on resize and live updates.
Hierarchy uses two spaces per level, without connector glyphs. Archived agents
are hidden. Selection highlights metadata on either side of Event without
recoloring event previews; an Event-only table uses a small `▸` marker.
Latest events always use the summary strategy, regardless of chat levels.
Compatible message chunks are combined per agent, so the preview shows the
message rather than only its last streamed chunk. Assistant previews omit the
role label and use all available cells in the event column, truncating with `…`.
Streamed tree previews intentionally preserve literal Markdown source and fold
blocks into a single line; authenticated agent-origin prompt mentions are the
exception and receive a local accent. Full chat parses message Markdown and
renders the original prompt body separately from that issuer cue.
The tree keeps a separate, bounded summary of observed live events for active,
known agents, so unrelated history eviction does not blank a quiet agent's last
preview. Each agent retains at most 32 event-type candidates, with at most 1 KiB
of event data per candidate (plus bounded presentation metadata); this is separate
from, and does not enlarge, the raw-history cache. Message chunks are bounded as
they accumulate. Candidates are discarded when an agent is removed, its session
or generation changes, or the connection's store is reset. This is not startup
backfill: an event the client never received cannot appear in the tree. Chat
continues to use real events and renderings from its bounded history window, and
explicit chat history can recover retained server events. Loading older history
does not replace a newer live preview; level 0 still controls which event types
appear in the tree.

### Raw events: `z`

From the tree, `z` opens a snapshot of the selected agent's currently loaded events whose effective rendering level is not hidden. Level-zero events are never included in this viewer. Use ↑/↓ to select an event, Enter for its complete pretty-printed JSON, and Esc to return (JSON Esc returns to the same list). The viewer does not fetch history or alter chat retention; reopen it to capture a fresh snapshot.

### Agent info: `i` (or `a`, then `i`)

Inspect the complete public agent record: identity, status, revision, timestamps,
errors, session ID/number/generation, harness settings (including environment,
options and plugin extensions), metadata and any additional server fields.
Nested values and long lines are not truncated. The view follows live updates
for the same agent ID without resetting your scroll position.

Use ↑/↓ or the mouse wheel to scroll, PgUp/PgDn for pages, and Home/End (or
Ctrl+Home/Ctrl+End) for top/bottom. `j` toggles between readable sections and the
complete JSON record; `?` opens key help. Escape returns to the tree or the same
actions-menu selection. Inspection sends no mutations. Settings/metadata may
contain sensitive values; the view shows what the server sends, not redacted
summaries. Chat/events and organization-wide settings remain separate views.

### Settings: `v`

The settings menu separates **server-wide organization/plugin configuration**
from **client-only event visibility levels and rendering levels**. Press `s` for server
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

### History cache: `v`, then `h`

These client-only settings save in `--config` and apply immediately:

| Setting | Default |
| --- | --- |
| Cached events (maximum, recent and explicitly loaded combined) | 2,000 |
| Chat page size (raw events, not coalesced messages) | 200 |
| Cache payload budget (bytes) | 33,554,432 (32 MiB) |
| Inactive chat expiry (minutes) | 10 |

Use Enter to edit a positive integer (`cacheBytes` must be at least 1,024),
Ctrl+U to clear, Escape to cancel, or `z` to restore defaults. Page sizes are
clamped to the event-cache limit. The byte budget counts serialized events and
presentations, not total process RSS; rendered output/widget text is bounded too.
The active chat's visible anchor and a bounded newest tail are preferred under
cache pressure, but still obey both limits. While browsing, incoming events keep
joining the active transcript without forcing a scroll; the widget materializes a
bounded display slice. If raw/cache or display limits evict older content, the
chat marks the incomplete window and reaching latest can reload the retained
server tail. Exact anchor preservation is best-effort when the anchor remains
within those limits. Inactive historical reads expire on the periodic sweep
(approximately every ten seconds), and inactive history is evicted first under
pressure. Recent events can remain within the global cache after a chat expires.
Leaving chat clears its rendered-text cache and hidden widget content.

Eviction **never deletes SQLite history**. Database retention is separately
configured under **v → s → Organization / core → maxEvents**: **0 means unlimited**
(the server default). A positive value permanently deletes older database events
on subsequent writes. Existing server overrides remain effective until changed;
previously deleted events cannot be recovered by this client.

### Agent lifecycle: `a`, `n`, `e`

The editor has fields for name, **Agent** (the API's harness/profile), provider,
model, working directory, metadata, environment, and plugin extensions. On servers
with Pi profiles, creation also has a **Thinking** picker; tools and appended
prompts belong to server defaults/profiles instead of extra creation fields.
Legacy servers retain the structured harness-options field. Use ↑/↓ and
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

Creation starts the agent immediately. **Agent** choices come from the server's
loaded plugins and their profile catalogs. With the Pi plugin this offers
`pi — Default` and `pi — <profile name>`. Configure defaults and sparse named
profiles under **Server settings → Pi agent → Agent profiles**. Each profile
inherits omitted fields; `z` resets a profile field to inherit, while staging an
empty tool list/prompt is an explicit override. Resolved settings are captured at
creation; editing/deleting profiles or defaults never changes existing agents,
even on restart. Provider/model and Thinking can be changed just for this agent.
Profile selection resets these draft overrides to the newly selected profile. For discovery-capable harnesses, Enter on provider opens its
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
a duplicate root. With Pi profiles, children inherit the parent's resolved
profile, model/provider and thinking/options (including one-off overrides), even
if its catalog profile has been deleted. Explicitly selecting another profile,
including Default, uses that profile with current server defaults instead.
Legacy servers copy harness/model/provider only; cwd provides the browsing default.
Container configuration inheritance remains independent.

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

### Skills field (optional plugin)

When `organization.snapshot.capabilities.plugins.skills` advertises a supported catalog endpoint and settings namespace, the ordinary `n` create and `e` modify forms include a **Skills** field. Open it with ↑/↓ and Enter; use ↑/↓ to browse, `/` to filter names/descriptions, `a` to mark a skill available, `i` to install it for this agent, `d` to remove it, and `S` to stage the selection back in the form. Save the agent form once to send the complete replacement under the advertised namespace, fenced by the captured revision; Escape cancels the nested or outer draft without a mutation. Older/disabled servers hide the field and receive no skills catalog requests.

**Installed** selects the skill for this agent's runtime (the harness loads its managed files); **available** grants the skill for delegation to a direct child without installing it for this agent. Removed/unavailable skills are omitted from the replacement map. A saved installed selection does not guarantee filesystem readiness: inspect operation errors and `skills.error` events. Active targets may restart. On revision conflict, discard/reopen to refresh rather than overwriting another client's changes.

Add shared skill repositories through `v` → `s` → **Skills** → **Add skill repository**. Enter one HTTPS Git URL or a server-side path; name and description come from the validated root `SKILL.md`. Registration is a separate catalog admission, not a server-settings save, agent assignment, or installation. After Add succeeds, the TUI returns to Skills settings with a notice; it does not insert or select an inline skill row. The Skills settings group shows runtime fields, the legacy-seed summary, and controls only—not catalog entries or per-skill registration feedback. The editable legacy seed list is hidden and remains read-only; its existing configured repositories continue reconciling asynchronously.

The registration action appears only when the server advertises `repositoryRegistration` with the supported `preserve-v1` history contract. The locator accepts one HTTPS Git URL or a server-side directory/root `SKILL.md` path (server path support is host-capability dependent); manual entry is available, with Tab completion where supported. It does not install or assign the skill to any agent. Use the catalog's explicit refresh to verify an uncertain outcome before retrying. Open **Manage registered catalog skills…** to browse manual entries and their source, managed location, history status, and details; configured seeds remain separate and are represented by the legacy-seed summary. `d` reversibly retires an entry from new grants; `r` restores it. Retirement preserves its catalog record, central history, existing selections/installations, recovery, and files. `x` opens a separate permanent-delete confirmation: deletion clears agent assignments and removes only verified plugin-owned installed/recovery directories and the central managed checkout/history. It does not stop running agents or delete the original local source path; active work, pending recovery, or unverified files block deletion. Configured seeds cannot be retired or deleted through this manager. After registration, use the ordinary agent Skills picker (`a` / `i`, then `S`, then save) to assign the skill. See [the plugin-owned API contract](../agentorg-plugin-skills/README.md) for source, history, retirement, and deletion behavior.

### TUI colors: `v t`

Use ↑/↓ to select a component, then Space, Enter or → to cycle colors; ← cycles
backward. `z` restores defaults and Escape returns to the tree. Preferences cover
selection, headers, borders, notices, footer, Markdown, tool phases, AgentOrg target accents, diffs, and the color of hidden event rows.
`default` uses the terminal's own foreground/background; orange uses xterm color
208. Changes are saved automatically in the client config and never affect the
server. Renderer examples use the same palette as tree and chat.

### Event visibility / rendering levels: `v l`

One selector controls event visibility and detail, with level 0 hiding the event
from tree summaries, chat, raw-event lists, and other filter-aware views. Levels are client-only; the client stays
subscribed to all events, so hiding state/operation events cannot freeze agent
state. All built-in event types appear alongside discovered plugin/unknown types.
Types formerly hidden by default remain hidden at level 0; unknown types default
to summary.

Use ↑ / ↓ to select an event type. Choose a level with 0–4, or cycle with ← / →,
Space, or Enter. Hidden rows are gray. Escape returns to the tree.

0. **Hidden**: omit the event from filter-aware views.
1. **Summary**: one line, truncated to terminal cell width.
2. **Extended**: at most two logical lines from the renderer, with a truncation
   indicator when capped. These may wrap onto additional terminal rows.
3. **Full**: all available event text, with terminal Markdown rendering.
4. **Raw**: the complete event JSON envelope, pretty-printed and wrapped.

`agent.message`, `prompt.queued`, and `tool.update` default to full;
`tool.result` defaults to extended; built-in lifecycle and status events default
to hidden. Other events default to summary.

On compatible servers, harnesses choose event-specific Markdown formats; tool
subtypes such as **`tool.call:edit`** and **`tool.result:read`** also appear in the
selector. A subtype uses its exact override before falling back to its parent
level; `z` removes the selected override and restores inheritance/default.
Subtype levels do not change server renderer selection.

The inline **Renderer examples** panel shows generated synthetic examples for
all five levels when space allows (only the selected level on smaller terminals).
`r` cycles matching renderer examples for comparison; this is a preview only,
not a server configuration change. The panel hides below 60 columns/16 rows;
level controls still work. Full/raw previews are explicitly bounded excerpts,
not limits on actual chat content. Older servers use local generic examples.

Tool-event precedence is exact harness emitted-identity renderer → canonical per-tool renderer → configured server default → generic. Explicit harness aliases (for example Pi's `mcp__agentorg__get_operation`) affect matching only; displayed/raw identity and subtype preferences remain emitted names. Core renders AgentOrg's fifteen public MCP tools with stable action headings and domain status/count details; the `∴` marker identifies them. `prompt_subagent` summaries use `∴ @child prompt`; `prompt_parent` uses the implicit parent target and the same semantic prompt presentation. In chat, multiline prompt continuation lines start flush-left rather than aligning under the prefix. Agent snapshots expose the full tree, but only agent-to-immediate-child prompts are authorized; `prompt_parent` is the adjacent upward route. TUI operator chat remains trusted operator control and may prompt any selected visible agent. The displayed target has an independent configurable accent color. Pi owns its native formatting. MCP headings describe requests, not implicit success, and distinguish tool invocation status from returned operation/agent/batch status. `get_operation` uses the generic operation renderer for every operation type, with the associated agent name in its summary/details and the original result still inspectable. It does not reinterpret prompt or creation results into custom labels; raw level remains the original event JSON. Semantic updates keep their priority detail instead of using the shell streaming tail. Header/detail layouts reserve one row for each: the actual returned state precedes labels and truncation warnings, including narrow panes. Full semantic headers are clipped so status is not buried behind a long target/prompt. Alias catalog entries carry harness scope and emitted-identity examples; previews inherit the same semantic hints as live/history rendering.

Pi supplies distinct read/bash/edit/write call/update/result styles:
paths/ranges and line counts, shell commands/exit information, edit diffs, and
write sizes/content. Headers are compact: **`$` bash**, **`<` read**, **`>` write**,
**`Δ` edit**, and **`• toolname`** for unknown/MCP tools. There is no `tool.call:`
or `tool.result:` prefix or routine `pending`/`completed` label. Paths, ranges,
commands, sizes, counts and errors remain. **Only the symbol** is yellow for
calls, orange for updates, green for successful results, or red for failed/cancelled
results. The command/filename stays plain and the same across phases; output and
errors appear in extended/full views, not as a replacement tree label. Edit
summaries additionally show green `+N` and red `-N` counts. Unknown/incomplete
result status stays neutral. Full tool updates show a plain-text output tail of at
most five terminal rows; extended updates show only the latest row. The limit is
applied after wrapping, so long lines cannot flood the chat pane. A light-gray
gutter separates output from the transcript without forcing a background color.
The gutter and line count use explicit grayscale rather than the terminal's
bright-black color. The line count describes the received output; a tail indicator
appears when earlier rows
are hidden. As new update events arrive, the excerpt advances to the latest output.
Updates without output retain their renderer's normal details. Other output bodies
keep their own Markdown/code colors.
Selected tree rows preserve event colors and keep the selection background
confined to metadata (blue by default).

Sparse tool updates/results recover their command/path from retained call context
on the server, including older adapter history, without changing raw envelopes.
Context is fenced by agent/generation and prompt/session; expired calls are not
guessed. After rebuilding, restart the server to load the updated/bundled harness
renderers and restart the TUI; an already-running process retains its old code.

Edit's extended level shows `Δ filename` followed by old text in red, then new
text in green on the next logical line, aligned below the old text. Multiline or
multiple changes are abbreviated with `↵`/`…`; `∅` denotes an empty side. Full
shows a context diff of changed regions with red removals and green additions.
Actual result diffs take precedence; pending calls use the retained replacement
text, labelled with replacement-relative line numbers, never current file reads.
Failed edits show errors rather than a misleading green replacement preview.
Unknown tools and missing/partial data remain readable.
Clients own Markdown styles, colors, terminal sanitization and cell clipping;
remote terminal commands are never trusted. Raw mode bypasses custom formatters
and excludes presentation sidecars. Harness-rendered messages are not coalesced,
so custom content cannot be accidentally joined using generic chunk rules.

Administrators can set `rendering.defaultToolRenderer` under **v → s → Event
rendering**. Defaults affect future deliveries/history reads; downloaded
presentations may stay cached until history is reloaded. Changing an agent's
harness may also change historical rendering; events store no historical harness
identity. No tools are rerun. See [the server contract](../agentorg/EXTENSIONS.md#event-renderers-presentation-contract-v1).

Colors, table fields, visibility and rendering levels are saved automatically to
`$XDG_CONFIG_HOME/org-tui/settings.json`, or `~/.config/org-tui/settings.json`
when XDG_CONFIG_HOME is unset. `--config` overrides the path. Only presentation
settings are saved, not prompts, agent settings, or transcript data.

### Chat and prompts

The chat shows the selected agent's retained event history using the configured
levels. Compatible contiguous message chunks are combined for readable text;
raw mode preserves each original record. **v → c** toggles compact tool phases
(chat only): a tool update replaces its call, and the result replaces the latest
visible phase in that call's position. Correlation uses the tool call ID scoped
to its agent and generation; events without an ID remain separate. The tree view
is unchanged. Thinking and user chunks are labeled
separately. Generation changes and intervening events prevent chunk merging.
Prompt result text is not appended again as an assistant response.

The chat header shows the agent's ancestry, separated by `/`. Opening an
interrupting prompt from the tree keeps the tree visible above the composer;
its target stays fixed even if live updates change the tree selection.

Typing `@` in either composer offers the fixed recipient's direct parent and
nonremoved descendants. Suggestions use names and relative paths (for example,
`@../parent`, `@child`, or `@child/grandchild`); they do not route the prompt to
another agent. Type to fuzzy-filter, use ↑/↓ to select, and press Tab to insert
the selected token or Space to insert it followed by a space. The suggestion
list appears above the composer, shifting the chat/tree viewport upward. That
space stays reserved after suggestions close until you leave the compose view.
Escape retains its existing behavior of returning to the tree without sending.

At the bottom, horizontal rules surround the message input, with **`>`** in the
upper rule. In both chat and tree prompts, input starts at the terminal's left
edge, wraps, and grows to keep the draft visible. Once the available terminal
height is filled, it scrolls vertically to follow the draft's end; sending still
includes the entire prompt. Resizing the terminal rewraps the draft.

- **Enter** sends the message. Every send explicitly uses `queue: false`: it
  cancels queued prompts and interrupts active work before the new prompt runs.
- **Page Up / mouse-wheel up** browse older content and pause viewport auto-scroll only; incoming events still join this chat while its position remains anchored. At the loaded top, Page Up (or wheel-up) fetches another older page for this agent.
- **Page Down / mouse-wheel down** reveal already-appended events. Reaching the actual bottom resumes auto-follow; a no-op Page Down at the bottom (including when the transcript is shorter than the viewport) keeps following. **Ctrl+Home** jumps to the loaded top; **Ctrl+End** explicitly reloads the latest bounded chat window and resumes auto-follow.
- Sending while scrolled does not force latest or reload chat. Loading older pages and live events use one bounded window rather than accumulating an unlimited backlog; if the visible anchor is evicted, the chat marks the incomplete window and clamps to retained content.
- **Ctrl+U** clears the draft and collapses the input back to one row.
- **Escape** returns to the tree without sending the input.

Direct API failures and asynchronous prompt failures are shown in the status
line. Acceptance is not reported as successful execution. Stopped/failed agents
must be started with `a` → **Start / restart agent** before they can receive messages.

## Connection and history behavior

The client bounds its startup live-event buffer while synchronizing a snapshot,
then downloads only a recent tail (up to the configured event/byte limits), never
the entire event log. Opening chat shows the latest configured page for that agent,
using cached coverage where available or querying SQLite through the server.
Older pages load on demand. State synchronization and evictable history coverage
are independent. Safe readiness queries retry `NOT_READY`.
Disconnects trigger backoff, reconnect, resnapshot, and another bounded tail load. A lower
snapshot sequence resets the old database's view. Retention gaps and truncated
payloads are explicitly marked; incomplete lifecycle data triggers a snapshot
refresh. Snapshots also refresh periodically to reconcile intermediate state.

Prompts are **never automatically retried** after disconnect/timeout, because
the server may already have accepted them. An unknown outcome is displayed as
such. This client does not respond to permission requests; they are visible as
events but require another client to resolve them.

"Full chat" means all available **server event history**, not the full native
harness transcript. The server retains events indefinitely by default, unless an
operator configures a positive `maxEvents` limit. The API lacks message
boundaries/session transcript downloads; missing or previously pruned text cannot
be recovered by this client. In-memory history and derived caches are bounded and
expire; oversized wire/cache records may be explicitly marked previews without
changing their durable copies. Treat
raw output as sensitive: it can include settings, prompts, and tool arguments.

## Development

```sh
bun test
bun run typecheck
```

Tests use deterministic mock Unix servers (no model calls), including fragmented
UTF-8 JSONL, response/event races, history replay, database replacement,
filtering, rendering, presentation-sidecar negotiation, raw preservation, subtype
level inheritance, renderer previews, and saved settings. The UI test launches the actual Bun CLI
in a pseudo-terminal via `script` (util-linux) and checks the rendered screen
using a headless terminal emulator, including selection highlight, `v l`,
live events, interrupting tree/chat prompts, Escape navigation, empty-tree root
creation, child creation, revision-fenced edits, conflicts, lifecycle confirmation,
and start/stop/restart/subtree/session/removal actions. Additional PTY tests cover
contextual key discovery and immediate invocation, text/shortcut isolation,
masked environment filtering/forms, collection stage/save/cancel and validation,
Podman directory grant completion, stale suggestions, and a future fixture
plugin's advertised lists, file paths, sensitive fields, and typed scalars.
