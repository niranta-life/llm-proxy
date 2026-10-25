export type InFlightRequests = {
  /** Counts one unit of work as active. Call the returned function once it is done; extra calls are ignored. */
  begin(): () => void;
  /** Resolves true once nothing is active, or false if timeoutMs passes first. */
  waitIdle(timeoutMs: number): Promise<boolean>;
};

export function createInFlightRequests(): InFlightRequests {
  let active = 0;
  const waiters = new Set<() => void>();

  return {
    begin(): () => void {
      active += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        active -= 1;
        if (active !== 0) return;
        for (const waiter of [...waiters]) waiter();
      };
    },
    waitIdle(timeoutMs: number): Promise<boolean> {
      if (active === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const finish = (idle: boolean): void => {
          clearTimeout(timer);
          waiters.delete(onIdle);
          resolve(idle);
        };
        const onIdle = (): void => finish(true);
        const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
        waiters.add(onIdle);
      });
    },
  };
}
