import type { Skill, SkillState, SkillStates } from './protocol.js';

export interface SkillChoice extends Skill {
  state: SkillState;
  retainedUnknown?: boolean;
}

/** Drafts a complete replacement map while retaining untouched legacy selections. */
export class SkillSelectionDraft {
  readonly catalog: readonly Skill[];
  private readonly baseline: SkillStates;
  private current: SkillStates;
  constructor(catalog: readonly Skill[], existing: SkillStates = {}) {
    this.catalog = structuredClone(catalog);
    this.baseline = structuredClone(existing);
    this.current = structuredClone(existing);
  }
  get dirty(): boolean {
    const keys = Object.keys(this.current);
    return keys.length !== Object.keys(this.baseline).length || keys.some(key => this.current[key] !== this.baseline[key]);
  }
  get states(): SkillStates { return structuredClone(this.current); }
  choices(): SkillChoice[] {
    const known = new Set(this.catalog.map(skill => skill.name));
    return [
      ...this.catalog.map(skill => ({ ...skill, state: Object.hasOwn(this.current, skill.name) ? this.current[skill.name]! : 'unavailable' as SkillState })),
      ...Object.entries(this.current).filter(([name]) => !known.has(name)).map(([name, state]) => ({
        name, gitUrl: '', description: 'Not present in the current catalog; retained until explicitly removed.', state, retainedUnknown: true,
      })),
    ];
  }
  setState(name: string, state: Exclude<SkillState, 'unavailable'>): void {
    if (!this.catalog.some(skill => skill.name === name)) throw new Error(`Unknown catalog skill ${name}`);
    this.current = { ...this.current, [name]: state };
  }
  replace(states: SkillStates): void {
    for (const [name, state] of Object.entries(states)) {
      if (!['unavailable', 'available', 'installed'].includes(state)) throw new Error(`Invalid state for ${name}`);
      if (!this.catalog.some(skill => skill.name === name) && (!Object.hasOwn(this.current, name) || this.current[name] !== state))
        throw new Error(`Cannot add unknown retained skill ${name}`);
    }
    this.current = structuredClone(states);
  }
  remove(name: string): void {
    if (!Object.hasOwn(this.current, name)) return;
    const next = { ...this.current };
    delete next[name];
    this.current = next;
  }
}
