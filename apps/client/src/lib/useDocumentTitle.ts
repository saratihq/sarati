"use client";

import { useEffect } from "react";
import { create } from "zustand";

const APP_NAME = "Sarati";

/** The title the mounted page asked for; <DocumentTitle /> is its only reader. */
export const useTitle = create<{ title: string }>(() => ({ title: APP_NAME }));

/** Per-route document title: useDocumentTitle("Versions", workflowName). */
export function useDocumentTitle(...parts: Array<string | null | undefined>) {
  const title = [...parts.filter(Boolean), APP_NAME].join(" · ");
  useEffect(() => {
    useTitle.setState({ title });
    return () => useTitle.setState({ title: APP_NAME });
  }, [title]);
}
