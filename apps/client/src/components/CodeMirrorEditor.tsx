"use client";

import { useMemo } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { useTheme } from "next-themes";

export interface CodeMirrorEditorProps {
  value: string;
  /** Drives the language mode (TS is type-stripped before it runs). */
  language: "js" | "ts";
  onChange: (value: string) => void;
  ariaLabel: string;
}

/** Frame overlay only — token colours come from @uiw's built-in light/dark themes. */
const frame = EditorView.theme({
  "&": {
    fontSize: "11px",
    borderRadius: "0.5rem",
    border: "1px solid var(--orchestr-line)",
    /* Tinted with the theme's own chrome ink so the well recesses in both themes. */
    background: "rgb(var(--orchestr-chrome-rgb) / 0.05)",
    overflow: "hidden",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: "1.5",
  },
  ".cm-content": { caretColor: "var(--orchestr-ink)" },
  ".cm-gutters": {
    background: "transparent",
    border: "none",
    color: "var(--orchestr-ink-subtle)",
  },
  ".cm-activeLine": { background: "rgb(var(--orchestr-chrome-rgb) / 0.04)" },
  ".cm-activeLineGutter": { background: "rgb(var(--orchestr-chrome-rgb) / 0.04)" },
});

/** CodeMirror surface for the Code node snippet; must load behind an `ssr:false` boundary. */
export default function CodeMirrorEditor({ value, language, onChange, ariaLabel }: CodeMirrorEditorProps) {
  // `resolvedTheme`, not `theme`: it collapses "system" to the concrete light/dark the palette needs.
  const { resolvedTheme } = useTheme();
  // Rebuild the language extension when the mode flips so TS syntax parses.
  const extensions = useMemo(
    () => [javascript({ typescript: language === "ts", jsx: false }), frame, EditorView.lineWrapping],
    [language],
  );
  return (
    <div aria-label={ariaLabel} data-testid="code-editor">
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={resolvedTheme === "light" ? "light" : "dark"}
        extensions={extensions}
        minHeight="140px"
        maxHeight="360px"
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
          autocompletion: false,
          searchKeymap: false,
        }}
      />
    </div>
  );
}
