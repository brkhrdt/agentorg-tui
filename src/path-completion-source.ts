import type { Session } from './session.js';
import type { PathCandidate } from './path-input.js';

export interface PathCompletionContext { recipientId: string; cwd: string; sourceId: string }
export interface PathCompletionSource {
  readonly id: string;
  complete(context: PathCompletionContext, input: string): Promise<PathCandidate[]>;
}

/** Initial source is explicitly the AgentOrg server host filesystem. */
export class HostPathCompletionSource implements PathCompletionSource {
  readonly id = 'organization.paths:host';
  constructor(private readonly session: Session) {}
  async complete(context: PathCompletionContext, input: string): Promise<PathCandidate[]> {
    if (!this.session.pathCompletion) throw new Error('Server path completion is not advertised');
    if (!context.recipientId || !context.cwd || context.sourceId !== this.id) throw new Error('Recipient path context is unavailable');
    // `.//` and `./~` are compose-friendly root/home shorthands. Normalize only
    // the lookup spelling; retain the user's prefix when a candidate is inserted.
    const lookupInput = input.startsWith('.//') ? input.slice(2) : input === './~' ? '~/' : input.startsWith('./~/') ? `~/${input.slice(4)}` : input;
    const result = await this.session.completePath(lookupInput, context.cwd, 'any');
    if (!this.session.pathCompletion) throw new Error('Server path completion is unavailable');
    return result.entries;
  }
}
