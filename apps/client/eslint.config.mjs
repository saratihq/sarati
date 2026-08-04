import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // These are React-Compiler advisory rules that ship as errors in
      // eslint-plugin-react-hooks v7 but did NOT exist in the source project's
      // ruleset. This is a faithful re-platform, not a rewrite — the ported
      // code is behaviorally identical to the source, so keep these as warnings
      // (best-practice hints) rather than build-blocking errors. Genuine
      // correctness rules (rules-of-hooks, exhaustive-deps) stay as-is.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      // Cosmetic: React renders raw apostrophes/quotes in JSX text fine. The
      // source project did not enforce this, so keep re-platformed copy verbatim.
      "react/no-unescaped-entities": "off",
      // Honor the leading-underscore convention for intentionally-unused args /
      // vars (e.g. a signature that documents a param it doesn't currently use).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // VAULT GUARD (constitution #4) — "are these two documents the same?" is
    // answered ONLY by the oracle in `lib/irCompare.ts` (`irContentKey` /
    // `irCanvasKey`), never by comparing serialized JSON. Key order is not
    // content: a byte-compare is how phantom "Unsaved changes" and phantom merge
    // conflicts were born (X18/X20), and one had drifted back into the composer's
    // co-editing fast path (found 2026-07-27). The server side is guarded by
    // `domain/single-definition-sites.spec.ts`; this is the client's half — it
    // lives in lint because this repo's gate is `pnpm lint && pnpm build`.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/lib/irCompare.ts"], // the oracle itself must serialize
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "BinaryExpression[operator=/^[!=]==$/] > CallExpression.left > MemberExpression[object.name='JSON'][property.name='stringify']",
          message:
            "Do not byte-compare documents (constitution #4). Use irContentKey (content) or irCanvasKey (content + layout) from @/lib/irCompare.",
        },
        {
          selector:
            "BinaryExpression[operator=/^[!=]==$/] > CallExpression.right > MemberExpression[object.name='JSON'][property.name='stringify']",
          message:
            "Do not byte-compare documents (constitution #4). Use irContentKey (content) or irCanvasKey (content + layout) from @/lib/irCompare.",
        },
      ],
    },
  },
  {
    // FlowCanvas deliberately uses refs as render-scoped memo caches
    // (`nodeCacheRef` / `edgeCacheRef` WeakMaps read during render to avoid
    // rebuilding node/edge objects on every parse). The react-compiler `refs`
    // advisory fundamentally disagrees with reading a ref in render, so scope it
    // off for this one file — the rule stays active everywhere else.
    files: ["src/components/FlowCanvas.tsx"],
    rules: { "react-hooks/refs": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Claude worktrees (agent/chip sessions) carry their own checkouts and
    // .next outputs — never lint them from the main checkout.
    ".claude/**",
    // design-sync artifacts (git-ignored): `ds-bundle/` is the compiled design
    // system + vendored React internals; `.ds-sync/` is the converter's scripts.
    // Neither is app source — linting them only surfaces vendored-code violations
    // that turn `pnpm lint` red on any machine that has run design-sync.
    "ds-bundle/**",
    ".ds-sync/**",
  ]),
]);

export default eslintConfig;
