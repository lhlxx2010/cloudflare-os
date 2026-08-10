import { Autocomplete, Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { CalendarConfiguratorRpc, CalendarConfiguratorValues } from "./calendar-configurator-types";

export default {
  initial: { availabilityMode: "thisCalendar" },

  isReady({ values }) {
    return typeof values.calendarId === "string" && values.calendarId.length > 0;
  },

  resourceUrl({ values }) {
    const calendarId = encodeURIComponent(values.calendarId ?? "");
    const availabilityMode = values.availabilityMode === "allVisible" ? "allVisible" : "thisCalendar";
    return `https://calendar.google.com/calendar/${calendarId}/?availability=${availabilityMode}`;
  },

  render({ values, setValues, ui }) {
    const availabilityMode = values.availabilityMode === "allVisible" ? "allVisible" : "thisCalendar";
    return <Section>
      <Field label="日历" description="选择此连接可以读取和管理的日历。">
        <Autocomplete
          name="calendarId"
          value={values.calendarId}
          placeholder="搜索日历…"
          loadOptions={query => ui.listCalendars(query)}
          onChange={calendarId => setValues({ calendarId })}
        />
      </Field>

      <Field
        label="空闲状态查询"
        description="忙闲检查只显示忙碌或空闲的时间段，不会显示事件详情。"
      >
        <RadioCards
          value={availabilityMode}
          options={[
            {
              value: "thisCalendar",
              title: "仅此日历",
              description: "仅检查此日历的空闲状态。",
            },
            {
              value: "allVisible",
              title: "我可见的所有日历",
              description: "检查你的账户可见的任何人；协作者也必须能够查看相应的空闲状态。",
            },
          ]}
          onChange={nextMode => {
            if (nextMode !== "thisCalendar" && nextMode !== "allVisible") return;
            setValues({ availabilityMode: nextMode });
          }}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CalendarConfiguratorRpc, CalendarConfiguratorValues>;
