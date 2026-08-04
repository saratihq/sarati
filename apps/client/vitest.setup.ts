import { beforeEach } from "vitest";

// Node ships its own no-op `localStorage` global, and it SHADOWS jsdom's inside the test environment
// — every setItem/removeItem call would throw. Install a real in-memory Storage instead.
function createStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(String(key)) ?? null,
    setItem: (key: string, value: string) => void entries.set(String(key), String(value)),
    removeItem: (key: string) => void entries.delete(String(key)),
    clear: () => entries.clear(),
  } as Storage;
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, value: createStorage() });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  // jsdom keeps its cookie jar for the whole file; expire whatever the previous test left behind.
  for (const pair of document.cookie.split(";")) {
    const name = pair.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
});
