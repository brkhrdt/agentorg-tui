import blessed from 'blessed';
import type { Agent, SkillStates, SkillState } from './protocol.js';
import { chatGroups, cell, clean, clip, renderEvent, renderTreeEvent } from './render.js';
import { LEVEL_NAMES, type Level, Settings } from './settings.js';
import { Session, type LifecycleMethod } from './session.js';
import { AgentEditor, AGENT_FIELDS, type AgentField } from './agent-editor.js';
import type { TreeRow } from './store.js';

type View = 'tree' | 'view' | 'filters' | 'levels' | 'chat' | 'prompt' | 'skills' | 'skill-add' | 'actions' | 'agent-edit' | 'agent-field' | 'confirm';

export class UI {
  readonly screen = blessed.screen({
    smartCSR: true, fullUnicode: true, title: 'Agent Organization',
    ignoreLocked: ['C-c'], warnings: false,
  });
  private title = blessed.box({ parent: this.screen, top: 0, height: 2, tags: false, style: { fg: 'cyan', bold: true } });
  private columns = blessed.box({ parent: this.screen, top: 2, height: 1, style: { fg: 'gray' } });
  private tree = blessed.list({
    parent: this.screen, top: 3, bottom: 2, keys: true, vi: false, mouse: true,
    tags: false, style: { selected: { bg: 'blue', fg: 'white', bold: true } },
    scrollbar: { ch: '│', style: { bg: 'gray' } },
  });
  private chat = blessed.box({
    parent: this.screen, top: 2, bottom: 5, hidden: true, scrollable: true,
    alwaysScroll: true, tags: false, mouse: true,
    scrollbar: { ch: '│', style: { bg: 'gray' } },
  });
  private input = blessed.textbox({
    parent: this.screen, bottom: 2, height: 3, hidden: true, keys: true, tags: false,
    border: 'line', label: ' > ', style: { border: { fg: 'cyan' } },
  });
  private menu = blessed.list({
    parent: this.screen, top: 3, bottom: 2, hidden: true,
    keys: true, vi: false, mouse: true, tags: false,
    style: { selected: { bg: 'blue', fg: 'white', bold: true } },
    scrollbar: { ch: '│', style: { bg: 'gray' } },
  });
  private notice = blessed.box({ parent: this.screen, bottom: 1, height: 1, tags: false, style: { fg: 'yellow' } });
  private footer = blessed.box({ parent: this.screen, bottom: 0, height: 1, tags: false, style: { fg: 'black', bg: 'white' } });
  private view: View = 'tree';
  private selectedAgent?: string;
  private editor?: AgentEditor;
  private editField?: AgentField;
  private actionAgent?: Agent;
  private actions: { label: string; method?: LifecycleMethod; create?: boolean; edit?: boolean }[] = [];
  private pendingAction?: { method: LifecycleMethod; agentId: string; label: string };
  private skillDraft: SkillStates = {};
  private skillNames: string[] = [];
  private skillRevision = 0;
  private chatAgent?: string;
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
  private renderedEvents = new Map<number, { signature: string; text: string }>();

  constructor(private session: Session, private settings: Settings, private configPath: string) {
    this.tree.on('select item', (_item, index) => {
      if (!this.updating) this.selectedAgent = this.rows[index]?.agent.id;
    });
    this.menu.on('select item', (_item, index) => { if (!this.updating) this.menuIndex = index; });
    this.tree.key('enter', () => this.openPrompt());
    this.tree.key('c', () => this.openChat());
    this.tree.key('v', () => this.setView('view'));
    this.tree.key('s', () => this.openSkills());
    this.tree.key('a', () => this.openActions());
    this.tree.key('n', () => this.openEditor(false));
    this.tree.key('e', () => this.openEditor(true));
    this.menu.key('y', () => { if (this.view === 'confirm') void this.runAction(); });
    this.menu.key('n', () => { if (this.view === 'confirm') this.setView('tree'); });
    this.menu.key('a', () => {
      if (this.view === 'skills') this.changeSkill('available');
    });
    this.menu.key('i', () => { if (this.view === 'skills') this.changeSkill('installed'); });
    this.menu.key('u', () => { if (this.view === 'skills') this.changeSkill('unavailable'); });
    this.menu.key('+', () => {
      if (this.view === 'skills' && this.session.skillsEnabled) { this.input.setValue(''); this.setView('skill-add'); }
    });
    this.tree.key('q', () => this.close());
    this.tree.key('escape', () => {});
    this.menu.key('escape', () => this.setView('tree'));
    this.menu.key(['f', 'l'], (ch) => {
      if (this.view === 'view') this.setView(ch === 'f' ? 'filters' : 'levels');
    });
    this.menu.key('enter', () => {
      if (this.view === 'view') this.setView(this.menuIndex === 0 ? 'filters' : 'levels');
      else if (this.view === 'levels') this.changeLevel(1);
      else if (this.view === 'skills') void this.saveSkills();
      else if (this.view === 'actions') this.chooseAction();
      else if (this.view === 'agent-edit') {
        if (this.menuIndex === AGENT_FIELDS.length) void this.saveAgent();
        else this.openField();
      } else if (this.view === 'confirm') {
        if (this.menuIndex === 1) void this.runAction(); else this.setView('tree');
      }
    });
    this.menu.key('space', () => {
      if (this.view === 'filters') {
        const type = this.menuTypes[this.menuIndex];
        if (type) { this.settings.toggle(type); this.saveSettings(); this.draw(); }
      } else if (this.view === 'levels') this.changeLevel(1);
      else if (this.view === 'skills') {
        const states: SkillState[] = ['unavailable', 'available', 'installed'];
        this.changeSkill(states[(states.indexOf(this.skillDraft[this.skillNames[this.menuIndex]!] ?? 'unavailable') + 1) % 3]!);
      }
    });
    this.menu.key(['left', 'right', '1', '2', '3', '4'], (ch, key) => {
      if (this.view !== 'levels') return;
      if (key.name === 'left') this.changeLevel(-1);
      else if (key.name === 'right') this.changeLevel(1);
      else this.changeLevel(0, Number(ch) as Level);
    });
    this.input.key('C-u', () => { if (!this.sending) { this.input.setValue(''); this.screen.render(); } });
    this.input.on('submit', (value: string) => { void this.submit(value); });
    this.input.on('cancel', () => this.setView(this.view === 'agent-field' ? 'agent-edit' : 'tree'));
    this.input.key(['pageup', 'pagedown', 'C-home', 'C-end'], (_ch, key) => {
      if (this.view !== 'chat') return;
      if (key.full === 'C-end') { this.follow = true; this.chat.setScrollPerc(100); }
      else if (key.full === 'C-home') { this.follow = false; this.chat.setScroll(0); }
      else {
        this.follow = false;
        this.chat.scroll((key.name === 'pageup' ? -1 : 1) * Math.max(1, Number(this.chat.height) - 2));
      }
      this.screen.render();
    });
    this.screen.key('C-c', () => this.close());
    this.screen.on('resize', () => { this.lastTreeItems = []; this.lastChat = ''; this.renderedEvents.clear(); this.scheduleDraw(); });
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
  private changeLevel(delta: number, absolute?: Level): void {
    const type = this.menuTypes[this.menuIndex];
    if (!type) return;
    this.settings.levels[type] = absolute ?? ((this.settings.level(type) - 1 + delta + 4) % 4 + 1) as Level;
    this.saveSettings(); this.draw();
  }
  private selected(): Agent | undefined { return this.selectedAgent ? this.session.store.agents.get(this.selectedAgent) : undefined; }
  private openActions(): void {
    if (this.sending) return;
    this.actionAgent = this.selected();
    this.actions = [{ label: this.actionAgent ? 'Create child (starts immediately)' : 'Create root (starts immediately)', create: true }];
    if (this.actionAgent) this.actions.push(
      { label: 'Modify agent', edit: true },
      { label: 'Start / restart agent', method: 'agent.restart' },
      { label: 'Stop agent (descendants stay active)', method: 'agent.stop' },
      { label: 'Restart subtree (including stopped descendants)', method: 'agent.restart_subtree' },
      { label: 'Replace session (fresh conversation)', method: 'agent.replace_session' },
      { label: 'Remove agent and descendants (archive)', method: 'agent.remove' },
    );
    this.setView('actions');
  }
  private chooseAction(): void {
    if (this.sending) return;
    const action = this.actions[this.menuIndex];
    if (!action) return;
    if (action.create || action.edit) { this.openEditor(!!action.edit, this.actionAgent); return; }
    if (!action.method || !this.actionAgent) return;
    this.pendingAction = { method: action.method, agentId: this.actionAgent.id, label: `${action.label} · ${this.actionAgent.name}` };
    this.setView('confirm');
  }
  private openEditor(modify: boolean, target = this.selected()): void {
    if (this.sending || (modify && !target)) return;
    this.editor = new AgentEditor(modify ? target!.parentId : target?.id ?? null, modify ? target : undefined);
    if (!modify && target) {
      this.editor.values.harness = target.settings.harness;
      this.editor.values.model = target.settings.model ?? '';
      this.editor.values.provider = String(target.settings.provider ?? '');
    }
    this.setView('agent-edit');
  }
  private openField(): void {
    if (this.sending || !this.editor) return;
    this.editField = AGENT_FIELDS[this.menuIndex];
    if (!this.editField) return;
    this.input.setValue(this.editor.values[this.editField]);
    this.setView('agent-field');
  }
  private async saveAgent(): Promise<void> {
    const editor = this.editor;
    if (this.sending || !editor) return;
    let params: Record<string, unknown>;
    try { params = editor.params(); } catch (error) { this.showNotice((error as Error).message); return; }
    this.sending = true;
    this.showNotice('Applying agent changes · launch settings may interrupt active work…');
    try {
      const operation = await this.session.mutate(editor.agentId ? 'agent.modify' : 'agent.create', params);
      if (!editor.agentId && operation.agentId) this.selectedAgent = operation.agentId;
      if (this.view === 'agent-edit' && this.editor === editor) this.setView('tree');
    } catch (error) { this.showNotice((error as Error).message); }
    finally { this.sending = false; this.draw(); }
  }
  private async runAction(): Promise<void> {
    const action = this.pendingAction;
    if (this.sending || !action) return;
    this.sending = true;
    this.showNotice(`${action.method} in progress…`);
    try {
      await this.session.mutate(action.method, { agentId: action.agentId });
      if (this.view === 'confirm') this.setView('tree');
    } catch (error) { this.showNotice((error as Error).message); }
    finally { this.sending = false; this.draw(); }
  }
  private openSkills(): void {
    if (this.sending) return;
    const agent = this.selected();
    if (!this.session.skillsEnabled) { this.showNotice('Skills plugin is not enabled on this server.'); return; }
    if (!agent) return;
    this.skillDraft = Object.fromEntries(this.session.skills.map(skill => [skill.name,
      Object.hasOwn(this.session.skillStates(agent.id), skill.name) ? this.session.skillStates(agent.id)[skill.name] : 'unavailable']));
    this.skillRevision = agent.revision;
    this.skillNames = this.session.skills.map(skill => skill.name);
    this.setView('skills');
  }
  private changeSkill(state: SkillState): void {
    const name = this.skillNames[this.menuIndex];
    if (name && !this.sending) { this.skillDraft[name] = state; this.draw(); }
  }
  private async saveSkills(): Promise<void> {
    if (this.sending || !this.selectedAgent) return;
    this.sending = true;
    this.showNotice('Applying skills · active agents restart…');
    try {
      await this.session.setSkills(this.selectedAgent, this.skillRevision, this.skillDraft);
      if (this.view === 'skills') this.setView('tree');
    } catch (error) { this.showNotice((error as Error).message); }
    finally { this.sending = false; this.draw(); }
  }
  private openChat(): void {
    if (this.sending) return;
    const agent = this.selected();
    if (!agent) return;
    this.chatAgent = agent.id; this.follow = true; this.lastChat = ''; this.renderedEvents.clear();
    this.input.setValue('');
    this.setView('chat');
  }
  private openPrompt(): void {
    if (this.sending || !this.selected()) return;
    this.input.setValue('');
    this.setView('prompt');
  }
  private setView(view: View): void {
    this.view = view;
    this.menuIndex = 0;
    this.tree.hide(); this.menu.hide(); this.chat.hide(); this.input.hide(); this.columns.hide();
    if (view === 'tree') {
      this.tree.show(); this.columns.show(); this.tree.focus();
    } else if (['view', 'filters', 'levels', 'skills', 'actions', 'agent-edit', 'confirm'].includes(view)) {
      this.menu.show(); this.menu.focus();
    } else {
      if (view === 'chat') this.chat.show();
      this.input.show(); this.input.focus();
      if (!this.sending) this.input.readInput();
    }
    this.draw();
  }
  private async submit(value: string): Promise<void> {
    if (this.sending) return;
    if (this.view === 'agent-field' && this.editor && this.editField) {
      this.editor.values[this.editField] = value;
      const index = AGENT_FIELDS.indexOf(this.editField);
      this.setView('agent-edit'); this.menuIndex = index; this.draw();
      return;
    }
    if (this.view === 'skill-add') {
      this.sending = true;
      this.showNotice('Cloning catalog skill…');
      try {
        const data = JSON.parse(value);
        await this.session.addSkill(data.name, data.gitUrl);
        this.setView('tree');
      } catch (error) { this.showNotice((error as Error).message); }
      finally {
        this.sending = false;
        if (this.view === 'skill-add') { this.input.focus(); this.input.readInput(); }
        this.draw();
      }
      return;
    }
    const view = this.view;
    const agentId = view === 'chat' ? this.chatAgent : this.selectedAgent;
    if (!agentId || !value.trim()) { this.input.focus(); this.input.readInput(); return; }
    this.sending = true;
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
    if (this.closing) return;
    const width = Math.max(1, Number(this.screen.width));
    const store = this.session.store;
    const agent = this.view === 'chat' ? store.agents.get(this.chatAgent ?? '') : this.selected();
    const heading = this.view === 'chat' ? `Chat · ${agent?.name ?? this.chatAgent}` :
      this.view === 'prompt' ? `Interrupting prompt · ${agent?.name}` :
      this.view === 'actions' ? `Agent actions · ${this.actionAgent?.name ?? 'empty organization'}` :
      this.view === 'agent-edit' ? `${this.editor?.agentId ? 'Modify agent' : 'Create agent'} · ${this.editor?.agentId ? `revision ${this.editor.revision}` : this.editor?.parentId ? 'child' : 'root'}` :
      this.view === 'agent-field' ? `Edit ${this.editField} · ${['metadata', 'env', 'options', 'extensions'].includes(this.editField ?? '') ? 'JSON object' : 'text'}` :
      this.view === 'confirm' ? `Confirm · ${this.pendingAction?.label}` :
      this.view === 'filters' ? 'Event filters · checked events appear in tree and chat' :
      this.view === 'levels' ? 'Event rendering levels · chat uses these; tree always uses summary' :
      this.view === 'skills' ? `Skills · ${agent?.name} · changes staged until Enter` :
      this.view === 'skill-add' ? 'Add catalog skill · enter JSON {"name":"…","gitUrl":"https://…"}' :
      this.view === 'view' ? 'View settings' : 'Agent Organization';
    this.title.setContent(`${clip(heading, width)}\n${clip(`${this.session.status} · ${this.session.socketPath}`, width)}`);
    if (this.view === 'tree') {
      this.rows = store.tree();
      const selectedIndex = Math.max(0, this.rows.findIndex(row => row.agent.id === this.selectedAgent));
      this.selectedAgent = this.rows[selectedIndex]?.agent.id;
      const nameWidth = Math.min(28, Math.max(8, Math.floor(width * 0.24)));
      const stateWidth = Math.min(11, Math.max(5, Math.floor(width * 0.13)));
      const modelWidth = Math.min(30, Math.max(8, Math.floor(width * 0.23)));
      // List items reserve one cell for the scrollbar, even when it is hidden.
      const eventWidth = Math.max(0, width - nameWidth - stateWidth - modelWidth - 7);
      this.columns.setContent(clip(`${cell('AGENT', nameWidth)}  ${cell('STATUS', stateWidth)}  ${cell('MODEL', modelWidth)}  LATEST TRACKED EVENT`, width));
      const latest = store.latest(this.settings);
      this.updating = true;
      const tableItems = this.rows.map(({ agent: rowAgent, depth }) => {
        const event = latest.get(rowAgent.id);
        return `${cell(`${'  '.repeat(depth)}${depth ? '└ ' : ''}${rowAgent.name}`, nameWidth)}  ${cell(rowAgent.state, stateWidth)}  ${cell(rowAgent.settings.model ?? '—', modelWidth)}  ${event ? renderTreeEvent(event, eventWidth) : '—'}`;
      });
      if (JSON.stringify(tableItems) !== JSON.stringify(this.lastTreeItems)) {
        this.tree.setItems(tableItems); this.lastTreeItems = tableItems;
      }
      this.tree.select(selectedIndex);
      this.updating = false;
      if (!tableItems.length && (!this.notice.getContent() || this.notice.getContent().startsWith('No active agents.'))) this.notice.setContent('No active agents. Press n to create a root agent, or a for actions.');
      else if (this.notice.getContent().startsWith('No active agents.')) this.notice.setContent('');
      this.footer.setContent(` ↑↓ select  Enter prompt  c chat  a actions  n create  e edit  ${this.session.skillsEnabled ? 's skills  ' : ''}v view  q quit`);
    } else if (this.view === 'actions' || this.view === 'agent-edit' || this.view === 'confirm') {
      this.updating = true;
      this.menu.setItems(this.view === 'actions' ? this.actions.map(action => action.label) :
        this.view === 'confirm' ? ['Cancel', 'Confirm — interrupts work; subtree actions affect descendants'] :
        [...AGENT_FIELDS.map(field => clip(`${cell(field, 12)} ${field === 'env' ? '(hidden; Enter to edit)' : this.editor?.values[field] || '(omitted)'}`, width - 1)), 'Save changes']);
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(this.sending ? ' Operation in progress · Esc tree · do not retry unknown outcomes' :
        this.view === 'confirm' ? ' ↑↓ select   Enter choose   y confirm   n / Esc cancel' :
        this.view === 'agent-edit' ? ' ↑↓ field   Enter edit / save   Esc discard · launch changes restart active agents' : ' ↑↓ action   Enter open   Esc tree');
    } else if (this.view === 'skills') {
      this.updating = true;
      this.menu.setItems(this.skillNames.map(name => {
        const skill = this.session.skills.find(s => s.name === name);
        return clip(`${cell(this.skillDraft[name] ?? 'unavailable', 11)}  ${name} · ${skill?.description ?? ''}`, width - 1);
      }));
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(' ↑↓ select   Space cycle   i installed   a available   u unavailable   Enter save   + add   Esc discard');
    } else if (this.view === 'view') {
      this.updating = true;
      this.menu.setItems(['f  Event filters', 'l  Event rendering levels']);
      this.menu.select(this.menuIndex);
      this.updating = false;
      this.footer.setContent(' f filters   l levels   ↑↓ select   Enter open   Esc tree');
    } else if (this.view === 'filters' || this.view === 'levels') {
      const currentType = this.menuTypes[this.menuIndex];
      this.menuTypes = this.settings.types(store.discovered);
      if (currentType) this.menuIndex = Math.max(0, this.menuTypes.indexOf(currentType));
      this.updating = true;
      this.menu.setItems(this.menuTypes.map(type => this.view === 'filters' ?
        `[${this.settings.tracked(type) ? 'x' : ' '}] ${clean(type)}` :
        `${cell(type, Math.min(30, Math.max(12, width - 22)))}  ${this.settings.level(type)} ${LEVEL_NAMES[this.settings.level(type) - 1]}`));
      this.menu.select(this.menuIndex); this.updating = false;
      this.footer.setContent(this.view === 'filters' ? ' ↑↓ select   Space toggle tracked   Esc tree · changes saved automatically' : ' ↑↓ event   ←→ level   1 summary  2 extended  3 full  4 raw   Esc tree');
    } else if (this.view === 'chat') {
      const events = store.orderedEvents().filter(event => event.agentId === this.chatAgent);
      const blocks = chatGroups(events, this.settings).map(event => {
        const signature = JSON.stringify(event);
        const cached = this.renderedEvents.get(event.seq);
        if (cached?.signature === signature) return cached.text;
        const text = renderEvent(event, this.settings.level(event.type), Math.max(1, width - 1));
        this.renderedEvents.set(event.seq, { signature, text });
        return text;
      });
      const content = [store.historyGap ? '[History gap: earlier events have expired.]' : '', ...blocks].filter(Boolean).join('\n\n') || 'No tracked events yet.';
      if (content !== this.lastChat) {
        const scroll = this.chat.getScroll();
        this.chat.setContent(content); this.lastChat = content;
        if (this.follow) this.chat.setScrollPerc(100); else this.chat.setScroll(scroll);
      }
      this.footer.setContent(' Enter interrupt/send   PgUp/PgDn scroll   Ctrl+End follow   Esc tree');
    } else if (this.view === 'agent-field') {
      this.footer.setContent(' Enter stage field   Ctrl+U clear   Esc discard field · choose Save changes to apply');
    } else {
      this.footer.setContent(' > Type a message · Enter sends (cancels active/queued work) · Esc cancels');
    }
    this.screen.render();
  }
  close(): void {
    if (this.closing) return;
    this.closing = true;
    if (this.drawTimer) clearTimeout(this.drawTimer);
    this.session.close(); this.screen.destroy();
    void this.saveChain.finally(() => process.exit(0));
  }
}
