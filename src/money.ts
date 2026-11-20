/** Money is whole cents (integers) everywhere inside the code. Dates are YYYY-MM-DD strings. */

export class MoneyError extends Error {}

/** Converts a decimal dollar amount from an API to cents, refusing anything with more than 2 decimals. */
export function dollarsToCents(value: number): number {
  if (!Number.isFinite(value)) throw new MoneyError(`not a finite amount: ${value}`);
  const text = value.toString();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new MoneyError(`not an amount with at most 2 decimals: ${text}`);
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents)) throw new MoneyError(`amount too large: ${text}`);
  return match[1] === "-" ? -cents : cents;
}

/** 123456 -> "$1,234.56". Negative amounts are formatted with a leading minus. */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new MoneyError(`not whole cents: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = (abs % 100).toString().padStart(2, "0");
  return `${sign}$${dollars}.${rest}`;
}

/** Parses "$1,234.56" or "$80" back to cents. Returns null if it isn't a dollar figure. */
export function parseDollarText(text: string): number | null {
  const match = /^\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?$/.exec(text.trim());
  if (!match?.[1]) return null;
  return Number(match[1].replaceAll(",", "")) * 100 + Number(match[2] ?? "0");
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(date: string): number {
  const match = DATE.exec(date);
  if (!match) throw new MoneyError(`not a YYYY-MM-DD date: ${date}`);
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const check = new Date(ms).toISOString().slice(0, 10);
  if (check !== date) throw new MoneyError(`not a real date: ${date}`);
  return ms / 86_400_000;
}

/** Whole calendar days from the due date to the run date. Zero or less means not overdue. */
export function daysOverdue(dueDate: string, asOf: string): number {
  return dayNumber(asOf) - dayNumber(dueDate);
}

/** Today's date in Sydney, as YYYY-MM-DD. */
export function sydneyDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** "2026-11-15" -> "15 Nov 2026" (no digits-only dates in customer messages). */
export function formatDate(date: string): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  dayNumber(date);
  const [y, m, d] = date.split("-");
  return `${Number(d)} ${months[Number(m) - 1] ?? "?"} ${y ?? "?"}`;
}
