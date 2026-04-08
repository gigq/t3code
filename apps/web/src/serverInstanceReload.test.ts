import { describe, expect, it } from "vitest";

import {
  readLastServerInstanceId,
  readServerInstanceReloadTarget,
  shouldReloadForServerInstanceChange,
  writeLastServerInstanceId,
  writeServerInstanceReloadTarget,
} from "./serverInstanceReload";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("serverInstanceReload", () => {
  it("does not reload on the first welcome for a tab", () => {
    expect(
      shouldReloadForServerInstanceChange({
        previousServerInstanceId: null,
        nextServerInstanceId: "server-b",
        previousReloadTarget: null,
      }),
    ).toBe(false);
  });

  it("reloads when the tab reconnects to a different server instance", () => {
    expect(
      shouldReloadForServerInstanceChange({
        previousServerInstanceId: "server-a",
        nextServerInstanceId: "server-b",
        previousReloadTarget: null,
      }),
    ).toBe(true);
  });

  it("does not loop reloads for the same new server instance", () => {
    expect(
      shouldReloadForServerInstanceChange({
        previousServerInstanceId: "server-a",
        nextServerInstanceId: "server-b",
        previousReloadTarget: "server-b",
      }),
    ).toBe(false);
  });

  it("persists the last seen server instance and reload target", () => {
    const storage = createMemoryStorage();

    expect(readLastServerInstanceId(storage)).toBeNull();
    expect(readServerInstanceReloadTarget(storage)).toBeNull();

    writeLastServerInstanceId(storage, "server-a");
    writeServerInstanceReloadTarget(storage, "server-b");
    expect(readLastServerInstanceId(storage)).toBe("server-a");
    expect(readServerInstanceReloadTarget(storage)).toBe("server-b");

    writeServerInstanceReloadTarget(storage, null);
    expect(readServerInstanceReloadTarget(storage)).toBeNull();
  });
});
