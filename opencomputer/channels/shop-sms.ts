import { defineChannel } from "@opencomputer/agent";

/**
 * Calls and texts to the shop's Twilio number arrive here.
 *
 * The number itself is not in this file. It is bound to the connection per
 * environment in the dashboard, so development and production do not share
 * one — the same reason Slack conversation IDs are not in source.
 */
export default defineChannel({
  id: "shop-sms",
  type: "twilio",
  displayName: "Customer calls and texts",
  // Idle suspension is deliberately off. A suspended session does not resume
  // here — the runtime binding is gone by the time the next message arrives, so
  // resume is refused and the message is dropped. Until that is fixed, holding
  // the runtime costs money but keeps the conversation alive, which is the
  // trade worth making.
});
