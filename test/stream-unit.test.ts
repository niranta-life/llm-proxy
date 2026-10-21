import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  attemptStatusFor,
  createStreamGate,
  createSseDecoder,
  drainStreams,
  eventsFromOpenAiChunk,
  initialChunkCursor,
  initialStreamMachine,
  reduceStream,
  renderChunk,
  renderDone,
  SlowConsumerError,
  streamErrorCode,
  StreamShutdownError,
  StreamTimeoutError,
  writeEventSequence,
  writeFrame,
  type CanonicalEvent,
  type FrameSocket,
} from '../src/inference/stream.js';

const header = { id: 'chatcmpl-stable', model: 'gpt-actual', created: 1_700_000_000 };

function memorySocket(): FrameSocket & { frames: string[] } {
  const frames: string[] = [];
  return {
    frames,
    write(chunk: string): boolean {
      frames.push(chunk);
      return true;
    },
    once(): void {},
    off(): void {},
  };
}

describe('OpenAI chunk normalization', () => {
  it('keeps one completion id, the assistant role, and ordered text deltas', () => {
    let cursor = initialChunkCursor();
    const started = eventsFromOpenAiChunk(
      {
        id: 'chatcmpl-stable',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'gpt-actual',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      },
      cursor,
    );
    cursor = started.cursor;
    expect(started.events).toEqual([{ type: 'start', id: 'chatcmpl-stable', model: 'gpt-actual', created: 1_700_000_000 }]);

    const firstText = eventsFromOpenAiChunk(
      {
        id: 'chatcmpl-other',
        object: 'chat.completion.chunk',
        created: 99,
        model: 'gpt-other',
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
      },
      cursor,
    );
    cursor = firstText.cursor;
    expect(cursor.id).toBe('chatcmpl-stable');
    expect(cursor.model).toBe('gpt-actual');
    expect(firstText.events).toEqual([{ type: 'text_delta', text: 'Hello' }]);

    const finished = eventsFromOpenAiChunk(
      {
        id: 'chatcmpl-stable',
        choices: [{ index: 0, delta: { content: ' there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
      cursor,
    );
    expect(finished.events.map((event) => event.type)).toEqual(['text_delta', 'finish', 'usage']);
    expect(finished.events[1]).toEqual({ type: 'finish', finishReason: 'stop' });
    expect(finished.events[2]).toEqual({
      type: 'usage',
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    });

    const frames = [started.events[0], firstText.events[0], ...finished.events].map((event) =>
      renderChunk(event as CanonicalEvent, header, true),
    );
    expect(frames.every((frame) => frame !== null)).toBe(true);
    const parsed = frames.map((frame) => JSON.parse(String(frame).replace(/^data: /, '').trim()) as {
      id: string;
      model: string;
      choices: Array<{ delta?: { role?: string; content?: string }; finish_reason: string | null }>;
      usage?: { prompt_tokens: number };
    });
    expect(parsed.map((chunk) => chunk.id)).toEqual([
      'chatcmpl-stable',
      'chatcmpl-stable',
      'chatcmpl-stable',
      'chatcmpl-stable',
      'chatcmpl-stable',
    ]);
    expect(parsed.every((chunk) => chunk.model === 'gpt-actual')).toBe(true);
    expect(parsed[0]?.choices[0]?.delta?.role).toBe('assistant');
    expect(parsed[1]?.choices[0]?.delta?.content).toBe('Hello');
    expect(parsed[2]?.choices[0]?.delta?.content).toBe(' there');
    expect(parsed[3]?.choices[0]?.finish_reason).toBe('stop');
    expect(parsed[4]?.choices).toEqual([]);
    expect(parsed[4]?.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(renderDone()).toBe('data: [DONE]\n\n');
  });

  it('maps finish reasons and omits usage that was not requested or not reported', () => {
    const length = eventsFromOpenAiChunk(
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-actual',
        choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
      },
      initialChunkCursor(),
    );
    expect(length.events.some((event) => event.type === 'finish' && event.finishReason === 'length')).toBe(true);
    const usage = length.events.find((event) => event.type === 'usage');
    expect(usage).toBeUndefined();
    const finish = length.events.find((event) => event.type === 'finish');
    expect(finish?.type === 'finish' ? renderChunk(finish, header, true) : null).toContain('"finish_reason":"length"');

    const partial = eventsFromOpenAiChunk(
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-actual',
        choices: [],
        usage: { prompt_tokens: 'nope', completion_tokens: 1.5, total_tokens: -1 },
      },
      initialChunkCursor(),
    );
    expect(partial.events.some((event) => event.type === 'usage')).toBe(false);
    const reported = { type: 'usage' as const, promptTokens: 4, completionTokens: null, totalTokens: null };
    expect(renderChunk(reported, header, false)).toBeNull();
    expect(renderChunk(reported, header, true)).toContain('"prompt_tokens":4');
    expect(renderChunk(reported, header, true)).not.toContain('completion_tokens');
  });

  it('rejects tools, a non-assistant role, and a bad finish reason', () => {
    const base = {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-actual',
    };
    expect(() =>
      eventsFromOpenAiChunk(
        { ...base, choices: [{ delta: { tool_calls: [] }, finish_reason: null }] },
        initialChunkCursor(),
      ),
    ).toThrow(/invalid/i);
    expect(() =>
      eventsFromOpenAiChunk(
        { ...base, choices: [{ delta: { role: 'user' }, finish_reason: null }] },
        initialChunkCursor(),
      ),
    ).toThrow(/invalid/i);
    expect(() =>
      eventsFromOpenAiChunk(
        { ...base, choices: [{ delta: { content: 1 }, finish_reason: null }] },
        initialChunkCursor(),
      ),
    ).toThrow(/invalid/i);
    expect(() =>
      eventsFromOpenAiChunk(
        { ...base, choices: [{ delta: {}, finish_reason: 'STOP' }] },
        initialChunkCursor(),
      ),
    ).toThrow(/invalid/i);
  });

  it('reassembles a UTF-8 character split across decoder writes', () => {
    const frame = Buffer.from(
      `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-actual', choices: [{ delta: { content: 'café' } }] })}\n\n`,
    );
    const split = frame.indexOf(0xc3);
    expect(split).toBeGreaterThan(0);
    const decoder = createSseDecoder();
    expect(decoder.push(frame.subarray(0, split + 1))).toEqual([]);
    const messages = decoder.push(frame.subarray(split + 1));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toContain('café');
    expect(decoder.finish().truncated).toBe(false);
  });
});

describe('stream state transitions', () => {
  it('moves through connecting and streaming and completes only after finish and done', () => {
    let machine = initialStreamMachine();
    expect(machine.status).toBe('connecting');
    machine = reduceStream(machine, { type: 'downstream_open' });
    expect(machine.status).toBe('streaming');
    machine = reduceStream(machine, { type: 'provider_finish' });
    expect(machine.status).toBe('streaming');
    machine = reduceStream(machine, { type: 'provider_done' });
    expect(machine.status).toBe('completed');
    expect(reduceStream(machine, { type: 'client_abort' }).status).toBe('completed');
    expect(attemptStatusFor('completed')).toBe('succeeded');
  });

  it('does not complete when the provider terminal event or done marker is missing', () => {
    let machine = reduceStream(initialStreamMachine(), { type: 'downstream_open' });
    machine = reduceStream(machine, { type: 'provider_done' });
    expect(machine.status).toBe('streaming');
    expect(reduceStream(machine, { type: 'upstream_closed' }).status).toBe('stream_truncated');

    const finished = reduceStream(reduceStream(initialStreamMachine(), { type: 'downstream_open' }), {
      type: 'provider_finish',
    });
    expect(reduceStream(finished, { type: 'upstream_closed' }).status).toBe('stream_truncated');
    expect(attemptStatusFor('stream_truncated')).toBe('failed');
  });

  it('records each terminal status and each timeout', () => {
    const streaming = reduceStream(initialStreamMachine(), { type: 'downstream_open' });
    expect(reduceStream(initialStreamMachine(), { type: 'client_abort' }).status).toBe('client_aborted');
    expect(reduceStream(streaming, { type: 'provider_failure' }).status).toBe('provider_failed');
    expect(reduceStream(initialStreamMachine(), { type: 'timeout', timer: 'connect' }).status).toBe('timed_out');
    expect(reduceStream(streaming, { type: 'timeout', timer: 'idle' }).status).toBe('timed_out');
    expect(reduceStream(streaming, { type: 'timeout', timer: 'total' }).status).toBe('timed_out');
    expect(reduceStream(streaming, { type: 'backpressure_timeout' }).status).toBe('slow_consumer');
    expect(reduceStream(streaming, { type: 'shutdown' }).status).toBe('interrupted');
    expect(reduceStream(initialStreamMachine(), { type: 'upstream_closed' }).status).toBe('stream_truncated');
    expect(attemptStatusFor('interrupted')).toBe('failed');
    expect(streamErrorCode('interrupted', null)).toBe('interrupted');
    expect(new StreamTimeoutError('connect').timer).toBe('connect');
    expect(new StreamTimeoutError('idle').timer).toBe('idle');
    expect(new StreamTimeoutError('total').timer).toBe('total');
    expect(streamErrorCode('client_aborted', null)).toBe('request_cancelled');
    expect(streamErrorCode('timed_out', null)).toBe('timeout');
    expect(streamErrorCode('slow_consumer', null)).toBe('slow_consumer');
    expect(streamErrorCode('stream_truncated', null)).toBe('stream_truncated');
    expect(streamErrorCode('provider_failed', 'rate_limit')).toBe('rate_limit');
    expect(streamErrorCode('provider_failed', null)).toBe('upstream_error');
    expect(streamErrorCode('completed', 'upstream_error')).toBeNull();
  });
});

describe('SSE writer backpressure', () => {
  it('writes ordered frames and one done marker after a finish event', async () => {
    const events: CanonicalEvent[] = [
      { type: 'start', id: header.id, model: header.model, created: header.created },
      { type: 'text_delta', text: 'Hello' },
      { type: 'usage', promptTokens: 1, completionTokens: null, totalTokens: null },
      { type: 'finish', finishReason: 'stop' },
    ];
    const socket = memorySocket();
    const written = await writeEventSequence({
      events: (async function* generate() {
        for (const event of events) yield event;
      })(),
      includeUsage: false,
      socket,
      signal: new AbortController().signal,
      backpressureTimeoutMs: 1000,
    });
    expect(written.header).toEqual(header);
    expect(written.chunkCount).toBe(3);
    expect(socket.frames.some((frame) => frame.includes('prompt_tokens'))).toBe(false);
    socket.frames.push(renderDone());
    expect(socket.frames.filter((frame) => frame.includes('[DONE]'))).toHaveLength(1);
    expect(socket.frames[0]).toContain('"role":"assistant"');
    expect(socket.frames[1]).toContain('Hello');
    expect(socket.frames[2]).toContain('"finish_reason":"stop"');
  });

  it('aborts a stalled consumer and removes the abort listener', async () => {
    const controller = new AbortController();
    const socket: FrameSocket = {
      write(): boolean {
        return false;
      },
      once(): void {},
      off(): void {},
    };
    await expect(writeFrame(socket, 'data: {}\n\n', 30, controller.signal)).rejects.toBeInstanceOf(SlowConsumerError);

    let settled = false;
    const pending = writeFrame(socket, 'data: {}\n\n', 5_000, controller.signal).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort();
    await pending;
    expect(settled).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('settles a stalled write on a stream deadline before the backpressure timer', async () => {
    const client = new AbortController();
    const deadline = new AbortController();
    const socket: FrameSocket = {
      write(): boolean {
        return false;
      },
      once(): void {},
      off(): void {},
    };
    const started = Date.now();
    const pending = writeFrame(socket, 'data: {}\n\n', 3_000, client.signal, deadline.signal);
    setTimeout(() => deadline.abort(new StreamTimeoutError('total')), 40);
    await expect(pending).rejects.toMatchObject({ timer: 'total' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(getEventListeners(client.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(deadline.signal, 'abort')).toHaveLength(0);

    const idle = new AbortController();
    idle.abort(new StreamTimeoutError('idle'));
    await expect(writeFrame(socket, 'data: {}\n\n', 3_000, client.signal, idle.signal)).rejects.toMatchObject({
      timer: 'idle',
    });

    const shutdown = new AbortController();
    shutdown.abort(new StreamShutdownError());
    await expect(writeFrame(socket, 'data: {}\n\n', 3_000, client.signal, shutdown.signal)).rejects.toMatchObject({
      code: 'interrupted',
    });
  });
});

describe('stream admission', () => {
  it('keeps a tenant cap beside the process cap and drains open streams', async () => {
    const gate = createStreamGate(2, 1);
    expect(gate.tryAcquire('alpha')).toBe('admitted');
    expect(gate.tryAcquire('alpha')).toBe('capacity');
    expect(gate.activeFor('alpha')).toBe(1);
    expect(gate.tryAcquire('beta')).toBe('admitted');
    expect(gate.active()).toBe(2);
    expect(gate.tryAcquire('beta')).toBe('capacity');
    gate.release('alpha');
    expect(gate.activeFor('alpha')).toBe(0);
    expect(gate.tryAcquire('alpha')).toBe('admitted');

    const full = createStreamGate(1, 2);
    expect(full.tryAcquire('alpha')).toBe('admitted');
    expect(full.tryAcquire('beta')).toBe('capacity');
    full.release('alpha');

    const draining = createStreamGate(2, 2);
    expect(draining.tryAcquire('alpha')).toBe('admitted');
    let aborted = 0;
    draining.track(() => {
      aborted += 1;
      setTimeout(() => draining.release('alpha'), 15);
    });
    const early = drainStreams(draining, 200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(draining.tryAcquire('beta')).toBe('shutting_down');
    const finishedDuringDrain = createStreamGate(1, 1);
    expect(finishedDuringDrain.tryAcquire('alpha')).toBe('admitted');
    setTimeout(() => finishedDuringDrain.release('alpha'), 20);
    const completed = await drainStreams(finishedDuringDrain, 200);
    expect(completed.idleBeforeAbort).toBe(true);
    expect(completed.aborted).toBe(0);
    expect(completed.activeAfter).toBe(0);
    expect(finishedDuringDrain.tryAcquire('beta')).toBe('shutting_down');
    const drained = await early;
    expect(aborted).toBe(1);
    expect(drained.aborted).toBe(1);
    expect(drained.activeAfter).toBe(0);
    const again = await drainStreams(draining, 50);
    expect(again.activeAfter).toBe(0);
    expect(again.aborted).toBe(0);
    expect(draining.tryAcquire('alpha')).toBe('shutting_down');
  });
});
