# Never Miss A Call

A plumber misses a call at 7:14pm. The caller waits four rings, hangs up, and
dials the next shop on the list. That was a $4,000 water heater job, and nobody
at the shop will ever know it existed.

This is a serverless agent that answers the call the shop didn't, takes a
voicemail, texts the caller back, and either pages the on-call tech or leaves a
clean brief for the morning.

```
missed call ─▶ voicemail ─┐
                          ├─▶ one conversation, keyed on their number
customer texts back ──────┘        │
                                   ├── file the lead immediately
                                   ├── emergency? page the on-call tech
                                   └── qualified? mark it and stop
```

## What makes it small

The agent has no `send_text`. **Its reply is the text message** — the channel
delivers whatever it answers, on the conversation the message arrived on.

It has no way to look up the conversation either. A voicemail and every text
that follows share one session, so the history is already in front of it.

What's left is the part that's actually this business's problem: qualify the
job, file it where the shop looks, and know when to wake somebody up.

## Requires an unreleased CLI

This declares a Twilio channel, which needs multi-provider channel support in
`@opencomputer/cli` (diggerhq/opencomputer#717) and on the platform
(diggerhq/blue#52). Until both ship, `opencomputer doctor` reports
`supports only type "slack"`.

## Set it up

```bash
npm install
npx opencomputer login
npx opencomputer link --create-project never-miss-a-call
```

**Airtable**, for where leads land. Create a base with a `Leads` table and these
columns: `Name`, `Phone`, `Address`, `Problem`, `Availability`, `Urgency`,
`Told Caller`, `Lead Status`, `Received At`. Then a token at
<https://airtable.com/create/tokens> scoped `data.records:write` on that base.

```bash
printf %s "$AIRTABLE_PAT" | npx opencomputer secrets set AIRTABLE_TOKEN --value-stdin
printf %s "appXXXXXXXX"  | npx opencomputer env set AIRTABLE_BASE_ID --value-stdin
printf %s "Leads"        | npx opencomputer env set AIRTABLE_TABLE   --value-stdin
printf %s "live"         | npx opencomputer env set LEADS_MODE       --value-stdin
```

**Shop settings**, so nothing about the business is in code:

```bash
printf %s "Dave's Plumbing & Heating" | npx opencomputer env set BUSINESS_NAME  --value-stdin
printf %s "the Austin metro"          | npx opencomputer env set SERVICE_AREA   --value-stdin
printf %s "+15125550111"              | npx opencomputer env set ON_CALL_NUMBER --value-stdin
printf %s "+15125550100"              | npx opencomputer env set BUSINESS_NUMBER --value-stdin
```

`BUSINESS_NUMBER` and a `TWILIO_BASIC_AUTH` secret are only needed to page the
on-call technician — replies to the caller don't use them.

```bash
printf %s "$(printf %s "$SID:$TOKEN" | base64)" \
  | npx opencomputer secrets set TWILIO_BASIC_AUTH --value-stdin
npx opencomputer deploy
```

Then **connect Twilio in the dashboard**: paste your Account SID and auth token,
pick a number, and OpenComputer points that number at itself.

## The last step, on the shop's real phone

Connecting a Twilio number does nothing on its own. Set **busy and no-answer
forwarding** on the existing business line to the Twilio number — a carrier code
dialled once from the handset, or one setting if the line is VoIP. Calls they
answer are untouched; only the missed ones come here.

This replaces the carrier's voicemail with one the agent can read, so think
about the greeting before switching it over.

## Seeing it work without a phone

`demo.sh` drives the whole loop from the terminal. It asks Twilio to place the
call *and speak the voicemail*, so no handset is involved:

```
./demo.sh          # voicemail, reply, follow-up text, and the lead as it fills in
./demo.sh call     # just the voicemail
./demo.sh text "…" # just a message
./demo.sh session  # the conversation the agent was handed
./demo.sh lead     # the newest Airtable row
./demo.sh reset    # end open sessions so the next run starts clean
```

It reads `demo.env` (Twilio account, the two numbers, the Airtable base) and
`opencomputer/.env.local` (the Airtable token); both are gitignored.

Both numbers belong to the same Twilio account on purpose. Messages between
them stay on Twilio's network, where A2P 10DLC does not apply — texting a real
mobile from an unregistered number fails with error 30034, so registration is a
prerequisite for a real shop, not for the demo.

Whether the agent pages the on-call technician varies between runs; "water on
the floor" sits right on the line the skill draws, and the model is the one
drawing it.

## What it will not do

- **Book.** Booking needs crew availability, drive time, and what's on the
  truck. An agent that confidently books a job the shop can't staff is worse
  than one that took a good message. Connecting Jobber or Housecall Pro is a
  tools change; `agent.ts` doesn't move.
- **Diagnose or quote.** Both are hard rules in the skill.
- **Wait to file.** The lead is written on the first reply, because most callers
  never send a second message. A half-filled row someone can act on beats a
  complete one that never lands.
- **Keep asking.** Four things — name, address, problem, availability — then it
  stops. It does not screen for gas or water nobody mentioned.

## Layout

```
opencomputer/
  channels/shop-sms.ts                the Twilio channel; no number in source
  agents/receptionist/
    agent.ts                          instructions per render
    channels/shop-sms.ts              this agent answers that channel
    tools/leads.ts                    file_lead, update_lead, find_lead_by_phone,
                                      find_stale_leads, Airtable connection
    tools/dispatch.ts                 page_on_call, the one message it sends itself
    schedules/sweep-stale-leads.ts    hourly: close out leads nobody replied to
    skills/qualifying-a-job/SKILL.md  page now / same day / next business day
```

The number and the Airtable base are per-environment configuration, not source,
so development and production don't share a phone line.

## The silent majority

Reply rates on missed-call text-back run 25–40% at best. So **most callers never
answer**, and the design follows from that: file on the first reply, no nudge,
and an hourly sweep that flips anything still unanswered after a day to
`no reply` — a list to phone back rather than a thread nobody will finish.
