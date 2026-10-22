// Guided interactive mode: menus, hints, and a confirm step for a person at a terminal.
import { INTERACTIVE_GROUPS, type InteractiveAction } from './cli-interactive-commands.js';
import { ACTION_HELP, COMMAND_HELP, PRINTS_SECRET, SECRET_FIELDS, fieldHint, isRequired } from './cli-interactive-help.js';

export type GuidedIO = {
  ask: (prompt: string) => Promise<string | null>;
  say: (text: string) => void;
  run: (command: string, values: Record<string, string>) => Promise<void>;
  failed: () => boolean;
};

const ACTIONS: readonly InteractiveAction[] = ['create', 'update', 'validate'];
const QUIT_WORDS: ReadonlySet<string> = new Set(['quit', 'exit', 'done', 'q']);
const HELP_WORDS: ReadonlySet<string> = new Set(['help', '?', 'h']);
const BACK_WORDS: ReadonlySet<string> = new Set(['back', 'b']);

// A menu answer: a picked item, a request to go back, or the end of the session.
type Choice = { kind: 'pick'; value: string } | { kind: 'back' } | { kind: 'quit' };

const WELCOME = [
  '',
  'llm-proxy setup',
  'Pick a task by number or name. Type help to see the list again, back to go up, or quit to stop.',
].join('\n');

function numberedMenu(title: string, items: readonly (readonly [string, string])[]): string {
  const width = Math.max(...items.map(([name]) => name.length));
  const numberWidth = String(items.length).length;
  const lines = items.map(
    ([name, help], index) => `  ${String(index + 1).padStart(numberWidth)}) ${name.padEnd(width)}  ${help}`,
  );
  return ['', title, ...lines].join('\n');
}

function actionMenu(): string {
  return numberedMenu('What do you want to do?', ACTIONS.map((action) => [action, ACTION_HELP[action]] as const));
}

function commandMenu(action: InteractiveAction): string {
  const commands = Object.keys(INTERACTIVE_GROUPS[action]);
  return numberedMenu(`${action}: pick a command`, commands.map((command) => [command, COMMAND_HELP[command] ?? ''] as const));
}

function matchChoice(answer: string, options: readonly string[]): string | undefined {
  if (/^\d+$/.test(answer)) return options[Number(answer) - 1];
  return options.find((option) => option === answer.toLowerCase());
}

async function chooseFrom(io: GuidedIO, options: readonly string[], menu: string, prompt: string): Promise<Choice> {
  io.say(menu);
  for (;;) {
    const line = await io.ask(prompt);
    if (line === null) return { kind: 'quit' };
    const answer = line.trim();
    if (answer === '') continue;
    if (QUIT_WORDS.has(answer.toLowerCase())) return { kind: 'quit' };
    if (BACK_WORDS.has(answer.toLowerCase())) return { kind: 'back' };
    if (HELP_WORDS.has(answer.toLowerCase())) {
      io.say(menu);
      continue;
    }
    const picked = matchChoice(answer, options);
    if (picked !== undefined) return { kind: 'pick', value: picked };
    io.say(`Not a choice: ${answer}. Type a number from 1 to ${options.length}, or help.`);
  }
}

// Returns the answers, or null when input ends part way through.
async function askFields(io: GuidedIO, command: string, fields: readonly string[]): Promise<Record<string, string> | null> {
  io.say(`\n${command}: ${COMMAND_HELP[command] ?? ''}\nPress Enter to leave a field blank.`);
  let values: Record<string, string> = {};
  for (const field of fields) {
    const hint = fieldHint(command, field);
    if (hint !== undefined) io.say(`  ${hint}`);
    const answer = await io.ask(`${field}${isRequired(command, field) ? ' (required)' : ''}: `);
    if (answer === null) return null;
    const value = answer.trim();
    if (value.length > 0) values = { ...values, [field]: value };
  }
  return values;
}

function summary(command: string, values: Record<string, string>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) return `\n${command} with no fields set.`;
  const lines = entries.map(([field, value]) => `  ${field}: ${SECRET_FIELDS.has(field) ? '(hidden)' : value}`);
  return [`\n${command} with:`, ...lines].join('\n');
}

async function confirm(io: GuidedIO, command: string): Promise<boolean | null> {
  for (;;) {
    const line = await io.ask(`Run ${command}? [Y/n] `);
    if (line === null) return null;
    const answer = line.trim().toLowerCase();
    if (answer === '' || answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    io.say('Type y or n.');
  }
}

async function runAndReport(io: GuidedIO, command: string, values: Record<string, string>): Promise<void> {
  await io.run(command, values);
  if (io.failed()) {
    io.say(`${command} did not work. Read the error above, then try again.`);
    return;
  }
  io.say(`${command} done. The result is above.`);
  if (PRINTS_SECRET.has(command)) {
    io.say('Save the secret now. llm-proxy shows it only once.');
  }
}

// Runs one command from menu to result. Returns false when the session must end.
async function guidedCommand(io: GuidedIO, action: InteractiveAction): Promise<boolean | 'back'> {
  const commands = Object.keys(INTERACTIVE_GROUPS[action]);
  const choice = await chooseFrom(io, commands, commandMenu(action), 'command: ');
  if (choice.kind !== 'pick') return choice.kind === 'back' ? 'back' : false;
  const fields = INTERACTIVE_GROUPS[action][choice.value as keyof (typeof INTERACTIVE_GROUPS)[typeof action]] as readonly string[];
  const values = await askFields(io, choice.value, fields);
  if (values === null) return false;
  io.say(summary(choice.value, values));
  const go = await confirm(io, choice.value);
  if (go === null) return false;
  if (go) await runAndReport(io, choice.value, values);
  else io.say('Skipped. Nothing was changed.');
  return true;
}

export async function runGuidedSession(io: GuidedIO): Promise<void> {
  io.say(WELCOME);
  for (;;) {
    const choice = await chooseFrom(io, ACTIONS, actionMenu(), 'action: ');
    if (choice.kind === 'quit') break;
    if (choice.kind === 'back') continue;
    const next = await guidedCommand(io, choice.value as InteractiveAction);
    if (next === false) break;
  }
  io.say('Bye.');
}
