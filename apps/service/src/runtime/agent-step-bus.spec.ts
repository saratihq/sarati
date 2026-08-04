import { firstValueFrom, toArray } from 'rxjs';

import type { AgentStep } from './agent';
import { AgentStepBus, channelKey, type SequencedStep } from './agent-step-bus';

const step = (i: number, kind: AgentStep['kind']): AgentStep => ({ step_index: i, kind });
const seq = (n: number, s: AgentStep): SequencedStep => ({ seq: n, step: s });

describe('AgentStepBus', () => {
  it('delivers published steps to a live subscriber, in order with a monotonic seq, until the channel closes', async () => {
    const bus = new AgentStepBus();
    const collected = firstValueFrom(bus.subscribe('s1').pipe(toArray()));

    bus.publish('s1', step(0, 'model'));
    bus.publish('s1', step(1, 'tool'));
    bus.publish('s1', step(2, 'final'));
    bus.close('s1');

    expect(await collected).toEqual([
      seq(1, step(0, 'model')),
      seq(2, step(1, 'tool')),
      seq(3, step(2, 'final')),
    ]);
  });

  it('drops a publish with no live subscriber and never allocates a channel', () => {
    const bus = new AgentStepBus();
    // No subscribe → publish is a silent drop, and the map stays empty (no unbounded growth).
    expect(() => bus.publish('ghost', step(0, 'model'))).not.toThrow();
    expect(bus.openSessionCount).toBe(0);
  });

  it('cleans up the channel when the last subscriber unsubscribes (no leak)', () => {
    const bus = new AgentStepBus();
    const sub = bus.subscribe('s2').subscribe();
    expect(bus.openSessionCount).toBe(1);
    sub.unsubscribe();
    expect(bus.openSessionCount).toBe(0);
  });

  it('cleans up the channel when the run closes it (no leak)', () => {
    const bus = new AgentStepBus();
    const seen: SequencedStep[] = [];
    bus.subscribe('s3').subscribe((s) => seen.push(s));
    bus.publish('s3', step(0, 'final'));
    bus.close('s3');
    expect(seen).toEqual([seq(1, step(0, 'final'))]);
    expect(bus.openSessionCount).toBe(0);
    // Closing an already-closed / unknown channel is an idempotent no-op.
    expect(() => bus.close('s3')).not.toThrow();
    expect(() => bus.close('never')).not.toThrow();
  });

  it('isolates one channel from another (keyed by the channel key)', () => {
    const bus = new AgentStepBus();
    const a: SequencedStep[] = [];
    const b: SequencedStep[] = [];
    bus.subscribe('a').subscribe((s) => a.push(s));
    bus.subscribe('b').subscribe((s) => b.push(s));
    bus.publish('a', step(0, 'model'));
    expect(a).toEqual([seq(1, step(0, 'model'))]);
    expect(b).toEqual([]);
    bus.close('a');
    bus.close('b');
  });

  it('assigns a channel-unique monotonic seq that never resets across overlapping step_index spaces', () => {
    // Two agent-loop invocations on ONE channel each restart step_index at 0, so the seq
    // must keep climbing or the wire order regresses.
    const bus = new AgentStepBus();
    const seen: SequencedStep[] = [];
    bus.subscribe('run').subscribe((s) => seen.push(s));
    // invocation #1
    bus.publish('run', step(0, 'model'));
    bus.publish('run', step(1, 'final'));
    // invocation #2 — step_index resets to 0/1 again
    bus.publish('run', step(0, 'model'));
    bus.publish('run', step(1, 'final'));
    bus.close('run');
    expect(seen.map((s) => s.seq)).toEqual([1, 2, 3, 4]); // strictly monotonic, no collision
    expect(seen.map((s) => s.step.step_index)).toEqual([0, 1, 0, 1]); // payload index still per-invocation
  });

  it('channelKey scopes a session id to its workflow+env (canonicalizing prod→production)', () => {
    expect(channelKey('wf1', 'production', 's')).toBe('wf1:production:s');
    // Same session id, different workflow → different channel (no cross-read).
    expect(channelKey('wf2', 'production', 's')).not.toBe(channelKey('wf1', 'production', 's'));
    // Env canonicalizes so the POST and the events path rendezvous even across the prod alias.
    expect(channelKey('wf1', 'prod', 's')).toBe(channelKey('wf1', 'production', 's'));
  });
});
