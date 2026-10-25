import type { Readable } from 'node:stream';

export const API_KEY_COMMANDS: ReadonlySet<string> = new Set([
  'register-openai-connection',
  'set-openai-credential',
  'register-anthropic-connection',
  'set-anthropic-credential',
  'register-vertex-connection',
  'register-xai-connection',
  'register-openrouter-connection',
  'register-dgx-connection',
]);

export const MAX_API_KEY_STDIN_BYTES = 64 * 1024;

export class ApiKeyInputError extends Error {}

type ApiKeyFlags = { 'api-key'?: string; 'api-key-stdin'?: boolean };

export type ResolvedApiKeyFlags<T extends ApiKeyFlags> = Omit<T, 'api-key-stdin'> & { 'api-key'?: string };

async function readCapped(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buffer.length;
      if (size > MAX_API_KEY_STDIN_BYTES) {
        stream.destroy();
        throw new ApiKeyInputError('api key from stdin is larger than 64 KiB');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof ApiKeyInputError) throw error;
    // The stream error text is not logged: it could echo input.
    throw new ApiKeyInputError('could not read the api key from stdin');
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function resolveApiKeyFlag<T extends ApiKeyFlags>(
  command: string,
  values: T,
  stdin: Readable & { isTTY?: boolean },
): Promise<ResolvedApiKeyFlags<T>> {
  const { 'api-key-stdin': fromStdin, ...rest } = values;
  if (fromStdin !== true) return rest;
  if (!API_KEY_COMMANDS.has(command)) {
    throw new ApiKeyInputError(
      'invalid command arguments: --api-key-stdin only works with commands that take an API key',
    );
  }
  if (values['api-key'] !== undefined) {
    throw new ApiKeyInputError('--api-key and --api-key-stdin cannot be combined');
  }
  if (stdin.isTTY === true) throw new ApiKeyInputError('--api-key-stdin needs the key piped on stdin');
  const apiKey = (await readCapped(stdin)).replace(/[\r\n]+$/, '');
  if (apiKey.length === 0) throw new ApiKeyInputError('api key from stdin is empty');
  return { ...rest, 'api-key': apiKey };
}
