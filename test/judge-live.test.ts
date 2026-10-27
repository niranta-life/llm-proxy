import { describe, expect, it } from 'vitest';

// CI uses the mock judge. A live Model C call stays outside the suite unless an operator sets the flag.
describe.skipIf(process.env.EVALUATION_JUDGE_LIVE !== 'true')('authorized live judge smoke', () => {
  it('runs only when an operator authorizes a live judge', () => {
    expect(process.env.EVALUATION_JUDGE_LIVE).toBe('true');
  });
});
