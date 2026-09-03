export interface WritableStorage {
  setItem(key: string, value: string): void;
}

export function persistJsonAfterHydration(
  storage: WritableStorage,
  key: string,
  value: unknown,
  hydrated: boolean,
): boolean {
  if (!hydrated) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
