import { describe, expect, it } from "vitest";
import { dryRunMarkerOf, withheldSummary } from "@/lib/dryRun";

// The markers below are the service's own, as a dry run on a live instance returned them.
describe("dryRunMarkerOf", () => {
  it("reads the marker off a step a dry run did not carry out", () => {
    const output = {
      dry_run: true,
      withheld: "write",
      skipped: "state-changing request (not sent in a dry run)",
      would_call: [{ method: "POST", url: "https://example.com/would-be-called" }],
    };
    expect(dryRunMarkerOf(output)).toBe(output);
  });

  it("finds none on a step that ran, whatever its output looks like", () => {
    for (const output of [7, "done", null, undefined, [], { status: 200 }, { dry_run: false }, { dry_run: "true" }]) {
      expect(dryRunMarkerOf(output)).toBeNull();
    }
  });
});

describe("withheldSummary", () => {
  it("names every request a write step would have made", () => {
    expect(
      withheldSummary({
        dry_run: true,
        withheld: "write",
        would_call: [
          { method: "POST", url: "https://example.com/a" },
          { method: "DELETE", url: "https://example.com/b" },
        ],
      }),
    ).toBe("Not sent — would call POST https://example.com/a, DELETE https://example.com/b");
  });

  it("says how long a skipped wait would have been", () => {
    expect(withheldSummary({ dry_run: true, withheld: "delay", skipped_delay_ms: 172_800_000 })).toBe(
      "Wait skipped — 48h 0m",
    );
  });

  it("says an approval was not waited for, and a managed step was not run", () => {
    expect(withheldSummary({ dry_run: true, withheld: "wait", skipped: "wait-for-event (dry run)" })).toBe(
      "Not waited for — a dry run does not pause for an event",
    );
    expect(withheldSummary({ dry_run: true, withheld: "managed_step" })).toBe(
      "Not run — a dry run does not run steps on a managed connection",
    );
  });

  it("still reads a marker recorded before the service named the reason", () => {
    expect(
      withheldSummary({ dry_run: true, would_call: [{ method: "PUT", url: "https://example.com/c" }] }),
    ).toBe("Not sent — would call PUT https://example.com/c");
    expect(withheldSummary({ dry_run: true, skipped_delay_ms: 5000 })).toBe("Wait skipped — 5.0s");
    expect(withheldSummary({ dry_run: true, skipped: "wait-for-event (dry run)" })).toBe(
      "Not run — wait-for-event (dry run)",
    );
  });
});
