import { registerChannel } from "@opencomputer/agent";
import shopSms from "../../../channels/shop-sms.js";

// One trigger: somebody sent us something. A text and a voicemail both arrive
// this way, and the conversation is keyed on their number either way.
export default registerChannel(shopSms, { on: ["message"] });
