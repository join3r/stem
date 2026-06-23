/**
 * Serializes access to pi's single foreground session.
 *
 * pi RPC has one mutable active session per process. Operations that create,
 * switch, fork, roll back, or rename sessions must not run while a turn is
 * streaming, and they must run FIFO with other foreground-session mutations.
 */
export class ForegroundSessionGate {
  private chain: Promise<unknown> = Promise.resolve();
  private activeTurnDone: Promise<void> | null = null;
  private resolveActiveTurn: (() => void) | null = null;

  run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(
      () => this.waitForTurnThenRun(task),
      () => this.waitForTurnThenRun(task)
    );
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  claimTurn(): void {
    if (this.activeTurnDone) throw new Error('A foreground turn is already active.');
    this.activeTurnDone = new Promise<void>((resolve) => {
      this.resolveActiveTurn = resolve;
    });
  }

  finishTurn(): void {
    this.resolveActiveTurn?.();
    this.resolveActiveTurn = null;
    this.activeTurnDone = null;
  }

  reset(): void {
    this.finishTurn();
    this.chain = Promise.resolve();
  }

  private async waitForTurnThenRun<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeTurnDone) await this.activeTurnDone;
    return task();
  }
}
