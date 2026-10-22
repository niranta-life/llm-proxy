import { afterAll, describe, expect, it } from 'vitest';
import { addDecimal, canonicalDecimal } from '../src/inference/cost.js';
import { loadTestDatabase } from './helpers.js';
import { adminPool } from './inference-support.js';

const db = loadTestDatabase();
const admin = adminPool(db);

afterAll(async () => {
  await admin.end();
});

type Split = { recognized: string; provisional: string; released: string };

function money(value: string): string {
  return canonicalDecimal(value);
}

async function split(
  mode: string,
  allocation: string,
  recognizedAlready: string,
  reserved: string | null,
  known: string | null,
): Promise<Split> {
  const result = await admin.query<{ recognized: string; provisional: string; released: string }>(
    `SELECT recognized::text, provisional::text, released::text
     FROM split_known_charge($1, $2::numeric, $3::numeric, $4::numeric, $5::numeric)`,
    [mode, allocation, recognizedAlready, reserved, known],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('split is missing');
  return {
    recognized: money(row.recognized),
    provisional: money(row.provisional),
    released: money(row.released),
  };
}

describe('split_known_charge', () => {
  it('returns the known-charge split and writes nothing', async () => {
    const before = await admin.query<{ count: string }>('SELECT count(*)::text AS count FROM cost_ledger');
    const hard = await split('hard', '2', '0', '1', '5');
    expect(hard).toEqual({ recognized: money('1'), provisional: money('0'), released: money('0') });
    const hardIgnoresRoom = await split('hard', '2', '99', '1', '5');
    expect(hardIgnoresRoom).toEqual(hard);

    const partial = await split('observe', '0.01', '0', '0.04', '0.03');
    expect(partial).toEqual({
      recognized: money('0.01'),
      provisional: money('0.02'),
      released: money('0.01'),
    });

    const empty = await split('observe', '0', '0', null, '0.03');
    expect(empty).toEqual({
      recognized: money('0'),
      provisional: money('0.03'),
      released: money('0'),
    });

    const forwardFirst = await split('observe', '1', '0', '0.80', '0.70');
    const forwardSecond = await split('observe', '1', '0.70', '0.80', '0.70');
    expect(forwardFirst).toEqual({
      recognized: money('0.70'),
      provisional: money('0'),
      released: money('0.10'),
    });
    expect(forwardSecond).toEqual({
      recognized: money('0.30'),
      provisional: money('0.40'),
      released: money('0.10'),
    });
    expect(addDecimal(forwardFirst.recognized, forwardSecond.recognized)).toBe(money('1.00'));
    expect(addDecimal(forwardFirst.provisional, forwardSecond.provisional)).toBe(money('0.40'));

    const reverseFirst = await split('observe', '1', '0', '0.80', '0.70');
    const reverseSecond = await split('observe', '1', forwardFirst.recognized, '0.80', '0.70');
    expect(reverseFirst).toEqual(forwardFirst);
    expect(reverseSecond).toEqual(forwardSecond);
    expect(addDecimal(reverseFirst.recognized, reverseSecond.recognized)).toBe(money('1.00'));
    expect(addDecimal(reverseFirst.provisional, reverseSecond.provisional)).toBe(money('0.40'));

    const after = await admin.query<{ count: string }>('SELECT count(*)::text AS count FROM cost_ledger');
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('rejects a null known charge', async () => {
    await expect(split('observe', '1', '0', '0.80', null)).rejects.toThrow(/known charge is missing/);
  });
});
