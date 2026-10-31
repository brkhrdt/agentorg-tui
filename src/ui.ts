import blessed from 'blessed';
import stringWidth from 'string-width';
import { PromptInput } from './prompt-input.js';
import { ComposeKeyInput, type ComposeSubmitMode } from './compose-keys.js';
import { matchMentionChoices, mentionChoices, mentionQuery, mentionRedrawRequired, mentionWindow, replaceMentionQuery, type MentionChoice } from './mention-completion.js';
import { composeSpan, composeWindow, replaceComposeSpan, type ComposeSpan } from './compose-completion.js';
import { HostPathCompletionSource, type PathCompletionSource } from './path-completion-source.js';
import type { Agent, Skill, SkillStates, SkillState, ServerSettingsField, ServerSettingsGroup, ContainerProfile, SettingsChoice, ServerEvent, EventRendering } from './protocol.js';
import type { SkillChoice } from './skill-selection.js';
import { chatGroupIdentity, chatGroups, cell, clean, clip, renderEvent } from './render.js';
import { COLOR_OPTIONS, COLOR_SETTINGS, DEFAULT_COLORS, DEFAULT_TABLE_FIELDS, DEFAULT_HISTORY, HISTORY_FIELDS, historySettings, LEVEL_NAMES, TABLE_FIELDS, type HistorySettings, type ColorSetting, type Level, Settings } from './settings.js';
import { renderTable } from './table.js';
import { toggleCollapsedBranch, visibleTreeRows } from './tree-view.js';
import { genericPreview, rendererPreview, rendererCandidates, rendererSubtypes } from './renderer-preview.js';
import { Session, type LifecycleMethod } from './session.js';
import { AgentEditor, PODMAN_FIELDS, type AgentField, type ImageScope } from './agent-editor.js';
import { ServerSettingsEditor } from './server-settings-editor.js';
import { StructuredEditor, collection, parseTyped, previewValue, valueText, valueType, type ValueType } from './structured-editor.js';
import type { TreeRow } from './store.js';
import { enablePathKeys, type PathCandidate } from './path-input.js';
import { filterVolumes, type VolumeChoice } from './volume-input.js';
import { renderAgentInfo } from './agent-info.js';
import { layoutChatParts, resolveChatAnchor, visibleChatOrigin, type ChatBlockLayout, type ChatLayoutPart, type ChatViewportAnchor } from './chat-viewport.js';

type KeyAction = { key: string; label: string; run: () => void };

type AgentAction = { key: string; label: string } & (
  { kind: 'create' | 'info' | 'edit' } | { kind: 'lifecycle'; method: LifecycleMethod }
);
type ComposeIdentity = { kind: 'chat'; id: string } | { kind: 'prompt'; agentId: string };
function sameComposeIdentity(a: ComposeIdentity, b: ComposeIdentity): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'chat' ? a.id === (b as { kind: 'chat'; id: string }).id : a.agentId === (b as { kind: 'prompt'; agentId: string }).agentId;
}
type View = 'history-settings' | 'history-field' | 'settings-choice-setup' | 'settings-options' | 'settings-records' | 'server-settings' | 'server-group' | 'server-field' | 'server-confirm' | 'server-facts' | 'volume-destination' | 'structured' | 'structured-filter' | 'structured-raw' | 'entry-key' | 'entry-type' | 'entry-value' | 'keys' | 'tree' | 'view' | 'colors' | 'table-fields' | 'levels' | 'chat' | 'raw-events' | 'raw-event-json' | 'prompt' | 'agent-skills' | 'agent-skills-filter' | 'local-skill-path' | 'local-skill-confirm' | 'skill-details' | 'catalog-manager' | 'catalog-delete-confirm' | 'actions' | 'agent-edit' | 'agent-field' | 'harness-options' | 'image-scope' | 'confirm' | 'agent-info';

function urlLikeSkillSource(source: string): boolean { return /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('//') || /^[^/\s]+@[^:\s]+:/.test(source); }
function pathCompletionAllowed(source: string): boolean {
  if (!source) return true;
  const lower = source.toLowerCase();
  const schemePrefixes = ['http', 'https', 'ssh', 'git', 'file'];
  if (!source.includes('/') && schemePrefixes.some(scheme => scheme.startsWith(lower))) return false;
  return !urlLikeSkillSource(source) && !/^[^/\s]+@[^:\s]*$/.test(source);
}

export function formatSkillDetails(skill: Skill): string {
  const safe = (value: unknown, fallback = 'unknown') => clean(value == null ? fallback : String(value));
  const source = skill.source?.kind === 'git' ? skill.source.gitUrl : skill.source?.path;
  const history = skill.history;
  return [
    `Name: ${safe(skill.name)}`,
    `Description: ${safe(skill.description)}`,
    `Source: ${safe(source)}`,
    `Managed location: ${safe(skill.path)}`,
    `Catalog status: ${safe(skill.status ?? (skill.catalogStatus === 'retired' ? 'retired' : 'ready'))}`,
    `History: ${safe(history?.mode, 'legacy/unknown')}`,
    ...(history?.selectedCommit ? [`Selected commit: ${safe(history.selectedCommit)}`] : []),
    ...(history?.originalHead ? [`Original HEAD: ${safe(history.originalHead)}`] : []),
    ...(history?.refCount !== undefined ? [`Preserved refs: ${safe(history.refCount)}`] : []),
    `Created: ${safe(skill.createdAt)}`,
    `Origin: ${safe(skill.origin, 'manual')}`,
  ].join('\n');
}

function agentHierarchy(agent: Agent | undefined, agents: Map<string, Agent>): string {
  const names: string[] = [], seen = new Set<string>();
  let current = agent;
  while (current && !seen.has(current.id)) {
    seen.add(current.id); names.unshift(current.name);
    current = current.parentId ? agents.get(current.parentId) : undefined;
  }
  return names.join(' / ');
}

export function rawEventJsonLabel(eventType: string | undefined, width: number): string {
  return clip(` Event JSON · ${clean(eventType ?? 'unavailable')} `, Math.max(0, width - 2));
}

export class UI {
  private composeKeyInput = (() => {
    const input = new ComposeKeyInput(() => this.view === 'chat' || this.view === 'prompt');
    input.attach(process.stdin);
    return input;
  })();
  readonly screen = blessed.screen({
    smartCSR: true, fullUnicode: true, title: 'Agent Organization',
    ignoreLocked: ['C-c'], warnings: false, input: this.composeKeyInput,
  });
  private title = blessed.box({ parent: this.screen, top: 0, height: 1, tags: false, style: { fg: 'cyan', bold: true } });
  private columns = blessed.box({ parent: this.screen, top: 1, height: 1, style: { fg: 'gray' } });
  private tree = blessed.list({
    parent: this.screen, top: 2, bottom: 2, keys: true, vi: false, mouse: true,
    // renderTable highlights metadata only, preserving event preview colors.
    invertSelected: false,
    tags: false, style: { selected: { bg: 'blue', fg: 'white', bold: true } },
    scrollbar: { ch: '│', style: { bg: 'gray' } },
  });
  private details = blessed.box({
    parent: this.screen, top: 1, bottom: 2, hidden: true, scrollable: true,
    alwaysScroll: true, keys: true, mouse: true, tags: false,
    scrollbar: { ch: '│', style: { bg: 'gray' } },
  });
  private chat = blessed.box({
    parent: this.screen, top: 1, bottom: 5, hidden: true, scrollable: true,
    alwaysScroll: true, tags: false, mouse: true,
    scrollbar: { ch: '│', style: { bg: 'gray' } },
  });
  private promptTop = blessed.box({ parent: this.screen, bottom: 4, height: 1, hidden: true, tags: false, style: { fg: 'cyan' } });
  private promptBottom = blessed.box({ parent: this.screen, bottom: 2, height: 1, hidden: true, tags: false, style: { fg: 'cyan' } });
  private mentionPanel = blessed.list({ parent: this.screen, bottom: 4, height: 4, hidden: true, keys: false, tags: false, style: { selected: { bg: 'blue', fg: 'white', bold: true } } });
  private mentionResults: MentionChoice[] = [];
  private mentionIndex = 0;
  private mentionOpen = false;
  private composePathSource: PathCompletionSource;
  private composeSpan?: ComposeSpan;
  private composeCandidates: PathCandidate[] = [];
  private composeResultDraft?: string;
  private composeResultContext?: { recipient: string; cwd: string; sourceId: string };
  private composeSelection = 0;
  private composeRequest = 0;
  private composeLookupKey?: string;
  private composeTimer?: ReturnType<typeof setTimeout>;
  private composeInFlight = false;
  private composeQueued?: { request: number; draft: string; recipient: string; cwd: string; sourceId: string; span: ComposeSpan };
  private composeDismissed?: string;
  private composeAcceptedFile?: { recipient: string; start: number; insertion: string };
  private composeStatus?: string;
  private composeRecipient?: string;
  private composeContextStamp = '';
  private composeShift = false;
  private pendingModifiedSubmission?: { identity: ComposeIdentity; text: string; revision: number };
  private dismissedMention?: string;
  private editorInput = blessed.textbox({
    parent: this.screen, bottom: 2, height: 3, hidden: true, keys: true, tags: false,
  });
  private composer = new PromptInput({
    parent: this.screen, bottom: 3, height: 1, hidden: true, keys: true, tags: false,
  });
  private get input(): blessed.Widgets.TextareaElement {
    return this.view === 'chat' || this.view === 'prompt' ? this.composer : this.editorInput;
  }
  private paths = blessed.list({
    parent: this.screen, bottom: 2, height: 5, hidden: true, tags: false,
    style: { selected: { bg: 'blue', fg: 'white' } },
  });
  private pathCandidates: PathCandidate[] = [];
  private volumeChoices: VolumeChoice[] = [];
  private pendingVolume?: VolumeChoice;
  private pathIndex = 0;
  private pathBase = '';
  private pathRequest = 0;
  private pathTimer?: ReturnType<typeof setTimeout>;
  private menu = blessed.list({
    parent: this.screen, top: 2, bottom: 2, hidden: true,
    keys: true, vi: false, mouse: true, tags: false,
    style: { selected: { bg: 'blue', fg: 'white', bold: true } },
    scrollbar: { ch: '│', style: { bg: 'gray' } },
  });
  private preview = blessed.box({ parent: this.screen, top: 2, bottom: 2, right: 0, width: '50%', hidden: true, tags: false, border: 'line', label: ' Renderer examples ', style: { border: { fg: 'cyan' } } });
  private previewIndex = 0;
  private form = blessed.box({ parent: this.screen, top: 2, height: 5, hidden: true, tags: false, border: 'line', label: ' Entry draft ', style: { border: { fg: 'cyan' } } });
  private structured?: StructuredEditor;
  private structuredField?: AgentField;
  private structuredIndex = 0;
  private entryIndex = 0;
  private entry: { id?: string; key: string; text: string; type: ValueType } = { key: '', text: '', type: 'string' };
  private notice = blessed.box({ parent: this.screen, bottom: 1, height: 1, tags: false, style: { fg: 'yellow' } });
  private footer = blessed.box({ parent: this.screen, bottom: 0, height: 1, tags: false, style: { fg: 'black', bg: 'white' } });
  private rawView = blessed.box({ parent: this.screen, top: 2, bottom: 2, left: 0, right: 0, hidden: true, tags: false, scrollable: true, alwaysScroll: true, keys: false, mouse: false, border: 'line', label: ' Raw events ', style: { border: { fg: 'cyan' } } });
  private rawSnapshot: ServerEvent[] = [];
  private selectedRawEvent?: ServerEvent;
  private rawIndex = 0;
  private rawListScroll = 0;
  private rawScroll = 0;
  private view: View = 'tree';
  private keyContext?: { view: View; index: number };
  private keyActions: KeyAction[] = [];
  private selectedAgent?: string;
  private collapsedAgentIds = new Set<string>();
  private editor?: AgentEditor;
  private editorRequest = 0;
  private serverEditor?: ServerSettingsEditor;
  private serverField?: ServerSettingsField;
  private structuredServer = false;
  private settingsRequest = 0;
  private records?: { parent: ServerSettingsEditor; field: ServerSettingsField; values: Record<string, unknown>[]; keys?: string[]; newKey?: string; index: number; parentIndex: number };
  private recordEditing = false;
  private genericChoices: SettingsChoice[] = [];
  private pendingChoiceSetup?: SettingsChoice;
  private choiceLabel = '';
  private choiceActions?: { choose(value: string): void; back(): void; manual?: () => void };
  private editField?: AgentField;
  private optionField: 'harness' | 'provider' | 'model' = 'harness';
  private agentOptions: { value: string; label: string }[] = [];
  private choicesRequest = 0;
  private actionAgentId?: string;
  private get actionAgent(): Agent | undefined { return this.session.store.agents.get(this.actionAgentId ?? ''); }
  private actions: AgentAction[] = [];
  private infoAgentId?: string;
  private infoReturn: { view: 'tree' | 'actions'; index: number } = { view: 'tree', index: 0 };
  private infoRaw = false;
  private lastInfo = '';
  private pendingAction?: { method: LifecycleMethod; agentId: string; label: string };
  private skillPicker?: { editor: AgentEditor; states: SkillStates; choices: SkillChoice[]; returnIndex: number; filter: string };
  private localSkillPath = '';
  private unrefreshedRegistration?: Skill;
  private skillDetailsFocus?: Skill;
  private skillDetailsReturnIndex = 0;
  private skillDetailsReturnView: 'catalog-manager' = 'catalog-manager';
  private catalogManagerReturnIndex = 0;
  private catalogDeleteReturnIndex = 0;
  private pendingCatalogDelete?: Skill;
  private catalogStatusRequest = 0;
  private catalogStatusInFlight = false;
  private lastSkillDetails = '';
  private localSkillSubmitting = false;
  private localSkillReturnIndex = 0;
  private navigationGeneration = 0;
  private skillsCatalogUiRequest = 0;
  private chatAgent?: string;
  private promptAgent?: string;
  private chatDrafts = new Map<string, string>();
  private chatDraftRevisions = new Map<string, number>();
  private promptDraft = '';
  private promptDraftRevision = 0;
  private rows: TreeRow[] = [];
  private menuTypes: string[] = [];
  private menuIndex = 0;
  private updating = false;
  private sending = false;
  private follow = true;
  private drawTimer?: ReturnType<typeof setTimeout>;
  private saveChain = Promise.resolve();
  private closing = false;
  private lastTreeItems: string[] = [];
  private lastChat = '';
  private chatLayout: ChatBlockLayout[] = [];
  private chatAnchorLost = false;
  private chatScrollGeneration = 0;
  private adjustingChatViewport = false;
  private renderedEvents = new Map<number, { event: ServerEvent; rendering?: EventRendering; level: number; width: number; colors: string; budget: number; text: string }>();
  private historyField?: keyof HistorySettings;

  constructor(private session: Session, private settings: Settings, private configPath: string, pathSource?: PathCompletionSource) {
    this.session.configureHistory(settings.history);
    this.composePathSource = pathSource ?? new HostPathCompletionSource(session);
    this.session.on('event', (event: ServerEvent) => {
      const data = event.data && typeof event.data === 'object' ? event.data as Record<string, any> : {};
      if (event.type === 'prompt.steer_submitted') this.showNotice(`Guidance submitted · ${data.steeringId ?? ''}`);
      else if (event.type === 'prompt.steer_pending') this.showNotice(`Guidance pending · ${data.steeringId ?? ''}`);
      else if (event.type === 'prompt.steer_delivered') this.showNotice(`Guidance delivered · ${data.steeringId ?? ''}`);
      else if (event.type === 'prompt.steer_failed') this.showNotice(`Guidance failed · ${data.error?.message ?? 'delivery was not confirmed'}`);
    });
    const itemForeground = this.menu.style.item.fg;
    this.menu.style.item.fg = (item: blessed.Widgets.BlessedElement) => {
      const index = this.menu.getItemIndex(item);
      if (this.view === 'levels' && this.settings.level(this.menuTypes[index] ?? '') === 0) {
        const color = this.settings.color('hiddenRows');
        return color === 'orange' ? 208 : color;
      }
      return typeof itemForeground === 'function' ? itemForeground(item) : itemForeground;
    };
    this.screen.on('prerender', () => this.resizeComposer());
    // Rows are already cell-clipped. Blessed otherwise word-wraps an exactly
    // full styled row just because trailing ANSI resets increase string.length.
    this.tree.on('adopt', (item: blessed.Widgets.BoxElement & { wrap: boolean }) => { item.wrap = false; });
    this.tree.on('select item', (_item, index) => {
      if (!this.updating) {
        this.selectedAgent = this.rows[index]?.agent.id;
        this.scheduleDraw();
      }
    });
    this.menu.on('select item', (_item, index) => {
      if (!this.updating) {
        this.menuIndex = index; this.previewIndex = 0;
        if (['levels', 'agent-edit', 'agent-skills'].includes(this.view)) this.scheduleDraw();
      }
    });
    for (const widget of [this.tree, this.menu, this.details, this.rawView]) {
      widget.key(['h', '?', 'r', 'x', 'S-r', 'p', 'd', 'c', 's', 'f', 'l', 't', 'v', 'q', 'n', 'e', 'y', 'a', 'i', 'u', '+', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'S-s', 'S-l', 'm', '/', 'S-j', 'b', 'z', 'j', 'space', 'up', 'down', 'left', 'right', 'enter', 'escape', 'tab', 'pageup', 'pagedown', 'home', 'end', 'C-home', 'C-end'], (ch, key) => {
        const binding = key.full === 'C-home' || key.full === 'C-end' ? key.full :
          ['space', 'up', 'down', 'left', 'right', 'enter', 'escape', 'pageup', 'pagedown', 'home', 'end', 'tab'].includes(key.name) ? key.name : ch;
        if (binding === '?') this.openKeys();
        else if (this.view === 'tree' && binding === 'tab') this.toggleSelectedBranch();
        else if (this.view === 'keys') {
          if (binding === 'escape') this.restoreKeyContext();
          else this.invokeKey(binding === 'enter' ? this.keyActions[this.menuIndex]?.key ?? '' : binding);
        } else this.contextActions().find(action => action.key === binding)?.run();
      });
    }
    this.menu.on('keypress', (ch, key) => {
      if (this.view !== 'structured' || !ch || key.ctrl || key.meta || !/^[^\x00-\x1f\x7f]$/u.test(ch) || 'aedS/?J'.includes(ch)) return;
      this.input.setValue(ch); this.structured!.filter = ch;
      this.setView('structured-filter');
    });
    enablePathKeys(this.editorInput, {
      active: () => this.view === 'structured-filter', acceptSpace: false,
      move: delta => {
        const count = this.structured?.entries().length ?? 0;
        this.menuIndex = Math.max(0, Math.min(count - 1, this.menuIndex + delta)); this.draw();
      },
      complete: () => {},
      changed: () => { this.structured!.filter = this.input.getValue(); this.menuIndex = 0; this.draw(); },
    });
    enablePathKeys(this.editorInput, {
      active: () => this.isPathInput(), acceptSpace: () => this.view !== 'local-skill-path',
      move: delta => {
        if (!this.pathCandidates.length) return;
        this.pathIndex = (this.pathIndex + delta + this.pathCandidates.length) % this.pathCandidates.length;
        this.paths.select(this.pathIndex); this.screen.render();
      },
      complete: () => {
        const choice = this.pathCandidates[this.pathIndex];
        if (!choice) return;
        this.input.setValue(choice.kind === 'directory' && !choice.path.endsWith('/') ? `${choice.path}/` : choice.path);
        this.refreshPaths();
      },
      changed: () => this.refreshPaths(),
    });
    enablePathKeys(this.editorInput, {
      active: () => this.isVolumeInput(), acceptSpace: false,
      move: delta => {
        if (!this.pathCandidates.length) return;
        this.pathIndex = (this.pathIndex + delta + this.pathCandidates.length) % this.pathCandidates.length;
        this.paths.select(this.pathIndex); this.screen.render();
      },
      complete: () => {
        const choice = this.pathCandidates[this.pathIndex];
        if (choice) this.input.setValue(choice.path);
      },
      changed: () => this.refreshVolumes(),
    });
    this.editorInput.key('C-u', () => {
      if (!this.sending) {
        this.input.setValue('');
        if (this.view === 'chat' || this.view === 'prompt') this.clearMentionCompletion();
        if (this.isPathInput()) this.refreshPaths();
        if (this.isVolumeInput()) this.refreshVolumes();
        if (this.view === 'structured-filter') { this.structured!.filter = ''; this.menuIndex = 0; this.draw(); }
        this.screen.render();
      }
    });
    // Keep Ctrl-U inert in the composer; Blessed's native textarea handler
    // otherwise treats it as a line-editing command.
    this.composer.key('C-u', () => {});
    // The screen may not receive global keys while Blessed's textarea grabs
    // input; route compose Ctrl-C through the focused widget as well.
    this.composer.key('C-c', () => {
      if (this.view === 'chat' || this.view === 'prompt') this.clearComposeDraft();
    });
    // readInput installs its listener next tick. Preserve a fast typed/pasted
    // filter tail during the navigation -> input transition.
    this.input.on('keypress', (ch, key) => {
      const input = this.input as typeof this.input & { __listener?: unknown; _listener: (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => void };
      if (['structured-filter', 'agent-skills-filter'].includes(this.view) && !input.__listener) input._listener(ch, key);
    });
    this.editorInput.on('submit', (value: string) => { void this.submit(value); });
    this.composer.on('submit', (value: string) => { void this.submit(value, this.composer.takeSubmitMode()); });
    this.composeKeyInput.on('modifiedEnter', (mode: ComposeSubmitMode) => {
      if (this.view === 'chat' || this.view === 'prompt') this.composer.submit(mode);
      // Blessed installs the fresh textarea key listener on nextTick after submit.
      setImmediate(() => this.composeKeyInput.resumeAfterSubmit());
    });
    for (const input of [this.editorInput, this.composer]) {
      input.on('cancel', () => {
        if (['volume-destination', 'entry-key', 'entry-value', 'structured-raw', 'structured-filter'].includes(this.view)) this.returnStructured();
        else if (this.view === 'agent-skills-filter') this.cancelSkillFilter();
        else if (this.view === 'local-skill-path' || this.view === 'local-skill-confirm') this.returnLocalSkill();
        else if (this.view === 'agent-skills') this.cancelAgentSkills();
        else this.setView(this.view === 'history-field' ? 'history-settings' : this.view === 'settings-choice-setup' ? 'settings-options' : this.view === 'server-field' ? 'server-group' : this.view === 'agent-field' ? 'agent-edit' : 'tree');
      });
    }
    const composerListener = this.composer._listener;
    this.composer._listener = function(ch, key) {
      const previous = thisUI.composer.getValue();
      const compose = thisUI.view === 'chat' || thisUI.view === 'prompt';
      if (compose && key.name === 'escape' && (thisUI.mentionOpen || thisUI.composeSpan || thisUI.composeStatus)) {
        thisUI.dismissComposeCompletion(); return;
      }
      const pathActive = compose && thisUI.composeSpan?.kind === 'path';
      const mentionActive = compose && thisUI.mentionOpen;
      if ((pathActive && thisUI.composeCandidates.length || mentionActive && thisUI.mentionResults.length) && (key.name === 'up' || key.name === 'down')) {
        const count = pathActive ? thisUI.composeCandidates.length : thisUI.mentionResults.length;
        if (pathActive) thisUI.composeSelection = (thisUI.composeSelection + (key.name === 'down' ? 1 : -1) + count) % count;
        else thisUI.mentionIndex = (thisUI.mentionIndex + (key.name === 'down' ? 1 : -1) + count) % count;
        thisUI.draw(); return;
      }
      if (key.name === 'tab' && compose && !key.ctrl && !key.meta) {
        const effectiveSpan = thisUI.effectiveComposeSpan(thisUI.composer.getValue());
        if (effectiveSpan?.kind === 'path') {
          if (pathActive) thisUI.acceptComposePath();
          else if (thisUI.composeDismissed !== thisUI.composeKey(effectiveSpan)) thisUI.refreshComposeCompletion();
          return;
        }
        const query = effectiveSpan?.kind === 'mention' ? effectiveSpan.query : undefined;
        if (query && thisUI.dismissedMention !== query && ((mentionActive && thisUI.mentionResults.length) || thisUI.currentMentionResults(query).length)) { thisUI.acceptMention(); return; }
      }
      if ((ch === ' ' || key.name === 'space') && compose && mentionActive) {
        thisUI.cancelMentionCompletion();
        composerListener.call(this, ' ', key);
        const current = thisUI.composer.getValue();
        if (current !== previous) thisUI.saveComposeDraft(current);
        return;
      }
      composerListener.call(this, ch, key);
      const current = thisUI.composer.getValue();
      if (current !== previous) thisUI.saveComposeDraft(current);
    };
    const thisUI = this;
    this.composer.on('keypress', () => {
      const identity = this.composeIdentity();
      if (!identity) return;
      setTimeout(() => {
        const active = this.composeIdentity();
        if (!active || active.kind !== identity.kind || (identity.kind === 'chat' && (active.kind !== 'chat' || active.id !== identity.id))) return;
        const value = this.composer.getValue();
        if (!this.sending) this.saveComposeDraft(value);
        this.updateMentionCompletion(); this.refreshComposeCompletion();
      }, 0);
    });
    this.composer.key(['pageup', 'pagedown', 'C-home', 'C-end'], (_ch, key) => {
      if (this.view !== 'chat') return;
      if (key.full === 'C-end') {
        this.chatScrollGeneration++; this.follow = true; this.chatAnchorLost = false;
        if (this.chatAgent) void this.session.followChat(this.chatAgent).catch(error => this.showNotice(error.message));
        this.adjustingChatViewport = true; this.chat.setScrollPerc(100); this.adjustingChatViewport = false;
      } else if (key.name === 'pagedown') {
        this.chat.scroll(Math.max(1, Number(this.chat.height) - 2));
        this.updateChatViewport();
      } else if (key.full === 'C-home') {
        this.chatScrollGeneration++;
        this.adjustingChatViewport = true; this.chat.setScroll(0); this.adjustingChatViewport = false;
        this.follow = false;
        if (this.chatAgent) this.session.pauseChat(this.chatAgent, this.captureChatAnchor()?.seq);
        this.loadOlderChat();
      } else {
        this.chat.scroll(-Math.max(1, Number(this.chat.height) - 2));
        this.updateChatViewport();
        if (key.name === 'pageup') this.loadOlderChat();
      }
      this.screen.render();
    });
    this.chat.on('scroll', () => this.updateChatViewport());
    this.chat.on('wheelup', () => {
      this.updateChatViewport();
      this.loadOlderChat();
    });
    this.chat.on('wheeldown', () => this.updateChatViewport());
    this.screen.key('escape', () => {
      if (this.sending && (this.view === 'chat' || this.view === 'prompt') && this.screen.focused !== this.composer) {
        this.saveComposeDraft(); this.setView('tree');
      }
    });
    this.screen.key('C-c', () => {
      if (this.view !== 'chat' && this.view !== 'prompt') this.close();
    });
    this.screen.on('resize', () => {
      this.lastTreeItems = []; this.lastChat = ''; this.renderedEvents.clear();
      this.scheduleDraw();
    });
    this.session.store.on('change', () => {
      if (this.mentionOpen && (this.view === 'chat' || this.view === 'prompt')) this.refreshMentionCompletion();
      this.checkComposeContext();
      this.scheduleDraw();
    });
    this.session.on('status', () => { this.checkComposeContext(); this.scheduleDraw(); });
    this.session.on('notice', (message: string) => this.showNotice(message));
    this.tree.focus();
    this.draw();
  }
  private chatGroupIdentity(event: ServerEvent): string { return chatGroupIdentity(event); }
  private chatAtBottom(): boolean {
    const viewport = Math.max(0, Number(this.chat.height));
    return this.chat.getScrollHeight() <= viewport || this.chat.getScrollPerc() >= 100;
  }
  private captureChatAnchor(scroll = visibleChatOrigin(this.chat)): ChatViewportAnchor | undefined {
    if (!this.chatLayout.length) return undefined;
    const row = Math.max(0, Math.floor(scroll));
    const block = this.chatLayout.find(item => row >= item.startRow && row < item.startRow + item.rows) ??
      this.chatLayout.find(item => item.startRow >= row) ?? this.chatLayout.at(-1);
    return block ? { identity: block.identity, seq: block.seq, rowOffset: row - block.startRow } : undefined;
  }
  private restoreChatAnchor(anchor: ChatViewportAnchor | undefined, layout: ChatBlockLayout[]): number {
    const result = resolveChatAnchor(anchor, layout);
    this.chatAnchorLost = result.lost;
    return result.row;
  }
  private updateChatViewport(): void {
    if (this.view !== 'chat' || this.adjustingChatViewport) return;
    this.chatScrollGeneration++;
    this.follow = this.chatAtBottom();
    if (!this.chatAgent) return;
    if (this.follow) this.session.resumeChat(this.chatAgent);
    else this.session.pauseChat(this.chatAgent, this.captureChatAnchor()?.seq);
  }
  private scheduleDraw(): void {
    if (this.drawTimer || this.closing) return;
    this.drawTimer = setTimeout(() => { this.drawTimer = undefined; this.draw(); }, 40);
  }
  private showNotice(message: string): void {
    if (this.closing) return;
    this.notice.setContent(clip(message, Number(this.screen.width)));
    this.screen.render();
  }
  private saveSettings(): void {
    this.saveChain = this.saveChain.then(() => this.settings.save(this.configPath))
      .then(() => this.showNotice(`Saved ${this.configPath}`))
      .catch(error => this.showNotice(`Cannot save settings: ${error.message}`));
  }
  private changeColor(delta: number): void {
    const key = Object.keys(COLOR_SETTINGS)[this.menuIndex] as ColorSetting | undefined;
    if (!key) return;
    const current = COLOR_OPTIONS.indexOf(this.settings.color(key) as typeof COLOR_OPTIONS[number]);
    this.settings.colors[key] = COLOR_OPTIONS[(current + delta + COLOR_OPTIONS.length) % COLOR_OPTIONS.length]!;
    this.saveSettings(); this.renderColors(); this.draw();
  }
  private renderColors(): void {
    const c = (key: ColorSetting) => this.settings.color(key) === 'orange' ? 208 : this.settings.color(key);
    this.title.style.fg = c('title'); this.columns.style.fg = c('headings');
    this.tree.style.selected = {};
    this.menu.style.selected = { bg: c('selectionBg'), fg: c('selectionFg'), bold: true };
    this.paths.style.selected = { bg: c('selectionBg'), fg: c('selectionFg') };
    this.notice.style.fg = c('notice'); this.footer.style = { fg: c('footerFg'), bg: c('footerBg') };
    this.input.style.border = { fg: c('border') }; this.promptTop.style.fg = c('border'); this.promptBottom.style.fg = c('border');
    this.mentionPanel.style.selected = { bg: c('selectionBg'), fg: c('selectionFg'), bold: true };
    this.preview.style.border = { fg: c('border') }; this.form.style.border = { fg: c('border') };
  }
  private toggleCompactToolCalls(): void {
    this.settings.compactToolCalls = !this.settings.compactToolCalls;
    this.saveSettings(); this.draw();
  }
  private setTableFieldPosition(position: number): void {
    const field = TABLE_FIELDS[this.menuIndex];
    const index = field ? this.settings.tableFields.indexOf(field) : -1;
    if (index < 0) { this.showNotice('Enable this field with Space before setting its order.'); return; }
    const [item] = this.settings.tableFields.splice(index, 1);
    this.settings.tableFields.splice(Math.min(position - 1, this.settings.tableFields.length), 0, item!);
    this.saveSettings(); this.draw();
  }
  private moveTableField(delta: number): void {
    const field = TABLE_FIELDS[this.menuIndex];
    const index = field ? this.settings.tableFields.indexOf(field) : -1;
    if (index < 0) { this.showNotice('Enable this field with Space before setting its order.'); return; }
    const target = index + delta;
    if (target < 0 || target >= this.settings.tableFields.length) return;
    this.setTableFieldPosition(target + 1);
  }
  private changeLevel(delta: number, absolute?: Level): void {
    const type = this.menuTypes[this.menuIndex];
    if (!type) return;
    this.settings.inheritedLevels.delete(type);
    this.settings.levels[type] = absolute ?? ((this.settings.level(type) + delta + 5) % 5) as Level;
    this.saveSettings(); this.draw();
  }
  private selected(): Agent | undefined { return this.selectedAgent ? this.session.store.agents.get(this.selectedAgent) : undefined; }
  private toggleSelectedBranch(): void {
    if (this.view !== 'tree' || !this.selectedAgent) return;
    const rows = this.session.store.tree();
    if (toggleCollapsedBranch(rows, this.collapsedAgentIds, this.selectedAgent)) this.draw();
  }
  private createParent(target = this.selected()): Agent | undefined {
    if (target) return target;
    // Never submit a second root just because selection was temporarily lost
    // during a snapshot refresh or a menu transition.
    const rows = this.session.store.tree();
    return rows.find(row => row.agent.parentId === null)?.agent ?? rows[0]?.agent;
  }
  private chooseMenu(): void {
    this.menuIndex = this.selectedMenuIndex();
    const fields = this.editor?.fields ?? [];
    if (this.view === 'history-settings') {
      this.historyField = (Object.keys(HISTORY_FIELDS) as (keyof HistorySettings)[])[this.menuIndex];
      if (this.historyField) { this.input.setValue(String(this.settings.history[this.historyField])); this.setView('history-field'); }
    } else if (this.view === 'colors') {
      const key = Object.keys(COLOR_SETTINGS)[this.menuIndex] as ColorSetting | undefined;
      if (key) this.changeColor(1);
    } else if (this.view === 'structured') this.openEntry(false);
    else if (this.view === 'entry-type') this.selectEntryType((['string', 'number', 'boolean', 'null', 'json'] as const)[this.menuIndex]!);
    else if (this.view === 'actions') this.chooseAction();
    else if (this.view === 'view') {
      const offset = this.session.serverSettingsCapability ? 1 : 0;
      if (offset && this.menuIndex === 0) void this.openServerSettings();
      else if (this.menuIndex === offset) this.setView('colors');
      else if (this.menuIndex === offset + 1) this.setView('table-fields');
      else if (this.menuIndex === offset + 2) this.setView('levels');
      else if (this.menuIndex === offset + 3) this.toggleCompactToolCalls();
      else if (this.menuIndex === offset + 4) this.setView('history-settings');
    } else if (this.view === 'settings-options') {
      const choice = this.genericChoices[this.menuIndex];
      try {
        if (choice?.setup) { this.pendingChoiceSetup = choice; this.input.setValue(''); this.setView('settings-choice-setup'); }
        else if (choice) this.choiceActions?.choose(choice.value);
      } catch (error) { this.showNotice((error as Error).message); }
    } else if (this.view === 'settings-records') this.openRecord(false);
    else if (this.view === 'server-settings') this.chooseServerGroup();
    else if (this.view === 'server-group') {
      const editor = this.serverEditor;
      const diagnostics = editor && !this.recordEditing ? this.skillErrorLines(editor.group) : [];
      const offset = this.skillGroupOffset(), fieldsEnd = offset + (editor?.fields.length ?? 0);
      const infoEnd = fieldsEnd + this.skillGroupInfoRows();
      const saveIndex = infoEnd + diagnostics.length;
      if (offset && this.menuIndex === 0) this.openLocalSkillPath();
      else if (offset === 2 && this.menuIndex === 1) this.openCatalogManager();
      else if (editor && this.menuIndex >= offset && this.menuIndex < fieldsEnd) this.openServerField(this.menuIndex - offset);
      else if (editor && this.menuIndex >= fieldsEnd && this.menuIndex < infoEnd) {
        this.showNotice(this.legacySeedSummary() ?? 'Legacy seeds are managed through the existing settings API.');
      } else if (editor && this.menuIndex >= infoEnd && this.menuIndex < saveIndex) this.showNotice(diagnostics[this.menuIndex - infoEnd] ?? 'Repository diagnostic');
      else if (editor && this.menuIndex === saveIndex) { if (this.recordEditing) this.stageRecord(); else this.setView('server-confirm'); }
      else if (editor && this.menuIndex > saveIndex) {
        const command = this.serverSkillsCommands()[this.menuIndex - saveIndex - 1];
        if (command?.key === 'c') void this.refreshSkillsCatalog(); else if (command?.key === 'R') void this.retrySkills();
      }
    } else if (this.view === 'catalog-manager') {
      const skill = this.catalogManagerEntries()[this.menuIndex];
      if (skill) this.openSkillDetails(skill);
    } else if (this.view === 'catalog-delete-confirm') {
      if (this.menuIndex === 1) void this.deleteManagedCatalogSkill(); else this.cancelCatalogDelete();
    } else if (this.view === 'server-confirm') {
      if (this.menuIndex === 1) void this.saveServerSettings(); else this.setView('server-group');
    } else if (this.view === 'local-skill-confirm') {
      if (this.menuIndex === 1) void this.registerLocalSkill(); else this.returnLocalSkill();
    }
    else if (this.view === 'confirm') { if (this.menuIndex === 1) void this.runAction(); else this.setView('tree'); }
    else if (this.view === 'harness-options') {
      const choice = this.agentOptions[this.menuIndex];
      if (choice && this.editor) {
        this.editor.select(this.optionField, choice.value);
        this.setView('agent-edit'); this.menuIndex = fields.indexOf(this.optionField); this.draw();
      } else if (this.menuIndex === this.agentOptions.length) {
        this.menuIndex = fields.indexOf(this.optionField); this.openField();
      }
    } else if (this.view === 'agent-edit') {
      if (this.menuIndex === fields.length) void this.saveAgent();
      else if (fields[this.menuIndex] === 'container') void this.openProfileChoices();
      else if (fields[this.menuIndex] === 'harness' && this.session.agentProfilesEnabled) void this.openAgentProfileChoices();
      else if (fields[this.menuIndex] === 'thinking') this.openThinkingChoices();
      else if (fields[this.menuIndex] === 'skills') this.openAgentSkills();
      else if (['harness', 'provider', 'model'].includes(fields[this.menuIndex] ?? '')) void this.openAgentOptions();
      else this.openField();
    } else if (this.view === 'image-scope') void this.saveAgent((['node', 'inherited', 'all'] as const)[this.menuIndex]);
  }
  private cycleMenu(): void {
    if (this.view === 'table-fields') {
      const field = TABLE_FIELDS[this.menuIndex];
      if (field) {
        const index = this.settings.tableFields.indexOf(field);
        if (index >= 0 && this.settings.tableFields.length === 1) {
          this.showNotice('Keep at least one table field visible.'); return;
        }
        if (index >= 0) this.settings.tableFields.splice(index, 1);
        else this.settings.tableFields.push(field);
        this.saveSettings(); this.draw();
      }
    } else if (this.view === 'colors') this.changeColor(1);
    else if (this.view === 'levels') this.changeLevel(1);
    else if (this.view === 'agent-skills') this.cycleSkill();
  }
  private lifecycle(method: LifecycleMethod, label: string): void {
    if (this.sending) return;
    const agent = this.selected();
    if (!agent) return;
    this.pendingAction = { method, agentId: agent.id, label: `${label} · ${agent.name}` };
    this.setView('confirm');
  }
  private contextActions(): KeyAction[] {
    const action = (key: string, label: string, run: () => void): KeyAction => ({ key, label, run });
    if (this.sending) return [action('escape', 'Return to tree (work still running)', () => this.setView('tree')), action('q', 'Quit client', () => this.close())];
    const lifecycle = [
      action('r', 'Start / restart agent', () => this.lifecycle('agent.restart', 'Start / restart agent')),
      action('x', 'Stop agent', () => this.lifecycle('agent.stop', 'Stop agent')),
      action('R', 'Restart subtree', () => this.lifecycle('agent.restart_subtree', 'Restart subtree')),
      action('p', 'Replace session', () => this.lifecycle('agent.replace_session', 'Replace session')),
      action('d', 'Remove agent and descendants', () => this.lifecycle('agent.remove', 'Remove agent and descendants')),
    ];
    const back = action('escape', 'Cancel / back', () => {
      if (['harness-options', 'image-scope'].includes(this.view)) {
        const index = this.editor?.fields.indexOf(this.optionField) ?? 0;
        this.setView('agent-edit'); this.menuIndex = index; this.draw();
      } else this.setView('tree');
    });
    const choose = () => this.chooseMenu();
    const cycle = () => this.cycleMenu();
    if (this.view === 'raw-events') return [
      action('up', 'Previous event', () => this.moveRaw(-1)), action('down', 'Next event', () => this.moveRaw(1)),
      action('enter', 'View full event JSON', () => this.openRawJson()),
      action('escape', 'Return to tree', () => this.setView('tree')),
    ];
    if (this.view === 'raw-event-json') return [
      action('up', 'Scroll up', () => this.scrollRawJson(-1)), action('down', 'Scroll down', () => this.scrollRawJson(1)),
      action('escape', 'Return to event list', () => this.setView('raw-events')),
    ];
    if (this.view === 'skill-details') return [
      ...(['pageup', 'pagedown', 'home', 'end', 'C-home', 'C-end'] as const).map(key => action(key,
        key.endsWith('home') ? 'Top' : key.endsWith('end') ? 'Bottom' : key === 'pageup' ? 'Previous page' : 'Next page', () => this.scrollSkillDetails(key))),
      action('escape', 'Back to registered catalog list', () => { this.setView(this.skillDetailsReturnView); this.menuIndex = this.skillDetailsReturnIndex; this.draw(); }),
    ];
    if (this.view === 'catalog-manager') return [
      action('enter', 'View full registered skill details', choose),
      ...(this.session.skillCatalogManagementAvailable && this.session.managedSkillCatalog[this.menuIndex]?.status === 'ready' ? [action('d', 'Retire selected skill from new grants', () => { void this.changeManagedCatalogStatus(true); })] : []),
      ...(this.session.skillCatalogManagementAvailable && this.session.managedSkillCatalog[this.menuIndex]?.status === 'retired' ? [action('r', 'Restore selected skill to active catalog', () => { void this.changeManagedCatalogStatus(false); })] : []),
      ...(this.session.skillCatalogDeletionAvailable && ['ready', 'retired'].includes(this.session.managedSkillCatalog[this.menuIndex]?.status ?? '') ? [action('x', 'Delete selected skill permanently', () => this.confirmCatalogDelete())] : []),
      action('escape', 'Back to Skills settings', () => { this.setView('server-group'); this.menuIndex = this.catalogManagerReturnIndex; this.draw(); }),
    ];
    if (this.view === 'catalog-delete-confirm') return [
      action('enter', 'Choose permanent deletion confirmation', choose),
      action('y', 'Delete skill and owned files permanently', () => { void this.deleteManagedCatalogSkill(); }),
      action('n', 'Cancel permanent deletion', () => this.cancelCatalogDelete()),
      action('escape', 'Cancel permanent deletion', () => this.cancelCatalogDelete()),
    ];
    if (this.view === 'agent-info') return [
      action('j', this.infoRaw ? 'Readable agent info' : 'Full agent JSON', () => { this.infoRaw = !this.infoRaw; this.draw(); this.details.setScroll(0); this.screen.render(); }),
      ...(['pageup', 'pagedown', 'home', 'end', 'C-home', 'C-end'] as const).map(key => action(key,
        key.endsWith('home') ? 'Top' : key.endsWith('end') ? 'Bottom' : key === 'pageup' ? 'Previous page' : 'Next page', () => this.scrollAgentInfo(key))),
      action('escape', `Back to ${this.infoReturn.view === 'tree' ? 'tree' : 'agent actions'}`, () => {
        const { view, index } = this.infoReturn;
        this.setView(view); this.menuIndex = index; this.draw();
      }),
    ];
    if (this.view === 'structured') return [
      action('a', 'Add entry', () => this.openEntry(true)), action('e', 'Edit selected entry', () => this.openEntry(false)), action('enter', 'Edit selected entry', choose),
      action('d', 'Remove selected entry from draft', () => { const entry = this.structured?.entries()[this.menuIndex]; if (entry) { this.structured!.remove(entry.id); this.menuIndex = Math.max(0, this.menuIndex - 1); this.draw(); } }),
      action('/', 'Filter (all keys become text)', () => { this.input.setValue(this.structured!.filter); this.setView('structured-filter'); }),
      action('S', 'Stage list / map in settings draft', () => this.stageStructured()),
      ...(!this.isVolumeField() ? [action('J', 'Advanced raw JSON', () => { this.entryIndex = this.menuIndex; this.input.setValue(this.structured!.serialize()); this.setView('structured-raw'); })] : []),
      action('escape', 'Discard list / map draft', () => this.returnAgentField()),
    ];
    if (this.view === 'entry-type') return (['string', 'number', 'boolean', 'null', 'json'] as const).map((type, index) => action(['s', 'n', 'b', 'z', 'j'][index]!, type, () => this.selectEntryType(type))).concat([action('enter', 'Choose selected type', choose), action('escape', 'Discard entry', () => this.returnStructured())]);
    if (this.view === 'actions') return this.actions.map((item, index) =>
      action(item.key, item.label, () => { this.menuIndex = index; this.chooseAction(); })
    ).concat([action('enter', 'Choose selected action', choose), back]);
    if (this.view === 'tree') return [
      action('tab', 'Collapse / expand selected branch', () => this.toggleSelectedBranch()),
      action('n', 'Create agent', () => this.openEditor(false)),
      ...(this.selected() ? [action('i', 'View all agent info', () => this.openAgentInfo(this.selected())), action('e', 'Modify agent', () => this.openEditor(true)), ...lifecycle,
        action('enter', 'Prompt', () => this.openPrompt()), action('c', 'Chat', () => this.openChat()), action('z', 'Raw events', () => this.openRawEvents()),
        ] : []),
      action('a', 'Agent actions', () => this.openActions()), action('v', 'Settings (server / client)', () => this.setView('view')),
      action('l', 'Event visibility / rendering levels', () => this.setView('levels')),
      action('q', 'Quit client', () => this.close()), back,
    ];
    if (this.view === 'view') return [action('enter', 'Choose selected setting', choose), ...(this.session.serverSettingsCapability ? [action('s', 'Server organization / plugin settings', () => { void this.openServerSettings(); })] : []), action('t', 'TUI colors (CLIENT ONLY)', () => this.setView('colors')), action('b', 'Table fields / order', () => this.setView('table-fields')), action('l', 'Event visibility / rendering levels (CLIENT ONLY)', () => this.setView('levels')), action('c', 'Toggle compact tool and steering phases', () => this.toggleCompactToolCalls()), action('h', 'History cache (CLIENT ONLY)', () => this.setView('history-settings')), back];
    if (this.view === 'history-settings') return [action('enter', 'Edit selected history limit', choose), action('z', 'Restore history cache defaults', () => { this.settings.history = { ...DEFAULT_HISTORY }; this.session.configureHistory(this.settings.history); this.saveSettings(); this.draw(); }), back];
    if (this.view === 'colors') return [action('space', 'Cycle selected color', cycle), action('left', 'Previous color', () => this.changeColor(-1)), action('right', 'Next color', () => this.changeColor(1)), action('enter', 'Next color', () => this.changeColor(1)), action('z', 'Reset all colors', () => { this.settings.colors = { ...DEFAULT_COLORS }; this.saveSettings(); this.draw(); }), back];
    if (this.view === 'table-fields') return [
      action('space', 'Toggle field visibility', cycle),
      ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((key, index) =>
        action(key, `Set selected field to position ${index + 1}`, () => this.setTableFieldPosition(index + 1))),
      action('left', 'Move field earlier', () => this.moveTableField(-1)),
      action('right', 'Move field later', () => this.moveTableField(1)),
      action('z', 'Reset table fields to defaults', () => { this.settings.tableFields = [...DEFAULT_TABLE_FIELDS]; this.saveSettings(); this.draw(); }),
      back,
    ];
    if (this.view === 'settings-options') return [action('enter', 'Choose option', choose), ...(this.choiceActions?.manual ? [action('m', 'Manual entry', () => this.choiceActions?.manual?.())] : []), action('escape', 'Back without selecting', () => this.choiceActions?.back())];
    if (this.view === 'settings-records') return [action('a', this.records?.keys ? 'Choose server resource' : 'Add configuration', () => this.openRecord(true)), action('enter', 'Edit entry', choose), action('e', 'Edit entry', choose),
      action('d', 'Remove entry from draft', () => { this.records!.values.splice(this.menuIndex, 1); this.records!.keys?.splice(this.menuIndex, 1); this.menuIndex = Math.max(0, this.menuIndex - 1); this.draw(); }),
      action('S', 'Stage entries in server draft', () => this.finishRecords(true)), action('escape', 'Discard collection edits', () => this.finishRecords(false))];
    if (this.view === 'server-settings') return [action('enter', 'Open settings / facts', choose), action('r', 'Refresh server settings', () => { void this.openServerSettings(); }), action('escape', 'Back to settings', () => this.setView('view'))];
    if (this.view === 'server-facts') return [action('escape', 'Back to server settings', () => this.setView('server-settings'))];
    if (this.view === 'server-group') return [action('enter', 'Open Add / catalog row / setting / save / command', choose), ...(this.skillRegistrationEnabled() ? [action('a', 'Add skill repository', () => this.openLocalSkillPath())] : []), action('S', this.recordEditing ? 'Stage entry in collection' : 'Review server-wide save', () => { if (this.recordEditing) this.stageRecord(); else this.setView('server-confirm'); }),
      ...this.serverSkillsCommands().map(command => action(command.key, command.key === 'c' ? 'Refresh shared Skills catalog only' : 'Retry legacy seed preparation', () => { if (command.key === 'c') void this.refreshSkillsCatalog(); else void this.retrySkills(); })),
      action('z', 'Reset selected field to startup default (draft)', () => {
      const field = this.serverEditor?.fields[this.menuIndex - this.skillGroupOffset()];
      if (field) { this.serverEditor!.reset(field); this.draw(); }
    }), ...(!this.recordEditing ? [action('r', 'Discard draft and reload current settings', () => { void this.reloadServerGroup(); })] : []), action('escape', 'Discard draft / back', () => { if (this.recordEditing) { this.serverEditor = this.records!.parent; this.recordEditing = false; this.setView('settings-records'); } else this.setView('server-settings'); })];
    if (this.view === 'server-confirm') return [action('enter', 'Choose confirmation row', choose), action('y', 'Save server-wide changes', () => { void this.saveServerSettings(); }), action('n', 'Back to draft', () => this.setView('server-group')), action('escape', 'Back to draft', () => this.setView('server-group'))];
    if (this.view === 'confirm') return [action('enter', 'Choose selected confirmation row', choose), action('y', 'Confirm', () => { void this.runAction(); }), action('n', 'Cancel', () => this.setView('tree')), back];
    if (this.view === 'agent-edit') return [action('enter', 'Edit selected field / save row', choose), action('S', 'Save changes', () => { void this.saveAgent(); }), back];
    if (this.view === 'image-scope') return (['node', 'inherited', 'all'] as const).map((scope, index) => action(String(index + 1), ['This node only', 'Inheriting descendants', 'All descendants'][index]!, () => { void this.saveAgent(scope); })).concat([action('enter', 'Choose selected scope', choose), back]);
    if (this.view === 'harness-options') return [action('enter', 'Choose selected option', choose), action('m', 'Manual entry', () => { this.menuIndex = this.editor!.fields.indexOf(this.optionField); this.openField(); }), back];
    if (this.view === 'agent-skills') return [
      action('a', 'Select as available', () => this.setPickerSkill('available')),
      action('i', 'Select as installed', () => this.setPickerSkill('installed')),
      action('d', 'Remove from this agent', () => this.removePickerSkill()),
      action('space', 'Cycle available / installed / removed', cycle),
      action('/', 'Filter catalog', () => { this.input.setValue(this.skillPicker?.filter ?? ''); this.setView('agent-skills-filter'); }),
      action('S', 'Stage selection in agent form', () => this.stageAgentSkills()),
      action('v', 'Open server settings for repository configuration', () => { this.cancelAgentSkills(); void this.openServerSettings(); }),
      action('escape', 'Cancel field draft', () => this.cancelAgentSkills()),
    ];
    if (this.view === 'local-skill-confirm') return [action('enter', 'Choose confirmation', choose), action('y', 'Register shared skill repository', () => { void this.registerLocalSkill(); }), action('n', 'Cancel', () => this.returnLocalSkill()), action('escape', 'Cancel registration', () => this.returnLocalSkill())];
    if (this.view === 'local-skill-path') return [action('enter', 'Review source and confirm', () => { const source = this.input.getValue(); if (!source || source.includes(String.fromCharCode(0)) || source.length > 4096) { this.showNotice('Enter a nonempty source locator up to 4,096 characters.'); return; } this.localSkillPath = source; this.setView('local-skill-confirm'); }), action('escape', 'Cancel registration', () => this.returnLocalSkill())];
    if (this.view === 'agent-skills-filter') return [
      action('enter', 'Apply filter', () => this.applySkillFilter()),
      action('escape', 'Cancel filter', () => this.cancelSkillFilter()),
    ];
    if (this.view === 'levels') return [0, 1, 2, 3, 4].map(level => action(String(level), LEVEL_NAMES[level]!, () => this.changeLevel(0, level as Level))).concat([
      action('r', 'Next renderer example (does not change server selection)', () => { this.previewIndex++; this.draw(); }),
      action('z', 'Inherit parent / default rendering level', () => {
        const type = this.menuTypes[this.menuIndex];
        if (type?.includes(':')) {
          delete this.settings.levels[type];
          this.settings.inheritedLevels.add(type);
        } else if (type) {
          this.settings.inheritedLevels.delete(type);
          this.settings.levels[type] = new Settings().level(type);
        }
        this.saveSettings(); this.draw();
      }),
      action('left', 'Previous level', () => this.changeLevel(-1)), action('right', 'Next level', () => this.changeLevel(1)), action('space', 'Cycle level', () => this.changeLevel(1)), action('enter', 'Cycle level', () => this.changeLevel(1)), back,
    ]);
    return [];
  }
  private async openChoices(label: string, load: () => Promise<SettingsChoice[]>, actions: NonNullable<UI['choiceActions']>): Promise<void> {
    const request = ++this.choicesRequest;
    this.genericChoices = []; this.choiceLabel = label; this.choiceActions = actions;
    this.setView('settings-options'); this.showNotice('Loading available options from the server…');
    try {
      const choices = await load();
      if (this.closing || request !== this.choicesRequest || this.view !== 'settings-options') return;
      this.genericChoices = choices; this.notice.setContent(choices.length ? '' : 'No available options. Configure server resources first or go back.'); this.draw();
    } catch (error) { if (!this.closing && request === this.choicesRequest && this.view === 'settings-options') this.showNotice((error as Error).message); }
  }
  private async openProfileChoices(): Promise<void> {
    const editor = this.editor!; const index = this.menuIndex;
    let catalog: { revision: number; profiles: ContainerProfile[] };
    const back = () => { this.setView('agent-edit'); this.menuIndex = index; this.draw(); };
    await this.openChoices('Container', async () => {
      catalog = await this.session.listProfiles();
      return catalog.profiles.map(p => ({ value: p.id, label: `${p.name} · ${p.image} · ${p.network}` }));
    }, { back, choose: value => {
      const profile = catalog.profiles.find(p => p.id === value);
      if (!profile) return;
      editor.selectProfile(profile, catalog.revision); back();
      this.showNotice('Container selected; review cwd and grants before saving.');
    } });
  }
  private async openAgentProfileChoices(): Promise<void> {
    const editor = this.editor!, index = this.menuIndex;
    const back = () => { this.setView('agent-edit'); this.menuIndex = index; this.draw(); };
    let profiles: Awaited<ReturnType<Session['listAgentProfiles']>> = [];
    await this.openChoices('Agent', async () => {
      profiles = await this.session.listAgentProfiles();
      return profiles.map((profile, i) => ({ value: String(i), label: `${profile.harness} — ${profile.name}${profile.model ? ` · ${profile.provider ?? ''}/${profile.model}` : ''}` }));
    }, { back, choose: value => { const profile = profiles[Number(value)]; if (profile && this.editor === editor) { editor.selectAgentProfile(profile); back(); } } });
  }
  private openThinkingChoices(): void {
    const editor = this.editor!, index = this.menuIndex;
    const back = () => { this.setView('agent-edit'); this.menuIndex = index; this.draw(); };
    void this.openChoices('Thinking level', async () => [...(!editor.agentId ? [''] : []), 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, label: value || 'Use profile/default' })), {
      back, choose: value => { editor.stage('thinking', value); back(); },
    });
  }
  private openRecord(add: boolean, choice?: SettingsChoice): void {
    const records = this.records; if (!records) return;
    if (add && records.keys && !choice) {
      const back = () => this.setView('settings-records');
      void this.openChoices(records.field.label, async () => (await this.session.settingsChoices(records.field.choicesEndpoint!))
        .filter(option => !records.keys!.includes(option.value)), {
        back, choose: key => { const selected = this.genericChoices.find(option => option.value === key); if (selected && this.records === records) this.openRecord(true, selected); },
      }); return;
    }
    if (!add && !records.values[this.menuIndex]) return;
    const value = { ...structuredClone(records.field.itemDefaults!), ...structuredClone(add ? choice?.defaults ?? {} : records.values[this.menuIndex]) };
    if (add) {
      const parentValues = records.parent.valuesObject();
      for (const [target, source] of Object.entries(records.field.itemDefaultsFrom ?? {})) value[target] = structuredClone(parentValues[source]);
      if (records.field.itemIdKey && records.field.itemIdKey !== records.field.itemLabelKey) value[records.field.itemIdKey] = crypto.randomUUID();
    }
    records.index = add ? -1 : this.menuIndex;
    records.newKey = add ? choice?.value : undefined;
    const label = records.keys ? (add ? records.newKey : records.keys[this.menuIndex]) : value[records.field.itemLabelKey ?? 'name'] || 'New entry';
    const group = { ...records.parent.group, title: `${records.field.label}: ${label ?? 'New entry'}`,
      fields: records.field.itemFields!, defaults: records.field.itemDefaults!, values: value, effective: value, overridden: [], restartRequired: [] };
    this.serverEditor = new ServerSettingsEditor(group); this.recordEditing = true; this.setView('server-group');
  }
  private stageRecord(): void {
    if (!this.records || !this.serverEditor) return;
    try {
      const value = this.serverEditor.valuesObject();
      if (this.records.index < 0) {
        if (this.records.keys) {
          if (!this.records.newKey || this.records.keys.includes(this.records.newKey)) throw new Error('Choose a new resource from the server');
          this.records.keys.push(this.records.newKey);
        }
        this.records.values.push(value);
      } else this.records.values[this.records.index] = value;
      this.serverEditor = this.records.parent; this.recordEditing = false; this.setView('settings-records');
    } catch (error) { this.showNotice((error as Error).message); }
  }
  private finishRecords(stage: boolean): void {
    if (!this.records) return;
    const { parent, field, values, keys, parentIndex } = this.records;
    try {
      if (stage) parent.stage(field, JSON.stringify(keys ? Object.fromEntries(keys.map((key, i) => [key, values[i]])) : values));
      this.serverEditor = parent; this.records = undefined; this.recordEditing = false;
      this.setView('server-group'); this.menuIndex = parentIndex; this.draw();
    } catch (error) { this.showNotice((error as Error).message); }
  }
  private async openServerSettings(): Promise<void> {
    const request = ++this.settingsRequest;
    this.setView('server-settings');
    this.showNotice('Loading shared server settings…');
    try {
      const catalog = await this.session.loadServerSettings();
      if (!this.closing && request === this.settingsRequest && this.view === 'server-settings') {
        this.menuIndex = catalog.groups.length === 1 && catalog.groups[0]?.namespace === 'skills' ? 1 : 0; this.notice.setContent(''); this.draw();
      }
    } catch (error) { if (!this.closing && request === this.settingsRequest) this.showNotice((error as Error).message); }
  }
  private async reloadServerGroup(): Promise<void> {
    const editor = this.serverEditor;
    try {
      const catalog = await this.session.loadServerSettings();
      if (this.closing || this.view !== 'server-group' || this.serverEditor !== editor) return;
      const group = catalog.groups.find(g => g.namespace === editor?.group.namespace);
      if (!group) throw new Error('Settings group is no longer available');
      this.serverEditor = new ServerSettingsEditor(group);
      this.notice.setContent(''); this.draw();
    } catch (error) { if (!this.closing) this.showNotice((error as Error).message); }
  }
  private chooseServerGroup(): void {
    if (this.menuIndex === 0) { this.setView('server-facts'); return; }
    const group = this.session.serverSettingsCatalog?.groups[this.menuIndex - 1];
    if (!group) { this.showNotice('This plugin has not declared server settings.'); return; }
    this.serverEditor = new ServerSettingsEditor(group);
    this.records = undefined; this.recordEditing = false;
    this.setView('server-group');
    if (group.namespace === 'skills' && this.session.skillReconciliation?.state === 'error') this.showNotice('Repository reconciliation has errors; press R to retry without saving settings.');
  }
  private openServerField(fieldIndex = this.menuIndex - this.skillGroupOffset()): void {
    const editor = this.serverEditor, field = editor?.fields[fieldIndex];
    this.menuIndex = fieldIndex;
    if (!editor || !field) return;
    this.serverField = field;
    if (field.itemFields) {
      const value = JSON.parse(editor.values[field.key]!);
      this.records = { parent: editor, field, values: field.editor === 'object-map' ? Object.values(value) : value,
        ...(field.editor === 'object-map' && { keys: Object.keys(value) }), index: -1, parentIndex: fieldIndex + this.skillGroupOffset() };
      this.setView('settings-records'); this.showNotice(field.description ?? ''); return;
    }
    if (field.editor === 'select' || (field.editor === 'text' && field.choicesEndpoint)) {
      const index = fieldIndex, back = () => { this.setView('server-group'); this.menuIndex = index + this.skillGroupOffset(); this.draw(); };
      void this.openChoices(field.label, () => field.choicesEndpoint ? this.session.settingsChoices(field.choicesEndpoint) : Promise.resolve(field.choices!.map(value => ({ value, label: value }))), {
        back, choose: value => { editor.stage(field, value); back(); },
        ...(field.editor === 'text' ? { manual: () => { this.input.setValue(editor.values[field.key]!); this.setView('server-field'); } } : {}),
      }); return;
    }
    if (field.editor === 'boolean') { editor.stage(field, editor.values[field.key] === 'true' ? 'false' : 'true'); this.draw(); return; }
    if (['list', 'string-map', 'object-map'].includes(field.editor)) {
      const directoryList = ['readOnlyDirs', 'readWriteDirs'].includes(field.key);
      this.structured = new StructuredEditor({ editor: directoryList ? 'directories' : field.editor as 'list' | 'string-map' | 'object-map', label: field.label, genericList: field.editor === 'list' && !field.choicesEndpoint && !directoryList }, editor.values[field.key]!);
      this.structuredServer = true; this.structuredField = undefined;
      this.structuredIndex = fieldIndex; this.setView('structured');
    } else { this.input.setValue(editor.values[field.key]!); this.setView('server-field'); }
  }
  private effectiveRestartRequired(group: ServerSettingsGroup): string[] {
    return group.restartRequired.filter(key => !(group.namespace === 'skills' && key === 'repositories' && group.fields.find(field => field.key === key)?.effect === 'immediate'));
  }
  private skillErrorLines(group: ServerSettingsGroup): string[] {
    if (group.namespace !== 'skills') return [];
    const reconciliation = this.session.skillReconciliation ?? group.reconciliation;
    return (reconciliation?.entries ?? []).filter(entry => entry.status === 'error').flatMap(entry => [
      `Repository ${entry.name} · error`,
      `Source: ${entry.gitUrl ?? 'unknown source'}`,
      `Error: ${entry.error ?? 'No diagnostic available'}`,
    ]);
  }
  private serverSkillsCommands(): Array<{ key: 'c' | 'R'; label: string }> {
    if (this.recordEditing || this.serverEditor?.group.namespace !== 'skills') return [];
    return [
      ...(this.session.skillsEnabled ? [{ key: 'c' as const, label: 'Refresh catalog (read-only)' }] : []),
      ...(this.session.skillsReconcileEndpointAvailable ? [{ key: 'R' as const, label: 'Retry legacy seed preparation' }] : []),
    ];
  }
  private legacySeedSummary(): string | undefined {
    const values = this.serverEditor?.group.values.repositories;
    if (!Array.isArray(values)) return 'Legacy configured seeds: unavailable';
    const names = values.flatMap(item => item && typeof item === 'object' && typeof (item as any).name === 'string' ? [(item as any).name] : []);
    return `Legacy configured seeds: ${names.length}${names.length ? ` · ${names.join(', ')}` : ''} · managed by legacy settings API`;
  }
  private skillRegistrationEnabled(): boolean {
    return !this.recordEditing && this.serverEditor?.group.namespace === 'skills' && !!this.session.skillRepositoryRegistrationAvailable;
  }
  private skillGroupOffset(): number { return this.serverEditor?.group.namespace === 'skills' && !this.recordEditing ? 2 : 0; }
  private skillGroupInfoRows(): number { return this.serverEditor?.group.namespace === 'skills' && !this.recordEditing ? 1 : 0; }
  private openSkillDetails(skill: Skill): void {
    this.skillDetailsFocus = skill;
    this.skillDetailsReturnView = 'catalog-manager';
    this.skillDetailsReturnIndex = this.menuIndex;
    this.lastSkillDetails = '';
    this.setView('skill-details');
  }
  private scrollSkillDetails(key: string): void {
    if (key.endsWith('home')) this.details.setScroll(0);
    else if (key.endsWith('end')) this.details.setScrollPerc(100);
    else this.details.scroll((key === 'pageup' ? -1 : 1) * Math.max(1, Number(this.details.height) - 2));
    this.screen.render();
  }
  private skillDetails(skill: Skill): string { return formatSkillDetails(skill); }
  private catalogManagerEntries(): Skill[] {
    const entries = this.session.managedSkillCatalog;
    const confirmed = this.unrefreshedRegistration;
    // Keep confirmed admission details inspectable when discovery fails, but
    // never make this fallback row eligible for management or agent grants.
    return confirmed && !entries.some(skill => skill.name === confirmed.name)
      ? [...entries, { ...confirmed, status: undefined }] : entries;
  }
  private openCatalogManager(): void {
    this.catalogManagerReturnIndex = this.menuIndex;
    this.setView('catalog-manager');
    this.showNotice(this.session.skillCatalogManagementAvailable
      ? 'Retirement hides a manual skill from new grants only. Existing selections, installations, history and files remain; Restore reverses retirement.'
      : 'This server does not advertise reversible registered-catalog management.');
  }
  private confirmCatalogDelete(): void {
    if (this.catalogStatusInFlight || !this.session.skillCatalogDeletionAvailable) return;
    const skill = this.session.managedSkillCatalog[this.menuIndex];
    if (!skill || !['ready', 'retired'].includes(skill.status ?? '')) return;
    this.pendingCatalogDelete = skill;
    this.catalogDeleteReturnIndex = this.menuIndex;
    this.setView('catalog-delete-confirm');
    this.showNotice('Irreversible: removes the catalog entry, agent assignments, plugin-owned installed/recovery copies, and central managed checkout/history. It does not stop running agents or delete the original source path. Active work or unverified/pending files block deletion.');
  }
  private cancelCatalogDelete(): void {
    this.pendingCatalogDelete = undefined;
    this.setView('catalog-manager');
    this.menuIndex = this.catalogDeleteReturnIndex;
    this.showNotice('Permanent deletion cancelled; no files or assignments were changed.');
    this.draw();
  }
  private async deleteManagedCatalogSkill(): Promise<void> {
    const skill = this.pendingCatalogDelete;
    if (!skill || this.catalogStatusInFlight || this.view !== 'catalog-delete-confirm') return;
    const navigation = this.navigationGeneration, request = ++this.catalogStatusRequest;
    const ownsContext = () => !this.closing && this.view === 'catalog-delete-confirm' &&
      this.navigationGeneration === navigation && this.catalogStatusRequest === request;
    this.catalogStatusInFlight = true;
    try {
      const outcome = await this.session.deleteSkillRepository(skill);
      if (!ownsContext()) return;
      this.pendingCatalogDelete = undefined;
      this.setView('catalog-manager');
      this.menuIndex = Math.min(this.catalogDeleteReturnIndex, Math.max(0, this.session.managedSkillCatalog.length - 1));
      this.showNotice(outcome.refreshed
        ? `Permanently deleted ${skill.name}; removed ${outcome.removedAssignments} agent assignment(s) and ${outcome.removedInstallations} plugin-owned install/recovery copies. Running agents were not stopped.`
        : `Permanently deleted ${skill.name}; assignments and files were removed, but catalog refresh failed. ${outcome.refreshError ?? 'Refresh from Skills settings to verify.'}`);
      this.draw();
    } catch (error) {
      if (ownsContext()) {
        await this.session.refreshSkills(true).catch(() => {});
        if (ownsContext()) this.showNotice((error as Error).message);
      }
    } finally {
      if (this.catalogStatusRequest === request) this.catalogStatusInFlight = false;
    }
  }
  private async changeManagedCatalogStatus(retired: boolean): Promise<void> {
    if (this.catalogStatusInFlight || this.view !== 'catalog-manager') return;
    const originalIndex = this.menuIndex;
    const skill = this.session.managedSkillCatalog[originalIndex];
    if (!skill) return;
    const sameIdentity = (candidate?: Skill) => !!candidate && candidate.name === skill.name && !!candidate.source && !!skill.source &&
      candidate.source.kind === skill.source.kind && (candidate.source.kind === 'git'
        ? skill.source.kind === 'git' && candidate.source.gitUrl === skill.source.gitUrl
        : skill.source.kind === 'local' && candidate.source.path === skill.source.path);
    if ((retired && skill.status !== 'ready') || (!retired && skill.status !== 'retired')) {
      this.showNotice('Catalog status changed; refresh the list before acting.'); return;
    }
    const navigation = this.navigationGeneration, request = ++this.catalogStatusRequest;
    const ownsContext = () => !this.closing && this.view === 'catalog-manager' &&
      this.navigationGeneration === navigation && this.catalogStatusRequest === request;
    this.catalogStatusInFlight = true;
    try {
      const outcome = await this.session.updateSkillCatalogRetirement(skill, retired);
      if (!ownsContext()) return;
      const currentSelection = this.session.managedSkillCatalog[this.menuIndex];
      if (this.menuIndex === originalIndex && sameIdentity(currentSelection)) {
        const recordIndex = this.session.managedSkillCatalog.findIndex(sameIdentity);
        if (recordIndex >= 0) this.menuIndex = recordIndex;
      }
      this.showNotice(outcome.refreshed
        ? retired ? `Retired ${skill.name} from new grants. Existing assignments, installations, history and files were preserved.` : `Restored ${skill.name} to the active catalog.`
        : `Catalog status changed for ${skill.name}; refresh failed. ${outcome.refreshError ?? 'Refresh the catalog to verify.'}`);
      this.draw();
    } catch (error) {
      if (ownsContext()) this.showNotice((error as Error).message);
    } finally {
      // Release the duplicate-action guard, but do not draw or publish feedback
      // from a completion whose navigation/request context is stale.
      if (this.catalogStatusRequest === request) this.catalogStatusInFlight = false;
    }
  }
  private async retrySkills(): Promise<void> {
    try { await this.session.reconcileSkills(); this.showNotice('Skills reconciliation retry accepted; settings were not changed.'); }
    catch (error) { this.showNotice(`Skills retry failed: ${(error as Error).message}`); }
    this.draw();
  }
  private async saveServerSettings(): Promise<void> {
    const editor = this.serverEditor;
    if (!editor || this.sending) return;
    this.sending = true; this.draw();
    try {
      const group = await this.session.updateServerSettings(editor.params());
      if (group.namespace === 'skills') await this.session.refreshSkills().catch(() => {});
      if (!this.closing && this.serverEditor === editor) {
        this.serverEditor = new ServerSettingsEditor(group);
        if (this.view === 'server-confirm') this.setView('server-group');
        const restart = this.effectiveRestartRequired(group);
        const reconciliation = group.reconciliation ?? this.session.skillReconciliation;
        const preparing = group.namespace === 'skills' && (reconciliation?.state === 'pending' || reconciliation?.state === 'running');
        this.showNotice(preparing ? `Saved on server · preparing repositories${restart.length ? ` · restart required: ${restart.join(', ')}` : '; no agents restarted'}` : restart.length ? `Saved on server · restart required: ${restart.join(', ')}` : 'Saved on server · no agents restarted');
      }
    } catch (error) {
      if (!this.closing && this.serverEditor === editor) {
        if (this.view === 'server-confirm') this.setView('server-group');
        this.showNotice(`${(error as Error).message} · draft retained; no automatic retry`);
        try { await this.session.loadServerSettings(); } catch { /* Keep the original save error. */ }
      }
    } finally { this.sending = false; this.draw(); }
  }
  private openKeys(): void {
    if (this.view === 'keys' || this.sending) return;
    this.keyActions = this.contextActions();
    if (!this.keyActions.length) return;
    this.keyContext = { view: this.view, index: this.menuIndex };
    this.setView('keys');
  }
  private restoreKeyContext(): void {
    const context = this.keyContext;
    if (!context) return;
    this.setView(context.view); this.menuIndex = context.index; this.draw();
  }
  private invokeKey(key: string): void {
    const action = this.keyActions.find(action => action.key === key);
    if (!action) return;
    this.restoreKeyContext(); action.run();
  }
  private openActions(): void {
    if (this.sending) return;
    this.actionAgentId = this.createParent()?.id;
    this.actions = [{ key: 'n', label: this.actionAgent ? 'Create child (starts immediately)' : 'Create root (starts immediately)', kind: 'create' }];
    if (this.actionAgent) this.actions.push(
      { key: 'i', label: 'View all agent info', kind: 'info' },
      { key: 'e', label: 'Modify agent', kind: 'edit' },
      { key: 'r', label: 'Start / restart agent', kind: 'lifecycle', method: 'agent.restart' },
      { key: 'x', label: 'Stop agent (descendants stay active)', kind: 'lifecycle', method: 'agent.stop' },
      { key: 'R', label: 'Restart subtree (including stopped descendants)', kind: 'lifecycle', method: 'agent.restart_subtree' },
      { key: 'p', label: 'Replace session (fresh conversation)', kind: 'lifecycle', method: 'agent.replace_session' },
      { key: 'd', label: 'Remove agent and descendants (archive)', kind: 'lifecycle', method: 'agent.remove' },
    );
    this.setView('actions');
  }
  private openAgentInfo(agent?: Agent): void {
    if (!agent) return;
    this.infoAgentId = agent.id;
    this.infoReturn = { view: this.view === 'actions' ? 'actions' : 'tree', index: this.menuIndex };
    this.infoRaw = false;
    this.lastInfo = '';
    this.setView('agent-info');
    this.details.setScroll(0);
    this.screen.render();
  }
  private scrollAgentInfo(key: string): void {
    if (key.endsWith('home')) this.details.setScroll(0);
    else if (key.endsWith('end')) this.details.setScrollPerc(100);
    else this.details.scroll((key === 'pageup' ? -1 : 1) * Math.max(1, Number(this.details.height) - 2));
    this.screen.render();
  }
  private chooseAction(): void {
    if (this.sending) return;
    const action = this.actions[this.menuIndex];
    if (!action) return;
    if (action.kind === 'info') { this.openAgentInfo(this.actionAgent); return; }
    if (action.kind === 'create' || action.kind === 'edit') { this.openEditor(action.kind === 'edit', this.actionAgent); return; }
    if (action.kind !== 'lifecycle' || !this.actionAgent) return;
    this.pendingAction = { method: action.method, agentId: this.actionAgent.id, label: `${action.label} · ${this.actionAgent.name}` };
    this.setView('confirm');
  }
  private async openEditor(modify: boolean, target = this.selected()): Promise<void> {
    if (this.sending || (modify && !target)) return;
    if (!modify && !this.session.harnesses.length) {
      this.showNotice('No agents are enabled on this server.');
      return;
    }
    const parent = modify ? this.session.store.agents.get(target!.parentId ?? '') : this.createParent(target);
    const request = ++this.editorRequest, view = this.view, previous = this.editor;
    let defaults;
    let containerCatalog: { revision: number; profiles: ContainerProfile[] } | undefined;
    // Modern child drafts inherit from their parent; selecting Default would pin
    // the server defaults instead. Legacy servers retain their grant-only drafts.
    if (!modify && (!parent || !this.session.podmanProfilesEnabled)) {
      try {
        if (this.session.podmanProfilesEnabled) containerCatalog = await this.session.listProfiles();
        else if (this.session.podmanDefaultsEnabled) defaults = await this.session.containerGrantDefaults();
      } catch (error) { if (!this.closing && request === this.editorRequest && this.view === view) this.showNotice((error as Error).message); return; }
      if (this.closing || this.sending || request !== this.editorRequest || this.view !== view || this.editor !== previous) return;
    }
    this.pathBase = String(parent?.settings.cwd ?? this.session.serverCwd);
    let agentProfiles;
    if (!modify && !parent && this.session.agentProfilesEnabled) {
      try { agentProfiles = await this.session.listAgentProfiles(this.session.harnesses[0]); }
      catch (error) { if (!this.closing && request === this.editorRequest && this.view === view) this.showNotice((error as Error).message); return; }
      if (this.closing || this.sending || request !== this.editorRequest || this.view !== view || this.editor !== previous) return;
    }
    this.editor = new AgentEditor(modify ? target!.parentId : parent?.id ?? null, modify ? target : undefined, this.session.podmanEnabled, this.session.settingsFields, this.session.podmanVolumesEnabled, this.session.podmanProfilesEnabled, this.session.agentProfilesEnabled,
      this.session.skillsEnabled ? { skills: { namespace: this.session.skillsNamespace, catalog: this.session.skillCatalog } } : undefined);
    if (!modify) {
      this.editor.values.harness = parent?.settings.harness ?? this.session.harnesses[0]!;
      this.editor.values.model = parent?.settings.model ?? '';
      this.editor.values.provider = String(parent?.settings.provider ?? '');
      if (parent && this.session.agentProfilesEnabled && parent.settings.harness === 'pi') this.editor.inheritAgent(parent);
      else if (agentProfiles?.[0]) this.editor.selectAgentProfile(agentProfiles[0]);
      this.editor.values.cwd = this.pathBase ? `${this.pathBase.replace(/\/$/, '')}/` : '';
      if (defaults) for (const key of PODMAN_FIELDS) this.editor.values[key] = JSON.stringify(defaults[key]);
      const defaultProfile = containerCatalog?.profiles.find(profile => profile.id === 'default');
      if (defaultProfile && containerCatalog) this.editor.selectProfile(defaultProfile, containerCatalog.revision);
    }
    this.setView('agent-edit');
  }
  private async openAgentOptions(): Promise<void> {
    const AGENT_FIELDS = this.editor?.fields ?? [];
    const editor = this.editor;
    const field = AGENT_FIELDS[this.menuIndex];
    if (!editor || this.sending || !['harness', 'provider', 'model'].includes(field ?? '')) return;
    this.optionField = field as typeof this.optionField;
    if (field !== 'harness' && !this.session.modelDiscovery.includes(editor.values.harness)) { this.openField(); return; }
    if (field === 'model' && !editor.values.provider.trim()) { this.showNotice('Select a provider before choosing a model.'); return; }
    const request = ++this.choicesRequest;
    const values = { ...editor.values };
    if (field !== 'harness') this.showNotice(`Loading available ${field === 'provider' ? 'providers' : 'models'}…`);
    try {
      const choices = field === 'harness' ? this.session.harnesses.map(value => ({ value, label: value })) :
        await this.session.agentChoices(field as 'provider' | 'model', values);
      if (this.closing || this.sending || request !== this.choicesRequest || this.editor !== editor || this.view !== 'agent-edit' || AGENT_FIELDS[this.menuIndex] !== field || JSON.stringify(editor.values) !== JSON.stringify(values)) return;
      this.optionField = field as typeof this.optionField;
      this.agentOptions = choices;
      this.setView('harness-options');
      this.menuIndex = Math.max(0, choices.findIndex(choice => choice.value === editor.values[this.optionField]));
      this.showNotice(choices.length ? '' : `No available ${field}s; enter a value manually or go back.`);
      this.draw();
    } catch (error) { if (!this.closing && request === this.choicesRequest && this.editor === editor && this.view === 'agent-edit') this.showNotice((error as Error).message); }
  }
  private openField(): void {
    const AGENT_FIELDS = this.editor?.fields ?? [];
    if (this.sending || !this.editor) return;
    this.editField = AGENT_FIELDS[this.menuIndex];
    if (!this.editField) return;
    if (this.editField === 'skills') { this.openAgentSkills(); return; }
    const value = this.editor.values[this.editField];
    if (collection(this.editor.spec(this.editField).editor)) {
      try {
        this.structuredServer = false;
        this.structured = new StructuredEditor(this.editor.spec(this.editField), value);
        this.structuredField = this.editField;
        this.structuredIndex = this.menuIndex;
        this.setView('structured');
      } catch (error) { this.showNotice(`${this.editField}: ${(error as Error).message}`); }
      return;
    }
    this.input.setValue((this.editField === 'cwd' || this.editor.spec(this.editField).editor === 'directory') && this.session.pathCompletion && value && !value.endsWith('/') ? `${value}/` : value);
    this.setView('agent-field');
    if (this.isPathInput()) this.refreshPaths();
  }
  private returnAgentField(): void {
    this.setView(this.structuredServer ? 'server-group' : 'agent-edit'); this.menuIndex = this.structuredIndex; this.draw();
  }
  private returnStructured(): void {
    const index = this.view === 'structured-filter' ? this.menuIndex : this.entryIndex;
    this.setView('structured'); this.menuIndex = index; this.draw();
  }
  private stageStructured(): void {
    if (!this.structured) return;
    try {
      if (this.structuredServer && this.serverEditor && this.serverField) this.serverEditor.stage(this.serverField, this.structured.serialize());
      else if (this.editor && this.structuredField) this.editor.stage(this.structuredField, this.structured.serialize());
      else return;
      this.returnAgentField();
    } catch (error) { this.showNotice((error as Error).message); }
  }
  private openEntry(add: boolean): void {
    if (!this.structured) return;
    const selected = add ? undefined : this.structured.entries()[this.menuIndex];
    if (!add && !selected) return;
    this.entryIndex = this.menuIndex;
    if (this.structuredServer && this.serverField?.choicesEndpoint) {
      const structured = this.structured, field = this.serverField;
      const back = () => { this.setView('structured'); this.menuIndex = this.entryIndex; this.draw(); };
      void this.openChoices(field.label, () => this.session.settingsChoices(field.choicesEndpoint!), { back,
        choose: value => { structured.put(selected?.id, selected?.key ?? '', value); back(); } }); return;
    }
    this.entry = { id: selected?.id, key: selected?.key ?? '', text: selected ? valueText(selected.value) : '', type: selected ? valueType(selected.value) : 'string' };
    const pathEntry = ['directories', 'paths'].includes(this.structured.spec.editor);
    const text = pathEntry ? this.entry.text || this.pathBase : this.entry.text;
    this.input.setValue(this.structured.isMap ? this.entry.key : pathEntry && this.structured.spec.editor === 'directories' && text && !text.endsWith('/') ? `${text}/` : text);
    this.setView(this.structured.isMap ? 'entry-key' : this.structured.spec.genericList ? 'entry-type' : 'entry-value');
    if (this.isPathInput()) this.refreshPaths();
    if (this.isVolumeInput()) this.refreshVolumes();
  }
  private selectEntryType(type: ValueType): void {
    this.entry.type = type;
    this.input.setValue(this.entry.text || (type === 'boolean' ? 'false' : type === 'null' ? 'null' : ''));
    this.setView('entry-value');
  }
  private isPathInput(): boolean {
    return this.session.pathCompletion && ((this.view === 'local-skill-path' && this.session.skillRepositorySourceKinds.includes('server-path')) ||
      (this.view === 'agent-field' && (this.editField === 'cwd' || ['directory', 'path'].includes(this.editor?.spec(this.editField!).editor ?? ''))) ||
      (this.view === 'entry-value' && ['directories', 'paths'].includes(this.structured?.spec.editor ?? '')));
  }
  private isVolumeField(): boolean { return !this.structuredServer && ['readOnlyVolumes', 'readWriteVolumes'].includes(this.structuredField ?? ''); }
  private isVolumeInput(): boolean { return this.view === 'entry-value' && this.isVolumeField(); }
  private refreshVolumes(): void {
    const request = ++this.pathRequest;
    if (this.pathTimer) clearTimeout(this.pathTimer);
    this.pathCandidates = []; this.pathIndex = 0;
    this.volumeChoices = [];
    this.paths.setItems(['Loading host volumes…']); this.screen.render();
    const query = this.input.getValue(), editor = this.structured;
    this.pathTimer = setTimeout(async () => {
      this.pathTimer = undefined;
      if (!this.isVolumeInput() || request !== this.pathRequest) return;
      try {
        const choices = filterVolumes(await this.session.listVolumes(), query, this.structuredField === 'readWriteVolumes');
        if (this.closing || !this.isVolumeInput() || request !== this.pathRequest || this.structured !== editor) return;
        this.volumeChoices = choices;
        this.pathCandidates = choices.map(choice => ({ name: choice.name, path: choice.name, kind: 'file' }));
        this.paths.setItems(choices.length ? choices.map(choice => clip(`${choice.name} → ${choice.destination ?? '(choose container destination)'}${choice.description ? ` · ${choice.description}` : ''}`, Number(this.screen.width) - 1)) : ['No matching host volumes']);
        this.paths.select(0); this.screen.render();
      } catch (error) {
        if (!this.closing && this.isVolumeInput() && request === this.pathRequest) {
          this.paths.setItems([clip((error as Error).message, Number(this.screen.width) - 1)]); this.screen.render();
        }
      }
    }, 75);
  }
  private pathKind(): 'directory' | 'any' {
    return this.view === 'local-skill-path' ? 'any' : (this.view === 'entry-value' && this.structured?.spec.editor === 'paths') || (this.view === 'agent-field' && this.editField && this.editor?.spec(this.editField).editor === 'path') ? 'any' : 'directory';
  }
  private refreshPaths(): void {
    const request = ++this.pathRequest;
    if (this.pathTimer) clearTimeout(this.pathTimer);
    this.pathCandidates = []; this.pathIndex = 0;
    this.notice.setContent('');
    const input = this.input.getValue(), editor = this.editor;
    if (this.view === 'local-skill-path' && (!pathCompletionAllowed(input) || !this.session.skillRepositorySourceKinds.includes('server-path'))) {
      this.paths.setItems([!pathCompletionAllowed(input) ? 'HTTPS/URL sources are not path-completed.' : 'Server paths are unsupported by this Skills plugin.']);
      this.screen.render(); return;
    }
    this.paths.setItems(['Loading directories…']);
    this.screen.render();
    this.pathTimer = setTimeout(async () => {
      this.pathTimer = undefined;
      if (!this.isPathInput() || request !== this.pathRequest) return;
      try {
        const result = await this.session.completePath(input, this.view === 'local-skill-path' ? this.session.serverCwd : this.pathBase, this.pathKind());
        if (this.closing || !this.isPathInput() || request !== this.pathRequest || this.editor !== editor) return;
        this.pathCandidates = result.entries;
        this.paths.setItems(result.entries.length ? result.entries.map(entry => clip(`${entry.name}${entry.kind === 'directory' ? '/' : ''}`, Number(this.screen.width) - 1)) : ['No matching directories']);
        this.paths.select(0); this.screen.render();
      } catch (error) {
        if (!this.closing && this.isPathInput() && request === this.pathRequest) {
          this.paths.setItems([clip((error as Error).message, Number(this.screen.width) - 1)]); this.screen.render();
        }
      }
    }, 75);
  }
  private async saveAgent(imageScope?: ImageScope): Promise<void> {
    const editor = this.editor;
    if (this.sending || !editor) return;
    const staleSkills = editor.staleSkills(this.session.skillCatalog);
    if (staleSkills.length) { this.showNotice(`Staged skills are stale (${staleSkills.join(', ')}); reopen Skills and explicitly remove or reselect them.`); return; }
    let params: Record<string, unknown>;
    try { params = editor.params(); } catch (error) { this.showNotice((error as Error).message); return; }
    if (editor.agentId && editor.imageChanged && this.session.podmanEnabled && !imageScope) { this.setView('image-scope'); return; }
    this.sending = true;
    this.draw();
    this.showNotice('Applying agent changes · launch settings may interrupt active work…');
    try {
      if (editor.agentId && imageScope) await this.session.modifyPodman(params, imageScope);
      else {
        const operation = await this.session.mutate(editor.agentId ? 'agent.modify' : 'agent.create', params);
        if (!editor.agentId && operation.agentId) this.selectedAgent = operation.agentId;
      }
      if (['agent-edit', 'image-scope'].includes(this.view) && this.editor === editor) this.setView('tree');
    } catch (error) { this.showNotice((error as Error).message); }
    finally { this.sending = false; this.draw(); }
  }
  private async runAction(): Promise<void> {
    const action = this.pendingAction;
    if (this.sending || !action) return;
    this.sending = true;
    this.draw();
    this.showNotice(`${action.method} in progress…`);
    try {
      await this.session.mutate(action.method, { agentId: action.agentId });
      if (this.view === 'confirm') this.setView('tree');
    } catch (error) { this.showNotice((error as Error).message); }
    finally { this.sending = false; this.draw(); }
  }
  private skillChoicesFor(editor: AgentEditor, states: SkillStates) {
    const choices = editor.skillChoices(this.session.skillCatalog, states);
    for (const choice of choices) if (choice.retainedUnknown) {
      const retained = this.session.retainedSkills.find(item => item.name === choice.name);
      if (retained) choice.description = `Retained selection · ${retained.status ?? 'repository removed'}${retained.error ? ` · ${retained.error}` : ''}`;
    }
    return choices;
  }
  private openAgentSkills(): void {
    const editor = this.editor;
    if (!editor || this.sending) return;
    this.skillPicker = { editor, states: editor.skillStates(), choices: this.skillChoicesFor(editor, editor.skillStates()), returnIndex: this.menuIndex, filter: '' };
    this.menuIndex = 0; this.setView('agent-skills');
    const state = this.session.skillReconciliation?.state;
    this.showNotice(state === 'pending' || state === 'running' ? 'Repository preparation is in progress; only ready catalog entries can be selected.' : state === 'error' ? 'Some repositories failed; retry from server settings (v) without resaving.' : this.hasCatalogSkills() ? 'Installed loads the skill for this agent; available permits delegation to a direct child without installing it here.' : 'No catalog skills yet. Open server settings (v) to configure repositories; prepared skills appear automatically.');
    this.draw();
  }
  private hasCatalogSkills(): boolean { return this.skillPicker?.choices.some(choice => !choice.retainedUnknown) ?? false; }
  private pickerChoices(): SkillChoice[] {
    const picker = this.skillPicker;
    if (!picker) return [];
    const query = picker.filter.trim().toLowerCase();
    return picker.choices.filter(choice => !query || `${choice.name} ${choice.description}`.toLowerCase().includes(query));
  }
  private selectedMenuIndex(): number { return Math.max(0, Number((this.menu as any).selected ?? this.menuIndex)); }
  private pickerState(name: string): SkillState {
    const states = this.skillPicker?.states ?? {};
    return Object.hasOwn(states, name) ? states[name]! : 'unavailable';
  }
  private setPickerSkill(state: 'available' | 'installed'): void {
    const choice = this.pickerChoices()[this.selectedMenuIndex()], picker = this.skillPicker;
    if (!choice || !picker || this.sending) return;
    if (choice.stale || (choice.retainedUnknown && !(this.pickerState(choice.name) === 'installed' && state === 'available') && this.pickerState(choice.name) !== state)) {
      this.showNotice(`${choice.name} is not currently grantable; remove the stale selection or wait for it to become ready.`); return;
    }
    picker.states = { ...picker.states, [choice.name]: state };
    this.draw();
  }
  private removePickerSkill(): void {
    const choice = this.pickerChoices()[this.selectedMenuIndex()], picker = this.skillPicker;
    if (!choice || !picker || this.sending) return;
    const states = { ...picker.states }; delete states[choice.name]; picker.states = states;
    this.menuIndex = Math.max(0, Math.min(this.menuIndex, this.pickerChoices().length - 1)); this.draw();
  }
  private cycleSkill(): void {
    const choice = this.pickerChoices()[this.selectedMenuIndex()];
    if (!choice) return;
    const state = this.pickerState(choice.name);
    if (state === 'unavailable') this.setPickerSkill('available');
    else if (state === 'available') this.setPickerSkill('installed');
    else this.removePickerSkill();
  }
  private openLocalSkillPath(): void {
    if (this.recordEditing || this.serverEditor?.group.namespace !== 'skills') return;
    if (!this.session.skillRepositoryRegistrationAvailable) { this.showNotice('Unified skill repository registration requires a compatible Skills plugin; no legacy API fallback is used.'); return; }
    this.localSkillReturnIndex = this.menuIndex;
    this.localSkillPath = '';
    this.input.setValue('');
    this.setView('local-skill-path');
    this.showNotice(`One source locator: supported HTTPS Git URL or server-side directory/root SKILL.md path. Required name and description are read from root SKILL.md. Paths use server cwd ${this.session.serverCwd || '(unknown)'} and server home; no shell expansion.`);
  }
  private returnLocalSkill(): void {
    if (this.closing) return;
    this.setView('server-group');
    this.menuIndex = this.localSkillReturnIndex;
    this.draw();
  }
  private async refreshSkillsCatalog(): Promise<void> {
    const editor = this.serverEditor, navigation = this.navigationGeneration, request = ++this.skillsCatalogUiRequest;
    const ownsContext = () => !this.closing && request === this.skillsCatalogUiRequest && navigation === this.navigationGeneration && this.view === 'server-group' && this.serverEditor === editor;
    try {
      await this.session.refreshSkills(true);
      if (ownsContext()) {
        this.unrefreshedRegistration = undefined;
        this.showNotice('Skills catalog refreshed; settings draft was not changed.');
      }
    } catch (error) {
      if (ownsContext()) this.showNotice(`Skills catalog refresh failed: ${(error as Error).message}`);
    }
    if (ownsContext()) this.draw();
  }
  private async registerLocalSkill(): Promise<void> {
    if (this.localSkillSubmitting || this.sending) return;
    if (this.recordEditing || this.serverEditor?.group.namespace !== 'skills' || !this.session.skillRepositoryRegistrationAvailable) {
      this.showNotice('Unified skill repository registration is unavailable; refresh capabilities or upgrade the server plugin.'); return;
    }
    const source = this.localSkillPath;
    if (!source) return;
    const editor = this.serverEditor, navigation = this.navigationGeneration;
    const ownsContext = () => !this.closing && this.view === 'local-skill-confirm' && this.serverEditor === editor && this.serverEditor?.group.namespace === 'skills' && !this.recordEditing && this.navigationGeneration === navigation;
    ++this.skillsCatalogUiRequest;
    this.localSkillSubmitting = true; this.sending = true; this.draw();
    try {
      const outcome = await this.session.registerSkillRepository(source);
      if (ownsContext()) {
        this.unrefreshedRegistration = outcome.refreshed ? undefined : outcome.record;
        this.returnLocalSkill();
        this.showNotice(outcome.refreshed
          ? `Registered ${outcome.record.name} in this organization's shared skill catalog. Source: ${outcome.record.source?.kind === 'git' ? outcome.record.source.gitUrl : outcome.record.source?.path}. Not assigned or installed.`
          : `Registered ${outcome.record.name}, but catalog refresh failed: ${outcome.refreshError}. Refresh catalog to verify; do not retry registration.`);
      }
    } catch (error) {
      if (ownsContext()) { this.returnLocalSkill(); this.showNotice((error as Error).message); }
    } finally { this.localSkillSubmitting = false; this.sending = false; this.draw(); }
  }
  private stageAgentSkills(): void {
    const picker = this.skillPicker;
    if (!picker || this.editor !== picker.editor) return;
    try {
      picker.editor.stageSkillStates(picker.states, this.session.skillCatalog);
      this.skillPicker = undefined;
      this.setView('agent-edit'); this.menuIndex = picker.returnIndex; this.showNotice('Skills staged in this agent draft; save the form to apply.'); this.draw();
    } catch (error) { this.showNotice((error as Error).message); }
  }
  private cancelAgentSkills(): void {
    const picker = this.skillPicker;
    this.skillPicker = undefined;
    this.setView('agent-edit'); if (picker) this.menuIndex = picker.returnIndex; this.draw();
  }
  private applySkillFilter(): void {
    if (!this.skillPicker) return;
    this.skillPicker.filter = this.input.getValue(); this.menuIndex = 0; this.setView('agent-skills'); this.draw();
  }
  private cancelSkillFilter(): void { this.setView('agent-skills'); this.draw(); }
  private rawEvents(): ServerEvent[] { return this.rawSnapshot; }
  private openRawEvents(): void {
    const agent = this.selected();
    if (!agent) return;
    // Capture only currently visible loaded records; hidden events cannot be revealed here.
    this.rawSnapshot = this.session.chatEvents(agent.id)
      .filter(event => this.settings.visible(event.type, this.session.store.renderings.get(event.seq)?.subtype))
      .map(event => JSON.parse(JSON.stringify(event)) as ServerEvent);
    this.rawIndex = this.rawSnapshot.length ? 0 : -1; this.rawListScroll = 0; this.rawScroll = 0;
    this.setView('raw-events');
  }
  private moveRaw(delta: number): void {
    const count = this.rawEvents().length;
    if (!count) { this.rawIndex = -1; return; }
    this.rawIndex = Math.max(0, Math.min(count - 1, this.rawIndex + delta)); this.rawListScroll = this.rawIndex; this.draw();
  }
  private openRawJson(): void {
    const event = this.rawIndex < 0 ? undefined : this.rawEvents()[this.rawIndex];
    if (!event) return;
    this.selectedRawEvent = event;
    this.rawListScroll = visibleChatOrigin(this.rawView);
    this.rawScroll = 0; this.setView('raw-event-json');
  }
  private scrollRawJson(delta: number): void {
    const max = Math.max(0, this.rawView.getScrollHeight() - Number(this.rawView.height) + 2);
    this.rawScroll = Math.max(0, Math.min(max, this.rawScroll + delta)); this.rawView.scrollTo(this.rawScroll); this.screen.render();
  }
  private openChat(): void {
    if (this.sending) return;
    const agent = this.selected();
    if (!agent) return;
    // Save the outgoing context before changing the recipient. Usually this is
    // a tree->chat transition, but keeping this boundary explicit prevents a
    // future direct chat switch from attributing stale text to the new agent.
    this.saveComposeDraft();
    if (this.view === 'chat' || this.view === 'prompt') this.setView('tree');
    this.chatAgent = agent.id; this.follow = true; this.chatAnchorLost = false; this.chatLayout = []; this.chatScrollGeneration++; this.lastChat = ''; this.renderedEvents.clear();
    this.clearMentionCompletion();
    // Set the new buffer before focus/readInput and redraw: Blessed's textarea
    // can retain the previous widget value across hide/show transitions.
    const draft = this.chatDrafts.get(agent.id) ?? '';
    this.composer.setValue(draft);
    this.setView('chat');
    this.updateMentionCompletion();
    void this.session.openChat(agent.id).catch(error => this.showNotice(`Chat history: ${error.message}`));
  }
  private loadOlderChat(): void {
    const id = this.chatAgent;
    if (this.view !== 'chat' || !id || visibleChatOrigin(this.chat) > 0 || this.session.chatLoading(id) || !this.session.chatHasMore(id)) return;
    const anchor = this.captureChatAnchor();
    const scrollGeneration = this.chatScrollGeneration;
    void this.session.olderChat(id).then(() => {
      if (this.view !== 'chat' || this.chatAgent !== id || this.follow || scrollGeneration !== this.chatScrollGeneration) return;
      this.draw();
      this.adjustingChatViewport = true;
      this.chat.setScroll(this.restoreChatAnchor(anchor, this.chatLayout));
      this.adjustingChatViewport = false;
      if (this.chatAgent) this.session.pauseChat(this.chatAgent, this.captureChatAnchor()?.seq);
      this.screen.render();
    }).catch(error => this.showNotice(error.message));
  }
  private openPrompt(): void {
    const agent = this.selected();
    if (this.sending || !agent) return;
    this.promptAgent = agent.id;
    this.clearMentionCompletion();
    this.composer.setValue(this.promptDraft);
    this.setView('prompt');
  }
  private currentMentionRecipient(): string | undefined { return this.view === 'chat' ? this.chatAgent : this.view === 'prompt' ? this.promptAgent : undefined; }
  private clearMentionCompletion(): void {
    this.mentionOpen = false; this.mentionResults = []; this.mentionIndex = 0; this.dismissedMention = undefined;
    this.composeRequest++; if (this.composeTimer) clearTimeout(this.composeTimer); this.composeTimer = undefined;
    this.composeSpan = undefined; this.composeCandidates = []; this.composeResultDraft = undefined; this.composeResultContext = undefined; this.composeStatus = undefined; this.composeDismissed = undefined; this.composeAcceptedFile = undefined; this.composeLookupKey = undefined;
    this.mentionPanel.hide();
  }
  private cancelMentionCompletion(): void {
    this.mentionOpen = false; this.mentionResults = []; this.mentionIndex = 0; this.dismissedMention = undefined;
    this.mentionPanel.hide();
  }
  private effectiveComposeSpan(value: string): ComposeSpan | undefined {
    const accepted = this.composeAcceptedFile;
    let span: ComposeSpan | undefined;
    if (accepted && accepted.recipient === this.currentMentionRecipient() && value.slice(accepted.start, accepted.start + accepted.insertion.length) === accepted.insertion) {
      const tailStart = accepted.start + accepted.insertion.length;
      const tail = composeSpan(value.slice(tailStart));
      span = tail ? { ...tail, start: tail.start + tailStart } : undefined;
    } else {
      if (accepted) this.composeAcceptedFile = undefined;
      span = composeSpan(value, this.composeSpan);
    }
    if (!this.session.pathCompletion && span?.kind === 'path') {
      const query = mentionQuery(value);
      return query ? { kind: 'mention', start: value.length - query.length, query } : undefined;
    }
    return span;
  }
  private currentMentionResults(query: string): MentionChoice[] {
    const recipient = this.currentMentionRecipient();
    if (!recipient) return [];
    const choices = mentionChoices(this.session.store.agents.values(), recipient);
    const fuzzyQuery = query.slice(1).split('/').at(-1) ?? '';
    return matchMentionChoices(choices, fuzzyQuery);
  }
  private refreshMentionCompletion(): boolean {
    if (this.composeSpan?.kind === 'path') {
      const wasOpen = this.mentionOpen;
      this.mentionOpen = false; this.mentionResults = []; this.mentionIndex = 0;
      this.mentionPanel.hide();
      return wasOpen;
    }
    const wasOpen = this.mentionOpen;
    const recipient = this.currentMentionRecipient();
    const query = mentionQuery(this.composer.getValue());
    if (!recipient || !query) {
      this.dismissedMention = undefined;
      if (!this.mentionOpen) return false;
      this.mentionOpen = false; this.mentionResults = []; this.mentionIndex = 0;
      this.mentionPanel.hide();
      return true;
    }
    if (this.dismissedMention === query) return false;
    if (this.dismissedMention) this.dismissedMention = undefined;
    this.mentionResults = this.currentMentionResults(query);
    this.mentionOpen = this.mentionResults.length > 0;
    if (this.mentionOpen) this.composeShift = true;
    this.mentionIndex = Math.min(this.mentionIndex, Math.max(0, this.mentionResults.length - 1));
    if (this.mentionOpen) this.mentionPanel.show(); else this.mentionPanel.hide();
    return mentionRedrawRequired(wasOpen, this.mentionOpen);
  }
  private updateMentionCompletion(): void {
    if (!this.refreshMentionCompletion()) return;
    this.resizeComposer(); this.draw();
  }
  private acceptMention(): void {
    const value = this.composer.getValue();
    const query = mentionQuery(value);
    const freshResults = query ? this.currentMentionResults(query) : [];
    this.mentionIndex = Math.min(this.mentionIndex, Math.max(0, freshResults.length - 1));
    const choice = freshResults[this.mentionIndex];
    const replaced = query && choice ? replaceMentionQuery(value, query, choice.token) : undefined;
    if (!choice || replaced === undefined) { this.clearMentionCompletion(); this.draw(); return; }
    this.composer.setValue(replaced);
    const identity = this.composeIdentity();
    this.saveComposeDraft(replaced);
    this.dismissedMention = choice.token;
    this.mentionOpen = false; this.mentionResults = []; this.mentionPanel.hide(); this.draw();
  }
  private checkComposeContext(): void {
    if (this.view !== 'chat' && this.view !== 'prompt') return;
    const recipient = this.currentMentionRecipient(), cwd = recipient ? this.session.store.agents.get(recipient)?.settings.cwd : undefined;
    const stamp = JSON.stringify([recipient, typeof cwd === 'string' ? cwd : null, this.session.pathCompletion, this.session.status.startsWith('connected')]);
    if (stamp === this.composeContextStamp) return;
    this.composeContextStamp = stamp;
    this.composeAcceptedFile = undefined; this.composeDismissed = undefined; this.composeLookupKey = undefined;
    if (this.composeSpan || this.composeStatus || this.composeCandidates.length) {
      this.composeRequest++; if (this.composeTimer) clearTimeout(this.composeTimer); this.composeTimer = undefined;
      this.composeSpan = undefined; this.composeCandidates = []; this.composeResultDraft = undefined; this.composeResultContext = undefined; this.composeStatus = undefined;
      if (this.session.pathCompletion && this.session.status.startsWith('connected')) this.refreshComposeCompletion();
    }
  }
  private dismissComposeCompletion(): void {
    if (this.mentionOpen) this.dismissedMention = mentionQuery(this.composer.getValue());
    if (this.composeSpan || this.composeStatus) this.composeDismissed = this.composeKey(this.composeSpan ?? composeSpan(this.composer.getValue()));
    this.composeRequest++; if (this.composeTimer) clearTimeout(this.composeTimer); this.composeTimer = undefined;
    this.composeSpan = undefined; this.composeCandidates = []; this.composeResultDraft = undefined; this.composeResultContext = undefined; this.composeStatus = undefined; this.composeLookupKey = undefined;
    this.mentionOpen = false; this.mentionResults = []; this.mentionPanel.hide();
    this.draw();
  }
  private composeKey(span?: ComposeSpan): string | undefined {
    const recipient = this.currentMentionRecipient();
    return recipient && span ? `${recipient}:${span.kind}:${span.start}:${span.query}` : undefined;
  }
  private refreshComposeCompletion(): void {
    if (this.view !== 'chat' && this.view !== 'prompt') return;
    const value = this.composer.getValue();
    const recipient = this.currentMentionRecipient();
    const next = this.effectiveComposeSpan(value);
    if (next?.kind === 'path' && this.mentionOpen) {
      this.mentionOpen = false; this.mentionResults = []; this.mentionPanel.hide();
    }
    if (next?.kind !== 'path' || !recipient) {
      const wasPath = !!this.composeSpan || !!this.composeStatus;
      this.composeRequest++; if (this.composeTimer) clearTimeout(this.composeTimer); this.composeTimer = undefined;
      this.composeSpan = undefined; this.composeCandidates = []; this.composeResultDraft = undefined; this.composeResultContext = undefined; this.composeStatus = undefined;
      this.composeRecipient = recipient; this.composeLookupKey = undefined;
      if (wasPath) this.mentionPanel.hide();
      return;
    }
    if (!this.session.pathCompletion) {
      this.composeRequest++; this.composeSpan = undefined; this.composeCandidates = []; this.composeResultDraft = undefined; this.composeResultContext = undefined; this.composeStatus = undefined; this.composeLookupKey = undefined;
      return;
    }
    const key = this.composeKey(next);
    if (this.composeDismissed && this.composeDismissed !== key) this.composeDismissed = undefined;
    this.composeSpan = next; this.composeRecipient = recipient;
    if (this.composeDismissed === key) {
      this.composeRequest++; if (this.composeTimer) clearTimeout(this.composeTimer); this.composeTimer = undefined;
      this.composeSpan = undefined; this.composeCandidates = []; this.composeResultDraft = undefined; this.composeResultContext = undefined; this.composeStatus = undefined; this.composeLookupKey = undefined; this.mentionPanel.hide(); return;
    }
    const agent = this.session.store.agents.get(recipient);
    const cwd = agent?.settings.cwd;
    if (typeof cwd !== 'string' || !cwd.length) {
      this.composeSpan = next; this.composeCandidates = []; this.composeStatus = 'Recipient cwd unavailable';
      this.composeRequest++; this.draw(); return;
    }
    const sourceId = this.composePathSource.id;
    const lookupKey = JSON.stringify([recipient, cwd, sourceId, value, next.query]);
    if (lookupKey === this.composeLookupKey) return;
    this.composeLookupKey = lookupKey;
    const request = ++this.composeRequest, draft = value;
    this.composeCandidates = []; this.composeResultDraft = undefined; this.composeResultContext = undefined; this.composeSelection = 0; this.composeStatus = 'Loading paths…';
    if (this.composeTimer) clearTimeout(this.composeTimer);
    this.composeTimer = setTimeout(() => {
      this.composeTimer = undefined;
      this.composeQueued = { request, draft, recipient, cwd, sourceId, span: next };
      this.drainComposeLookup();
    }, 75);
  }
  private drainComposeLookup(): void {
    if (this.composeInFlight || !this.composeQueued) return;
    const lookup = this.composeQueued; this.composeQueued = undefined;
    const current = () => !this.closing && lookup.request === this.composeRequest && this.composer.getValue() === lookup.draft &&
      this.currentMentionRecipient() === lookup.recipient && this.session.pathCompletion && this.composePathSource.id === lookup.sourceId &&
      this.session.store.agents.get(lookup.recipient)?.settings.cwd === lookup.cwd && this.session.status.startsWith('connected');
    if (!current()) return;
    this.composeInFlight = true;
    void this.composePathSource.complete({ recipientId: lookup.recipient, cwd: lookup.cwd, sourceId: lookup.sourceId }, lookup.span.query).then(entries => {
      if (!current()) return;
      // organization.paths already filters/ranks before its bounded limit;
      // preserve that server order rather than reranking a truncated subset.
      this.composeCandidates = entries; this.composeResultDraft = lookup.draft; this.composeResultContext = { recipient: lookup.recipient, cwd: lookup.cwd, sourceId: lookup.sourceId }; this.composeStatus = this.composeCandidates.length ? undefined : 'No matching paths';
      this.composeShift = true; this.draw();
    }).catch(error => {
      if (!current()) return;
      this.composeCandidates = []; this.composeStatus = (error as Error).message; this.composeShift = true; this.draw();
    }).finally(() => {
      this.composeInFlight = false;
      this.drainComposeLookup();
    });
  }
  private acceptComposePath(): void {
    const span = this.composeSpan, item = this.composeCandidates[this.composeSelection];
    if (!span || !item || !this.session.pathCompletion || this.currentMentionRecipient() !== this.composeRecipient) return;
    const value = this.composer.getValue(), recipient = this.composeRecipient, context = this.composeResultContext;
    if (!recipient || !context || value !== this.composeResultDraft || context.recipient !== recipient || context.sourceId !== this.composePathSource.id || this.session.store.agents.get(recipient)?.settings.cwd !== context.cwd) {
      this.composeCandidates = []; this.composeResultDraft = undefined; this.composeResultContext = undefined; this.composeStatus = 'Loading paths…';
      this.refreshComposeCompletion(); return;
    }
    const basename = item.name;
    const slash = span.query.lastIndexOf('/');
    const typedPrefix = span.query === './~' ? './~/' : slash >= 0 ? span.query.slice(0, slash + 1) : '';
    const insertion = typedPrefix + basename + (item.kind === 'directory' ? '/' : ' ');
    const nextValue = replaceComposeSpan(value, span, insertion);
    if (nextValue === undefined) { this.refreshComposeCompletion(); return; }
    this.composeRequest++; if (this.composeTimer) clearTimeout(this.composeTimer); this.composeTimer = undefined;
    this.composer.setValue(nextValue); this.composeCandidates = []; this.composeResultDraft = undefined; this.composeResultContext = undefined; this.composeStatus = undefined;
    if (item.kind === 'directory') { this.composeSpan = { kind: 'path', start: span.start, query: nextValue.slice(span.start) }; this.composeDismissed = undefined; this.refreshComposeCompletion(); }
    else { this.composeSpan = undefined; this.composeAcceptedFile = { recipient: this.composeRecipient!, start: span.start, insertion }; this.composeDismissed = this.composeKey(span); this.mentionPanel.hide(); }
    this.resizeComposer(); this.draw();
  }
  private resizeComposer(): void {
    if (this.view !== 'prompt' && this.view !== 'chat') return;
    const previous = Number(this.composer.height);
    const previousChatHeight = Number(this.chat.height);
    const previousTreeHeight = Number(this.tree.height);
    const anchor = this.view === 'chat' && !this.follow ? this.captureChatAnchor() : undefined;
    const rows = this.composer.reflow(Math.max(1, Number(this.screen.height) - (this.composeShift ? 11 : 7)));
    this.promptTop.bottom = rows + 3;
    this.mentionPanel.bottom = rows + 4;
    this.tree.bottom = rows + (this.composeShift ? 8 : 4);
    this.chat.bottom = rows + (this.composeShift ? 8 : 4);
    const chatGeometryChanged = this.view === 'chat' && Number(this.chat.height) !== previousChatHeight;
    const treeGeometryChanged = this.view === 'prompt' && Number(this.tree.height) !== previousTreeHeight;
    if (rows !== previous || chatGeometryChanged || treeGeometryChanged) {
      if (this.view === 'prompt') this.tree.scrollTo(Math.max(0, this.rows.findIndex(row => row.agent.id === this.selectedAgent)));
      else if (this.follow) {
        this.adjustingChatViewport = true;
        try { this.chat.setScrollPerc(100); }
        finally { this.adjustingChatViewport = false; }
      }
      else if (anchor) {
        this.adjustingChatViewport = true;
        this.chat.setScroll(this.restoreChatAnchor(anchor, this.chatLayout));
        this.adjustingChatViewport = false;
      }
    }
  }
  private composeIdentity(): ComposeIdentity | undefined {
    if (this.view === 'chat' && this.chatAgent) return { kind: 'chat', id: this.chatAgent };
    if (this.view === 'prompt' && this.promptAgent) return { kind: 'prompt', agentId: this.promptAgent };
    return undefined;
  }
  private composeDraftRevision(identity: ComposeIdentity): number {
    return identity.kind === 'chat' ? this.chatDraftRevisions.get(identity.id) ?? 0 : this.promptDraftRevision;
  }
  private saveComposeDraft(value = this.composer.getValue()): void {
    const identity = this.composeIdentity();
    const pending = this.pendingModifiedSubmission;
    if (identity && pending && sameComposeIdentity(identity, pending.identity) && !value &&
        this.composeDraftRevision(identity) === pending.revision &&
        (identity.kind === 'chat' ? this.chatDrafts.get(identity.id) : this.promptDraft) === pending.text) return;
    if (identity?.kind === 'chat') {
      if (this.chatDrafts.get(identity.id) !== value) {
        this.chatDrafts.set(identity.id, value);
        this.chatDraftRevisions.set(identity.id, (this.chatDraftRevisions.get(identity.id) ?? 0) + 1);
      }
    } else if (identity?.kind === 'prompt' && this.promptDraft !== value) {
      this.promptDraft = value; this.promptDraftRevision++;
    }
  }
  private clearComposeDraft(): void {
    const identity = this.composeIdentity();
    if (identity?.kind === 'chat') {
      this.chatDrafts.set(identity.id, '');
      this.chatDraftRevisions.set(identity.id, (this.chatDraftRevisions.get(identity.id) ?? 0) + 1);
    } else if (identity?.kind === 'prompt') {
      this.promptDraft = ''; this.promptDraftRevision++;
    }
    this.composer.setValue('');
    this.clearMentionCompletion();
    this.composeShift = false;
    // Enter ends Blessed's current readInput cycle. A working send normally
    // blocks edits, but Ctrl-C explicitly starts a fresh local editing cycle.
    if (this.sending && (this.view === 'chat' || this.view === 'prompt')) this.composer.readInput();
    this.resizeComposer(); this.draw();
  }
  private setView(view: View): void {
    if (this.view === 'chat' || this.view === 'prompt') this.saveComposeDraft();
    ++this.navigationGeneration;
    ++this.editorRequest; // Navigation cancels any pending new-draft defaults load.
    if (this.view === 'chat' && view !== 'chat') {
      this.session.leaveChat();
      this.adjustingChatViewport = true;
      this.chat.setContent(''); this.lastChat = ''; this.chatLayout = []; this.renderedEvents.clear();
      this.adjustingChatViewport = false;
    }
    if ((this.view === 'chat' || this.view === 'prompt') && view !== 'chat' && view !== 'prompt') {
      this.composeShift = false; this.clearMentionCompletion();
    }
    this.view = view;
    this.menuIndex = 0;
    this.previewIndex = 0;
    ++this.pathRequest;
    if (this.pathTimer) { clearTimeout(this.pathTimer); this.pathTimer = undefined; }
    this.tree.hide(); this.menu.hide(); this.chat.hide(); this.rawView.hide(); this.details.hide(); this.editorInput.hide(); this.composer.hide(); this.promptTop.hide(); this.promptBottom.hide(); this.mentionPanel.hide(); this.columns.hide(); this.paths.hide(); this.form.hide(); this.preview.hide();
    this.menu.bottom = 2;
    const composer = view === 'chat' || view === 'prompt';
    // Blessed's typings omit removable borders and their runtime side flags.
    this.input.border = (composer ? undefined : { type: 'line', left: true, right: true, top: true, bottom: true }) as unknown as blessed.Widgets.Border;
    this.input.height = composer ? 1 : 3;
    this.input.bottom = composer ? 3 : this.isPathInput() || this.isVolumeInput() ? 7 : 2;
    this.promptTop.bottom = 4;
    this.tree.bottom = view === 'prompt' ? 5 : 2;
    if (this.isPathInput() || this.isVolumeInput()) { this.paths.show(); if (this.isPathInput()) this.refreshPaths(); }
    if (view === 'tree' || view === 'prompt') {
      this.tree.show(); this.columns.show();
      if (view === 'tree') this.tree.focus();
      else {
        // Reselecting the same row is a no-op in Blessed; explicitly reveal it
        // after reducing the viewport to make room for the composer.
        this.tree.scrollTo(Math.max(0, this.rows.findIndex(row => row.agent.id === this.selectedAgent)));
        this.input.show(); this.input.focus(); if (!this.sending) this.input.readInput();
      }
    } else if (view === 'raw-events' || view === 'raw-event-json') {
      this.rawView.show(); this.rawView.focus();
    } else if (view === 'agent-info' || view === 'skill-details') {
      this.details.show(); this.details.focus();
    } else if (['history-settings', 'settings-options', 'settings-records', 'server-settings', 'server-group', 'server-confirm', 'server-facts', 'structured', 'entry-type', 'keys', 'view', 'colors', 'table-fields', 'levels', 'agent-skills', 'local-skill-confirm', 'catalog-manager', 'catalog-delete-confirm', 'actions', 'agent-edit', 'harness-options', 'image-scope', 'confirm'].includes(view)) {
      this.menu.show(); this.menu.focus();
    } else {
      if (view === 'chat') this.chat.show();
      if (view === 'structured-filter') this.menu.show();
      if (['entry-key', 'entry-value'].includes(view)) this.form.show();
      this.input.show(); this.input.focus();
      if (!this.sending) this.input.readInput();
    }
    if (composer) { this.promptTop.show(); this.promptBottom.show(); if (this.mentionOpen) this.mentionPanel.show(); }
    this.draw();
  }
  private async submit(value: string, mode: ComposeSubmitMode = 'default'): Promise<void> {
    if (this.sending) {
      // Enter completes the current Blessed readInput cycle even though the
      // single-flight guard rejects this duplicate send. Re-arm composition.
      if (this.view === 'chat' || this.view === 'prompt') this.composer.readInput();
      return;
    }
    if (this.view === 'local-skill-path') { if (!value || value.length > 4096 || value.includes(String.fromCharCode(0))) { this.showNotice('Enter a nonempty source locator up to 4,096 characters.'); this.input.readInput(); return; } this.localSkillPath = value; this.setView('local-skill-confirm'); return; }
    if (this.view === 'history-field' && this.historyField) {
      try {
        this.settings.history = historySettings({ ...this.settings.history, [this.historyField]: Number(value) });
        this.session.configureHistory(this.settings.history);
        this.saveSettings(); this.setView('history-settings');
      } catch (error) { this.showNotice((error as Error).message); this.input.readInput(); }
      return;
    }
    if (this.view === 'agent-skills-filter') { this.skillPicker && (this.skillPicker.filter = value); this.menuIndex = 0; this.setView('agent-skills'); this.draw(); return; }
    if (this.view === 'settings-choice-setup' && this.pendingChoiceSetup?.setup) {
      const choice = this.pendingChoiceSetup, actions = this.choiceActions;
      this.sending = true;
      try {
        await this.session.setupChoice(choice.setup!, value.trim());
        if (!this.closing && this.view === 'settings-choice-setup' && this.choiceActions === actions) {
          actions?.choose(choice.value); this.showNotice('Resource registered; stage and save the configuration to grant access.');
        }
      } catch (error) { if (!this.closing && this.view === 'settings-choice-setup') this.showNotice((error as Error).message); }
      finally { this.sending = false; if (!this.closing && this.view === 'settings-choice-setup') { this.input.focus(); this.input.readInput(); } this.draw(); }
      return;
    }
    if (this.view === 'server-field' && this.serverEditor && this.serverField) {
      try {
        this.serverEditor.stage(this.serverField, value);
        const index = this.serverEditor.fields.indexOf(this.serverField);
        this.setView('server-group'); this.menuIndex = index + this.skillGroupOffset(); this.draw();
      } catch (error) { this.showNotice((error as Error).message); this.input.focus(); this.input.readInput(); }
      return;
    }
    if (this.view === 'volume-destination' && this.pendingVolume && this.structured) {
      const editor = this.structured, choice = this.pendingVolume;
      this.sending = true;
      try {
        await this.session.configureVolume(choice.name, value.trim());
        if (this.closing || this.structured !== editor || this.view !== 'volume-destination') return;
        editor.put(this.entry.id, this.entry.key, choice.name);
        this.returnStructured();
        this.notice.setContent('Destination registered; stage and save the list to grant access.');
      } catch (error) {
        if (!this.closing && this.view === 'volume-destination') this.showNotice((error as Error).message);
      } finally {
        this.sending = false;
        if (!this.closing && this.view === 'volume-destination') { this.input.focus(); this.input.readInput(); }
        this.draw();
      }
      return;
    }
    if (['structured-filter', 'structured-raw', 'entry-key', 'entry-value'].includes(this.view) && this.structured) {
      const view = this.view;
      try {
        if (view === 'structured-filter') { const index = this.menuIndex; this.returnStructured(); this.menuIndex = index; this.openEntry(false); }
        else if (view === 'structured-raw') { this.structured.raw(value); this.returnStructured(); }
        else if (view === 'entry-key') {
          if (!value.trim()) throw new Error('Name cannot be blank');
          this.entry.key = value;
          if (this.structured.spec.editor === 'object-map') this.setView('entry-type');
          else this.selectEntryType('string');
        } else {
          if (this.isVolumeInput()) {
            const choice = this.volumeChoices[this.pathIndex];
            if (!choice) throw new Error('Choose an eligible server volume; discovery must succeed before staging');
            if (!choice.destination) {
              this.pendingVolume = choice;
              this.input.setValue('');
              this.setView('volume-destination');
              return;
            }
            value = choice.name;
          }
          if (this.isPathInput()) {
            if (!value.trim()) throw new Error('Path cannot be blank');
            const editor = this.structured;
            this.sending = true;
            try {
              const kind = this.pathKind();
              const result = await this.session.completePath(value, this.pathBase, kind);
              if (this.closing || this.structured !== editor || !this.isPathInput()) return;
              if (kind === 'directory' && !result.isDirectory) throw new Error('Choose an existing server directory (Tab inserts the suggestion)');
              value = result.path;
            } finally { this.sending = false; }
          }
          this.structured.put(this.entry.id, this.entry.key, parseTyped(value, this.entry.type));
          this.returnStructured();
        }
        this.notice.setContent('');
      } catch (error) {
        this.showNotice(`${this.structuredField}: ${(error as Error).message}`);
        this.input.focus(); this.input.readInput();
      }
      this.draw(); return;
    }
    if (this.view === 'agent-field' && this.editor && this.editField) {
      if (this.isPathInput()) {
        const editor = this.editor;
        this.sending = true;
        try {
          const kind = this.pathKind();
          if (!value.trim() && this.editField !== 'cwd') throw new Error('Path cannot be blank');
          const result = await this.session.completePath(value, this.pathBase, kind, this.editField === 'cwd');
          if (this.editField !== 'cwd' && kind === 'directory' && !result.isDirectory) throw new Error('Choose an existing server directory');
          if (this.closing || this.editor !== editor || !this.isPathInput()) return;
          value = result.path;
          this.notice.setContent('');
        } catch (error) {
          if (!this.closing && this.editor === editor && this.isPathInput()) {
            this.showNotice((error as Error).message);
            this.input.focus(); this.input.readInput();
          }
          return;
        } finally { this.sending = false; }
      }
      if (['harness', 'provider', 'model'].includes(this.editField)) this.editor.select(this.editField as 'harness' | 'provider' | 'model', value);
      else {
        try { this.editor.stage(this.editField, value); }
        catch (error) { this.showNotice(`${this.editor.label(this.editField)}: ${(error as Error).message}`); this.input.focus(); this.input.readInput(); return; }
      }
      const index = this.editor.fields.indexOf(this.editField);
      this.setView('agent-edit'); this.menuIndex = index; this.draw();
      return;
    }
    const view = this.view;
    const identity = this.composeIdentity();
    const agentId = view === 'chat' ? this.chatAgent : this.promptAgent;
    if (!agentId || !value.trim()) { this.input.focus(); this.input.readInput(); return; }
    this.clearMentionCompletion();
    this.saveComposeDraft(value);
    const submitted = value;
    const submittedRevision = identity ? this.composeDraftRevision(identity) : -1;
    const submittedNavigation = this.navigationGeneration;
    const pendingSubmission = mode !== 'default' && identity ? { identity, text: submitted, revision: submittedRevision } : undefined;
    if (pendingSubmission) this.pendingModifiedSubmission = pendingSubmission;
    this.sending = true;
    this.draw();
    // Enter ends the current textarea read cycle. Keep composition responsive
    // while acceptance is pending so Escape and local draft edits remain usable.
    // Modified Enter starts a fresh draft before buffered trailing bytes replay.
    this.composer.show();
    if (mode !== 'default') this.composer.setValue('');
    this.composer.readInput();
    this.draw();
    const steering = mode === 'default' && !!this.session.activePrompt(agentId);
    this.showNotice(mode === 'queue' ? 'Queueing prompt…' : mode === 'interrupt' ? 'Interrupting and submitting prompt…' : steering ? 'Sending guidance to active prompt…' : 'Sending interrupting prompt…');
    try {
      if (mode === 'queue') await this.session.prompt(agentId, submitted, true);
      else if (mode === 'interrupt') await this.session.prompt(agentId, submitted, false);
      else await this.session.sendPromptOrSteer(agentId, submitted);
      const submittedDraftStillCurrent = !!identity && this.composeDraftRevision(identity) === submittedRevision &&
        (identity.kind === 'chat' ? this.chatDrafts.get(identity.id) === submitted : this.promptDraft === submitted);
      if (submittedDraftStillCurrent && identity?.kind === 'chat') {
        this.chatDrafts.set(identity.id, ''); this.chatDraftRevisions.set(identity.id, submittedRevision + 1);
      } else if (submittedDraftStillCurrent && identity?.kind === 'prompt') {
        this.promptDraft = ''; this.promptDraftRevision = submittedRevision + 1;
      }
      if (!submittedDraftStillCurrent) return;
      const active = this.composeIdentity();
      const sameContext = !!identity && !!active && identity.kind === active.kind &&
        (identity.kind !== 'chat' || active.kind === 'chat' && identity.id === active.id);
      if (submittedDraftStillCurrent && sameContext && (this.composer.getValue() === submitted || mode !== 'default' && !this.composer.getValue())) {
        if (this.composer.getValue() === submitted) this.composer.setValue('');
        this.clearMentionCompletion();
        // Only the original tree-prompt context returns to tree. A reopened
        // prompt for the same recipient is synchronized in place, never retargeted.
        if (view === 'prompt' && this.navigationGeneration === submittedNavigation) this.setView('tree');
      }
    } catch (error) {
      const activeIdentity = this.composeIdentity();
      if (mode !== 'default' && identity && activeIdentity && sameComposeIdentity(identity, activeIdentity) &&
          this.composeDraftRevision(identity) === submittedRevision && !this.composer.getValue()) this.composer.setValue(submitted);
      this.showNotice((error as Error).message);
    }
    finally {
      if (pendingSubmission && this.pendingModifiedSubmission === pendingSubmission) this.pendingModifiedSubmission = undefined;
      this.sending = false;
      if (this.view === 'chat' || this.view === 'prompt') this.refreshComposeCompletion();
      this.draw();
    }
  }
  private draw(): void {
    const AGENT_FIELDS = this.editor?.fields ?? [];
    if (this.closing) return;
    this.renderColors();
    const width = Math.max(1, Number(this.screen.width));
    if (this.view === 'chat' || this.view === 'prompt') {
      if (this.mentionOpen) {
        const window = mentionWindow(this.mentionResults, this.mentionIndex, 4);
        const lines = window.items.map((_choice, index) => clip(`${window.start + index === this.mentionIndex ? '›' : ' '} ${window.items[index]!.token}`, width));
        this.mentionPanel.setItems(lines); this.mentionPanel.select(this.mentionIndex - window.start); this.mentionPanel.show();
      } else if (this.composeSpan?.kind === 'path' && (this.composeCandidates.length || this.composeStatus)) {
        const window = composeWindow(this.composeCandidates, this.composeSelection, 4);
        const lines = window.items.map((item, index) => clip(`${window.start + index === this.composeSelection ? '›' : ' '} ${item.name}${item.kind === 'directory' ? '/' : '  [file]'}`, width));
        this.mentionPanel.setItems(lines.length ? lines : [clip(`  ${this.composeStatus ?? 'No matching paths'}`, width)]);
        if (lines.length) this.mentionPanel.select(this.composeSelection - window.start);
        else this.mentionPanel.select(0);
        this.mentionPanel.show();
      } else this.mentionPanel.hide();
    } else this.mentionPanel.hide();
    const promptLabel = ' > ';
    const composeAgentId = this.view === 'chat' ? this.chatAgent : this.view === 'prompt' ? this.promptAgent : undefined;
    const queuedCount = composeAgentId ? this.session.store.queuedPromptCount(composeAgentId) : 0;
    const queueLabel = queuedCount > 0 ? `${queuedCount}x queued prompts ` : '';
    this.promptTop.setContent(clip(`─${promptLabel}${queueLabel}${'─'.repeat(Math.max(0, width - promptLabel.length - queueLabel.length - 1))}`, width));
    this.promptBottom.setContent('─'.repeat(width));
    this.menu.width = '100%';
    this.preview.hide();
    const store = this.session.store;
    const agent = this.view === 'agent-info' ? store.agents.get(this.infoAgentId ?? '') :
      this.view === 'chat' ? store.agents.get(this.chatAgent ?? '') :
      this.view === 'prompt' ? store.agents.get(this.promptAgent ?? '') : this.selected();
    const structuredLabel = this.structuredServer ? this.serverField?.label : this.structuredField ? this.editor?.label(this.structuredField) : '';
    const heading = this.view === 'history-settings' ? 'History cache · client preferences · changes saved automatically' :
      this.view === 'history-field' ? `Edit ${HISTORY_FIELDS[this.historyField!]} · positive integer` :
      this.view === 'structured' || this.view === 'structured-filter' ? `Edit ${structuredLabel} · ${this.structured?.filter ? `filter: ${this.structured.filter}` : 'list / map'} · S stages; ${this.structuredServer ? 'server' : 'agent'} Save applies` :
      this.view === 'volume-destination' ? `Container destination · ${this.pendingVolume?.name} · e.g. /home/pi/.pi` :
      this.view === 'structured-raw' ? `Edit ${structuredLabel} · advanced JSON` :
      this.view === 'entry-type' ? `Edit ${structuredLabel} · value type` :
      this.view === 'entry-key' || this.view === 'entry-value' ? `Edit ${structuredLabel} · ${this.view === 'entry-key' ? 'name' : `value (${this.entry.type})`}` :
      this.view === 'keys' ? `Keys · ${this.keyContext?.view} · press a shown key` : this.view === 'chat' ? `Chat · ${agentHierarchy(agent, store.agents) || this.chatAgent}` :
      this.view === 'agent-info' ? `Agent info · ${agent?.name ?? this.infoAgentId} · ${this.infoRaw ? 'JSON' : 'read-only'}` :
      this.view === 'skill-details' ? `Registered skill repository · ${this.skillDetailsFocus?.name ?? 'unknown'}` :
      this.view === 'catalog-manager' ? 'Manage registered catalog skills · reversible retirement' :
      this.view === 'catalog-delete-confirm' ? `Confirm permanent deletion · ${this.pendingCatalogDelete?.name ?? 'unknown skill'}` :
      this.view === 'prompt' ? `Prompt · ${agent?.name ?? this.promptAgent}` :
      this.view === 'actions' ? `Agent actions · ${this.actionAgent?.name ?? 'empty organization'}` :
      this.view === 'agent-edit' && this.editor?.fields[this.selectedMenuIndex()] === 'skills' ? `Skills: ${this.editor.agentId ? `modify draft · revision ${this.editor.revision}` : 'new agent draft'}` :
      this.view === 'agent-edit' ? `${this.editor?.agentId ? 'Modify agent' : 'Create agent'} · ${this.editor?.agentId ? `revision ${this.editor.revision}` : this.editor?.parentId ? 'child' : 'root'}` :
      this.view === 'agent-field' ? `Edit ${this.editor?.label(this.editField!)} · ${this.editor?.spec(this.editField!).editor}` :
      this.view === 'harness-options' ? `Select ${this.optionField === 'harness' ? 'Agent' : this.optionField}${this.optionField === 'model' ? ` · ${this.editor?.values.provider}` : ''}` :
      this.view === 'image-scope' ? 'Image change · choose which agents to update' :
      this.view === 'confirm' ? `Confirm · ${this.pendingAction?.label}` :
      this.view === 'table-fields' ? 'Table fields / order · client preferences · changes saved automatically' :
      this.view === 'colors' ? 'TUI colors · client preferences · changes saved automatically' :
      this.view === 'levels' ? 'Event visibility / rendering levels · hidden events are omitted throughout the client' :
      this.view === 'agent-skills' ? `Skills: ${agent?.name} · staged in draft` :
      this.view === 'local-skill-path' ? 'Add skill repository · one source locator' :
      this.view === 'local-skill-confirm' ? 'Confirm skill repository registration' :
      this.view === 'agent-skills-filter' ? `Filter skills · ${this.skillPicker?.filter ?? ''}` :
      this.view === 'settings-choice-setup' ? `${this.pendingChoiceSetup?.setup?.label}` :
      this.view === 'settings-options' ? `${this.choiceLabel} · select an available option` :
      this.view === 'settings-records' ? `${this.records?.field.label} · ${this.records?.keys ? 'volume / resource entries' : 'named configurations'} · S stages; server Save applies` :
      this.view === 'server-settings' ? 'Server settings · shared by all clients' :
      this.view === 'server-facts' ? 'Organization facts · read-only' :
      this.view === 'server-group' ? `${this.serverEditor?.group.title} · ${this.recordEditing ? 'configuration draft' : 'server-wide'} · revision ${this.serverEditor?.group.revision}` :
      this.view === 'server-field' ? `${this.serverField?.label}${this.serverField?.choices ? ` · choices: ${this.serverField.choices.join(', ')}` : ''} · ${this.serverField?.description ?? this.serverField?.editor}` :
      this.view === 'server-confirm' ? 'Confirm server-wide settings · affects all clients and agents' :
      this.view === 'view' ? 'View settings · server configuration / client preferences' : 'Agent Organization';
    const state = clip(this.session.status, width);
    const titleText = clip(heading, Math.max(0, width - stringWidth(state) - 1));
    this.title.setContent(`${titleText}${' '.repeat(Math.max(0, width - stringWidth(titleText) - stringWidth(state)))}${state}`);
    if (['structured', 'structured-filter'].includes(this.view)) {
      const entries = this.structured?.entries() ?? [];
      this.menuIndex = Math.max(0, Math.min(this.menuIndex, entries.length - 1));
      this.updating = true;
      this.menu.bottom = this.view === 'structured-filter' ? 5 : 2;
      this.menu.setItems(entries.length ? entries.map(entry => clip(this.structured!.isMap ? `${entry.key}=${this.structured!.spec.sensitive ? '••••' : previewValue(entry.value)}` : this.structured!.spec.genericList ? previewValue(entry.value) : String(entry.value), width - 1)) : ['No matching entries']);
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(this.view === 'structured-filter' ? ' Filter: type freely · ↑↓ select · Enter edit · Ctrl+U clear · Esc actions' : ` ↑↓ select  a add  e edit  d delete  / filter  S stage${this.isVolumeField() ? '' : '  J raw'}  Esc discard`);
    } else if (this.view === 'entry-type') {
      this.updating = true;
      this.menu.setItems(['s  String', 'n  Number', 'b  Boolean', 'z  Null', 'j  Advanced JSON value']); this.menu.select(this.menuIndex);
      this.updating = false;
      this.footer.setContent(' s string  n number  b boolean  z null  j JSON  Enter choose  Esc discard');
    } else if (this.view === 'entry-key' || this.view === 'entry-value') {
      this.form.setContent(`Name: ${this.entry.key || '(new entry)'}\nValue: ${this.entry.text || '(empty)'}\nEditing ${this.view === 'entry-key' ? 'name' : 'value'} below; Escape discards this entry.`);
      this.footer.setContent(this.isVolumeInput() ? ' Type to fuzzy-filter · ↑↓ select · Tab complete · Enter stage volume · Esc cancel' : this.isPathInput() ? ' ↑↓ select  Tab insert / descend  Space / Enter stage path  Ctrl+U clear  Esc discard entry' : ' Text entry · Enter next / stage entry  Ctrl+U clear  Esc discard entry');
    } else if (this.view === 'volume-destination') {
      this.footer.setContent(' Absolute container path (not a host path) · Enter register and stage volume · Esc discard entry');
    } else if (this.view === 'structured-raw') {
      this.footer.setContent(' Advanced JSON · Enter validate and stage  Ctrl+U clear  Esc discard raw edit');
    } else if (this.view === 'keys') {
      this.updating = true;
      this.menu.setItems(this.keyActions.map(action => `${cell(action.key === 'escape' ? 'Esc' : action.key, 8)} ${action.label}`));
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(' Press shown key to act · ↑↓ browse · Enter choose · Esc back');
    } else if (this.view === 'catalog-manager') {
      const entries = this.catalogManagerEntries();
      this.updating = true;
      this.menu.setItems(entries.length ? entries.map((skill, index) => clip(index >= this.session.managedSkillCatalog.length
        ? `CONFIRMED · ${skill.name} · catalog refresh required`
        : `${skill.status === 'retired' ? 'RETIRED' : 'READY'} · ${skill.name} · ${skill.description}`, width - 1)) : ['No manually registered catalog skills. Configured seeds are managed separately.']);
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(entries[this.menuIndex] && this.menuIndex >= this.session.managedSkillCatalog.length
        ? ' Read-only confirmation · refresh catalog from Skills settings before managing · Enter details  Esc back'
        : this.session.skillCatalogManagementAvailable
          ? ` ↑↓ select  Enter details  d retire  r restore${this.session.skillCatalogDeletionAvailable ? '  x permanently delete' : ''}  Esc Skills settings`
          : 'Read-only · management capability unsupported  Enter details  Esc Skills settings');
    } else if (this.view === 'catalog-delete-confirm') {
      this.updating = true;
      this.menu.setItems([
        'Cancel — keep the catalog entry and all assignments/files',
        'Delete permanently — clear assignments and remove plugin-owned copies plus central checkout/history',
      ].map(line => clip(line, width - 1)));
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(' ↑↓ select  Enter choose  y delete permanently  n / Esc cancel · no agent is stopped');
    } else if (this.view === 'skill-details') {
      const content = this.skillDetailsFocus ? this.skillDetails(this.skillDetailsFocus) : 'Registered skill details unavailable.';
      if (content !== this.lastSkillDetails) {
        const scroll = this.details.getScroll();
        this.details.setContent(content); this.lastSkillDetails = content;
        this.details.setScroll(scroll);
      }
      this.footer.setContent(' ↑↓ scroll  PgUp/PgDn page  Home/End top/bottom  ? keys  Esc back to Skills');
    } else if (this.view === 'agent-info') {
      const content = agent ? renderAgentInfo(agent, this.infoRaw) : `Agent ${clean(this.infoAgentId ?? '')} is no longer in the current snapshot.`;
      if (content !== this.lastInfo) {
        const scroll = this.details.getScroll();
        this.details.setContent(content); this.lastInfo = content;
        this.details.setScroll(scroll);
      }
      this.footer.setContent(' ↑↓ scroll  PgUp/PgDn page  Home/End top/bottom  j readable/JSON  ? keys  Esc back');
    } else if (this.view === 'tree' || this.view === 'prompt') {
      const allRows = store.tree();
      this.rows = this.view === 'tree' ? visibleTreeRows(allRows, this.collapsedAgentIds) : allRows;
      let selectedIndex = this.rows.findIndex(row => row.agent.id === this.selectedAgent);
      if (selectedIndex < 0) selectedIndex = this.rows.length ? 0 : -1;
      this.selectedAgent = this.rows[selectedIndex]?.agent.id;
      const fields = this.settings.tableFields.length ? this.settings.tableFields : [...DEFAULT_TABLE_FIELDS];
      // Blessed lists reserve a scrollbar cell even when it is hidden.
      const { header, items: tableItems } = renderTable(this.rows, store.latest(this.settings), fields, width - 1, store.treeRenderings(), this.settings.colors, selectedIndex, this.view === 'tree' ? this.collapsedAgentIds : undefined);
      this.columns.setContent(header);
      this.updating = true;
      if (JSON.stringify(tableItems) !== JSON.stringify(this.lastTreeItems)) {
        this.tree.setItems(tableItems); this.lastTreeItems = tableItems;
      }
      this.tree.select(selectedIndex);
      this.updating = false;
      if (!tableItems.length && (!this.notice.getContent() || this.notice.getContent().startsWith('No active agents.'))) this.notice.setContent('No active agents. Press n to create a root agent, or a for actions.');
      else if (this.notice.getContent().startsWith('No active agents.')) this.notice.setContent('');
      this.footer.setContent(this.view === 'prompt' ? ` Enter steer/send · Alt+Enter queue · Ctrl+Enter interrupt+submit  Esc ${this.mentionOpen || this.composeSpan || this.composeStatus ? 'dismiss completion' : 'tree'} · Ctrl+C clear` : ' ↑↓ select  Enter prompt  c chat  z raw events  i info  a actions  n create  e edit  v view  q quit');
    } else if (this.view === 'actions' || this.view === 'agent-edit' || this.view === 'harness-options' || this.view === 'image-scope' || this.view === 'confirm') {
      this.updating = true;
      this.menu.setItems(this.view === 'actions' ? this.actions.map(action => `${action.key}  ${action.label}`) :
        this.view === 'image-scope' ? ['This node only (pin inheriting child branches to the old image)', 'This node + descendants inheriting its image', 'This node + all descendants (replace explicit overrides)'] :
        this.view === 'confirm' ? ['Cancel', 'Confirm — interrupts work; subtree actions affect descendants'] :
        this.view === 'harness-options' ? [...this.agentOptions.map(choice => `${choice.value === this.editor?.values[this.optionField] ? '●' : '○'} ${choice.label}`), 'Enter manually…'] :
        [...this.editor!.fields.map((field, index) => clip(`${cell(field === 'skills' && index !== this.selectedMenuIndex() ? 'Skills' : this.editor!.label(field), field.startsWith('plugin:') || field === 'container' ? 28 : 12)} ${this.editor!.spec(field).sensitive ? '(hidden; Enter to edit)' : collection(this.editor!.spec(field).editor) ? '(structured; Enter to edit)' : this.editor?.display(field) || '(omitted)'}`, width - 1)), 'Save changes']);
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(this.sending ? ' Operation in progress · Esc tree · do not retry unknown outcomes' :
        this.view === 'confirm' ? ' ↑↓ select   Enter choose   y confirm   n / Esc cancel' :
        ['harness-options', 'image-scope'].includes(this.view) ? ' ↑↓ select   Enter choose   Esc back' :
        this.view === 'agent-edit' ? ' ↑↓ field   Enter edit / choose / save   Esc discard · launch changes restart active agents' : this.view === 'actions' ? ` ↑↓ action   Enter open   n create${this.actionAgent ? '   i agent info   e edit' : ''}   Esc tree` : ' ↑↓ action   Enter open   Esc tree');
    } else if (this.view === 'agent-skills') {
      const picker = this.skillPicker;
      if (picker) picker.choices = this.skillChoicesFor(picker.editor, picker.states);
      const choices = this.pickerChoices();
      this.updating = true;
      this.menu.setItems(choices.length ? choices.map(choice => clip(`${cell(this.pickerState(choice.name), 11)}  ${cell(choice.name, 24)} ${choice.stale ? '[stale] [not in catalog] ' : choice.retainedUnknown ? '[not in catalog] [retained] ' : ''}${choice.description}`, width - 1)) :
        [this.hasCatalogSkills() ? 'No skills match this filter.' : 'No catalog skills. Open server settings (v) to configure skill sources.']);
      this.menu.select(Math.max(0, this.menuIndex)); this.updating = false;
      this.footer.setContent(choices.length ? ' ↑↓ select  a available  i installed  d remove  Space cycle  / filter  S stage in form  Esc cancel' : ' v server settings  S stage  Esc cancel · no catalog entries to assign');
    } else if (this.view === 'local-skill-confirm') {
      this.updating = true; this.menu.setItems([`Cancel`, `Register repository from: ${this.localSkillPath}`, 'Name and description come from validated root SKILL.md. This creates an independent shared catalog entry now; it does not add a seed, assign or install a skill.', ...(urlLikeSkillSource(this.localSkillPath) ? [] : ['Local sources copy ignored and untracked files; history may retain secrets or deleted data. Supported Git history is preserved; non-Git directories receive an initial commit. Choose a narrow trusted root.'])]); this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(' y register exactly once  n / Esc cancel · no agent changes');
    } else if (this.view === 'local-skill-path') {
      this.footer.setContent(` Source: HTTPS Git URL or server path  Enter review  Tab complete paths only  Space literal  Esc cancel${this.session.skillRepositorySourceKinds.includes('server-path') ? '' : ' · paths unsupported on this server'}`);
    } else if (this.view === 'agent-skills-filter') {
      this.footer.setContent(' Type a name/description filter  Enter apply  Ctrl+U clear  Esc cancel');
    } else if (this.view === 'settings-options') {
      this.updating = true; this.menu.setItems(this.genericChoices.length ? this.genericChoices.map(c => clip(c.label, width - 1)) : ['No available options']);
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(` ↑↓ select  Enter choose${this.choiceActions?.manual ? '  m manual entry' : ''}  Esc back`);
    } else if (this.view === 'settings-records') {
      this.updating = true; this.menu.setItems(this.records?.values.length ? this.records.values.map((v, i) => clip(this.records!.keys ? `${this.records!.keys[i]}${v[this.records!.field.itemLabelKey ?? 'name'] ? ` → ${v[this.records!.field.itemLabelKey ?? 'name']}` : ''}` : String(v[this.records!.field.itemLabelKey ?? 'name'] ?? `Entry ${i + 1}`) + (v.image ? ` · ${v.image}` : ''), width - 1)) : [this.records?.keys ? 'No entries. Press a to choose a server resource.' : 'No configurations. Press a to add.']);
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(` a ${this.records?.keys ? 'choose server resource' : 'add'}  Enter / e edit  d delete  S stage ${this.records?.keys ? 'map' : 'list'}  Esc discard · no host resources are deleted`);
    } else if (['server-settings', 'server-group', 'server-confirm', 'server-facts'].includes(this.view)) {
      const catalog = this.session.serverSettingsCatalog, editor = this.serverEditor;
      this.updating = true;
      if (this.view === 'server-settings') {
        const declared = new Set(catalog?.groups.map(g => g.plugin ?? g.namespace));
        this.menu.setItems(['Organization facts (read-only)', ...(catalog?.groups.map(g => `${g.title} · shared server settings${this.effectiveRestartRequired(g).length ? ' · RESTART REQUIRED' : ''}${g.namespace === 'skills' && this.session.skillReconciliation ? ` · ${this.session.skillReconciliation.state}` : ''}`) ?? []), ...(catalog?.facts.plugins.filter(p => !declared.has(p)).map(p => `${p} · no server settings declared (read-only)`) ?? [])]);
      } else if (this.view === 'server-facts') {
        this.menu.setItems(catalog ? Object.entries(catalog.facts).map(([key, value]) => clip(`${key}: ${Array.isArray(value) ? value.join(', ') || '(none)' : value}`, width - 1)) : ['Server facts unavailable']);
      } else if (this.view === 'server-confirm') {
        const params = editor?.params();
        this.menu.setItems(['Cancel — keep draft', 'Save — changes configuration for every connected client', ...(editor?.group.fields.filter(f => Object.hasOwn(params!.patch, f.key) || params!.reset.includes(f.key)).map(f => `${f.label}: ${editor.inherits(f.key) ? '(inherited)' : previewValue(f.editor === 'text' || f.editor === 'select' ? editor.values[f.key] : JSON.parse(editor.values[f.key]!))} · ${f.effect}`) ?? [])]);
      } else if (editor) {
        const current = catalog?.groups.find(g => g.namespace === editor.group.namespace);
        const diagnostics = this.recordEditing ? [] : this.skillErrorLines(editor.group);
        const commands = this.serverSkillsCommands();
        const skillsGroup = editor.group.namespace === 'skills' && !this.recordEditing;
        const offset = this.skillGroupOffset();
        const rows = [
          ...(offset ? [this.skillRegistrationEnabled() ? 'Add skill repository…' : 'Add skill repository unavailable · upgrade Skills plugin', 'Manage registered catalog skills…'] : []),
          ...editor.fields.map(f => clip(`${f.label}: ${editor.inherits(f.key) ? '(inherited)' : previewValue(f.editor === 'text' || f.editor === 'select' ? editor.values[f.key] : JSON.parse(editor.values[f.key]!))} · ${editor.state(f.key)} · ${f.effect}${this.effectiveRestartRequired(editor.group).includes(f.key) ? ` · RESTART REQUIRED (effective ${previewValue(editor.group.effective[f.key])})` : ''}`, width - 1)),
          ...(skillsGroup ? [clip(this.legacySeedSummary() ?? 'Legacy configured seeds: unavailable', width - 1)] : []),
          ...diagnostics.map(line => clip(line, width - 1)),
          this.recordEditing ? 'Stage configuration in list (not yet saved on server)' : 'Review / save server-wide changes',
          ...commands.map(command => `${command.key}  ${command.label}`),
        ];
        this.menu.setItems(rows);
        if (!this.recordEditing && current && current.revision !== editor.group.revision && !this.notice.getContent().includes('draft retained')) this.notice.setContent('Server settings changed in another client · draft is stale; r discards and reloads');
      }
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(this.view === 'server-group' ? (this.recordEditing ? ' ↑↓ field  Enter edit  z reset (draft)  S stage entry into collection  Esc discard entry · server Save still required' : ` ↑↓ field  Enter row / field  z reset default (draft)  S review save  r discard/reload${editor?.group.namespace === 'skills' && this.session.skillsEnabled ? '  c refresh catalog' : ''}${editor?.group.namespace === 'skills' && this.session.skillRepositoryRegistrationAvailable ? '  a add skill repository' : ''}${editor?.group.namespace === 'skills' && this.session.skillsReconcileEndpointAvailable ? '  R retry legacy seeds' : ''}  Esc back`) : this.view === 'server-confirm' ? ' Enter choose  y save server-wide  n / Esc keep draft · no automatic agent restarts' : ' ↑↓ select  Enter open  Esc back · not client-local preferences');
    } else if (this.view === 'view') {
      this.updating = true;
      this.menu.setItems([...(this.session.serverSettingsCapability ? ['s  Organization / plugins (SERVER-WIDE)'] : []), 't  TUI colors (CLIENT ONLY)', 'b  Table fields / order (CLIENT ONLY)', 'l  Event visibility / rendering levels (CLIENT ONLY)', `c  Compact tool/steering phases in chat: ${this.settings.compactToolCalls ? 'on' : 'off'}`, 'h  History cache (CLIENT ONLY)']);
      this.menu.select(this.menuIndex);
      this.updating = false;
      this.footer.setContent(' s server settings   t TUI colors   b table fields   l event visibility / rendering levels   c compact phases   h history cache   ↑↓ select   Enter open   Esc tree');
    } else if (this.view === 'history-settings') {
      this.updating = true;
      this.menu.setItems((Object.keys(HISTORY_FIELDS) as (keyof HistorySettings)[]).map(key => `${HISTORY_FIELDS[key]}: ${this.settings.history[key]}`));
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(' ↑↓ limit  Enter edit  z defaults  Esc tree · cache eviction never deletes database history');
    } else if (this.view === 'history-field') {
      this.footer.setContent(' Enter save and apply immediately  Ctrl+U clear  Esc cancel · positive integer');
    } else if (this.view === 'colors') {
      this.updating = true;
      const keys = Object.keys(COLOR_SETTINGS) as ColorSetting[];
      this.menu.setItems(keys.map(key => `${COLOR_SETTINGS[key]}: ${this.settings.color(key)}`));
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(' ↑↓ component  Space / Enter / → next color  ← previous  z defaults  Esc tree');
    } else if (this.view === 'table-fields') {
      this.updating = true;
      this.menu.setItems(TABLE_FIELDS.map(field => {
        const order = this.settings.tableFields.indexOf(field);
        return `[${order >= 0 ? 'x' : ' '}] ${order >= 0 ? String(order + 1).padStart(2, ' ') : '  '}  ${field}${order === 0 ? ' · tree indent' : ''}`;
      }));
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(' ↑↓ field  Space toggle  ←→ reorder  1–9/0 position  z defaults  ? keys  Esc tree');
    } else if (this.view === 'levels') {
      const currentType = this.menuTypes[this.menuIndex];
      const subtypes = rendererSubtypes(this.session.renderers, agent?.settings.harness);
      this.menuTypes = this.settings.types([...store.discovered, ...subtypes]);
      if (currentType) this.menuIndex = Math.max(0, this.menuTypes.indexOf(currentType));
      const type = this.menuTypes[this.menuIndex] ?? '';
      const [parent, subtype] = type.split(':');
      const candidates = rendererCandidates(this.session.renderers, parent!, subtype, agent?.settings.harness);
      const preview = candidates[this.previewIndex % Math.max(1, candidates.length)] ?? genericPreview(parent!);
      const height = Number(this.screen.height);
      const showPreview = preview && width >= 60 && height >= 16;
      const menuWidth = showPreview && width >= 90 ? Math.floor(width / 2) : width;
      // Use the whole pane: reserve only the level label, gap and list scrollbar.
      const levelWidth = Math.max(...LEVEL_NAMES.map(name => name.length)) + 2;
      const typeWidth = Math.max(0, menuWidth - levelWidth - 3);
      if (showPreview) {
        const side = width >= 90;
        this.menu.width = side ? '50%' : '100%';
        this.menu.bottom = side ? 2 : 11;
        this.preview.width = side ? '50%' : '100%';
        this.preview.top = side ? 2 : height - 11;
        this.preview.show();
        this.preview.setContent(rendererPreview(preview, parent!, this.settings.level(type), Math.max(1, (side ? Math.floor(width / 2) : width) - 3), Math.max(1, (side ? height - 4 : 9) - 2), this.settings.colors, subtype));
      } else this.menu.bottom = 2;
      this.updating = true;
      this.menu.setItems(this.menuTypes.map(type => {
        const level = this.settings.level(type);
        return `${cell(type, typeWidth)}  ${level} ${LEVEL_NAMES[level]}`;
      }));
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(' ↑↓ event  ←→ level  0–4 level  r examples  z inherit  Esc tree');
    } else if (this.view === 'raw-events') {
      const events = this.rawEvents();
      this.rawIndex = events.length ? Math.max(0, Math.min(events.length - 1, this.rawIndex)) : -1;
      const width = Math.max(1, Number(this.screen.width) - 4);
      this.rawView.setLabel(` Raw events · visible events `);
      this.rawView.setContent(events.length ? events.map((event, index) => {
        const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
        const summary = clean(`${event.seq} · ${event.time} · ${event.type} · ${JSON.stringify(data) ?? String(data)}`).replace(/\s+/g, ' ');
        const line = clip(summary, width - 2);
        return `${index === this.rawIndex ? '› ' : '  '}${line}`;
      }).join('\n') : 'No events in this loaded history window.');
      this.rawView.scrollTo(Math.max(0, this.rawListScroll));
      this.footer.setContent(' ↑↓ select event   Enter full JSON   Esc tree');
    } else if (this.view === 'raw-event-json') {
      const event = this.selectedRawEvent;
      this.rawView.setLabel(rawEventJsonLabel(event?.type, width));
      const json = event ? JSON.stringify(event, null, 2).replace(/[\x7f-\x9f]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`) : 'No event selected.';
      this.rawView.setContent(json);
      this.rawView.scrollTo(this.rawScroll);
      this.footer.setContent(' ↑↓ scroll   Esc event list');
    } else if (this.view === 'chat') {
      const events = this.session.chatEvents(this.chatAgent!);
      const groups = chatGroups(events, this.settings, store.renderings);
      const anchor = this.follow ? undefined : this.captureChatAnchor();
      const colors = JSON.stringify(this.settings.colors);
      const selected = new Map<number, { event: ServerEvent; text: string }>();
      const retained = new Set<number>();
      const displayLimit = this.settings.history.cacheBytes;
      let used = 0;
      const renderBlock = (index: number, available: number): number => {
        if (index < 0 || index >= groups.length || selected.has(index) || available < 3) return 0;
        const event = groups[index]!;
        const rendering = store.renderings.get(event.seq);
        const level = this.settings.level(event.type, rendering?.subtype);
        const cached = this.renderedEvents.get(event.seq);
        let text = cached?.event === event && cached.rendering === rendering && cached.level === level && cached.width === width && cached.colors === colors && cached.budget === available ? cached.text :
          renderEvent(event, level, Math.max(1, width - 1), rendering, this.settings.colors);
        const textLimit = available - 2;
        if (Buffer.byteLength(text) > textLimit) {
          const suffix = '\n[Display budget reached.]';
          if (textLimit < Buffer.byteLength(suffix)) return 0;
          const clipped = Buffer.from(text).subarray(0, textLimit - Buffer.byteLength(suffix)).toString('utf8');
          text = `${clipped}${suffix}`;
        }
        selected.set(index, { event, text }); retained.add(event.seq);
        used += Buffer.byteLength(text) + 2;
        this.renderedEvents.set(event.seq, { event, rendering, level, width, colors, budget: available, text });
        return Buffer.byteLength(text) + 2;
      };
      if (this.follow) {
        for (let index = groups.length - 1; index >= 0 && used < displayLimit; index--) renderBlock(index, displayLimit - used);
      } else {
        const tailReserve = Math.min(Math.floor(displayLimit / 3), 64 * 1024);
        for (let index = groups.length - 1; index >= 0 && used < tailReserve; index--) renderBlock(index, Math.min(displayLimit - used, tailReserve - used));
        const anchorIndex = anchor ? groups.findIndex(event => this.chatGroupIdentity(event) === anchor.identity) : -1;
        if (anchorIndex >= 0) renderBlock(anchorIndex, displayLimit - used);
        if (anchorIndex >= 0) {
          for (let distance = 1; distance < groups.length && used < displayLimit; distance++) {
            renderBlock(anchorIndex - distance, displayLimit - used);
            renderBlock(anchorIndex + distance, displayLimit - used);
          }
        }
        for (let index = groups.length - 1; index >= 0 && used < displayLimit; index--) renderBlock(index, displayLimit - used);
        for (let index = 0; index < groups.length && used < displayLimit; index++) renderBlock(index, displayLimit - used);
      }
      for (const seq of this.renderedEvents.keys()) if (!retained.has(seq)) this.renderedEvents.delete(seq);

      const headers = [
        ...(this.session.chatLoading(this.chatAgent!) ? ['[Loading history…]'] : []),
        ...(store.historyGap ? ['[History gap: earlier events have expired.]'] : []),
        ...(this.session.chatCoverageIncomplete(this.chatAgent!) ? ['[Chat window has gaps; scroll to the latest to reload retained history.]'] : []),
      ];
      const ordered = [...selected.entries()].sort((a, b) => a[0] - b[0]);
      const anchorRetained = !anchor || ordered.some(([, block]) => this.chatGroupIdentity(block.event) === anchor.identity);
      this.chatAnchorLost = !!anchor && !anchorRetained;
      if (this.chatAnchorLost) headers.push('[View moved to the nearest retained message; the previous anchor was evicted.]');
      const parts: ChatLayoutPart[] = headers.map(text => ({ text }));
      let previousIndex = -1;
      for (const [index, block] of ordered) {
        if (previousIndex >= 0 && index > previousIndex + 1) parts.push({ text: '[Messages omitted to keep the displayed history within its budget.]' });
        parts.push({ text: block.text, event: block.event, identity: this.chatGroupIdentity(block.event) });
        previousIndex = index;
      }
      if (!parts.length) parts.push({ text: 'No visible events yet.' });
      const content = parts.map(part => part.text).join('\n\n');
      let nextLayout = this.chatLayout;
      if (content !== this.lastChat) {
        this.adjustingChatViewport = true;
        try {
          this.chat.setContent(content); this.lastChat = content;
          nextLayout = layoutChatParts(parts, (this.chat as any)._clines?.ftor ?? []);
          if (this.follow) this.chat.setScrollPerc(100);
          else this.chat.setScroll(this.restoreChatAnchor(anchor, nextLayout));
        } finally { this.adjustingChatViewport = false; }
      }
      this.chatLayout = nextLayout;
      this.footer.setContent(` Enter steer/send · Alt+Enter queue · Ctrl+Enter interrupt+submit  Esc tree · PgUp older · Ctrl+C clear`);
    } else if (this.view === 'settings-choice-setup') {
      this.footer.setContent(' Enter register resource and select  Ctrl+U clear  Esc cancel · registration persists independently; no agent access yet');
    } else if (this.view === 'server-field') {
      this.footer.setContent(' Enter stage field  Ctrl+U clear  Esc discard field · review Save to apply server-wide');
    } else if (this.view === 'agent-field') {
      this.footer.setContent(this.isPathInput() ?
        ' ↑↓ select   Tab complete / descend   Space / Enter stage path   Ctrl+U clear   Esc discard' :
        ' Enter stage field   Ctrl+U clear   Esc discard field · choose Save changes to apply');
    } else {
      this.footer.setContent(` Enter steer/send · Alt+Enter queue · Ctrl+Enter interrupt+submit  Esc tree · Ctrl+C clear`);
    }
    if (this.sending) this.footer.setContent(this.view === 'chat' || this.view === 'prompt' ? ' Working · do not retry unknown outcomes' : this.input.visible ? ' Working · do not retry unknown outcomes' : ' Working · Esc tree  q quit · do not retry unknown outcomes');
    else if (this.contextActions().length && this.view !== 'keys') this.footer.setContent(` ? keys |${this.footer.getContent()}`);
    this.screen.render();
  }
  close(): void {
    if (this.closing) return;
    this.closing = true;
    if (this.drawTimer) clearTimeout(this.drawTimer);
    if (this.pathTimer) clearTimeout(this.pathTimer);
    if (this.composeTimer) clearTimeout(this.composeTimer);
    ++this.pathRequest; ++this.composeRequest;
    this.session.close(); this.screen.destroy(); this.composeKeyInput.dispose();
    void this.saveChain.finally(() => process.exit(0));
  }
}
