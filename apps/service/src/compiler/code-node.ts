import { type Location, type Message, type TransformFailure, transformSync } from 'esbuild';

import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import type { DagCodeNode, Guard } from '../runtime/dag-plan';
import {
  CODE_LANGUAGE_CHOICES,
  CODE_LANGUAGES,
  type CodeLanguage,
  type CodeNode,
  DEFAULT_CODE_LANGUAGE,
} from '../runtime/run-plan';

const TS_FRAME = '__orchestr_ts';
const FRAME_OPENING_LINES = 1;
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

interface SnippetError {
  text: string;
  line: number;
  location: Location;
}

/** The language the Code step `nodeId` runs in, absent or null meaning the default; any other throws `unsupported_code_language`. */
export function codeLanguageOf(nodeId: string, raw: unknown): CodeLanguage {
  if (raw === undefined || raw === null) return DEFAULT_CODE_LANGUAGE;
  const language = CODE_LANGUAGES.find((runnable) => runnable === raw);
  if (language) return language;
  throw new DomainError(
    `Code node "${nodeId}" has "language": ${JSON.stringify(raw)}, which the sandbox does not run — set it to ${CODE_LANGUAGE_CHOICES}, or remove it for "${DEFAULT_CODE_LANGUAGE}"`,
    400,
    { code: 'unsupported_code_language', node_id: nodeId },
  );
}

/** Lower a `CodeNode` to runnable JS; TypeScript is type-stripped, not type-checked: a syntax error fails. */
export function toDagCodeNode(node: CodeNode, guards: Guard[]): DagCodeNode {
  return {
    kind: 'code',
    id: node.id,
    code: transpileToJs(node.code, codeLanguageOf(node.id, node.language), node.id),
    guards,
    ...(node.onError === 'continue' ? { onError: 'continue' as const } : {}),
    ...(node.retry ? { retry: node.retry } : {}),
  };
}

function transpileToJs(code: string, language: CodeLanguage, nodeId: string): string {
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
  const framed = inSnippet(firstError(err), FRAME_OPENING_LINES);
  if (!framed) return `could not be transpiled: ${errorMessage(err)}`;
  const lineCount = code.split(LINE_BREAK).length;
  // Past the snippet, a stray `}` may have closed the frame early: only the bare snippet shows where.
  const shown = framed.line > lineCount ? (inSnippet(bareParseError(code), 0) ?? framed) : framed;
  return `has a TypeScript syntax error ${positionInSnippet(shown, lineCount)}: ${shown.text}`;
}

function bareParseError(code: string): Message | undefined {
  try {
    transformSync(code, { loader: 'ts' });
    return undefined;
  } catch (err) {
    return firstError(err);
  }
}

function firstError(err: unknown): Message | undefined {
  return (err as Partial<TransformFailure>).errors?.[0];
}

function inSnippet(message: Message | undefined, linesBefore: number): SnippetError | undefined {
  if (!message?.location) return undefined;
  return { text: message.text, line: message.location.line - linesBefore, location: message.location };
}

function positionInSnippet({ line, location }: SnippetError, lineCount: number): string {
  // esbuild's column counts UTF-8 bytes.
  const lineBytes = Buffer.from(location.lineText);
  const atEnd = line > lineCount || (line === lineCount && location.column >= lineBytes.length);
  if (atEnd) return 'at the end of the snippet';
  return `at line ${line}, column ${Array.from(lineBytes.subarray(0, location.column).toString()).length + 1}`;
}
