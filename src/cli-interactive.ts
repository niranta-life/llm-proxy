import { createInterface } from 'node:readline';
import { interactiveFields } from './cli-interactive-commands.js';
import { runGuidedSession } from './cli-interactive-guided.js';

export { INTERACTIVE_GROUPS, interactiveFields, type InteractiveAction } from './cli-interactive-commands.js';

export type InteractiveInput = {
  ask(prompt: string): Promise<string | null>;
  close(): void;
};

export function openInteractiveInput(): InteractiveInput {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  const pending: string[] = [];
  let waiter: ((value: string | null) => void) | null = null;
  let closed = false;
  rl.on('line', (line) => {
    if (waiter === null) {
      pending.push(line);
      return;
    }
    const resolve = waiter;
    waiter = null;
    resolve(line);
  });
  rl.on('close', () => {
    closed = true;
    if (waiter === null) return;
    const resolve = waiter;
    waiter = null;
    resolve(pending.shift() ?? null);
  });
  return {
    ask(prompt: string) {
      process.stderr.write(prompt);
      const queued = pending.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    close() {
      if (closed) return;
      rl.close();
    },
  };
}

export type InteractiveSession = {
  // true when a person is at a terminal: show menus, hints, and a confirm step.
  guided: boolean;
  ask: (prompt: string) => Promise<string | null>;
  say: (text: string) => void;
  run: (command: string, values: Record<string, string>) => Promise<void>;
  failed: () => boolean;
  reject: (message: string) => void;
};

export async function runInteractiveSession(session: InteractiveSession): Promise<void> {
  if (session.guided) return runGuidedSession(session);
  return runScriptedSession(session);
}

// Piped input: plain prompts, no menus, stop at the first error.
async function runScriptedSession(input: InteractiveSession): Promise<void> {
  for (;;) {
    const actionLine = await input.ask('action: ');
    if (actionLine === null) return;
    const action = actionLine.trim();
    if (action === 'done') return;
    if (action !== 'create' && action !== 'update' && action !== 'validate') {
      input.reject('invalid command arguments');
      return;
    }
    const commandLine = await input.ask('command: ');
    if (commandLine === null) {
      input.reject('invalid command arguments');
      return;
    }
    const command = commandLine.trim();
    const fields = interactiveFields(action, command);
    if (fields === undefined) {
      input.reject('invalid command arguments');
      return;
    }
    const values: Record<string, string> = {};
    for (const field of fields) {
      const answer = await input.ask(`${field}: `);
      if (answer === null) {
        input.reject('invalid command arguments');
        return;
      }
      if (answer.length > 0) values[field] = answer;
    }
    await input.run(command, values);
    if (input.failed()) return;
  }
}

