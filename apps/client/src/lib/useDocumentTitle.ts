"use client";

import { useEffect } from "react";

/** Per-route document title: useDocumentTitle("Versions", workflowName). */
export function useDocumentTitle(...parts: Array<string | null | undefined>) {
  useEffect(() => {
    const meaningful = parts.filter(Boolean) as string[];
    document.title = meaningful.length ? `${meaningful.join(" · ")} · Sarati` : "Sarati";
    return () => {
      document.title = "Sarati";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- parts is spread; join for identity
  }, [parts.filter(Boolean).join("·")]);
}