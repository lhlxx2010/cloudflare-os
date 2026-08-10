import { describe, expect, it } from "vitest";
import { formatCadence, formatOccurrences, formatTiming } from "./format";
import type { ManagementSchedule } from "../src/management-types";

const common = {
  scheduleId: "schedule-a",
  title: "Morning brief",
  description: "Prepare the morning brief.",
  workspaceId: "a".repeat(64),
};

describe("formatCadence", () => {
  it("describes interval, weekday, and one-shot schedules", () => {
    expect(formatCadence({ kind: "interval", everyMs: 3_600_000, anchorMs: 0 })).toBe("每小时");
    expect(
      formatCadence({
        kind: "calendar",
        timeZone: "America/Chicago",
        rule: {
          freq: "weekly",
          interval: 1,
          byDay: ["MO", "TU", "WE", "TH", "FR"],
          hour: 8,
          minute: 0,
          anchorMs: 0,
        },
      }),
    ).toBe("工作日 8:00");
    expect(
      formatCadence({
        kind: "once",
        fireAt: Date.UTC(2026, 6, 30, 14),
        timeZone: "America/Chicago",
      }),
    ).toBe("2026年7月30日 9:00 执行一次");
  });
});

describe("formatTiming", () => {
  it("uses bounded status copy and relative timestamps", () => {
    const now = Date.UTC(2026, 6, 30, 12);
    const active: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "active",
      nextFire: now + 2 * 3_600_000,
    };
    const dead: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "dead",
      failedAt: now - 60_000,
      failureCode: "authorization_failed",
    };

    expect(formatTiming(active, now).relative).toBe("2小时后运行");
    expect(formatTiming(dead, now)).toMatchObject({
      relative: "1分钟前失败",
      diagnostic: "多次重试后授权仍然失败。",
    });
  });

  it("does not invent an absolute time while the next run is pending", () => {
    const active: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "active",
    };

    expect(formatTiming(active, Date.UTC(2026, 6, 30, 12))).toEqual({
      relative: "下次运行时间待定",
    });
  });

  it("marks a retry so it is not mistaken for a new occurrence", () => {
    const now = Date.UTC(2026, 6, 30, 12);
    const retrying: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "active",
      nextFire: now + 5 * 60_000,
      retrying: true,
    };

    expect(formatTiming(retrying, now).relative).toBe("5分钟后运行（重试）");
  });
});

describe("formatOccurrences", () => {
  const hourly = {
    ...common,
    cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
    status: "active",
    nextFire: 0,
  } as const satisfies Partial<ManagementSchedule> as ManagementSchedule;

  it("reports progress toward a counted bound", () => {
    expect(formatOccurrences({ ...hourly, occurrences: { count: 3 }, occurrenceCount: 1 }))
      .toBe("已执行 1/3 次");
    expect(formatOccurrences({ ...hourly, occurrences: { count: 1 } }))
      .toBe("已执行 0/1 次");
  });

  it("renders a time bound in the schedule's own timezone", () => {
    const until = Date.UTC(2026, 7, 3, 13);
    const calendar: ManagementSchedule = {
      ...hourly,
      cadence: {
        kind: "calendar",
        timeZone: "America/New_York",
        rule: { freq: "daily", interval: 1, hour: 9, minute: 0, anchorMs: 0 },
      },
      occurrences: { until },
    };

    // Rendered in the cadence's zone, not UTC: 13:00Z is 9am in New York.
    expect(formatOccurrences(calendar)).toContain("2026年8月3日");
    expect(formatOccurrences(calendar)).toContain("GMT-4");
  });

  it("omits a bound the schedule does not have", () => {
    expect(formatOccurrences(hourly)).toBeUndefined();
  });
});

describe("formatTiming terminal copy", () => {
  const base = {
    ...common,
    cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
    status: "completed",
    completedAt: 0,
  } as const satisfies Partial<ManagementSchedule> as ManagementSchedule;

  it("distinguishes a used bound from a delivered one-shot", () => {
    expect(formatTiming({ ...base, occurrences: { count: 2 } }, 0).diagnostic)
      .toBe("此重复任务已完成最后一次计划运行。");
    expect(
      formatTiming(
        { ...base, cadence: { kind: "once", fireAt: 0, timeZone: "UTC" } },
        0,
      ).diagnostic,
    ).toBe("此一次性任务已完成。");
  });

  it("explains a recurrence that expired before its first occurrence", () => {
    const expired = { ...base, status: "expired", expiredAt: 0 } as ManagementSchedule;

    expect(formatTiming(expired, 0).diagnostic)
      .toBe("此重复任务在首次运行前便已超过截止时间。");
  });
});
