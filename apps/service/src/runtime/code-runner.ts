import releaseAsyncVariant from '@jitl/quickjs-singlefile-cjs-release-asyncify';
import { Injectable, Logger } from '@nestjs/common';
import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncContext,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncWASMModule,
  type QuickJSHandle,
} from 'quickjs-emscripten';

import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';

/** Wall-clock ceiling per snippet (ADR 0027) — enforced by BOTH the interrupt handler (CPU-bound
 *  loops) and the host poll loop (a suspended `await`, which queues no job to interrupt). */
export const CODE_TIME_LIMIT_MS = 5_000;

/** Per-execution heap ceiling (ADR 0027); an allocation past it throws `out of memory` in the guest. */
export const CODE_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;

/** Max serialized size of a code node's return value — it lands in the run record AND every
 *  downstream scope, so it is capped before the guest string is parsed into the host. */
export const CODE_OUTPUT_LIMIT_BYTES = 1024 * 1024; // 1 MiB

/** Guest call-stack ceiling — must stay BELOW the host V8 stack, else the host overflows first and
 *  raises a raw `RangeError` instead of QuickJS's clean guest `stack overflow`. */
const CODE_STACK_LIMIT_BYTES = 256 * 1024;

/** The one input a snippet receives — the run scope plus a `trigger` convenience alias (ADR 0027). */
export interface CodeInput {
  /** Prior steps' outputs, keyed by node id — the SAME shape references resolve against. */
  steps: Record<string, unknown>;
  /** The firing event payload (alias of `steps.trigger`), for convenience. */
  trigger: unknown;
}

export interface CodeRunOptions {
  /** Runnable JavaScript (TS is transpiled to JS at compile time — the runner only ever sees JS). */
  code: string;
  /** The data injected as `steps` / `trigger` inside the snippet. */
  input: CodeInput;
  /** Wall-clock ceiling; defaults to {@link CODE_TIME_LIMIT_MS}. */
  timeoutMs?: number;
  /** Heap ceiling in bytes; defaults to {@link CODE_MEMORY_LIMIT_BYTES}. */
  memoryLimitBytes?: number;
  /** Max serialized output size in bytes; defaults to {@link CODE_OUTPUT_LIMIT_BYTES}. */
  outputLimitBytes?: number;
}

/** Global the input is injected under; deleted after parse so the snippet sees only `steps`/`trigger`. */
const INPUT_GLOBAL = '__ORCHESTR_CODE_INPUT__';

/**
 * Wrap the user snippet as an async function body. The output marshals OUT via a guest-side
 * `JSON.stringify`, not a live-handle copy: circular-safe, JSON-shaped, and no QuickJS handle
 * can escape. `undefined` (no `return`) marshals to `null`.
 */
function wrap(code: string): string {
  return `(async () => {
  "use strict";
  const { steps, trigger } = JSON.parse(globalThis.${INPUT_GLOBAL});
  delete globalThis.${INPUT_GLOBAL};
  const __orchestr_run = async () => {
${code}
  };
  const __orchestr_result = await __orchestr_run();
  return JSON.stringify(__orchestr_result === undefined ? null : __orchestr_result);
})()`;
}

/** Yield to the host event loop so a resolving guest promise's job can settle before the next poll. */
const yieldToHost = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Process-wide lazy singleton WASM module — each execution still gets its OWN runtime + context
 * (own heap, limit, deadline), so runs share no state while the WASM arena is paid once. The
 * `singlefile-cjs` variant embeds the WASM, so it loads under CommonJS/Jest and survives
 * `nest build` → `node dist` with no runtime asset-path resolution.
 */
let modulePromise: Promise<QuickJSAsyncWASMModule> | null = null;
function quickJsModule(): Promise<QuickJSAsyncWASMModule> {
  modulePromise ??= newQuickJSAsyncWASMModuleFromVariant(releaseAsyncVariant);
  return modulePromise;
}

/**
 * Runs a user snippet in a REAL sandbox: the JS engine itself runs inside WebAssembly (QuickJS via
 * `quickjs-emscripten`), so Node, V8, `require`, `process`, `fetch`, the filesystem and the network
 * are simply absent (ADR 0027 — never swap this for `node:vm`). Only the injected input and the
 * JSON-marshalled return value cross the boundary. Every execution is bounded by a wall-clock
 * deadline, a heap limit and a stack limit; every failure becomes a clean {@link DomainError}.
 */
@Injectable()
export class CodeRunner {
  private readonly logger = new Logger(CodeRunner.name);

  /** Run one snippet and return its JSON-shaped output; every guest failure mode is a {@link DomainError}. */
  async run(opts: CodeRunOptions): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? CODE_TIME_LIMIT_MS;
    const memoryLimitBytes = opts.memoryLimitBytes ?? CODE_MEMORY_LIMIT_BYTES;
    const outputLimitBytes = opts.outputLimitBytes ?? CODE_OUTPUT_LIMIT_BYTES;
    const inputJson = this.serializeInput(opts.input);

    const mod = await quickJsModule();
    const runtime = mod.newRuntime();
    runtime.setMemoryLimit(memoryLimitBytes);
    runtime.setMaxStackSize(CODE_STACK_LIMIT_BYTES);
    const deadline = Date.now() + timeoutMs;
    runtime.setInterruptHandler(() => Date.now() > deadline);
    const context = runtime.newContext();
    try {
      return await this.evaluate(
        context,
        runtime,
        opts.code,
        inputJson,
        deadline,
        timeoutMs,
        outputLimitBytes,
      );
    } catch (err) {
      // A raw host error must never escape the sandbox boundary.
      if (err instanceof DomainError) throw err;
      throw new DomainError(`Code node failed: ${errorMessage(err)}`);
    } finally {
      // Disposal order is load-bearing: context BEFORE runtime, else a live context at
      // runtime-free trips a QuickJS GC assert. A cleanup warning never masks the outcome.
      try {
        context.dispose();
        runtime.dispose();
      } catch (err) {
        this.logger.warn(`code sandbox disposal warning: ${errorMessage(err)}`);
      }
    }
  }

  /** Inject the input, run the wrapped snippet, and return its settled output. */
  private async evaluate(
    context: QuickJSAsyncContext,
    runtime: QuickJSAsyncRuntime,
    code: string,
    inputJson: string,
    deadline: number,
    timeoutMs: number,
    outputLimitBytes: number,
  ): Promise<unknown> {
    const inputHandle = context.newString(inputJson);
    context.setProp(context.global, INPUT_GLOBAL, inputHandle);
    inputHandle.dispose();

    const evalResult = await context.evalCodeAsync(wrap(code));
    if (evalResult.error) {
      const message = this.messageFrom(context.dump(evalResult.error));
      evalResult.error.dispose();
      throw new DomainError(`Code node failed to compile: ${message}`);
    }
    // The wrapper is an async IIFE, so its value is a guest Promise. Pump the job queue
    // and poll the promise's state until it settles or the deadline passes.
    const promiseHandle = evalResult.value;
    try {
      return await this.settle(context, runtime, promiseHandle, deadline, timeoutMs, outputLimitBytes);
    } finally {
      promiseHandle.dispose();
    }
  }

  /** JSON-encode the injected input; a non-serializable scope is the caller's bug, surfaced cleanly. */
  private serializeInput(input: CodeInput): string {
    try {
      return JSON.stringify({ steps: input.steps, trigger: input.trigger });
    } catch (err) {
      throw new DomainError(`Code node input is not serializable: ${errorMessage(err)}`);
    }
  }

  /**
   * Drive the guest promise to settlement: run pending jobs, then read the state. Still pending past
   * the deadline is the async-hang guard — a suspended `await` queues no job for the interrupt handler.
   */
  private async settle(
    context: QuickJSAsyncContext,
    runtime: QuickJSAsyncRuntime,
    promiseHandle: QuickJSHandle,
    deadline: number,
    timeoutMs: number,
    outputLimitBytes: number,
  ): Promise<unknown> {
    for (;;) {
      runtime.executePendingJobs();
      const state = context.getPromiseState(promiseHandle);
      if (state.type === 'fulfilled') {
        // `dump` is typed `any` at the WASM boundary — pin it to `unknown` so none leaks past here.
        const json: unknown = context.dump(state.value);
        state.value.dispose();
        return this.parseOutput(json, outputLimitBytes);
      }
      if (state.type === 'rejected') {
        const message = this.messageFrom(context.dump(state.error));
        state.error.dispose();
        // The interrupt handler only trips past the deadline, so an `interrupted` rejection IS
        // a timeout — report it as one, unifying the CPU-loop and async-hang paths.
        if (message === 'interrupted' && Date.now() > deadline) {
          throw new DomainError(`Code node timed out after ${timeoutMs}ms`);
        }
        throw new DomainError(`Code node threw: ${message}`);
      }
      if (Date.now() > deadline) {
        throw new DomainError(`Code node timed out after ${timeoutMs}ms`);
      }
      await yieldToHost();
    }
  }

  /** Parse the guest's JSON output string back into a plain host value, capping its size. */
  private parseOutput(json: unknown, limitBytes: number): unknown {
    if (typeof json !== 'string') return null; // defensive; the wrapper always returns a string
    // Cap BEFORE parse — bytes, not chars, since the run scope is UTF-8 JSON.
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > limitBytes) {
      throw new DomainError(
        `Code node returned too much data — ${Math.ceil(bytes / 1024)}KB exceeds the ${Math.round(
          limitBytes / 1024,
        )}KB output limit. Return a summary or a reference instead of the full payload.`,
      );
    }
    return JSON.parse(json);
  }

  /** Pull a readable message out of a dumped guest error (an Error-shaped object, or anything). */
  private messageFrom(dumped: unknown): string {
    if (dumped && typeof dumped === 'object' && 'message' in dumped) {
      const message = (dumped as { message?: unknown }).message;
      if (typeof message === 'string' && message.length > 0) return message;
    }
    return typeof dumped === 'string' ? dumped : JSON.stringify(dumped);
  }
}
