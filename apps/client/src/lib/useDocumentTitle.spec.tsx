import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DocumentTitle } from "@/components/DocumentTitle";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

vi.mock("next/font/google", () => ({ Inter: () => ({ variable: "font-inter" }) }));
vi.mock("@clerk/nextjs", () => ({ ClerkProvider: ({ children }: { children: ReactNode }) => children }));

function Page({ parts }: { parts: Array<string | null | undefined> }) {
  useDocumentTitle(...parts);
  return null;
}

const shell = (page: ReactNode) => (
  <>
    <DocumentTitle />
    {page}
  </>
);

describe("the tab title", () => {
  it("names the page and the workflow it is on", () => {
    render(shell(<Page parts={["Overview", "Nightly sync"]} />));
    expect(document.title).toBe("Overview · Nightly sync · Sarati");
  });

  it("leaves out a name that has not loaded yet, then takes it", () => {
    const { rerender } = render(shell(<Page parts={["Overview", undefined]} />));
    expect(document.title).toBe("Overview · Sarati");

    rerender(shell(<Page parts={["Overview", "Nightly sync"]} />));
    expect(document.title).toBe("Overview · Nightly sync · Sarati");
  });

  it("falls back to the app name when the page leaves", () => {
    const { rerender } = render(shell(<Page parts={["Runs"]} />));
    rerender(shell(null));
    expect(document.title).toBe("Sarati");
  });

  // Next remounts a metadata <title> on every navigation and the newest one wins, so a second
  // title — the root layout's — would put the bare app name back each time a search param changes.
  it("is the document's only title, and the root metadata declares none", async () => {
    render(shell(<Page parts={["Runs"]} />));
    expect(document.querySelectorAll("title")).toHaveLength(1);

    const { metadata } = await import("@/app/layout");
    expect(metadata).not.toHaveProperty("title");
  });
});
