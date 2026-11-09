import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mergeIntervals, type Interval } from '../src/intervals';

// Valid by construction: start + a non-negative length. The small range makes
// overlapping, touching, nested, and single-point intervals common.
const interval: fc.Arbitrary<Interval> = fc
  .tuple(fc.integer({ min: -20, max: 20 }), fc.nat(10))
  .map(([start, length]): Interval => [start, start + length]);

// Lays intervals out left to right. A step of 0 shares an endpoint exactly, a
// step of 1 leaves a gap between adjacent integers, and negative steps overlap.
const chainedIntervals: fc.Arbitrary<Interval[]> = fc
  .tuple(
    fc.integer({ min: -20, max: 20 }),
    fc.array(fc.tuple(fc.integer({ min: -2, max: 2 }), fc.nat(4)), { maxLength: 12 }),
  )
  .map(([origin, steps]) => {
    let cursor = origin;
    return steps.map(([step, length]): Interval => {
      const start = cursor + step;
      cursor = start + length;
      return [start, cursor];
    });
  });

// Exact copies of an existing list element are valid input too.
const withDuplicates = (xs: Interval[]): fc.Arbitrary<Interval[]> =>
  xs.length === 0
    ? fc.constant(xs)
    : fc.array(fc.constantFrom(...xs), { maxLength: 4 }).map(extra => [...xs, ...extra]);

const shuffled = <T>(xs: T[]): fc.Arbitrary<T[]> =>
  fc.shuffledSubarray(xs, { minLength: xs.length, maxLength: xs.length });

// Moving a whole list far from zero keeps its overlaps and touches, while
// reaching bugs that a small range hides, such as integer overflow.
const farFromZero: fc.Arbitrary<number> = fc.oneof(
  { weight: 3, arbitrary: fc.constant(0) },
  { weight: 1, arbitrary: fc.constantFrom(1_000, -40_000, 65_536, 2 ** 31, -(2 ** 31), 2 ** 40) },
);

const intervalList: fc.Arbitrary<Interval[]> = fc
  .tuple(fc.oneof(fc.array(interval, { maxLength: 12 }), chainedIntervals), farFromZero)
  .map(([xs, offset]) => xs.map(([start, end]): Interval => [start + offset, end + offset]))
  .chain(withDuplicates)
  .chain(shuffled);

const listAndShuffle: fc.Arbitrary<[Interval[], Interval[]]> = intervalList.chain(xs =>
  fc.tuple(fc.constant(xs), shuffled(xs)),
);

// Sorted, with at least one uncovered real number between neighbours.
const separatedIntervals: fc.Arbitrary<Interval[]> = fc
  .tuple(
    fc.integer({ min: -20, max: 20 }),
    fc.array(fc.tuple(fc.integer({ min: 1, max: 5 }), fc.nat(5)), { maxLength: 10 }),
  )
  .map(([origin, pieces]) => {
    let cursor = origin;
    return pieces.map(([gap, length]): Interval => {
      const start = cursor + gap;
      cursor = start + length;
      return [start, cursor];
    });
  });

const invalidInterval: fc.Arbitrary<Interval> = fc.oneof(
  // start > end
  fc
    .tuple(fc.integer({ min: -20, max: 20 }), fc.integer({ min: 1, max: 10 }))
    .map(([start, drop]): Interval => [start, start - drop]),
  // non-integer start, still with start <= end
  fc
    .tuple(fc.integer({ min: -20, max: 20 }), fc.nat(10))
    .map(([start, length]): Interval => [start + 0.5, start + 1 + length]),
  // non-integer end, still with start <= end
  fc
    .tuple(fc.integer({ min: -20, max: 20 }), fc.nat(10))
    .map(([start, length]): Interval => [start, start + length + 0.5]),
  // not finite numbers
  fc.constantFrom<Interval>([NaN, 1], [1, NaN], [0, Infinity], [-Infinity, 0]),
);

// Tiny reference check: is p inside any interval of the list?
const covered = (list: readonly Interval[], p: number): boolean =>
  list.some(([start, end]) => start <= p && p <= end);

// Every integer and half-integer from just left of the list to just right of it.
const samplePoints = (list: readonly Interval[]): number[] => {
  if (list.length === 0) return [];
  const low = Math.min(...list.map(([start]) => start)) - 1;
  const high = Math.max(...list.map(([, end]) => end)) + 1;
  const points: number[] = [];
  for (let p = low; p <= high; p += 0.5) points.push(p);
  return points;
};

describe('mergeIntervals', () => {
  // Pattern: invariant. Every input interval lies inside some output interval.
  it('every input interval lies inside some output interval', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const out = mergeIntervals(xs);
        const uncovered = xs.filter(([s, e]) => !out.some(([a, b]) => a <= s && e <= b));
        expect(uncovered).toEqual([]);
      }),
    );
  });

  // Pattern: invariant. The output is well formed, sorted, and neighbours neither overlap nor touch.
  it('output intervals are valid, sorted, and strictly separated', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const out = mergeIntervals(xs);
        for (const [start, end] of out) expect(start).toBeLessThanOrEqual(end);
        for (let i = 0; i + 1 < out.length; i++) {
          expect(out[i]![1]).toBeLessThan(out[i + 1]![0]);
        }
      }),
    );
  });

  // Pattern: invariant. The input array and its intervals are not modified.
  it('does not modify its input', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const before = structuredClone(xs);
        mergeIntervals(xs);
        expect(xs).toEqual(before);
      }),
    );
  });

  // Pattern: invariant. Any invalid interval, anywhere in the list, throws a RangeError.
  it('throws a RangeError when any interval is invalid', () => {
    fc.assert(
      fc.property(intervalList, intervalList, invalidInterval, (before, after, bad) => {
        expect(() => mergeIntervals([...before, bad, ...after])).toThrow(RangeError);
      }),
    );
  });

  // Pattern: differential. A real point is covered by the output exactly when the input covers it.
  it('covers exactly the same integer and half-integer points as the input', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const out = mergeIntervals(xs);
        for (const p of samplePoints(xs)) {
          expect([p, covered(out, p)]).toEqual([p, covered(xs, p)]);
        }
      }),
    );
  });

  // Pattern: metamorphic. Reordering the input does not change the output.
  it('ignores input order', () => {
    fc.assert(
      fc.property(listAndShuffle, ([xs, reordered]) => {
        expect(mergeIntervals(reordered)).toEqual(mergeIntervals(xs));
      }),
    );
  });

  // Pattern: metamorphic. Repeating the whole input does not change the output.
  it('ignores duplicates', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        expect(mergeIntervals([...xs, ...xs])).toEqual(mergeIntervals(xs));
      }),
    );
  });

  // Pattern: metamorphic. Shifting every input interval shifts the output by the same amount.
  it('shifts along with its input', () => {
    fc.assert(
      fc.property(intervalList, fc.integer({ min: -50, max: 50 }), (xs, k) => {
        const shift = (list: readonly Interval[]) =>
          list.map(([start, end]): Interval => [start + k, end + k]);
        expect(mergeIntervals(shift(xs))).toEqual(shift(mergeIntervals(xs)));
      }),
    );
  });

  // Pattern: algebraic. Merging is idempotent.
  it('merging an already merged list changes nothing', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const once = mergeIntervals(xs);
        expect(mergeIntervals(once)).toEqual(once);
      }),
    );
  });

  // Pattern: conditional. If no intervals overlap or touch, the output is the input in sorted order.
  it('returns separated intervals unchanged, in sorted order', () => {
    fc.assert(
      fc.property(
        separatedIntervals.chain(xs => fc.tuple(fc.constant(xs), shuffled(xs))),
        ([sorted, input]) => {
          expect(mergeIntervals(input)).toEqual(sorted);
        },
      ),
    );
  });

  // Pattern: conditional. If two intervals share exactly one endpoint, they merge into one.
  it('merges intervals that touch at a single point', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -20, max: 20 }),
        fc.nat(10),
        fc.nat(10),
        (start, left, right) => {
          const middle = start + left;
          const end = middle + right;
          expect(
            mergeIntervals([
              [start, middle],
              [middle, end],
            ]),
          ).toEqual([[start, end]]);
        },
      ),
    );
  });

  // Pattern: conditional. An interval nested inside another disappears into it.
  it('keeps the outer interval when another is nested inside it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -20, max: 20 }),
        fc.nat(10),
        fc.nat(10),
        fc.nat(10),
        (start, before, length, after) => {
          const outer: Interval = [start, start + before + length + after];
          const inner: Interval = [start + before, start + before + length];
          expect(mergeIntervals([outer, inner])).toEqual([outer]);
          expect(mergeIntervals([inner, outer])).toEqual([outer]);
        },
      ),
    );
  });

  // Pattern: conditional. An empty input gives an empty output.
  it('returns [] for []', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});
