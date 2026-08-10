import type { ManagementSchedule } from "../src/management-types";
import type { ScheduleCadence, Weekday } from "../src/types";

const WEEKDAYS: Record<Weekday, string> = {
  SU: "周日",
  MO: "周一",
  TU: "周二",
  WE: "周三",
  TH: "周四",
  FR: "周五",
  SA: "周六",
};

export type ScheduleTiming = {
  relative: string;
  absolute?: string;
  diagnostic?: string;
};

export function formatCadence(cadence: ScheduleCadence, locale = "zh-CN"): string {
  if (cadence.kind === "interval") return formatInterval(cadence.everyMs);
  if (cadence.kind === "once") {
    const date = new Intl.DateTimeFormat(locale, {
      timeZone: cadence.timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(cadence.fireAt);
    const time = new Intl.DateTimeFormat(locale, {
      timeZone: cadence.timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(cadence.fireAt);
    return `${date} ${time} 执行一次`;
  }

  const { rule } = cadence;
  if (rule.freq === "hourly") {
    const prefix = rule.interval === 1 ? "每小时" : `每 ${rule.interval} 小时`;
    return `${prefix}的第 ${rule.minute.toString().padStart(2, "0")} 分钟`;
  }
  const time = formatClock(rule.hour, rule.minute, locale);
  if (rule.freq === "daily") {
    return rule.interval === 1 ? `每天 ${time}` : `每 ${rule.interval} 天的 ${time}`;
  }
  if (rule.interval === 1 && rule.byDay.join(",") === "MO,TU,WE,TH,FR") {
    return `工作日 ${time}`;
  }
  const days = new Intl.ListFormat(locale, { style: "short", type: "conjunction" }).format(
    rule.byDay.map((day) => WEEKDAYS[day]),
  );
  const prefix = rule.interval === 1 ? "每周" : `每 ${rule.interval} 周`;
  return `${prefix}的${days} ${time}`;
}

/** Describes a finite recurrence bound and, for a counted bound, progress toward it. */
export function formatOccurrences(
  schedule: ManagementSchedule,
  locale = "zh-CN",
): string | undefined {
  const bound = schedule.occurrences;
  if (!bound) return undefined;
  if ("count" in bound) {
    return `已执行 ${schedule.occurrenceCount ?? 0}/${bound.count} 次`;
  }
  return `持续至 ${formatAbsolute(bound.until, scheduleTimeZone(schedule), locale)}`;
}

export function formatTiming(
  schedule: ManagementSchedule,
  now = Date.now(),
  locale = "zh-CN",
): ScheduleTiming {
  const timestamp = scheduleTimestamp(schedule);
  if (timestamp === undefined) return { relative: "下次运行时间待定" };
  const absolute = formatAbsolute(timestamp, scheduleTimeZone(schedule), locale);
  if (schedule.status === "active") {
    return {
      relative: `${formatRelative(timestamp - now, locale)}运行${schedule.retrying ? "（重试）" : ""}`,
      absolute,
    };
  }
  if (schedule.status === "dead") {
    return {
      relative: `${formatRelative(schedule.failedAt - now, locale)}失败`,
      absolute,
      diagnostic:
        schedule.failureCode === "authorization_failed"
          ? "多次重试后授权仍然失败。"
          : "多次重试后任务回调仍然失败。",
    };
  }
  if (schedule.status === "completed") {
    return {
      relative: `${formatRelative(schedule.completedAt - now, locale)}完成`,
      absolute,
      diagnostic: schedule.occurrences
        ? "此重复任务已完成最后一次计划运行。"
        : "此一次性任务已完成。",
    };
  }
  return {
    relative: `${formatRelative(schedule.expiredAt - now, locale)}过期`,
    absolute,
    diagnostic: schedule.cadence.kind === "once"
      ? "此一次性任务已过期，未能执行。"
      : "此重复任务在首次运行前便已超过截止时间。",
  };
}

function formatInterval(milliseconds: number): string {
  const units = [
    [7 * 24 * 60 * 60_000, "周"],
    [24 * 60 * 60_000, "天"],
    [60 * 60_000, "小时"],
    [60_000, "分钟"],
    [1_000, "秒"],
  ] as const;
  const [unitMs, unit] = units.find(([size]) => milliseconds % size === 0) ?? [1, "毫秒"];
  const count = milliseconds / unitMs;
  return count === 1 ? `每${unit}` : `每 ${count} ${unit}`;
}

function formatClock(hour: number, minute: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(Date.UTC(2020, 0, 1, hour, minute));
}

function formatRelative(milliseconds: number, locale: string): string {
  const absolute = Math.abs(milliseconds);
  const [size, unit] =
    absolute >= 24 * 60 * 60_000
      ? ([24 * 60 * 60_000, "day"] as const)
      : absolute >= 60 * 60_000
        ? ([60 * 60_000, "hour"] as const)
        : absolute >= 60_000
          ? ([60_000, "minute"] as const)
          : ([1_000, "second"] as const);
  const value = Math.round(milliseconds / size);
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value, unit);
}

function formatAbsolute(timestamp: number, timeZone: string | undefined, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(timestamp);
}

function scheduleTimestamp(schedule: ManagementSchedule): number | undefined {
  if (schedule.status === "active") return schedule.nextFire;
  if (schedule.status === "dead") return schedule.failedAt;
  if (schedule.status === "completed") return schedule.completedAt;
  return schedule.expiredAt;
}

function scheduleTimeZone(schedule: ManagementSchedule): string | undefined {
  return schedule.cadence.kind === "interval" ? undefined : schedule.cadence.timeZone;
}
