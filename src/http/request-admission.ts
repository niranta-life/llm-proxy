export type RequestDrain = { requestsIdle: boolean };

export type RequestAdmission = {
  beginShutdown(): void;
  shuttingDown(): boolean;
  enter(): () => void;
  drain(timeoutMs: number): Promise<RequestDrain>;
  drainRequests(timeoutMs: number): Promise<boolean>;
};

export function createRequestAdmission(): RequestAdmission {
  let closing = false;
  let active = 0;
  const waiters: Array<() => void> = [];

  function notify(): void {
    if (active !== 0) return;
    for (const waiter of [...waiters]) waiter();
  }

  function waitIdle(timeoutMs: number): Promise<boolean> {
    if (active === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (idle: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = waiters.indexOf(onIdle);
        if (index >= 0) waiters.splice(index, 1);
        resolve(idle);
      };
      const onIdle = (): void => finish(true);
      const timer = setTimeout(() => finish(active === 0), Math.max(0, timeoutMs));
      waiters.push(onIdle);
    });
  }

  return {
    beginShutdown(): void {
      closing = true;
    },
    shuttingDown(): boolean {
      return closing;
    },
    enter(): () => void {
      active += 1;
      let left = false;
      return () => {
        if (left) return;
        left = true;
        active -= 1;
        notify();
      };
    },
    drain(timeoutMs: number): Promise<RequestDrain> {
      closing = true;
      return waitIdle(timeoutMs).then((requestsIdle) => ({ requestsIdle }));
    },
    drainRequests(timeoutMs: number): Promise<boolean> {
      return waitIdle(timeoutMs);
    },
  };
}
