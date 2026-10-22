import { describe, expect, it } from 'vitest';
import { INTERACTIVE_GROUPS, runInteractiveSession } from '../src/cli-interactive.js';
import { ACTION_HELP, COMMAND_HELP, fieldHint } from '../src/cli-interactive-help.js';

type Call = { command: string; values: Record<string, string> };

function session(answers: string[], options: { guided: boolean; failOn?: string } = { guided: true }) {
  const queue = [...answers];
  const prompts: string[] = [];
  const said: string[] = [];
  const calls: Call[] = [];
  const rejected: string[] = [];
  let failed = false;
  const done = runInteractiveSession({
    guided: options.guided,
    ask: async (prompt) => {
      prompts.push(prompt);
      return queue.length > 0 ? (queue.shift() as string) : null;
    },
    say: (text) => {
      said.push(text);
    },
    run: async (command, values) => {
      calls.push({ command, values });
      if (command === options.failOn) failed = true;
    },
    failed: () => failed,
    reject: (message) => {
      rejected.push(message);
    },
  });
  return { done, prompts, said, calls, rejected, output: () => said.join('\n') };
}

describe('interactive help catalog', () => {
  it('describes every action and every command', () => {
    for (const [action, commands] of Object.entries(INTERACTIVE_GROUPS)) {
      expect(ACTION_HELP[action as keyof typeof ACTION_HELP]?.length ?? 0).toBeGreaterThan(0);
      for (const command of Object.keys(commands)) {
        expect(COMMAND_HELP[command]?.length ?? 0, command).toBeGreaterThan(0);
      }
    }
  });

  it('uses the command-specific hint before the generic one', () => {
    expect(fieldHint('validate-deployment', 'status')).toContain('validated_mock');
    expect(fieldHint('set-deployment-health', 'status')).toContain('healthy');
    expect(fieldHint('set-alias', 'tenant-id')).toContain('provision-tenant');
    expect(fieldHint('set-execution-policy', 'attempt-deadline-ms')).toContain('Milliseconds');
  });
});

describe('guided interactive session', () => {
  it('shows a welcome and a numbered action menu before the first question', async () => {
    const s = session(['quit']);
    await s.done;
    expect(s.output()).toContain('help');
    expect(s.output()).toContain('1) create');
    expect(s.output()).toContain('2) update');
    expect(s.output()).toContain('3) validate');
    expect(s.output()).toContain(ACTION_HELP.create);
    expect(s.calls).toEqual([]);
    expect(s.rejected).toEqual([]);
  });

  it('accepts numbers for the action and the command, then confirms and runs', async () => {
    const s = session(['1', '1', 'acme', 'ops', 'y', 'quit']);
    await s.done;
    expect(s.output()).toContain('1) provision-tenant');
    expect(s.output()).toContain(COMMAND_HELP['provision-tenant']);
    expect(s.calls).toEqual([{ command: 'provision-tenant', values: { name: 'acme', label: 'ops' } }]);
  });

  it('marks required fields in the prompt', async () => {
    const s = session(['create', 'add-key', '', '', 'n', 'quit']);
    await s.done;
    expect(s.prompts).toContain('tenant-id (required): ');
    expect(s.prompts).toContain('label: ');
  });

  it('asks again after a choice it does not know', async () => {
    const s = session(['nope', '9', 'validate', 'nope', 'list-inference', 'tid', '', 'quit']);
    await s.done;
    expect(s.rejected).toEqual([]);
    expect(s.output()).toContain('Not a choice');
    expect(s.calls).toEqual([{ command: 'list-inference', values: { 'tenant-id': 'tid' } }]);
  });

  it('goes back from the command menu to the action menu', async () => {
    const s = session(['create', 'back', 'validate', 'list-inference', 'tid', 'yes', 'exit']);
    await s.done;
    expect(s.calls).toEqual([{ command: 'list-inference', values: { 'tenant-id': 'tid' } }]);
  });

  it('prints the menu again for help', async () => {
    const s = session(['help', 'create', '?', 'back', 'quit']);
    await s.done;
    const menus = s.said.filter((line) => line.includes('1) provision-tenant'));
    expect(menus).toHaveLength(2);
  });

  it('skips the command when the person says no', async () => {
    const s = session(['create', 'provision-tenant', 'acme', '', 'n', 'quit']);
    await s.done;
    expect(s.calls).toEqual([]);
    expect(s.output()).toContain('Skipped');
  });

  it('hides provider keys in the summary', async () => {
    const s = session(['create', 'register-openai-connection', 'tid', 'sk-secret-value', 'n', 'quit']);
    await s.done;
    expect(s.output()).not.toContain('sk-secret-value');
    expect(s.output()).toContain('api-key');
  });

  it('keeps going after a failed command', async () => {
    const s = session(['create', 'provision-tenant', '', '', 'y', 'create', 'provision-tenant', 'acme', '', 'y', 'quit'], {
      guided: true,
      failOn: 'provision-tenant',
    });
    await s.done;
    expect(s.calls).toHaveLength(2);
    expect(s.output()).toContain('did not work');
  });

  it('reminds the person to save a new tenant secret', async () => {
    const s = session(['create', 'provision-tenant', 'acme', '', 'y', 'quit']);
    await s.done;
    expect(s.output()).toContain('only once');
  });

  it('ends quietly when input closes at the action menu', async () => {
    const s = session([]);
    await s.done;
    expect(s.rejected).toEqual([]);
  });
});

describe('scripted interactive session', () => {
  it('keeps the plain prompts and prints no menus', async () => {
    const s = session(['create', 'provision-tenant', 'acme', 'ops', 'done'], { guided: false });
    await s.done;
    expect(s.prompts).toEqual(['action: ', 'command: ', 'name: ', 'label: ', 'action: ']);
    expect(s.said).toEqual([]);
    expect(s.calls).toEqual([{ command: 'provision-tenant', values: { name: 'acme', label: 'ops' } }]);
  });

  it('stops at the first unknown action', async () => {
    const s = session(['nope', 'create'], { guided: false });
    await s.done;
    expect(s.rejected).toEqual(['invalid command arguments']);
  });

  it('stops at the first failed command', async () => {
    const s = session(['create', 'provision-tenant', '', '', 'create', 'provision-tenant', 'b', '', 'done'], {
      guided: false,
      failOn: 'provision-tenant',
    });
    await s.done;
    expect(s.calls).toHaveLength(1);
  });
});
