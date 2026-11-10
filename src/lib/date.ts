export const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

export const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const today = () => new Date().toISOString().slice(0, 10);

export const daysBetween = (later: string, earlier: string) =>
  Math.round(
    (toDate(later).getTime() - toDate(earlier).getTime()) / 86_400_000,
  );
export const addDays = (s: string, n: number) =>
  fmt(new Date(toDate(s).getTime() + n * 86_400_000));

/**  (Jan 31 + 1m = Feb 28). */
export function addMonths(s: string, months: number): string {
  const [y, m, d] = s.split("-").map(Number);
  const total = m - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
