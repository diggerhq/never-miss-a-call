import {
  defineConnection,
  defineTool,
  secretHeader,
  useSecret,
} from "@opencomputer/agent";

function env(): Record<string, string | undefined> {
  const runtime = globalThis as {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env ?? {};
}

/**
 * The one message this agent sends itself.
 *
 * Replies to the caller go out through the channel — the platform delivers
 * whatever the agent answers, on the conversation the message arrived on. A
 * page goes to the on-call technician, who is not part of that conversation,
 * so it needs its own way out.
 */
export const twilio = defineConnection({
  id: "twilio-api",
  origin: "https://api.twilio.com",
  methods: ["POST"],
  pathPrefix: "/2010-04-01/Accounts/",
  headers: {
    // Twilio uses HTTP Basic, so the secret holds base64("<SID>:<TOKEN>").
    Authorization: secretHeader(useSecret("TWILIO_BASIC_AUTH"), {
      prefix: "Basic ",
    }),
  },
});

export const pageOnCall = defineTool({
  name: "page_on_call",
  description:
    "Wake the on-call technician for a genuine emergency: active leak, no heat " +
    "in freezing weather, gas smell, sewage backup, no water. Use this sparingly " +
    "and only once you have an address.",
  input: {
    type: "object",
    required: ["summary", "callerNumber"],
    properties: {
      summary: { type: "string", description: "One line: what is wrong and where." },
      callerNumber: { type: "string" },
      address: { type: "string" },
    },
  },
  async run({ input, signal }) {
    const summary = String(input.summary ?? "");
    const callerNumber = String(input.callerNumber ?? "");
    const address = input.address ? String(input.address) : "address not captured";
    const page = `EMERGENCY: ${summary} — ${address} — call back ${callerNumber}`;

    const to = env().ON_CALL_NUMBER;
    const from = env().BUSINESS_NUMBER;
    const sid = env().TWILIO_ACCOUNT_SID;
    if (!to || !from || !sid) {
      return {
        paged: false,
        reason: "ON_CALL_NUMBER, BUSINESS_NUMBER and TWILIO_ACCOUNT_SID are not all set",
        message: page,
      };
    }
    const response = await twilio.fetch(`/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: from, Body: page }).toString(),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Twilio rejected the page (${String(response.status)})`);
    }
    return { paged: true, to, message: page };
  },
});
