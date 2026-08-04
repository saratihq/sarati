import { transformSync } from 'esbuild';

import { errorMessage } from '../common/error-message';
import type { DagCodeNode, Guard } from '../runtime/dag-plan';
import type { CodeNode } from '../runtime/run-plan';

/**
 * Lower a `CodeNode` (ADR 0027) to its executable `DagCodeNode` — the ONE place both compilers turn
 * a snippet into runtime form, so the transpile + policy mapping never drifts. TypeScript is
 * transpiled HERE, at compile time, so the runtime only ever executes JS and a type error fails the
 * plan build. The caller attaches the error lane.
 */
export function toDagCodeNode(node: CodeNode, guards: Guard[]): DagCodeNode {
  return {
    kind: 'code',
    id: node.id,
    code: transpileToJs(node.code, node.language, node.id),
    guards,
    ...(node.onError === 'continue' ? { onError: 'continue' as const } : {}),
    ...(node.retry ? { retry: node.retry } : {}),
  };
}

/** Transpile a snippet to runnable JS; `js` passes through, `ts` is type-stripped by esbuild. */
function transpileToJs(code: string, language: 'js' | 'ts', nodeId: string): string {
  if (language === 'js') return code;
  try {
    return transformSync(code, { loader: 'ts' }).code;
  } catch (err) {
    throw new Error(`Code node "${nodeId}" has a TypeScript error: ${errorMessage(err)}`);
  }
}
