"use client";

import { useTitle } from "@/lib/useDocumentTitle";

/** The document's only <title>: a second one in the root metadata is remounted on every navigation and wins. */
export function DocumentTitle() {
  const title = useTitle((s) => s.title);
  return <title>{title}</title>;
}
