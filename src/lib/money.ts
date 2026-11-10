export type Rate = { num: bigint; den: bigint };

/** Half-up rounding of num/den to an integer. Requires num >= 0, den > 0. */
export const roundDiv = (num: bigint, den: bigint): bigint => {
  if (num < 0n || den <= 0n)
    throw new Error("roundDiv expects num >= 0 and den > 0");
  return (2n * num + den) / (2n * den);
};

/** "0.18" -> 18/100. Exact; no floats. */
export function parseRate(input: string | number): Rate {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(input).trim());
  if (!m) throw new Error(`Invalid rate: ${input}`);
  const frac = m[2] ?? "";
  return { num: BigInt(m[1] + frac), den: 10n ** BigInt(frac.length) };
}

export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
