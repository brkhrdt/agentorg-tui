import type { Skill, SkillState, SkillStates } from './protocol.js';

export interface SkillChoice extends Skill {
  state: SkillState;
  retainedUnknown?: boolean;
  stale?: boolean;
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
  choices(catalog: readonly Skill[] = this.catalog, states: SkillStates = this.current): SkillChoice[] {
    const known = new Set(catalog.map(skill => skill.name));
    return [
      ...catalog.map(skill => ({ ...skill, state: Object.hasOwn(states, skill.name) ? states[skill.name]! : 'unavailable' as SkillState })),
      ...Object.entries(states).filter(([name]) => !known.has(name)).map(([name, state]) => {
        const previous = this.catalog.find(skill => skill.name === name);
        return {
          ...previous, name, gitUrl: previous?.gitUrl ?? '', description: previous?.description ?? 'Not present in the current catalog; retained until explicitly removed.', state,
          retainedUnknown: true, stale: state !== this.baseline[name] && !(this.baseline[name] === 'installed' && state === 'available'),
        };
      }),
    ];
  }
  staleSelections(catalog: readonly Skill[]): string[] {
    const known = new Set(catalog.map(skill => skill.name));
    return Object.entries(this.current).filter(([name, state]) => state !== 'unavailable' && !known.has(name) && state !== this.baseline[name] && !(this.baseline[name] === 'installed' && state === 'available')).map(([name]) => name);
  }
  setState(name: string, state: Exclude<SkillState, 'unavailable'>, catalog: readonly Skill[] = this.catalog): void {
    if (!catalog.some(skill => skill.name === name)) throw new Error(`Unknown catalog skill ${name}`);
    this.current = { ...this.current, [name]: state };
  }
  replace(states: SkillStates, catalog: readonly Skill[] = this.catalog): void {
    for (const [name, state] of Object.entries(states)) {
      if (!['unavailable', 'available', 'installed'].includes(state)) throw new Error(`Invalid state for ${name}`);
      if (!catalog.some(skill => skill.name === name) && (!Object.hasOwn(this.current, name) || (this.current[name] !== state && !(this.current[name] === 'installed' && state === 'available'))))
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
