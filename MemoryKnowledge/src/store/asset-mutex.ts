/** Preserve the atomic admission/mutation boundaries formerly provided by sync SQLite. */
export class AssetMutex {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}
