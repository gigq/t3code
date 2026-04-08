const LAST_SERVER_INSTANCE_ID_STORAGE_KEY = "t3code:last-server-instance-id";
const RELOAD_TARGET_SERVER_INSTANCE_ID_STORAGE_KEY = "t3code:reload-target-server-instance-id";

export function shouldReloadForServerInstanceChange(input: {
  readonly previousServerInstanceId: string | null;
  readonly nextServerInstanceId: string;
  readonly previousReloadTarget: string | null;
}): boolean {
  if (input.previousServerInstanceId === null) {
    return false;
  }

  if (input.previousServerInstanceId === input.nextServerInstanceId) {
    return false;
  }

  return input.previousReloadTarget !== input.nextServerInstanceId;
}

export function readLastServerInstanceId(storage: Storage | null): string | null {
  return readStorageValue(storage, LAST_SERVER_INSTANCE_ID_STORAGE_KEY);
}

export function writeLastServerInstanceId(storage: Storage | null, serverInstanceId: string): void {
  writeStorageValue(storage, LAST_SERVER_INSTANCE_ID_STORAGE_KEY, serverInstanceId);
}

export function readServerInstanceReloadTarget(storage: Storage | null): string | null {
  return readStorageValue(storage, RELOAD_TARGET_SERVER_INSTANCE_ID_STORAGE_KEY);
}

export function writeServerInstanceReloadTarget(
  storage: Storage | null,
  serverInstanceId: string | null,
): void {
  writeStorageValue(storage, RELOAD_TARGET_SERVER_INSTANCE_ID_STORAGE_KEY, serverInstanceId);
}

function readStorageValue(storage: Storage | null, key: string): string | null {
  if (!storage) {
    return null;
  }

  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageValue(storage: Storage | null, key: string, value: string | null): void {
  if (!storage) {
    return;
  }

  try {
    if (value === null) {
      storage.removeItem(key);
      return;
    }

    storage.setItem(key, value);
  } catch {
    // Ignore storage failures so reconnect handling still proceeds.
  }
}
