import { DomainError } from '../common/domain-error';
import { CodeRunner, type CodeInput } from './code-runner';

/**
 * The sandbox proof: every guarantee making it safe to run user code is a NAMED test —
 * the boundary (no host reach), the bounds (time / memory / stack), and the marshalling. Isolation
 * is structural (the engine runs inside WASM), but assert it rather than assume it.
 */
describe('CodeRunner (WASM sandbox)', () => {
  const runner = new CodeRunner();
  const emptyInput: CodeInput = { steps: {}, trigger: undefined };
  const run = (
    code: string,
    input: CodeInput = emptyInput,
    timeoutMs?: number,
    memoryLimitBytes?: number,
    outputLimitBytes?: number,
  ) => runner.run({ code, input, timeoutMs, memoryLimitBytes, outputLimitBytes });

  describe('I/O contract', () => {
    it('maps input → output: reads steps.<id>.field and returns a transformed object', async () => {
      const input: CodeInput = { steps: { calc: { body: { a: 40, b: 2 } } }, trigger: undefined };
      const out = await run('return { total: steps.calc.body.a + steps.calc.body.b };', input);
      expect(out).toEqual({ total: 42 });
    });

    it('exposes the trigger payload as `trigger`', async () => {
      const input: CodeInput = { steps: { trigger: { name: 'ada' } }, trigger: { name: 'ada' } };
      expect(await run('return trigger.name.toUpperCase();', input)).toBe('ADA');
    });

    it('awaits an async snippet (async/await inside the sandbox)', async () => {
      const input: CodeInput = { steps: { n: 21 }, trigger: undefined };
      expect(await run('return await Promise.resolve(steps.n * 2);', input)).toBe(42);
    });

    it('a bare snippet with no return produces null', async () => {
      expect(await run('const x = 5;')).toBeNull();
    });

    it('coerces to the JSON data model (NaN/Infinity → null, undefined dropped)', async () => {
      expect(await run('return { a: NaN, b: Infinity, c: undefined, d: 1 };')).toEqual({
        a: null,
        b: null,
        d: 1,
      });
    });

    it('returns a deep copy — no live handle; the value is a plain host object', async () => {
      const out = await run('return { nested: { arr: [1, 2, 3] } };');
      expect(out).toEqual({ nested: { arr: [1, 2, 3] } });
      // A plain, mutable, structured-clone-equal host value (not a proxy/handle).
      (out as { nested: { arr: number[] } }).nested.arr.push(4);
      expect((out as { nested: { arr: number[] } }).nested.arr).toEqual([1, 2, 3, 4]);
    });

    it('cannot mutate the host scope (input is JSON-copied into the isolate)', async () => {
      const input: CodeInput = { steps: { data: { count: 1 } }, trigger: undefined };
      await run('steps.data.count = 999; return steps.data.count;', input);
      expect(input.steps.data).toEqual({ count: 1 }); // host object untouched
    });
  });

  describe('failure modes → clean DomainError', () => {
    it('a snippet that throws surfaces as a DomainError (message preserved)', async () => {
      await expect(run('throw new Error("kaboom");')).rejects.toMatchObject({
        constructor: DomainError,
        message: expect.stringContaining('kaboom'),
      });
    });

    it('a syntax error is a clean compile failure', async () => {
      await expect(run('return ((;')).rejects.toBeInstanceOf(DomainError);
    });

    it('a return value with a circular reference fails cleanly (not a host crash)', async () => {
      await expect(run('const o = {}; o.self = o; return o;')).rejects.toBeInstanceOf(DomainError);
    });
  });

  describe('resource bounds', () => {
    it('kills a CPU-bound infinite loop at the time limit (fast, does not hang)', async () => {
      const started = Date.now();
      await expect(run('while (true) {}', emptyInput, 300)).rejects.toMatchObject({
        constructor: DomainError,
        message: expect.stringContaining('timed out'),
      });
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('kills a never-resolving await at the time limit (async hang guard)', async () => {
      const started = Date.now();
      await expect(run('await new Promise(() => {}); return 1;', emptyInput, 300)).rejects.toMatchObject({
        constructor: DomainError,
        message: expect.stringContaining('timed out'),
      });
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('kills a memory bomb at the memory limit', async () => {
      await expect(
        run('const a = []; for (;;) a.push(new Array(100000).fill(1));', emptyInput, 5000, 24 * 1024 * 1024),
      ).rejects.toMatchObject({ constructor: DomainError, message: expect.stringContaining('memory') });
    }, 15000);

    it('a runaway recursion overflows the guest stack, not the host', async () => {
      await expect(run('function f() { return 1 + f(); } return f();')).rejects.toBeInstanceOf(DomainError);
    });

    it('rejects an output over the size cap — before the giant payload lands in the run record (B10)', async () => {
      // ~2KB return against a 1KB cap → a clean node failure, not a huge value passed through.
      await expect(
        run(`return 'x'.repeat(2000);`, emptyInput, undefined, undefined, 1024),
      ).rejects.toMatchObject({
        constructor: DomainError,
        message: expect.stringMatching(/too much data|output limit/i),
      });
    });

    it('allows an output under the cap unchanged', async () => {
      const out = await run(`return 'x'.repeat(100);`, emptyInput, undefined, undefined, 1024);
      expect(out).toBe('x'.repeat(100));
    });
  });

  describe('isolation — no host capability is reachable', () => {
    it('process / require / fetch / setTimeout / global / Buffer are all absent', async () => {
      const out = await run(
        'return { process: typeof process, require: typeof require, fetch: typeof fetch, setTimeout: typeof setTimeout, global: typeof global, Buffer: typeof Buffer, module: typeof module };',
      );
      expect(out).toEqual({
        process: 'undefined',
        require: 'undefined',
        fetch: 'undefined',
        setTimeout: 'undefined',
        global: 'undefined',
        Buffer: 'undefined',
        module: 'undefined',
      });
    });

    it('the Function-constructor escape hatch cannot reach the host', async () => {
      // A classic vm-escape probe: reach a host global via `(function(){}).constructor`.
      // In the WASM isolate there is no host to reach — process stays undefined.
      expect(await run('return typeof (function(){}).constructor("return typeof process")();')).toBe(
        'string',
      );
      expect(await run('return (function(){}).constructor("return typeof process")();')).toBe('undefined');
    });

    it('the injected input global is cleaned up — the snippet sees only steps/trigger', async () => {
      expect(await run('return typeof globalThis.__ORCHESTR_CODE_INPUT__;')).toBe('undefined');
    });
  });

  describe('lifecycle stability', () => {
    it('stays healthy and does not leak across many sequential runs (incl. killed ones)', async () => {
      for (let i = 0; i < 10; i++) {
        await expect(run('await new Promise(() => {}); return 1;', emptyInput, 50)).rejects.toBeInstanceOf(
          DomainError,
        );
      }
      expect(await run('return 42;')).toBe(42);
    }, 15000);
  });
});
