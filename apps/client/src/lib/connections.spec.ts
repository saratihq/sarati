import { describe, expect, it } from "vitest";
import type { AccountIdentity, Connection } from "@/api/client";
import {
  accountLabel,
  activeConnections,
  appDisplayName,
  candidateConnections,
  connectionLabel,
  describeAccount,
  matchingConnections,
} from "@/lib/connections";

const person = (over: Partial<AccountIdentity> = {}): AccountIdentity => ({
  subject: "user",
  name: null,
  id: null,
  email: null,
  handle: null,
  ...over,
});

const conn = (over: Partial<Connection> & Pick<Connection, "id" | "provider">): Connection => ({
  display_name: null,
  auth_type: "oauth2",
  ...over,
});

describe("activeConnections", () => {
  const rows = [
    conn({ id: "1", provider: "slack", status: "active" }),
    conn({ id: "2", provider: "slack", status: "pending" }),
    conn({ id: "3", provider: "slack", status: "expired" }),
    conn({ id: "4", provider: "slack", status: "failed" }),
    conn({ id: "5", provider: "slack" }),
  ];

  it("keeps only rows a step can actually run as", () => {
    expect(activeConnections(rows).map((c) => c.id)).toEqual(["1", "5"]);
  });

  it("treats a status-less row as active — older rows carry none", () => {
    expect(activeConnections([conn({ id: "5", provider: "slack" })])).toHaveLength(1);
  });

  it("returns an empty list rather than a stale one when nothing is usable", () => {
    expect(activeConnections(rows.filter((c) => c.status && c.status !== "active"))).toEqual([]);
  });
});

describe("matchingConnections", () => {
  const rows = [
    conn({ id: "1", provider: "google" }),
    conn({ id: "2", provider: "google-sheets" }),
    conn({ id: "3", provider: "slack" }),
  ];

  it("matches the provider exactly", () => {
    expect(matchingConnections(rows, "slack").map((c) => c.id)).toEqual(["3"]);
  });

  it("matches a family credential — a google account serves google-sheets", () => {
    expect(matchingConnections(rows, "google-sheets").map((c) => c.id)).toEqual(["1", "2"]);
  });

  it("does not match a merely-similar slug", () => {
    expect(matchingConnections([conn({ id: "1", provider: "goog" })], "google")).toEqual([]);
  });

  it("returns nothing for a slug-less type", () => {
    expect(matchingConnections(rows, undefined)).toEqual([]);
  });
});

describe("candidateConnections", () => {
  const rows = [conn({ id: "1", provider: "google" }), conn({ id: "2", provider: "slack" })];

  /** A wrong-app credential hard-errors at run time, so an empty picker is the honest answer. */
  it("never falls back to every account when the app has no match", () => {
    expect(candidateConnections(rows, "notion")).toEqual([]);
  });

  it("offers everything only when the node type carries no app slug", () => {
    expect(candidateConnections(rows, undefined)).toBe(rows);
  });
});

describe("connectionLabel", () => {
  it("names the account when there is one, so two of the same app are told apart", () => {
    expect(connectionLabel(conn({ id: "1", provider: "slack", display_name: "Work" }))).toBe("slack · Work");
  });

  it("falls back to the provider alone", () => {
    expect(connectionLabel(conn({ id: "1", provider: "slack" }))).toBe("slack");
    expect(connectionLabel(conn({ id: "1", provider: "slack", display_name: "" }))).toBe("slack");
  });

  it("names the account the provider reported when nobody has named the connection", () => {
    const gmail = conn({ id: "1", provider: "gmail", account: person({ email: "me@e2e.local", id: "me@e2e.local" }) });
    expect(connectionLabel(gmail)).toBe("gmail · me@e2e.local");
    expect(connectionLabel({ ...gmail, display_name: "Work" })).toBe("gmail · Work");
  });
});

describe("accountLabel / describeAccount", () => {
  it("leads with what a person recognises — the email, else the handle, name or id", () => {
    expect(accountLabel(person({ email: "me@e2e.local", handle: "me", name: "Me" }))).toBe("me@e2e.local");
    expect(accountLabel(person({ handle: "eghuzefa", id: "190477365" }))).toBe("eghuzefa");
    expect(accountLabel(person())).toBe("an unnamed account");
  });

  it("adds the id when it says something the label does not", () => {
    expect(describeAccount(person({ handle: "eghuzefa", id: "190477365" }))).toBe("eghuzefa (190477365)");
    expect(describeAccount(person({ email: "me@e2e.local", id: "me@e2e.local" }))).toBe("me@e2e.local");
  });
});

describe("appDisplayName", () => {
  it.each([
    { slug: "google-sheets", name: "Google Sheets" },
    { slug: "slack", name: "Slack" },
    { slug: "microsoft_teams", name: "Microsoft Teams" },
    { slug: "google--drive", name: "Google Drive" },
    { slug: "", name: "" },
  ])("renders $slug as $name", ({ slug, name }) => {
    expect(appDisplayName(slug)).toBe(name);
  });
});
