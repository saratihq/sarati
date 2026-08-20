import { compileWorkflowIrDag } from './compile-ir-dag';
import { emptySettings, type WorkflowIR } from '../ir/models';

/** "Wait three days, then follow up" — the shape a multi-day sequence needs on the canvas. */
function waitIr(parameters: Record<string, unknown>): WorkflowIR {
  return {
    version: '1.0',
    name: 'wait',
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'Start',
        node_type: 'orchestr:webhook',
        type_version: 1,
        position: { x: 0, y: 0 },
        metadata: {},
        parameters: {},
      },
      {
        id: 'pause',
        name: 'Wait',
        node_type: 'orchestr:wait_for_duration',
        type_version: 1,
        position: { x: 300, y: 0 },
        metadata: {},
        parameters,
      },
    ],
    edges: [
      {
        id: 'e1',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'pause',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: emptySettings(),
    metadata: {},
  };
}

describe('a wait measured in days compiles to a delay', () => {
  it('turns days into milliseconds', () => {
    const plan = compileWorkflowIrDag(waitIr({ amount: 3, unit: 'days' }));
    expect(plan.nodes.find((n) => n.id === 'pause')).toMatchObject({ kind: 'delay', ms: 259_200_000 });
  });

  it('supports the shorter units too', () => {
    const msFor = (amount: number, unit: string): unknown =>
      compileWorkflowIrDag(waitIr({ amount, unit })).nodes.find((n) => n.id === 'pause');
    expect(msFor(90, 'minutes')).toMatchObject({ kind: 'delay', ms: 5_400_000 });
    expect(msFor(6, 'hours')).toMatchObject({ kind: 'delay', ms: 21_600_000 });
  });

  it('refuses a wait with no duration rather than running one of zero', () => {
    expect(() => compileWorkflowIrDag(waitIr({ unit: 'days' }))).toThrow(/needs an "amount"/);
    expect(() => compileWorkflowIrDag(waitIr({ amount: 0, unit: 'days' }))).toThrow(/needs an "amount"/);
    expect(() => compileWorkflowIrDag(waitIr({ amount: -2, unit: 'days' }))).toThrow(/needs an "amount"/);
  });

  it('names the units it accepts when given one it does not', () => {
    expect(() => compileWorkflowIrDag(waitIr({ amount: 3, unit: 'fortnights' }))).toThrow(
      /needs a "unit" of minutes, hours, days/,
    );
  });
});
