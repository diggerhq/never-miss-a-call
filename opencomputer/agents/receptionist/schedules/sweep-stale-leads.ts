import { defineSchedule } from "@opencomputer/agent";

/**
 * Most callers never text back — industry reply rates run 25-40% at best. This
 * closes out the ones who went quiet so the shop's list stays honest: a lead
 * sitting at "awaiting reply" for a day is a person to call, not a live thread.
 *
 * Deliberately does not nudge. One text per missed call.
 */
export default defineSchedule({
  id: "sweep-stale-leads",
  cron: "0 * * * *",
  timezone: "America/Chicago",
  enabled: ["development", "production"],
  overlap: "skip",
  dispatch: {
    text: "Close out leads that never got a reply.",
    payload: { mode: "sweep", olderThanHours: 24 },
  },
});
