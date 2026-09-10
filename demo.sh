#!/usr/bin/env bash
# Drives the whole missed-call loop from the terminal, with no phone involved.
#
# Twilio places the call itself and speaks the voicemail, so the demo needs no
# handset — and it sidesteps A2P 10DLC, because messages between two numbers on
# one Twilio account stay on Twilio's network, where carrier registration does
# not apply. Texting a real phone from here fails with error 30034.
#
#   ./demo.sh            full run: voicemail, reply, follow-up text, lead
#   ./demo.sh call       just the voicemail
#   ./demo.sh text "…"   just a follow-up text
#   ./demo.sh session    print the current conversation
#   ./demo.sh lead       print the newest Airtable lead
#   ./demo.sh reset      end open sessions so the next run starts clean
set -euo pipefail
cd "$(dirname "$0")"

# Credentials live in env files, never in this script. demo.env carries the
# Twilio account and the two numbers; .env.local carries the Airtable token.
set -a
[ -f demo.env ] && . ./demo.env
[ -f opencomputer/.env.local ] && . ./opencomputer/.env.local
set +a
: "${TWILIO_ACCOUNT_SID:?set TWILIO_ACCOUNT_SID}"
: "${TWILIO_AUTH_TOKEN:?set TWILIO_AUTH_TOKEN}"
SHOP="${BUSINESS_NUMBER:-+18548423677}"   # the agent answers here
CALLER="${CALLER_NUMBER:-+17432699273}"   # stands in for the customer
API="https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID"
AUTH="$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN"
AGENT="never-miss-a-call"

say()  { printf "\n\033[1m%s\033[0m\n" "$1"; }
note() { printf "  %s\n" "$1"; }

VOICEMAIL="${VOICEMAIL_TEXT:-Hi, this is Marcus. My kitchen sink is completely backed up and there is water on the floor. I am at 4400 Oak Grove Lane. Please call me back today.}"

sessions_json() {
  npx --yes opencomputer session list --json 2>/dev/null > /tmp/nmac-sessions.json || true
}

latest_outbound() {
  curl -s -u "$AUTH" "$API/Messages.json?From=$SHOP&PageSize=1" | python3 -c '
import json, sys
messages = json.load(sys.stdin).get("messages", [])
print(messages[0]["sid"] if messages else "")'
}

place_call() {
  say "Calling the shop — nobody picks up, so it rolls to the agent"
  # Wait out the greeting before speaking, or the message records over it.
  local twiml sid
  twiml="<Response><Pause length=\"9\"/><Say voice=\"alice\">${VOICEMAIL}</Say><Pause length=\"2\"/></Response>"
  sid=$(curl -s -u "$AUTH" "$API/Calls.json" \
    --data-urlencode "To=$SHOP" \
    --data-urlencode "From=$CALLER" \
    --data-urlencode "Twiml=$twiml" | python3 -c '
import json, sys
print(json.load(sys.stdin).get("sid", ""))')
  note "call $sid placed"
  note "greeting, beep, voicemail, then Whisper transcribes it"
}

send_text() {
  say "The customer texts back"
  note "\"$1\""
  curl -s -u "$AUTH" "$API/Messages.json" \
    --data-urlencode "To=$SHOP" \
    --data-urlencode "From=$CALLER" \
    --data-urlencode "Body=$1" | python3 -c '
import json, sys
print("  sent", json.load(sys.stdin).get("sid", ""))'
}

# Poll rather than sleep a fixed amount: transcription time varies.
wait_for_reply() {
  local before="$1" attempt latest
  say "Waiting for the agent"
  for attempt in $(seq 1 40); do
    latest=$(latest_outbound)
    if [ -n "$latest" ] && [ "$latest" != "$before" ]; then
      curl -s -u "$AUTH" "$API/Messages/$latest.json" > /tmp/nmac-reply.json
      python3 - <<'PYEOF'
import json
m = json.load(open("/tmp/nmac-reply.json"))
print("\n  \033[32m-> text to the customer (%s)\033[0m" % m["status"])
print("  %s\n" % m["body"])
PYEOF
      return 0
    fi
    sleep 3
  done
  note "no reply yet — check the session log"
  return 1
}

show_session() {
  say "What the agent was handed"
  sessions_json
  python3 - <<'PYEOF'
import json
try:
    everything = json.load(open("/tmp/nmac-sessions.json"))
except Exception:
    everything = []
sessions = [s for s in everything if s.get("agentId") == "never-miss-a-call"]
if not sessions:
    print("  no session yet")
else:
    s = max(sessions, key=lambda s: s["createdAt"])
    print("  session %s  (%s, %d turn(s))" % (s["id"], s["status"], len(s["turns"])))
    for turn in s["turns"]:
        lines = turn["input"].split("\n")
        print("    %s %s" % (lines[0], " ".join(lines[1:]).strip()[:110]))
PYEOF
}

show_lead() {
  say "The lead the shop actually sees"
  local base tbl
  base="${AIRTABLE_BASE_ID:?set AIRTABLE_BASE_ID in demo.env}"
  tbl="${AIRTABLE_TABLE:-Leads}"
  if [ -z "${AIRTABLE_TOKEN:-}" ]; then
    note "set AIRTABLE_TOKEN in opencomputer/.env.local to show this"
    return
  fi
  curl -s -H "Authorization: Bearer $AIRTABLE_TOKEN" \
    "https://api.airtable.com/v0/$base/$tbl?maxRecords=1&sort%5B0%5D%5Bfield%5D=Received+At&sort%5B0%5D%5Bdirection%5D=desc" \
    > /tmp/nmac-lead.json
  python3 - <<'PYEOF'
import json
records = json.load(open("/tmp/nmac-lead.json")).get("records", [])
if not records:
    print("  no leads yet")
else:
    fields = records[0]["fields"]
    for key in ("Lead Status", "Name", "Phone", "Address", "Problem",
                "Availability", "Urgency", "Told Caller"):
        if fields.get(key):
            print("  %-14s %s" % (key, str(fields[key])[:70]))
PYEOF
}

case "${1:-all}" in
  call)
    place_call
    ;;
  session)
    show_session
    ;;
  lead)
    show_lead
    ;;
  text)
    before=$(latest_outbound)
    send_text "${2:?give the message}"
    wait_for_reply "$before"
    ;;
  reset)
    say "Ending open sessions"
    sessions_json
    for id in $(python3 -c 'import json;print("\n".join(s["id"] for s in json.load(open("/tmp/nmac-sessions.json")) if s.get("agentId")=="never-miss-a-call" and s.get("status")!="ended"))'); do
      npx --yes opencomputer session end "$id" >/dev/null 2>&1 && note "ended $id"
    done
    ;;
  all)
    before=$(latest_outbound)
    place_call
    wait_for_reply "$before"
    show_session
    show_lead
    before=$(latest_outbound)
    send_text "its Marcus, 4400 Oak Grove Lane, I am home until 6"
    wait_for_reply "$before"
    show_session
    show_lead
    say "One conversation: the voicemail and the text share a session"
    ;;
  *)
    echo "usage: $0 [all|call|text <message>|session|lead|reset]" >&2
    exit 1
    ;;
esac
