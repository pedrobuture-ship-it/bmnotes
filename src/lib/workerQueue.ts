/** One active job per worker; cancelled queued work never reaches the worker. */
export class WorkerQueue<Input, Output> {
  private worker: Worker | null = null;
  private jobs = new Map<number, { input: Input; resolve: (value: Output) => void; reject: (error: Error) => void }>();
  private active: number | null = null;
  private nextId = 0;
  private timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(private createWorker: () => Worker) {}

  submit(input: Input): { promise: Promise<Output>; cancel: () => void } {
    const id = ++this.nextId;
    const promise = new Promise<Output>((resolve, reject) => {
      this.jobs.set(id, { input, resolve, reject });
    });
    this.pump();
    return {
      promise,
      cancel: () => {
        const job = this.jobs.get(id);
        this.jobs.delete(id);
        job?.reject(new Error("Cancelled"));
      },
    };
  }

  private fail(message: string) {
    clearTimeout(this.timeout);
    this.worker?.terminate();
    this.worker = null;
    this.active = null;
    for (const job of this.jobs.values()) job.reject(new Error(message));
    this.jobs.clear();
  }

  private pump() {
    if (this.active !== null || this.jobs.size === 0) return;
    try {
      if (!this.worker) {
        this.worker = this.createWorker();
        this.worker.onmessage = (event: MessageEvent<{ id: number; result?: Output; error?: string }>) => {
          if (event.data.id !== this.active) return;
          clearTimeout(this.timeout);
          const job = this.jobs.get(event.data.id);
          this.jobs.delete(event.data.id);
          this.active = null;
          if (event.data.error) job?.reject(new Error(event.data.error));
          else job?.resolve(event.data.result as Output);
          this.pump();
        };
        this.worker.onerror = () => this.fail("Background processing failed");
        this.worker.onmessageerror = () => this.fail("Background result could not be read");
      }
      const [id, job] = this.jobs.entries().next().value!;
      this.active = id;
      this.timeout = setTimeout(() => this.fail("Background processing timed out"), 15_000);
      this.worker.postMessage({ id, input: job.input });
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }
}
