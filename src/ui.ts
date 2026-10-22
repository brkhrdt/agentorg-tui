import blessed from 'blessed';
import stringWidth from 'string-width';
import { PromptInput } from './prompt-input.js';
import type { Agent, SkillStates, SkillState, ServerSettingsField, ServerSettingsGroup, ContainerProfile, SettingsChoice, ServerEvent, EventRendering } from './protocol.js';
import type { SkillChoice } from './skill-selection.js';
import { chatGroups, cell, clean, clip, renderEvent } from './render.js';
import { COLOR_OPTIONS, COLOR_SETTINGS, DEFAULT_COLORS, DEFAULT_TABLE_FIELDS, DEFAULT_HISTORY, HISTORY_FIELDS, historySettings, LEVEL_NAMES, TABLE_FIELDS, type HistorySettings, type ColorSetting, type Level, Settings } from './settings.js';
import { renderTable } from './table.js';
import { genericPreview, rendererPreview } from './renderer-preview.js';
import { Session, type LifecycleMethod } from './session.js';
import { AgentEditor, PODMAN_FIELDS, type AgentField, type ImageScope } from './agent-editor.js';
import { ServerSettingsEditor } from './server-settings-editor.js';
import { StructuredEditor, collection, parseTyped, previewValue, valueText, valueType, type ValueType } from './structured-editor.js';
import type { TreeRow } from './store.js';
import { enablePathKeys, type PathCandidate } from './path-input.js';
import { filterVolumes, type VolumeChoice } from './volume-input.js';
import { renderAgentInfo } from './agent-info.js';

type KeyAction = { key: string; label: string; run: () => void };
type AgentAction = { key: string; label: string } & (
  { kind: 'create' | 'info' | 'edit' } | { kind: 'lifecycle'; method: LifecycleMethod }
);
type View = 'history-settings' | 'history-field' | 'settings-choice-setup' | 'settings-options' | 'settings-records' | 'server-settings' | 'server-group' | 'server-field' | 'server-confirm' | 'server-facts' | 'volume-destination' | 'structured' | 'structured-filter' | 'structured-raw' | 'entry-key' | 'entry-type' | 'entry-value' | 'keys' | 'tree' | 'view' | 'colors' | 'table-fields' | 'filters' | 'levels' | 'chat' | 'prompt' | 'agent-skills' | 'agent-skills-filter' | 'local-skill-path' | 'local-skill-confirm' | 'actions' | 'agent-edit' | 'agent-field' | 'harness-options' | 'image-scope' | 'confirm' | 'agent-info';

function agentHierarchy(agent: Agent | undefined, agents: Map<string, Agent>): string {
  const names: string[] = [], seen = new Set<string>();
  let current = agent;
  while (current && !seen.has(current.id)) {
    seen.add(current.id); names.unshift(current.name);
    current = current.parentId ? agents.get(current.parentId) : undefined;
  }
  return names.join(' / ');
}

export class UI {
  readonly screen = blessed.screen({
    smartCSR: true, fullUnicode: true, title: 'Agent Organization',
    ignoreLocked: ['C-c'], warnings: false,
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
  private view: View = 'tree';
  private keyContext?: { view: View; index: number };
  private keyActions: KeyAction[] = [];
  private selectedAgent?: string;
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
  private localSkillSubmitting = false;
  private localSkillReturnIndex = 0;
  private navigationGeneration = 0;
  private skillsCatalogUiRequest = 0;
  private chatAgent?: string;
  private promptAgent?: string;
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
  private renderedEvents = new Map<number, { event: ServerEvent; rendering?: EventRendering; level: number; width: number; colors: string; budget: number; text: string }>();
  private historyField?: keyof HistorySettings;

  constructor(private session: Session, private settings: Settings, private configPath: string) {
    this.session.configureHistory(settings.history);
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
    for (const widget of [this.tree, this.menu, this.details]) {
      widget.key(['h', '?', 'r', 'x', 'S-r', 'p', 'd', 'c', 's', 'f', 'l', 't', 'v', 'q', 'n', 'e', 'y', 'a', 'i', 'u', '+', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'S-s', 'S-l', 'm', '/', 'S-j', 'b', 'z', 'j', 'space', 'left', 'right', 'enter', 'escape', 'pageup', 'pagedown', 'home', 'end', 'C-home', 'C-end'], (ch, key) => {
        const binding = key.full === 'C-home' || key.full === 'C-end' ? key.full :
          ['space', 'left', 'right', 'enter', 'escape', 'pageup', 'pagedown', 'home', 'end'].includes(key.name) ? key.name : ch;
        if (binding === '?') this.openKeys();
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
    for (const input of [this.editorInput, this.composer]) input.key('C-u', () => {
      if (!this.sending) {
        this.input.setValue('');
        if (this.isPathInput()) this.refreshPaths();
        if (this.isVolumeInput()) this.refreshVolumes();
        if (this.view === 'structured-filter') { this.structured!.filter = ''; this.menuIndex = 0; this.draw(); }
        this.screen.render();
      }
    });
    // readInput installs its listener next tick. Preserve a fast typed/pasted
    // filter tail during the navigation -> input transition.
    this.input.on('keypress', (ch, key) => {
      const input = this.input as typeof this.input & { __listener?: unknown; _listener: (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => void };
      if (['structured-filter', 'agent-skills-filter'].includes(this.view) && !input.__listener) input._listener(ch, key);
    });
    for (const input of [this.editorInput, this.composer]) {
      input.on('submit', (value: string) => { void this.submit(value); });
      input.on('cancel', () => {
        if (['volume-destination', 'entry-key', 'entry-value', 'structured-raw', 'structured-filter'].includes(this.view)) this.returnStructured();
        else if (this.view === 'agent-skills-filter') this.cancelSkillFilter();
        else if (this.view === 'local-skill-path' || this.view === 'local-skill-confirm') this.returnLocalSkill();
        else if (this.view === 'agent-skills') this.cancelAgentSkills();
        else this.setView(this.view === 'history-field' ? 'history-settings' : this.view === 'settings-choice-setup' ? 'settings-options' : this.view === 'server-field' ? 'server-group' : this.view === 'agent-field' ? 'agent-edit' : 'tree');
      });
    }
    this.composer.key(['pageup', 'pagedown', 'C-home', 'C-end'], (_ch, key) => {
      if (this.view !== 'chat') return;
      if (key.full === 'C-end') {
        this.follow = true;
        if (this.chatAgent) void this.session.followChat(this.chatAgent).catch(error => this.showNotice(error.message));
        this.chat.setScrollPerc(100);
      } else {
        this.follow = false;
        if (this.chatAgent) this.session.pauseChat(this.chatAgent);
        if (key.full === 'C-home') this.chat.setScroll(0);
        else this.chat.scroll((key.name === 'pageup' ? -1 : 1) * Math.max(1, Number(this.chat.height) - 2));
        if (key.name === 'pageup' || key.full === 'C-home') this.loadOlderChat();
      }
      this.screen.render();
    });
    this.chat.on('wheelup', () => {
      this.follow = false;
      if (this.chatAgent) this.session.pauseChat(this.chatAgent);
      this.loadOlderChat();
    });
    this.screen.key('C-c', () => this.close());
    this.screen.on('resize', () => {
      this.lastTreeItems = []; this.lastChat = ''; this.renderedEvents.clear();
      this.scheduleDraw();
    });
    this.session.store.on('change', () => this.scheduleDraw());
    this.session.on('status', () => this.scheduleDraw());
    this.session.on('notice', (message: string) => this.showNotice(message));
    this.tree.focus();
    this.draw();
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
    this.settings.levels[type] = absolute ?? ((this.settings.level(type) - 1 + delta + 4) % 4 + 1) as Level;
    this.saveSettings(); this.draw();
  }
  private selected(): Agent | undefined { return this.selectedAgent ? this.session.store.agents.get(this.selectedAgent) : undefined; }
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
      else if (this.menuIndex === offset + 2) this.setView('filters');
      else if (this.menuIndex === offset + 3) this.setView('levels');
      else if (this.menuIndex === offset + 4) this.toggleCompactToolCalls();
      else if (this.menuIndex === offset + 5) this.setView('history-settings');
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
      const saveIndex = (editor?.fields.length ?? 0) + diagnostics.length;
      if (this.menuIndex === saveIndex) { if (this.recordEditing) this.stageRecord(); else this.setView('server-confirm'); }
      else if (editor && this.menuIndex >= editor.fields.length && this.menuIndex < saveIndex) this.showNotice(diagnostics[this.menuIndex - editor.fields.length] ?? 'Repository diagnostic');
      else if (editor && this.menuIndex > saveIndex) {
        const command = this.serverSkillsCommands()[this.menuIndex - saveIndex - 1];
        if (command?.key === 'c') void this.refreshSkillsCatalog();
        else if (command?.key === 'L') this.openLocalSkillPath();
      } else this.openServerField();
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
    else if (this.view === 'filters') {
      const type = this.menuTypes[this.menuIndex];
      if (type) { this.settings.toggle(type); this.saveSettings(); this.draw(); }
    } else if (this.view === 'agent-skills') this.cycleSkill();
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
      action('n', 'Create agent', () => this.openEditor(false)),
      ...(this.selected() ? [action('i', 'View all agent info', () => this.openAgentInfo(this.selected())), action('e', 'Modify agent', () => this.openEditor(true)), ...lifecycle,
        action('enter', 'Interrupting prompt', () => this.openPrompt()), action('c', 'Chat', () => this.openChat()),
        ] : []),
      action('a', 'Agent actions', () => this.openActions()), action('v', 'Settings (server / client)', () => this.setView('view')),
      action('f', 'Event filters', () => this.setView('filters')), action('l', 'Rendering levels', () => this.setView('levels')),
      action('q', 'Quit client', () => this.close()), back,
    ];
    if (this.view === 'view') return [action('enter', 'Choose selected setting', choose), ...(this.session.serverSettingsCapability ? [action('s', 'Server organization / plugin settings', () => { void this.openServerSettings(); })] : []), action('t', 'TUI colors (CLIENT ONLY)', () => this.setView('colors')), action('b', 'Table fields / order', () => this.setView('table-fields')), action('f', 'Client-only event filters', () => this.setView('filters')), action('l', 'Client-only event rendering levels', () => this.setView('levels')), action('c', 'Toggle compact tool phases', () => this.toggleCompactToolCalls()), action('h', 'History cache (CLIENT ONLY)', () => this.setView('history-settings')), back];
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
    if (this.view === 'server-group') return [action('enter', 'Edit field / review save / run command', choose), action('S', this.recordEditing ? 'Stage entry in collection' : 'Review server-wide save', () => { if (this.recordEditing) this.stageRecord(); else this.setView('server-confirm'); }),
      ...this.serverSkillsCommands().map(command => action(command.key, command.key === 'c' ? 'Refresh shared Skills catalog only' : 'Register a local server skill', () => { if (command.key === 'c') void this.refreshSkillsCatalog(); else this.openLocalSkillPath(); })),
      ...(!this.recordEditing && this.serverEditor?.group.namespace === 'skills' && this.session.skillsReconcileEndpointAvailable ? [action('R', 'Retry skills reconciliation without saving settings', () => { void this.retrySkills(); })] : []),
      action('z', 'Reset selected field to startup default (draft)', () => {
      const field = this.serverEditor?.fields[this.menuIndex];
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
    if (this.view === 'local-skill-confirm') return [action('enter', 'Choose confirmation', choose), action('y', 'Register this server-side skill', () => { void this.registerLocalSkill(); }), action('n', 'Cancel', () => this.returnLocalSkill()), action('escape', 'Cancel registration', () => this.returnLocalSkill())];
    if (this.view === 'local-skill-path') return [action('enter', 'Review path and confirm', () => { const path = this.input.getValue(); if (!path) { this.showNotice('Enter a server-side path.'); return; } this.localSkillPath = path; this.setView('local-skill-confirm'); }), action('escape', 'Cancel registration', () => this.returnLocalSkill())];
    if (this.view === 'agent-skills-filter') return [
      action('enter', 'Apply filter', () => this.applySkillFilter()),
      action('escape', 'Cancel filter', () => this.cancelSkillFilter()),
    ];
    if (this.view === 'filters') return [action('space', 'Toggle selected event', cycle), back];
    if (this.view === 'levels') return [1, 2, 3, 4].map(level => action(String(level), LEVEL_NAMES[level - 1]!, () => this.changeLevel(0, level as Level))).concat([
      action('r', 'Next renderer example (does not change server selection)', () => { this.previewIndex++; this.draw(); }),
      action('z', 'Inherit parent / default rendering level', () => {
        const type = this.menuTypes[this.menuIndex];
        if (type?.includes(':')) delete this.settings.levels[type];
        else if (type) this.settings.levels[type] = new Settings().level(type);
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
  private openServerField(): void {
    const editor = this.serverEditor, field = editor?.fields[this.menuIndex];
    if (!editor || !field) return;
    this.serverField = field;
    if (field.itemFields) {
      const value = JSON.parse(editor.values[field.key]!);
      this.records = { parent: editor, field, values: field.editor === 'object-map' ? Object.values(value) : value,
        ...(field.editor === 'object-map' && { keys: Object.keys(value) }), index: -1, parentIndex: this.menuIndex };
      this.setView('settings-records'); this.showNotice(field.description ?? ''); return;
    }
    if (field.editor === 'select' || (field.editor === 'text' && field.choicesEndpoint)) {
      const index = this.menuIndex, back = () => { this.setView('server-group'); this.menuIndex = index; this.draw(); };
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
      this.structuredIndex = this.menuIndex; this.setView('structured');
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
  private serverSkillsCommands(): Array<{ key: 'c' | 'L'; label: string }> {
    if (this.recordEditing || this.serverEditor?.group.namespace !== 'skills') return [];
    return [
      ...(this.session.skillsEnabled ? [{ key: 'c' as const, label: 'Refresh catalog (read-only)' }] : []),
      ...(this.session.localSkillImportAvailable ? [{ key: 'L' as const, label: 'Register local skill' }] : []),
    ];
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
    return this.session.pathCompletion && (this.view === 'local-skill-path' || (this.view === 'agent-field' && (this.editField === 'cwd' || ['directory', 'path'].includes(this.editor?.spec(this.editField!).editor ?? ''))) ||
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
    this.paths.setItems(['Loading directories…']);
    this.screen.render();
    const input = this.input.getValue(), editor = this.editor;
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
    if (this.recordEditing || this.serverEditor?.group.namespace !== 'skills' || !this.session.localSkillImportAvailable) return;
    this.localSkillReturnIndex = this.menuIndex;
    this.localSkillPath = '';
    this.input.setValue('');
    this.setView('local-skill-path');
    this.showNotice(`Enter a server-side directory or root SKILL.md path. Server startup base: ${this.session.serverCwd || '(unknown)'}.`);
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
      if (ownsContext()) this.showNotice('Skills catalog refreshed; settings draft was not changed.');
    } catch (error) {
      if (ownsContext()) this.showNotice(`Skills catalog refresh failed: ${(error as Error).message}`);
    }
    if (ownsContext()) this.draw();
  }
  private async registerLocalSkill(): Promise<void> {
    if (this.localSkillSubmitting || this.sending) return;
    if (this.recordEditing || this.serverEditor?.group.namespace !== 'skills' || !this.session.localSkillImportAvailable) {
      this.showNotice('Local skill import is unavailable in this Skills settings context.'); return;
    }
    const path = this.localSkillPath;
    if (!path) return;
    const editor = this.serverEditor, navigation = this.navigationGeneration;
    const ownsContext = () => !this.closing && this.view === 'local-skill-confirm' && this.serverEditor === editor && this.serverEditor?.group.namespace === 'skills' && !this.recordEditing && this.navigationGeneration === navigation;
    ++this.skillsCatalogUiRequest;
    this.localSkillSubmitting = true; this.sending = true; this.draw();
    try {
      await this.session.importLocalSkill(path);
      if (ownsContext()) this.returnLocalSkill();
      if (!this.closing) this.showNotice('Local skill registered and catalog refreshed. It is not installed or assigned; use the agent Skills picker to stage it and save that agent.');
    } catch (error) {
      if (ownsContext()) this.returnLocalSkill();
      if (!this.closing) this.showNotice((error as Error).message);
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
  private openChat(): void {
    if (this.sending) return;
    const agent = this.selected();
    if (!agent) return;
    this.chatAgent = agent.id; this.follow = true; this.lastChat = ''; this.renderedEvents.clear();
    this.composer.setValue('');
    this.setView('chat');
    void this.session.openChat(agent.id).catch(error => this.showNotice(`Chat history: ${error.message}`));
  }
  private loadOlderChat(): void {
    const id = this.chatAgent;
    if (this.view !== 'chat' || !id || this.chat.getScroll() > 0 || this.session.chatLoading(id) || !this.session.chatHasMore(id)) return;
    const anchor = this.chat.getScreenLines().slice(0, 2).join('\n');
    void this.session.olderChat(id).then(() => {
      if (this.view !== 'chat' || this.chatAgent !== id) return;
      this.draw();
      const lines = this.chat.getScreenLines();
      const index = anchor ? lines.findIndex((_, i) => lines.slice(i, i + 2).join('\n') === anchor) : 0;
      this.chat.setScroll(Math.max(0, index - Math.max(1, Number(this.chat.height) - 2)));
      this.screen.render();
    }).catch(error => this.showNotice(error.message));
  }
  private openPrompt(): void {
    const agent = this.selected();
    if (this.sending || !agent) return;
    this.promptAgent = agent.id;
    this.composer.setValue('');
    this.setView('prompt');
  }
  private resizeComposer(): void {
    if (this.view !== 'prompt' && this.view !== 'chat') return;
    const previous = Number(this.composer.height);
    const rows = this.composer.reflow(Math.max(1, Number(this.screen.height) - 7));
    this.promptTop.bottom = rows + 3;
    this.tree.bottom = rows + 4;
    this.chat.bottom = rows + 4;
    if (rows !== previous) {
      if (this.view === 'prompt') this.tree.scrollTo(Math.max(0, this.rows.findIndex(row => row.agent.id === this.selectedAgent)));
      else if (this.follow) this.chat.setScrollPerc(100);
    }
  }
  private setView(view: View): void {
    ++this.navigationGeneration;
    ++this.editorRequest; // Navigation cancels any pending new-draft defaults load.
    if (this.view === 'chat' && view !== 'chat') {
      this.session.leaveChat();
      this.chat.setContent(''); this.lastChat = ''; this.renderedEvents.clear();
    }
    this.view = view;
    this.menuIndex = 0;
    this.previewIndex = 0;
    ++this.pathRequest;
    if (this.pathTimer) { clearTimeout(this.pathTimer); this.pathTimer = undefined; }
    this.tree.hide(); this.menu.hide(); this.chat.hide(); this.details.hide(); this.editorInput.hide(); this.composer.hide(); this.promptTop.hide(); this.promptBottom.hide(); this.columns.hide(); this.paths.hide(); this.form.hide(); this.preview.hide();
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
    } else if (view === 'agent-info') {
      this.details.show(); this.details.focus();
    } else if (['history-settings', 'settings-options', 'settings-records', 'server-settings', 'server-group', 'server-confirm', 'server-facts', 'structured', 'entry-type', 'keys', 'view', 'colors', 'table-fields', 'filters', 'levels', 'agent-skills', 'local-skill-confirm', 'actions', 'agent-edit', 'harness-options', 'image-scope', 'confirm'].includes(view)) {
      this.menu.show(); this.menu.focus();
    } else {
      if (view === 'chat') this.chat.show();
      if (view === 'structured-filter') this.menu.show();
      if (['entry-key', 'entry-value'].includes(view)) this.form.show();
      this.input.show(); this.input.focus();
      if (!this.sending) this.input.readInput();
    }
    if (composer) { this.promptTop.show(); this.promptBottom.show(); }
    this.draw();
  }
  private async submit(value: string): Promise<void> {
    if (this.sending) return;
    if (this.view === 'local-skill-path') { if (!value) { this.showNotice('Enter a server-side path.'); this.input.readInput(); return; } this.localSkillPath = value; this.setView('local-skill-confirm'); return; }
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
        this.setView('server-group'); this.menuIndex = index; this.draw();
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
    const agentId = view === 'chat' ? this.chatAgent : this.promptAgent;
    if (!agentId || !value.trim()) { this.input.focus(); this.input.readInput(); return; }
    this.sending = true;
    this.draw();
    this.showNotice('Sending interrupting prompt…');
    try {
      await this.session.prompt(agentId, value);
      if (this.view === view) {
        this.input.setValue('');
        if (view === 'prompt') this.setView('tree');
      }
    } catch (error) { this.showNotice((error as Error).message); }
    finally {
      this.sending = false;
      if (this.view === 'chat' || this.view === 'prompt') { this.input.focus(); this.input.readInput(); }
      this.draw();
    }
  }
  private draw(): void {
    const AGENT_FIELDS = this.editor?.fields ?? [];
    if (this.closing) return;
    this.renderColors();
    const width = Math.max(1, Number(this.screen.width));
    const promptLabel = ' > ';
    this.promptTop.setContent(clip(`─${promptLabel}${'─'.repeat(Math.max(0, width - promptLabel.length - 1))}`, width));
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
      this.view === 'prompt' ? `Interrupting prompt · ${agent?.name ?? this.promptAgent}` :
      this.view === 'actions' ? `Agent actions · ${this.actionAgent?.name ?? 'empty organization'}` :
      this.view === 'agent-edit' && this.editor?.fields[this.selectedMenuIndex()] === 'skills' ? `Skills: ${this.editor.agentId ? `modify draft · revision ${this.editor.revision}` : 'new agent draft'}` :
      this.view === 'agent-edit' ? `${this.editor?.agentId ? 'Modify agent' : 'Create agent'} · ${this.editor?.agentId ? `revision ${this.editor.revision}` : this.editor?.parentId ? 'child' : 'root'}` :
      this.view === 'agent-field' ? `Edit ${this.editor?.label(this.editField!)} · ${this.editor?.spec(this.editField!).editor}` :
      this.view === 'harness-options' ? `Select ${this.optionField === 'harness' ? 'Agent' : this.optionField}${this.optionField === 'model' ? ` · ${this.editor?.values.provider}` : ''}` :
      this.view === 'image-scope' ? 'Image change · choose which agents to update' :
      this.view === 'confirm' ? `Confirm · ${this.pendingAction?.label}` :
      this.view === 'table-fields' ? 'Table fields / order · client preferences · changes saved automatically' :
      this.view === 'colors' ? 'TUI colors · client preferences · changes saved automatically' :
      this.view === 'filters' ? 'Event filters · checked events appear in tree and chat' :
      this.view === 'levels' ? 'Event rendering levels · chat uses these; tree always uses summary' :
      this.view === 'agent-skills' ? `Skills: ${agent?.name} · staged in draft` :
      this.view === 'local-skill-path' ? 'Register local server skill · enter directory or root SKILL.md' :
      this.view === 'local-skill-confirm' ? 'Confirm local skill registration' :
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
    } else if (this.view === 'agent-info') {
      const content = agent ? renderAgentInfo(agent, this.infoRaw) : `Agent ${clean(this.infoAgentId ?? '')} is no longer in the current snapshot.`;
      if (content !== this.lastInfo) {
        const scroll = this.details.getScroll();
        this.details.setContent(content); this.lastInfo = content;
        this.details.setScroll(scroll);
      }
      this.footer.setContent(' ↑↓ scroll  PgUp/PgDn page  Home/End top/bottom  j readable/JSON  ? keys  Esc back');
    } else if (this.view === 'tree' || this.view === 'prompt') {
      this.rows = store.tree();
      const selectedIndex = Math.max(0, this.rows.findIndex(row => row.agent.id === this.selectedAgent));
      this.selectedAgent = this.rows[selectedIndex]?.agent.id;
      const fields = this.settings.tableFields.length ? this.settings.tableFields : [...DEFAULT_TABLE_FIELDS];
      // Blessed lists reserve a scrollbar cell even when it is hidden.
      const { header, items: tableItems } = renderTable(this.rows, store.latest(this.settings), fields, width - 1, store.renderings, this.settings.colors, selectedIndex);
      this.columns.setContent(header);
      this.updating = true;
      if (JSON.stringify(tableItems) !== JSON.stringify(this.lastTreeItems)) {
        this.tree.setItems(tableItems); this.lastTreeItems = tableItems;
      }
      this.tree.select(selectedIndex);
      this.updating = false;
      if (!tableItems.length && (!this.notice.getContent() || this.notice.getContent().startsWith('No active agents.'))) this.notice.setContent('No active agents. Press n to create a root agent, or a for actions.');
      else if (this.notice.getContent().startsWith('No active agents.')) this.notice.setContent('');
      this.footer.setContent(this.view === 'prompt' ? ' Text: Enter interrupt/send  Ctrl+U clear  Esc tree' : ' ↑↓ select  Enter prompt  c chat  i info  a actions  n create  e edit  v view  q quit');
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
      this.updating = true; this.menu.setItems([`Cancel`, `Register: ${this.localSkillPath}`, 'This copies the skill into the shared server snapshot. Imported code is shared with every client. Registration does not install or assign it.']); this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(' y register exactly once  n / Esc cancel · no agent changes');
    } else if (this.view === 'local-skill-path') {
      this.footer.setContent(' Enter review  Tab complete if supported  spaces are literal  Esc cancel · server-side path');
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
        this.menu.setItems([...editor.fields.map(f => clip(`${f.label}: ${editor.inherits(f.key) ? '(inherited)' : previewValue(f.editor === 'text' || f.editor === 'select' ? editor.values[f.key] : JSON.parse(editor.values[f.key]!))} · ${editor.state(f.key)} · ${f.effect}${this.effectiveRestartRequired(editor.group).includes(f.key) ? ` · RESTART REQUIRED (effective ${previewValue(editor.group.effective[f.key])})` : ''}`, width - 1)), ...diagnostics.map(line => clip(line, width - 1)), this.recordEditing ? 'Stage configuration in list (not yet saved on server)' : 'Review / save server-wide changes', ...commands.map(command => `${command.key}  ${command.label}`)]);
        if (!this.recordEditing && current && current.revision !== editor.group.revision && !this.notice.getContent().includes('draft retained')) this.notice.setContent('Server settings changed in another client · draft is stale; r discards and reloads');
      }
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(this.view === 'server-group' ? (this.recordEditing ? ' ↑↓ field  Enter edit  z reset (draft)  S stage entry into collection  Esc discard entry · server Save still required' : ` ↑↓ field  Enter edit  z reset default (draft)  S review save  r discard/reload${editor?.group.namespace === 'skills' && this.session.skillsEnabled ? '  c refresh catalog' : ''}${editor?.group.namespace === 'skills' && this.session.localSkillImportAvailable ? '  L register local skill' : ''}${editor?.group.namespace === 'skills' && this.session.skillsReconcileEndpointAvailable ? '  R retry repositories' : ''}  Esc back`) : this.view === 'server-confirm' ? ' Enter choose  y save server-wide  n / Esc keep draft · no automatic agent restarts' : ' ↑↓ select  Enter open  Esc back · not client-local preferences');
    } else if (this.view === 'view') {
      this.updating = true;
      this.menu.setItems([...(this.session.serverSettingsCapability ? ['s  Organization / plugins (SERVER-WIDE)'] : []), 't  TUI colors (CLIENT ONLY)', 'b  Table fields / order (CLIENT ONLY)', 'f  Event filters (CLIENT ONLY)', 'l  Event rendering levels (CLIENT ONLY)', `c  Compact tool phases in chat: ${this.settings.compactToolCalls ? 'on' : 'off'}`, 'h  History cache (CLIENT ONLY)']);
      this.menu.select(this.menuIndex);
      this.updating = false;
      this.footer.setContent(' s server settings   t TUI colors   b table fields   f event filters   l rendering levels   c compact phases   h history cache   ↑↓ select   Enter open   Esc tree');
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
    } else if (this.view === 'filters' || this.view === 'levels') {
      const currentType = this.menuTypes[this.menuIndex];
      const subtypes = this.session.renderers.flatMap(renderer => [...new Set([renderer.tool, ...(renderer.aliases ?? [])].filter((tool): tool is string => !!tool))].flatMap(tool => renderer.eventTypes.map(type => `${type}:${tool}`)));
      this.menuTypes = this.settings.types([...store.discovered, ...(this.view === 'levels' ? subtypes : [])]).filter(type => this.view === 'levels' || !type.includes(':'));
      if (currentType) this.menuIndex = Math.max(0, this.menuTypes.indexOf(currentType));
      const type = this.menuTypes[this.menuIndex] ?? '';
      const [parent, subtype] = type.split(':');
      const candidates = this.session.renderers.filter(renderer => renderer.eventTypes.includes(parent!) && (!renderer.tool || renderer.tool === subtype || renderer.aliases?.includes(subtype ?? '')))
        .sort((a, b) => Number(b.harness === agent?.settings.harness) - Number(a.harness === agent?.settings.harness));
      const preview = candidates[this.previewIndex % Math.max(1, candidates.length)] ?? genericPreview(parent!);
      const height = Number(this.screen.height);
      const showPreview = this.view === 'levels' && preview && width >= 60 && height >= 16;
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
      this.menu.setItems(this.menuTypes.map(type => this.view === 'filters' ?
        `[${this.settings.tracked(type) ? 'x' : ' '}] ${clean(type)}` :
        `${cell(type, typeWidth)}  ${this.settings.level(type)} ${LEVEL_NAMES[this.settings.level(type) - 1]}`));
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(this.view === 'filters' ? ' ↑↓ select   Space toggle tracked   Esc tree · changes saved automatically' : ' ↑↓ event  ←→ level  1–4 level  r examples  z inherit  Esc tree');
    } else if (this.view === 'chat') {
      const events = this.session.chatEvents(this.chatAgent!);
      const groups = chatGroups(events, this.settings, store.renderings);
      if (this.follow) groups.reverse();
      const blocks: string[] = [], retained = new Set<number>();
      const colors = JSON.stringify(this.settings.colors);
      let budget = this.settings.history.cacheBytes;
      for (const event of groups) {
        if (budget <= 0) break;
        const rendering = store.renderings.get(event.seq);
        const level = this.settings.level(event.type, rendering?.subtype);
        const cached = this.renderedEvents.get(event.seq);
        let text = cached?.event === event && cached.rendering === rendering && cached.level === level && cached.width === width && cached.colors === colors && cached.budget === budget ? cached.text :
          renderEvent(event, level, Math.max(1, width - 1), rendering, this.settings.colors);
        if (Buffer.byteLength(text) > budget) text = Buffer.from(text).subarray(0, budget).toString('utf8') + '\n[Display budget reached; raw history remains in the database.]';
        this.renderedEvents.set(event.seq, { event, rendering, level, width, colors, budget, text });
        retained.add(event.seq); blocks.push(text); budget -= Buffer.byteLength(text) + 2;
      }
      for (const seq of this.renderedEvents.keys()) if (!retained.has(seq)) this.renderedEvents.delete(seq);
      if (this.follow) blocks.reverse();
      const content = [this.session.chatLoading(this.chatAgent!) ? '[Loading history…]' : '', store.historyGap ? '[History gap: earlier events have expired.]' : '', ...blocks].filter(Boolean).join('\n\n') || 'No tracked events yet.';
      if (content !== this.lastChat) {
        const scroll = this.chat.getScroll();
        this.chat.setContent(content); this.lastChat = content;
        if (this.follow) this.chat.setScrollPerc(100); else this.chat.setScroll(scroll);
      }
      this.footer.setContent(' Text: Enter interrupt/send  PgUp older  PgDn scroll  Ctrl+Home top  Ctrl+End latest/follow  Ctrl+U clear  Esc tree');
    } else if (this.view === 'settings-choice-setup') {
      this.footer.setContent(' Enter register resource and select  Ctrl+U clear  Esc cancel · registration persists independently; no agent access yet');
    } else if (this.view === 'server-field') {
      this.footer.setContent(' Enter stage field  Ctrl+U clear  Esc discard field · review Save to apply server-wide');
    } else if (this.view === 'agent-field') {
      this.footer.setContent(this.isPathInput() ?
        ' ↑↓ select   Tab complete / descend   Space / Enter stage path   Ctrl+U clear   Esc discard' :
        ' Enter stage field   Ctrl+U clear   Esc discard field · choose Save changes to apply');
    } else {
      this.footer.setContent(' Text: Enter interrupt/send (cancels active/queued work)  Ctrl+U clear  Esc cancel');
    }
    if (this.sending) this.footer.setContent(this.input.visible ? ' Working · Ctrl+C quits · do not retry unknown outcomes' : ' Working · Esc tree  q quit  Ctrl+C quit · do not retry unknown outcomes');
    else if (this.contextActions().length && this.view !== 'keys') this.footer.setContent(` ? keys |${this.footer.getContent()}`);
    this.screen.render();
  }
  close(): void {
    if (this.closing) return;
    this.closing = true;
    if (this.drawTimer) clearTimeout(this.drawTimer);
    if (this.pathTimer) clearTimeout(this.pathTimer);
    ++this.pathRequest;
    this.session.close(); this.screen.destroy();
    void this.saveChain.finally(() => process.exit(0));
  }
}
