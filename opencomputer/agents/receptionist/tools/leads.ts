import {
  bearer,
  defineConnection,
  defineTool,
  useSecret,
} from "@opencomputer/agent";

// Where finished leads land. Swap this file to point at a field service
// system instead — nothing in agent.ts changes.
export const airtable = defineConnection({
  id: "airtable-api",
  origin: "https://api.airtable.com",
  methods: ["GET", "POST", "PATCH"],
  pathPrefix: "/v0/",
  headers: {
    Authorization: bearer(useSecret("AIRTABLE_TOKEN")),
  },
});

function env(): Record<string, string | undefined> {
  const runtime = globalThis as {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env ?? {};
}

/**
 * Filing has its own switch, so you can write real leads to Airtable while
 * texts stay simulated. Both default to demo.
 */
function isLive(): boolean {
  return env().LEADS_MODE === "live";
}

export const fileLead = defineTool({
  name: "file_lead",
  description:
    "Create the lead row. Call this immediately after the first text goes out, " +
    "with whatever you already know — usually just the number, and the problem " +
    "if they left a voicemail. Returns a recordId. Use update_lead to fill in " +
    "the rest as the caller answers. Filing early means the shop still has the " +
    "lead if the caller never replies.",
  input: {
    type: "object",
    required: ["phone"],
    properties: {
      name: { type: "string" },
      phone: { type: "string", description: "Caller number in E.164" },
      address: { type: "string", description: "Service address" },
      problem: { type: "string", description: "In the caller's own words" },
      availability: { type: "string", description: "When they can be there" },
      urgency: {
        type: "string",
        enum: ["emergency", "same-day", "next-business-day"],
      },
      toldCaller: { type: "string", description: "What you promised them" },
      leadStatus: {
        type: "string",
        enum: ["awaiting reply", "qualified", "no reply"],
      },
    },
  },
  async run({ input, signal }) {
    const value = (key: string) =>
      input[key] === undefined || input[key] === null ? "" : String(input[key]);
    const fields = {
      Name: value("name"),
      Phone: value("phone"),
      Address: value("address"),
      Problem: value("problem"),
      Availability: value("availability"),
      Urgency: value("urgency"),
      "Told Caller": value("toldCaller"),
      "Lead Status": value("leadStatus") || "awaiting reply",
      "Received At": new Date().toISOString(),
    };

    if (!isLive()) {
      return {
        filed: false,
        mode: "demo",
        table: env().AIRTABLE_TABLE ?? "Leads",
        fields,
        note: "Demo mode: nothing was written to Airtable.",
      };
    }

    const base = env().AIRTABLE_BASE_ID;
    const table = env().AIRTABLE_TABLE ?? "Leads";
    if (!base) throw new Error("AIRTABLE_BASE_ID is not configured");

    const response = await airtable.fetch(
      `/v0/${base}/${encodeURIComponent(table)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ records: [{ fields }], typecast: true }),
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(
        `Airtable rejected the lead (${String(response.status)}). Check that ` +
          `the table name and column names match exactly.`,
      );
    }
    const created = (await response.json()) as {
      records?: Array<{ id?: string }>;
    };
    return {
      filed: true,
      mode: "live",
      table,
      recordId: created.records?.[0]?.id ?? null,
      fields,
    };
  },
});

export const updateLead = defineTool({
  name: "update_lead",
  description:
    "Fill in a lead you already filed, using the recordId that file_lead " +
    "returned. Call this each time the caller tells you something new, and set " +
    "leadStatus to 'qualified' once you have their name, address, problem, and " +
    "availability.",
  input: {
    type: "object",
    required: ["recordId"],
    properties: {
      recordId: { type: "string", description: "The id file_lead returned" },
      name: { type: "string" },
      address: { type: "string" },
      problem: { type: "string" },
      availability: { type: "string" },
      urgency: {
        type: "string",
        enum: ["emergency", "same-day", "next-business-day"],
      },
      toldCaller: { type: "string" },
      leadStatus: {
        type: "string",
        enum: ["awaiting reply", "qualified", "no reply"],
      },
    },
  },
  async run({ input, signal }) {
    const recordId = String(input.recordId ?? "");
    if (!recordId) throw new Error("update_lead requires a recordId");

    const column: Record<string, string> = {
      name: "Name",
      address: "Address",
      problem: "Problem",
      availability: "Availability",
      urgency: "Urgency",
      toldCaller: "Told Caller",
      leadStatus: "Lead Status",
    };
    const fields: Record<string, string> = {};
    for (const [key, name] of Object.entries(column)) {
      if (input[key] !== undefined && input[key] !== null && input[key] !== "") {
        fields[name] = String(input[key]);
      }
    }
    if (!Object.keys(fields).length) {
      throw new Error("update_lead needs at least one field to change");
    }

    if (!isLive()) {
      return {
        updated: false,
        mode: "demo",
        recordId,
        fields,
        note: "Demo mode: nothing was written to Airtable.",
      };
    }

    const base = env().AIRTABLE_BASE_ID;
    const table = env().AIRTABLE_TABLE ?? "Leads";
    if (!base) throw new Error("AIRTABLE_BASE_ID is not configured");

    const response = await airtable.fetch(
      `/v0/${base}/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields, typecast: true }),
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(
        `Airtable rejected the update (${String(response.status)}).`,
      );
    }
    return { updated: true, mode: "live", recordId, fields };
  },
});

interface LeadRow {
  recordId: string;
  [field: string]: unknown;
}

async function query(
  formula: string,
  signal: AbortSignal | undefined,
  extra: Record<string, string> = {},
): Promise<LeadRow[]> {
  const base = env().AIRTABLE_BASE_ID;
  const table = env().AIRTABLE_TABLE ?? "Leads";
  if (!base) throw new Error("AIRTABLE_BASE_ID is not configured");
  const params = new URLSearchParams({ filterByFormula: formula, ...extra });
  const response = await airtable.fetch(
    `/v0/${base}/${encodeURIComponent(table)}?${params.toString()}`,
    { signal },
  );
  if (!response.ok) {
    throw new Error(`Airtable rejected the query (${String(response.status)}).`);
  }
  const page = (await response.json()) as {
    records?: Array<{ id: string; fields: Record<string, unknown> }>;
  };
  return (page.records ?? []).map((r) => ({ recordId: r.id, ...r.fields }));
}

export const findLeadByPhone = defineTool({
  name: "find_lead_by_phone",
  description:
    "Look up an earlier lead for a phone number — a repeat customer, or a job " +
    "from last week. You do not need this to remember the current " +
    "conversation; the session already holds it.",
  input: {
    type: "object",
    required: ["phone"],
    properties: {
      phone: { type: "string", description: "Caller number in E.164" },
    },
  },
  async run({ input, signal }) {
    const phone = String(input.phone ?? "").trim();
    if (!phone) throw new Error("find_lead_by_phone requires a phone number");
    if (phone.includes("'")) throw new Error("Invalid phone number");

    if (!isLive()) {
      return {
        mode: "demo",
        leads: [],
        note:
          "Demo mode: no Airtable lookup. In a console session the earlier " +
          "conversation is already above, so read it there.",
      };
    }
    return {
      mode: "live",
      leads: await query(`{Phone}='${phone}'`, signal, {
        maxRecords: "1",
        "sort[0][field]": "Received At",
        "sort[0][direction]": "desc",
      }),
    };
  },
});

export const findStaleLeads = defineTool({
  name: "find_stale_leads",
  description:
    "List leads still marked 'awaiting reply' whose call came in more than " +
    "olderThanHours ago. Used by the hourly sweep to close out callers who " +
    "never texted back.",
  input: {
    type: "object",
    properties: {
      olderThanHours: {
        type: "number",
        description: "Defaults to 24.",
      },
    },
  },
  async run({ input, signal }) {
    const hours = Math.max(1, Number(input.olderThanHours ?? 24) || 24);
    const formula =
      `AND({Lead Status}='awaiting reply',` +
      `IS_BEFORE({Received At}, DATEADD(NOW(), -${hours}, 'hours')))`;

    if (!isLive()) {
      return { mode: "demo", leads: [], note: "Demo mode: no Airtable query." };
    }
    return { mode: "live", olderThanHours: hours, leads: await query(formula, signal) };
  },
});
