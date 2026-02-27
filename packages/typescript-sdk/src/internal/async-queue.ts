function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown error");
}

export class AsyncQueue<T> {
  private readonly items: Array<
    | { type: "value"; value: T }
    | { type: "done" }
    | { type: "error"; error: Error }
  > = [];
  private readonly waiters: Array<
    (
      item:
        | { type: "value"; value: T }
        | { type: "done" }
        | { type: "error"; error: Error }
    ) => void
  > = [];
  private settled = false;

  push(value: T): void {
    if (this.settled) {
      return;
    }

    this.enqueue({ type: "value", value });
  }

  close(): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.enqueue({ type: "done" });
  }

  fail(error: unknown): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.enqueue({ type: "error", error: toError(error) });
  }

  async next(): Promise<IteratorResult<T>> {
    const item =
      this.items.shift() ??
      (await new Promise<(typeof this.items)[number]>((resolve) => {
        this.waiters.push(resolve);
      }));

    if (item.type === "value") {
      return { value: item.value, done: false };
    }

    if (item.type === "done") {
      return { value: undefined, done: true };
    }

    throw item.error;
  }

  private enqueue(item: (typeof this.items)[number]): void {
    const waiter = this.waiters.shift();

    if (waiter) {
      waiter(item);
      return;
    }

    this.items.push(item);
  }
}
