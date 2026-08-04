import type { AgentModelAuth, AgentModelPort, ModelCallRequest, ModelTurn } from './agent';

/**
 * Test support for the `orchestr:agent` loop — NOT in the production bundle (excluded from
 * `tsconfig.build.json`, like `*.spec.ts`); prod DI binds `AGENT_MODEL_CALL` to the real provider.
 */

/**
 * A scripted {@link AgentModelPort} replaying a fixed sequence of turns, ignoring the request. The
 * LAST turn repeats once exhausted, so an all-tool-calling script drives the loop to `max_steps`.
 */
export class ScriptedAgentModel implements AgentModelPort {
  /** How many times the loop called the model — asserts the `max_steps` bound in tests. */
  callCount = 0;
  /** The requests the loop made, in order — lets a test assert the tools/messages the loop passed. */
  readonly requests: ModelCallRequest[] = [];

  constructor(private readonly turns: ModelTurn[]) {
    if (turns.length === 0) throw new Error('ScriptedAgentModel needs at least one scripted turn');
  }

  call(req: ModelCallRequest, _auth: AgentModelAuth): Promise<ModelTurn> {
    const turn = this.turns[Math.min(this.callCount, this.turns.length - 1)]!;
    this.callCount += 1;
    // Snapshot the messages array — the loop keeps mutating its live buffer after the call.
    this.requests.push({ ...req, messages: [...req.messages] });
    return Promise.resolve(turn);
  }
}
