import { DomainError } from '../common/domain-error';
import { emptySettings, type IREdge, type IRNode, type WorkflowIR } from '../ir/models';
import type { DagCodeNode } from '../runtime/dag-plan';
import type { CodeNode, RunPlan } from '../runtime/run-plan';
import { compileWorkflowIrDag } from './compile-ir-dag';
import { runPlanToDag } from './run-plan-to-dag';

/**
 * Code node compilation: both producers must lower to the same `DagCodeNode` —
 * TS transpiled at compile time, guards attached, policy carried, error edges peeled.
 */

function codeIrNode(id: string, parameters: Record<string, unknown>): IRNode {
  return {
    id,
    name: id,
    node_type: 'orchestr:code',
    type_version: 1,
    parameters,
    position: { x: 0, y: 0 },
    metadata: {},
  };
}
function edge(source: string, target: string, port_type = 'main'): IREdge {
  return {
    id: `${source}->${target}:${port_type}`,
    source_node_id: source,
    source_port: 0,
    target_node_id: target,
    target_port: 0,
    port_type,
  };
}
const ir = (nodes: IRNode[], edges: IREdge[] = []): WorkflowIR => ({
  version: '1',
  name: 'code-compile',
  description: '',
  nodes,
  edges,
  settings: emptySettings(),
  metadata: {},
});

function refusalDetails(compile: () => unknown): Record<string, unknown> | undefined {
  try {
    compile();
  } catch (err) {
    return err instanceof DomainError ? err.details : undefined;
  }
  return undefined;
}
const codeNodeOf = (plan: { nodes: { id: string; kind: string }[] }, id: string): DagCodeNode =>
  plan.nodes.find((n) => n.id === id && n.kind === 'code') as DagCodeNode;

describe('code node compilation', () => {
  describe('IR path (compileWorkflowIrDag)', () => {
    it('lowers orchestr:code (js) to a DagCodeNode carrying the raw snippet + guards', () => {
      const plan = compileWorkflowIrDag(
        ir([codeIrNode('shape', { language: 'js', code: 'return steps.x;' })]),
      );
      const node = codeNodeOf(plan, 'shape');
      expect(node.kind).toBe('code');
      expect(node.code).toBe('return steps.x;');
      expect(node.guards).toEqual([]);
      // `language` is not carried onto the runtime node — it is always JS post-transpile.
      expect('language' in node).toBe(false);
    });

    it('transpiles TypeScript to JavaScript at compile time (types stripped)', () => {
      const plan = compileWorkflowIrDag(
        ir([
          codeIrNode('ts', { language: 'ts', code: 'const n: number = steps.x as number; return n + 1;' }),
        ]),
      );
      const node = codeNodeOf(plan, 'ts');
      expect(node.code).not.toContain(': number');
      expect(node.code).not.toContain(' as number');
      expect(node.code).toContain('return n + 1');
    });

    it('carries the onError/retry policy, clamped like an action', () => {
      const plan = compileWorkflowIrDag(
        ir([
          codeIrNode('c', {
            code: 'return 1;',
            onError: 'continue',
            retry: { maxAttempts: 999, backoffMs: 10 },
          }),
        ]),
      );
      const node = codeNodeOf(plan, 'c');
      expect(node.onError).toBe('continue');
      expect(node.retry).toEqual({ maxAttempts: 10, backoffMs: 10 }); // maxAttempts clamped to 10
    });

    it('peels an error edge from a code node into its onErrorBranch', () => {
      const plan = compileWorkflowIrDag(
        ir(
          [
            codeIrNode('risky', { code: 'throw new Error("x");' }),
            { ...codeIrNode('handler', { code: 'return "handled";' }) },
          ],
          [edge('risky', 'handler', 'error')],
        ),
      );
      const node = codeNodeOf(plan, 'risky');
      expect(node.onErrorBranch?.nodes.map((n) => n.id)).toEqual(['handler']);
      // The handler is NOT in the main flow (it lives in the peeled lane).
      expect(plan.nodes.some((n) => n.id === 'handler')).toBe(false);
    });

    it('rejects a code node with no snippet', () => {
      expect(() => compileWorkflowIrDag(ir([codeIrNode('empty', { code: '   ' })]))).toThrow(/non-empty/);
    });

    it('refuses a language the sandbox does not run, rather than running the snippet as JavaScript', () => {
      for (const language of ['python', 'typescript', 'javascript', '', 5]) {
        const step = { ...codeIrNode('py', { language, code: 'return 1;' }), name: 'Score it' };
        expect(() => compileWorkflowIrDag(ir([step]))).toThrow(
          new DomainError(
            `Code node "py" has "language": ${JSON.stringify(language)}, which the sandbox does not run — set it to "js" or "ts", or remove it for "js"`,
          ),
        );
        expect(refusalDetails(() => compileWorkflowIrDag(ir([step])))).toEqual({
          code: 'unsupported_code_language',
          node_id: 'py',
        });
      }
    });

    it('runs a snippet with no language, or a null one, as JavaScript, untouched', () => {
      for (const parameters of [{}, { language: null }]) {
        const plan = compileWorkflowIrDag(
          ir([codeIrNode('plain', { ...parameters, code: 'const n = 1; return n;' })]),
        );
        expect(codeNodeOf(plan, 'plain').code).toBe('const n = 1; return n;');
      }
    });

    it('rejects a TypeScript snippet that does not compile', () => {
      expect(() =>
        compileWorkflowIrDag(ir([codeIrNode('bad', { language: 'ts', code: 'const x: = ;' })])),
      ).toThrow('Code node "bad" has a TypeScript syntax error at line 1, column 10: Unexpected "="');
    });
  });

  describe('raw-plan path (runPlanToDag)', () => {
    it('lowers a CodeNode (with guards from sibling order) and its error lane', () => {
      const code: CodeNode = {
        kind: 'code',
        id: 'transform',
        language: 'ts',
        code: 'const v: number = 1; return v;',
        onErrorBranch: [{ kind: 'action', id: 'onFail', actionId: 'log.write', props: {} }],
      };
      const plan: RunPlan = {
        id: 'p',
        nodes: [{ kind: 'action', id: 'first', actionId: 'a.b', props: {} }, code],
      };
      const dag = runPlanToDag(plan);
      const node = codeNodeOf(dag, 'transform');
      expect(node.code).not.toContain(': number');
      expect(node.guards).toEqual([{ source: 'first', port: 0 }]); // runs after the previous sibling
      expect(node.onErrorBranch?.nodes.map((n) => n.id)).toEqual(['onFail']);
    });

    it('refuses a language the sandbox does not run, rather than transpiling it as TypeScript', () => {
      const code = { kind: 'code', id: 'py', language: 'python', code: 'return 1;' } as unknown as CodeNode;
      expect(() => runPlanToDag({ id: 'p', nodes: [code] })).toThrow(
        'Code node "py" has "language": "python", which the sandbox does not run — set it to "js" or "ts", or remove it for "js"',
      );
      expect(refusalDetails(() => runPlanToDag({ id: 'p', nodes: [code] }))).toEqual({
        code: 'unsupported_code_language',
        node_id: 'py',
      });
    });

    it('runs a snippet with no language as JavaScript, untouched, rather than transpiling it as TypeScript', () => {
      const dag = runPlanToDag({
        id: 'p',
        nodes: [{ kind: 'code', id: 'plain', code: 'const n = 1; return n;' }],
      });
      expect(codeNodeOf(dag, 'plain').code).toBe('const n = 1; return n;');
    });
  });
});
