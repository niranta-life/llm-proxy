import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_EXTRACTOR_VERSION,
  extractRequestFeatures,
  featureInputFromChat,
  type ExtractedFeatures,
} from '../src/inference/request-features.js';
import type { ChatRequest } from '../src/inference/validate.js';
import { validateChatRequest } from '../src/inference/validate.js';

const evidenceDir = process.env.SLICE_06A_EVIDENCE;

function text(role: 'system' | 'user' | 'assistant', content: string) {
  return { role, content };
}

function extracted(messages: ReturnType<typeof text>[], extra: Partial<Parameters<typeof extractRequestFeatures>[0]> = {}) {
  return extractRequestFeatures({
    messages,
    stream: false,
    requestedModel: 'auto',
    taskHint: null,
    structuredOutput: false,
    toolRequired: false,
    ...extra,
  });
}

function shape(feature: ExtractedFeatures) {
  return {
    taskCategory: feature.taskCategory,
    classificationSource: feature.classificationSource,
    messageCount: feature.messageCount,
    instructionPresent: feature.instructionPresent,
    conversationDepth: feature.conversationDepth,
    inputSize: feature.inputSize,
    inputTokenEstimate: feature.inputTokenEstimate,
    streamRequested: feature.streamRequested,
    structuredOutput: feature.structuredOutput,
    toolRequired: feature.toolRequired,
    complexityEstimate: feature.complexityEstimate,
    extractorVersion: feature.extractorVersion,
  };
}

describe('request feature extractor', () => {
  const fixtures: string[] = [];

  it('uses a validated hint before the rules', () => {
    const prompt = 'HINT-CLASSIFY extract the invoice fields';
    const feature = extracted([text('user', prompt)], { taskHint: 'classification' });
    expect(feature.taskCategory).toBe('classification');
    expect(feature.classificationSource).toBe('caller_hint');
    expect(JSON.stringify(feature)).not.toContain('HINT-CLASSIFY');
    expect(JSON.stringify(feature)).not.toContain(prompt);
    fixtures.push(`hint classification ${JSON.stringify(shape(feature))}`);
  });

  it('accepts an extraction hint', () => {
    const feature = extracted([text('user', 'HINT-EXTRACT hello there')], { taskHint: 'extraction' });
    expect(feature.taskCategory).toBe('extraction');
    expect(feature.classificationSource).toBe('caller_hint');
    expect(JSON.stringify(feature)).not.toContain('HINT-EXTRACT');
    fixtures.push(`hint extraction ${JSON.stringify(shape(feature))}`);
  });

  it('infers reasoning when no hint is present', () => {
    const prompt = 'Explain this step by step.';
    const feature = extracted([text('user', prompt)]);
    expect(feature.taskCategory).toBe('reasoning');
    expect(feature.classificationSource).toBe('rules');
    expect(JSON.stringify(feature)).not.toContain(prompt);
    fixtures.push(`rules reasoning ${JSON.stringify(shape(feature))}`);
  });

  it('infers each remaining rule category', () => {
    const cases: Array<[string, string]> = [
      ['classification', 'Please classify this ticket.'],
      ['extraction', 'Extract the account number.'],
      ['summarization', 'Summarize the meeting notes.'],
      ['coding', 'Implement a function that adds two numbers.'],
      ['translation', 'Translate this sentence into French.'],
      ['writing', 'Draft a short product announcement.'],
      ['general_qa', 'What is the capital of France?'],
    ];
    for (const [category, prompt] of cases) {
      const feature = extracted([text('user', prompt)]);
      expect(feature.taskCategory).toBe(category);
      expect(feature.classificationSource).toBe('rules');
      expect(JSON.stringify(feature)).not.toContain(prompt);
      fixtures.push(`rules ${category} ${JSON.stringify(shape(feature))}`);
    }
  });

  it('leaves an unmatched request unknown and ignores an invalid hint', () => {
    const plain = extracted([text('user', 'hello there')]);
    expect(plain.taskCategory).toBe('unknown');
    expect(plain.classificationSource).toBe('unknown');
    const invalid = extracted([text('user', 'hello there')], { taskHint: 'not-a-task' });
    expect(invalid.taskCategory).toBe('unknown');
    expect(invalid.classificationSource).toBe('unknown');
    expect(JSON.stringify(invalid)).not.toContain('not-a-task');
    const ruled = extracted([text('user', 'Prove this claim.')], { taskHint: 'not-a-task' });
    expect(ruled.taskCategory).toBe('reasoning');
    expect(ruled.classificationSource).toBe('rules');
    expect(JSON.stringify(ruled)).not.toContain('not-a-task');
    fixtures.push(`unknown ${JSON.stringify(shape(plain))}`);
    fixtures.push(`invalid hint ${JSON.stringify(shape(invalid))}`);
  });

  it('keeps structure for a long prompt, streaming, and a multi-turn instruction', () => {
    const needle = 'NEEDLE-06A-PROMPT';
    const longText = `${needle} ${'alpha '.repeat(2000)}`;
    const started = performance.now();
    const longFeature = extracted([text('user', longText)]);
    const extractMs = performance.now() - started;
    expect(longFeature.taskCategory).toBe('unknown');
    expect(longFeature.inputSize).toBe(longText.length);
    expect(longFeature.inputTokenEstimate).toBe(Math.ceil(longText.length / 4));
    expect(longFeature.complexityEstimate).toBe('high');
    expect(JSON.stringify(longFeature)).not.toContain(needle);
    fixtures.push(`long extractMs=${extractMs.toFixed(3)} size=${longFeature.inputSize} estimate=${longFeature.inputTokenEstimate}`);

    const messages = [
      text('system', 'Follow the instruction.'),
      text('user', 'hello'),
      text('assistant', 'hi'),
      text('user', 'hello again'),
    ];
    const silent = extracted(messages, { stream: false });
    const streaming = extracted(messages, { stream: true });
    expect(silent.extractorVersion).toBe(FEATURE_EXTRACTOR_VERSION);
    expect(silent.messageCount).toBe(4);
    expect(silent.instructionPresent).toBe(true);
    expect(silent.conversationDepth).toBe(2);
    expect(silent.inputSize).toBe(messages.reduce((sum, message) => sum + message.content.length, 0));
    expect(silent.structuredOutput).toBe(false);
    expect(silent.toolRequired).toBe(false);
    expect(streaming.streamRequested).toBe(true);
    expect(shape({ ...streaming, streamRequested: false })).toEqual(shape(silent));
    fixtures.push(`structure ${JSON.stringify(shape(silent))}`);
  });

  it('rejects an invalid task on the chat body and does not forward a valid one as a provider field', () => {
    expect(() => validateChatRequest({ model: 'auto', messages: [text('user', 'hello')], task: 'nope' })).toThrow(
      /task must be a supported category/i,
    );
    const parsed = validateChatRequest({ model: 'auto', messages: [text('user', 'hello')], task: 'writing' });
    expect(parsed.taskHint).toBe('writing');
    expect(parsed.optional.task).toBeUndefined();
    const chat: ChatRequest = {
      model: 'auto',
      messages: [text('user', 'hello')],
      stream: false,
      includeUsage: false,
      taskHint: 'writing',
      optional: {},
    };
    expect(featureInputFromChat(chat).structuredOutput).toBe(false);
    expect(featureInputFromChat(chat).toolRequired).toBe(false);
    if (evidenceDir !== undefined && evidenceDir.length > 0) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'feature-extraction-fixtures.txt'), `${fixtures.join('\n')}\n`);
    }
  });
});
