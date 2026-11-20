import { describe, expect, it } from "vitest";
import {
  daysOverdue,
  dollarsToCents,
  formatCents,
  formatDate,
  MoneyError,
  parseDollarText,
  sydneyDate,
} from "../src/money.js";

describe("dollarsToCents", () => {
  it("converts API decimals to whole cents", () => {
    expect(dollarsToCents(2145.5)).toBe(214550);
    expect(dollarsToCents(100.1)).toBe(10010);
    expect(dollarsToCents(0)).toBe(0);
    expect(dollarsToCents(-12.05)).toBe(-1205);
  });

  it("refuses more than two decimals and non-numbers", () => {
    expect(() => dollarsToCents(1.005)).toThrow(MoneyError);
    expect(() => dollarsToCents(Number.NaN)).toThrow(MoneyError);
    expect(() => dollarsToCents(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });

  it("settles the float trap that plain number maths gets wrong", () => {
    const float = 300.3 - 100.1 - 200.2;
    expect(float).not.toBe(0); // why the code never does this
    expect(dollarsToCents(300.3) - dollarsToCents(100.1) - dollarsToCents(200.2)).toBe(0);
  });
});

describe("formatting and parsing dollars", () => {
  it("formats cents with thousands separators", () => {
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(-2500)).toBe("-$25.00");
  });

  it("parses what it formats, and nothing else", () => {
    for (const cents of [0, 5, 99, 100, 214550, 123456789]) {
      expect(parseDollarText(formatCents(cents))).toBe(cents);
    }
    expect(parseDollarText("$80")).toBe(8000);
    expect(parseDollarText("80.00")).toBeNull();
    expect(parseDollarText("$1,23.00")).toBeNull();
  });
});

describe("dates", () => {
  it("counts calendar days across month ends and leap days", () => {
    expect(daysOverdue("2026-10-21", "2026-11-20")).toBe(30);
    expect(daysOverdue("2026-11-20", "2026-11-20")).toBe(0);
    expect(daysOverdue("2026-11-21", "2026-11-20")).toBe(-1);
    expect(daysOverdue("2028-02-28", "2028-03-01")).toBe(2);
  });

  it("refuses dates that don't exist", () => {
    expect(() => daysOverdue("2026-02-30", "2026-03-01")).toThrow(MoneyError);
    expect(() => daysOverdue("20/11/2026", "2026-11-20")).toThrow(MoneyError);
  });

  it("uses the Sydney date, not UTC", () => {
    expect(sydneyDate(new Date("2026-11-19T13:30:00Z"))).toBe("2026-11-20");
    expect(sydneyDate(new Date("2026-11-19T12:30:00Z"))).toBe("2026-11-19");
  });

  it("writes dates without digit-only formats", () => {
    expect(formatDate("2026-11-05")).toBe("5 Nov 2026");
  });
});
