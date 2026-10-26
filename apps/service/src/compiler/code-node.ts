import { type Location, type TransformFailure, transformSync } from 'esbuild';

import { errorMessage } from '../common/error-message';
import type { DagCodeNode, Guard } from '../runtime/dag-plan';
import type { CodeNode } from '../runtime/run-plan';

const TS_FRAME = '__orchestr_ts';
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** Lower a `CodeNode` to runnable JS; TypeScript is type-stripped, not type-checked: a syntax error fails. */
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

function transpileToJs(code: string, language: 'js' | 'ts', nodeId: string): string {
  if (language === 'js') return code;
  try {
    // Transpiled as the async function body it runs as: on its own, `await` makes `return` illegal.
    const framed = transformSync(`const ${TS_FRAME} = async () => {\n${code}\n};`, { loader: 'ts' }).code;
    return `${framed}return ${TS_FRAME}();\n`;
  } catch (err) {
    throw new Error(`Code node "${nodeId}" ${transpileFailure(err, code)}`);
  }
}

function transpileFailure(err: unknown, code: string): string {
  const first = (err as Partial<TransformFailure>).errors?.[0];
  if (!first?.location) return `could not be transpiled: ${errorMessage(err)}`;
  return `has a TypeScript syntax error ${positionInSnippet(first.location, code)}: ${first.text}`;
}

function positionInSnippet(location: Location, code: string): string {
  // esbuild's line counts the frame's opening line, and its column is in UTF-8 bytes.
  const line = location.line - 1;
  if (line > code.split(LINE_BREAK).length) return 'at the end of the snippet';
  const before = Buffer.from(location.lineText).subarray(0, location.column).toString();
  return `at line ${line}, column ${Array.from(before).length + 1}`;
}
