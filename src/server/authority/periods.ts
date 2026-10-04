/**
 * Calendar periods for budgets and frequency limits, in UTC. A monthly budget
 * covers 1 Oct 00:00 UTC up to 1 Nov 00:00 UTC; a reservation counts in the
 * period in which it was made. (Rolling windows are not used: a calendar period
 * is what an owner means by "$2,000 a month", and it is easy to audit.)
 */

export type Period = "hour" | "day" | "week" | "month";

export type PeriodWindow = { period: Period; key: string; start: Date; end: Date; label: string };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");

export function periodWindow(period: Period, at: Date): PeriodWindow {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  switch (period) {
    case "hour": {
      const h = at.getUTCHours();
      const start = new Date(Date.UTC(y, m, d, h));
      return { period, key: `${y}-${pad(m + 1)}-${pad(d)}T${pad(h)}`, start, end: new Date(start.getTime() + 3_600_000), label: `${d} ${MONTHS[m].slice(0, 3)} ${y}, ${pad(h)}:00–${pad((h + 1) % 24)}:00 UTC` };
    }
    case "day": {
      const start = new Date(Date.UTC(y, m, d));
      return { period, key: `${y}-${pad(m + 1)}-${pad(d)}`, start, end: new Date(Date.UTC(y, m, d + 1)), label: `${d} ${MONTHS[m].slice(0, 3)} ${y} (UTC)` };
    }
    case "week": {
      // ISO week: Monday start; the week belongs to the year of its Thursday.
      const dow = (at.getUTCDay() + 6) % 7;
      const start = new Date(Date.UTC(y, m, d - dow));
      const thursday = new Date(start.getTime() + 3 * 86_400_000);
      const isoYear = thursday.getUTCFullYear();
      const jan4 = new Date(Date.UTC(isoYear, 0, 4));
      const week1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000);
      const week = 1 + Math.round((start.getTime() - week1.getTime()) / (7 * 86_400_000));
      return { period, key: `${isoYear}-W${pad(week)}`, start, end: new Date(start.getTime() + 7 * 86_400_000), label: `Week ${week}, ${isoYear} (UTC)` };
    }
    case "month": {
      const start = new Date(Date.UTC(y, m, 1));
      return { period, key: `${y}-${pad(m + 1)}`, start, end: new Date(Date.UTC(y, m + 1, 1)), label: `${MONTHS[m]} ${y} (UTC)` };
    }
  }
}

export const PERIOD_WORD: Record<Period, string> = { hour: "hour", day: "day", week: "week", month: "month" };
