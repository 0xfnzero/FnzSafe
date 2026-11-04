// Kept outside React so cleanup survives navigation/unmount. The offscreen
// document owns the timer; no secret is persisted to extension storage.
export class SecretClipboard {
  private value: string | undefined;
  private failedClears = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly clipboard: { readText(): Promise<string>; writeText(value: string): Promise<void> }, private readonly reportFailure: () => void = () => {}, private readonly ttl = 15_000) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => undefined);
    return next;
  }
  copy(value: string): Promise<void> {
    return this.serial(async () => {
      // Verify read permission before copying: cleanup must compare ownership.
      await this.clipboard.readText();
      await this.clipboard.writeText(value);
      this.value = value;
      this.failedClears = 0;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.clear().catch(this.reportFailure); }, this.ttl);
    });
  }
  clear(): Promise<void> {
    return this.serial(async () => {
      clearTimeout(this.timer);
      const value = this.value;
      if (value === undefined) return;
      try {
        if (await this.clipboard.readText() === value) await this.clipboard.writeText('');
        this.value = undefined;
      } catch (error) {
        // Retry transient permission/focus failures, but never keep the secret
        // indefinitely if the browser permanently denies clipboard access.
        if (++this.failedClears < 3) this.timer = setTimeout(() => { void this.clear().catch(this.reportFailure); }, 5_000);
        else this.value = undefined;
        throw error;
      }
    });
  }
}
