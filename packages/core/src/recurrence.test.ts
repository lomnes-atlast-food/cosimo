import { describe, expect, test } from "bun:test";
import { addDays } from "@cosimo/shared";
import {
  describeSchedule,
  firstIndexOnOrAfter,
  LAST_DAY,
  occurrence,
  rawOccurrence,
  renderPeriodText,
  type Schedule,
  upcoming,
} from "./recurrence.ts";

const dates = (s: Schedule, count: number, from = 0) => upcoming(s, from, count).map((o) => o.date);

describe("occurrences", () => {
  test("monthly on the 31st doesn't drift after short months, and finds Feb 29 in a leap year", () => {
    const s: Schedule = { unit: "month", interval: 1, start_date: "2026-01-31" };
    expect(dates(s, 5)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    // 2028-02 is 25 months after 2026-01.
    expect(occurrence(s, 25)).toBe("2028-02-29");
    expect(occurrence(s, 26)).toBe("2028-03-31");
  });

  test("last day of the month, starting mid-month", () => {
    const s: Schedule = { unit: "month", interval: 1, anchor_day: LAST_DAY, start_date: "2026-01-15" };
    expect(dates(s, 4)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  test("an anchor before the start date's day starts in the next month", () => {
    const s: Schedule = { unit: "month", interval: 1, anchor_day: 5, start_date: "2026-01-20" };
    expect(dates(s, 2)).toEqual(["2026-02-05", "2026-03-05"]);
  });

  test("quarterly anchored on the 31st", () => {
    const s: Schedule = { unit: "month", interval: 3, anchor_day: 31, start_date: "2026-01-31" };
    expect(dates(s, 5)).toEqual(["2026-01-31", "2026-04-30", "2026-07-31", "2026-10-31", "2027-01-31"]);
  });

  test("yearly from Feb 29 lands on Feb 28, then Feb 29 again in the next leap year", () => {
    const s: Schedule = { unit: "year", interval: 1, start_date: "2024-02-29" };
    expect(dates(s, 5)).toEqual(["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
  });

  test("every 2 weeks, across a year boundary", () => {
    const s: Schedule = { unit: "week", interval: 2, start_date: "2026-12-14" };
    expect(dates(s, 4)).toEqual(["2026-12-14", "2026-12-28", "2027-01-11", "2027-01-25"]);
  });

  test("every 10 days", () => {
    const s: Schedule = { unit: "day", interval: 10, start_date: "2026-02-20" };
    expect(dates(s, 3)).toEqual(["2026-02-20", "2026-03-02", "2026-03-12"]);
  });

  test("a maximum count and an inclusive end date stop the schedule", () => {
    const max: Schedule = { unit: "month", interval: 1, start_date: "2026-01-01", max_occurrences: 3 };
    expect(dates(max, 10)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(occurrence(max, 3)).toBeNull();
    const end: Schedule = { unit: "month", interval: 1, start_date: "2026-01-01", end_date: "2026-03-01" };
    expect(dates(end, 10)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(occurrence({ ...end, end_date: "2026-02-28" }, 2)).toBeNull();
    expect(occurrence(end, -1)).toBeNull();
  });

  test("firstIndexOnOrAfter matches a brute-force scan", () => {
    const schedules: Schedule[] = [
      { unit: "day", interval: 1, start_date: "2026-01-01" },
      { unit: "day", interval: 10, start_date: "2026-02-20" },
      { unit: "week", interval: 2, start_date: "2026-12-14" },
      { unit: "month", interval: 1, start_date: "2026-01-31" },
      { unit: "month", interval: 1, anchor_day: LAST_DAY, start_date: "2026-01-15" },
      { unit: "month", interval: 3, anchor_day: 31, start_date: "2026-01-31" },
      { unit: "month", interval: 2, anchor_day: 5, start_date: "2026-01-20" },
      { unit: "year", interval: 1, start_date: "2024-02-29" },
      { unit: "year", interval: 2, anchor_day: LAST_DAY, start_date: "2025-03-10" },
    ];
    for (const s of schedules) {
      for (let i = -5; i < 900; i += 7) {
        const date = addDays(s.start_date, i);
        let brute = 0;
        while (rawOccurrence(s, brute) < date) brute++;
        expect(firstIndexOnOrAfter(s, date)).toBe(brute);
      }
    }
  });
});

describe("describeSchedule", () => {
  test("summaries", () => {
    expect(
      describeSchedule({ unit: "month", interval: 1, anchor_day: LAST_DAY, start_date: "2026-01-31" }),
    ).toBe("Monthly on the last day");
    expect(describeSchedule({ unit: "month", interval: 1, start_date: "2026-01-15" })).toBe(
      "Monthly on the 15th",
    );
    expect(describeSchedule({ unit: "week", interval: 2, start_date: "2026-09-28" })).toBe(
      "Every 2 weeks on Monday",
    );
    expect(describeSchedule({ unit: "week", interval: 1, start_date: "2026-10-02" })).toBe(
      "Weekly on Friday",
    );
    expect(
      describeSchedule({
        unit: "month",
        interval: 3,
        anchor_day: 31,
        start_date: "2026-01-31",
        max_occurrences: 12,
      }),
    ).toBe("Quarterly on the 31st, 12 times");
    expect(describeSchedule({ unit: "month", interval: 2, anchor_day: 22, start_date: "2026-01-01" })).toBe(
      "Every 2 months on the 22nd",
    );
    expect(describeSchedule({ unit: "day", interval: 1, start_date: "2026-01-01", max_occurrences: 1 })).toBe(
      "Daily, 1 time",
    );
    expect(
      describeSchedule({ unit: "day", interval: 10, start_date: "2026-01-01", end_date: "2026-12-31" }),
    ).toBe("Every 10 days, until 2026-12-31");
    expect(describeSchedule({ unit: "year", interval: 1, start_date: "2024-02-29" })).toBe(
      "Yearly on February 29",
    );
    expect(
      describeSchedule({ unit: "year", interval: 2, anchor_day: LAST_DAY, start_date: "2026-02-01" }),
    ).toBe("Every 2 years on the last day of February");
    expect(describeSchedule({ unit: "month", interval: 1, anchor_day: 3, start_date: "2026-01-01" })).toBe(
      "Monthly on the 3rd",
    );
    expect(describeSchedule({ unit: "month", interval: 1, anchor_day: 11, start_date: "2026-01-01" })).toBe(
      "Monthly on the 11th",
    );
  });
});

describe("renderPeriodText", () => {
  test("every placeholder", () => {
    expect(renderPeriodText("{month} {year} {quarter} {period} {date}", "2026-05-31")).toBe(
      "May 2026 Q2 May 2026 2026-05-31",
    );
  });

  test("offsets across a year boundary", () => {
    const d = "2026-01-15";
    expect(renderPeriodText("{month-1}", d)).toBe("December");
    expect(renderPeriodText("{period-1}", d)).toBe("December 2025");
    expect(renderPeriodText("{year-1}", d)).toBe("2025");
    expect(renderPeriodText("{quarter-1}", d)).toBe("Q4");
    expect(renderPeriodText("{month+12}", d)).toBe("January");
    expect(renderPeriodText("{period+1}", "2026-12-01")).toBe("January 2027");
  });

  test("unknown tokens are left as typed", () => {
    expect(renderPeriodText("Rent {Month} {week} {date+1} {month", "2026-01-15")).toBe(
      "Rent {Month} {week} {date+1} {month",
    );
  });
});
