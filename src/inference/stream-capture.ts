import { CAPTURE_BYTE_CEILING } from './sample-crypto.js';

export type VisibleCapture = {
  parts: string[];
  bytes: number;
  discarded: boolean;
};

export function createVisibleCapture(): VisibleCapture {
  return { parts: [], bytes: 0, discarded: false };
}

export function appendVisibleDelta(buffer: VisibleCapture, text: string): void {
  if (buffer.discarded || text.length === 0) return;
  const next = Buffer.byteLength(text, 'utf8');
  if (next > CAPTURE_BYTE_CEILING || buffer.bytes > CAPTURE_BYTE_CEILING - next) {
    buffer.parts = [];
    buffer.bytes = 0;
    buffer.discarded = true;
    return;
  }
  buffer.parts.push(text);
  buffer.bytes += next;
}

export function visibleCaptureText(buffer: VisibleCapture): string | null {
  if (buffer.discarded) return null;
  return buffer.parts.join('');
}
