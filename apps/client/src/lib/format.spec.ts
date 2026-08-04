import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDate, formatDuration, humanizeKey, timeAgo } from "@/lib/format";

const DASH = "—";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatDate", () => {
  it("renders a day-precise US short date", () => {
    expect(formatDate("2026-01-05T12:00:00Z")).toBe("Jan 5, 2026");
    expect(formatDate("2026-12-31T23:59:59Z")).toBe("Dec 31, 2026");
  });

  it.each([null, undefined, "", "not-a-date", "2026-13-45"])("degrades to an em dash on %s", (iso) => {
    expect(formatDate(iso)).toBe(DASH);
  });
});

describe("formatDuration", () => {
  it.each([
    { ms: 0, out: "0ms" },
    { ms: 420, out: "420ms" },
    { ms: 420.6, out: "421ms" },
    { ms: 999, out: "999ms" },
    { ms: 1_000, out: "1.0s" },
    { ms: 3_240, out: "3.2s" },
    { ms: 59_949, out: "59.9s" },
    { ms: 60_000, out: "1m 0s" },
    { ms: 134_000, out: "2m 14s" },
    { ms: 3_600_000, out: "1h 0m" },
    { ms: 3_840_000, out: "1h 4m" },
    { ms: 90_000_000, out: "25h 0m" },
  ])("renders $ms ms as $out", ({ ms, out }) => {
    expect(formatDuration(ms)).toBe(out);
  });

  it.each([null, undefined, -1, NaN, Infinity])("degrades to an em dash on %s", (ms) => {
    expect(formatDuration(ms)).toBe(DASH);
  });
});

describe("humanizeKey", () => {
  it.each([
    { key: "channel_id", out: "Channel ID" },
    { key: "channelId", out: "Channel ID" },
    { key: "channel_ids", out: "Channel IDs" },
    { key: "api_url", out: "API URL" },
    { key: "webhook-url", out: "Webhook URL" },
    { key: "jsonBody", out: "JSON Body" },
    { key: "user.name", out: "User Name" },
    { key: "maxIterations", out: "Max Iterations" },
    { key: "rss", out: "RSS" },
    // Deliberately lowercase: "ms" is a unit, not an acronym to shout.
    { key: "ms", out: "ms" },
  ])("turns $key into $out", ({ key, out }) => {
    expect(humanizeKey(key)).toBe(out);
  });

  it("returns a key it cannot split unchanged", () => {
    expect(humanizeKey("")).toBe("");
    expect(humanizeKey("___")).toBe("___");
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-03-10T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it.each([
    { label: "under a minute", ms: 30_000, out: "just now" },
    { label: "exactly a minute", ms: 60_000, out: "1m ago" },
    { label: "minutes", ms: 5 * 60_000, out: "5m ago" },
    { label: "an hour", ms: 60 * 60_000, out: "1h ago" },
    { label: "hours", ms: 3 * 60 * 60_000, out: "3h ago" },
    { label: "a day", ms: 24 * 60 * 60_000, out: "1d ago" },
    { label: "days", ms: 2 * 24 * 60 * 60_000, out: "2d ago" },
  ])("renders $label as $out", ({ ms, out }) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(timeAgo(ago(ms))).toBe(out);
  });

  it("falls back to an absolute date past a week", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(timeAgo(ago(8 * 24 * 60 * 60_000))).toBe("Mar 2, 2026");
  });

  it("reads a future timestamp as just now rather than a negative age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(timeAgo(new Date(now.getTime() + 60_000).toISOString())).toBe("just now");
  });

  it.each([null, undefined, "nonsense"])("degrades to an em dash on %s", (iso) => {
    expect(timeAgo(iso)).toBe(DASH);
  });
});
