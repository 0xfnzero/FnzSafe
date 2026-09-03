export interface AsyncRequestIntent {
  key: string;
  generation: number;
}

export function createAsyncRequestIntent(): AsyncRequestIntent {
  return { key: "", generation: 0 };
}

export function beginAsyncRequestIntent(intent: AsyncRequestIntent, key: string): number {
  if (intent.key !== key) {
    intent.key = key;
    intent.generation += 1;
  }
  return intent.generation;
}

export function isCurrentAsyncRequest(
  intent: AsyncRequestIntent,
  key: string,
  generation: number,
): boolean {
  return intent.key === key && intent.generation === generation;
}
