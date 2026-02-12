#!/bin/bash
# Donna Loops Demo
#
# Usage: ./scripts/demo.sh <worker-url> <admin-token>
#
# Three acts:
#   1. Attach Identity — tell the system who you are
#   2. Compounding    — run a protocol twice, see the second run improve on the first
#   3. Identity Shift — change who you are, see the output transform

set -euo pipefail

URL="${1:?Usage: ./scripts/demo.sh <worker-url> <admin-token>}"
TOKEN="${2:?Usage: ./scripts/demo.sh <worker-url> <admin-token>}"
AUTH="Authorization: Bearer $TOKEN"

# Colors
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
MAGENTA='\033[0;35m'
NC='\033[0m'

# Helper: extract field from LLM step output
extract() {
  echo "$1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
step3 = data['execution_results'][2]['result']['data']
if isinstance(step3, str):
    try: step3 = json.loads(step3)
    except: pass
field = '$2'
val = step3.get(field, '') if isinstance(step3, dict) else ''
if isinstance(val, list):
    for item in val: print('  - ' + str(item))
else:
    print(str(val))
" 2>/dev/null
}

# Helper: extract similarity from memory.search step
similarity() {
  echo "$1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
step2 = data['execution_results'][1]['result']['data']
if step2 and len(step2) > 0:
    print(f'{step2[0].get(\"similarity\", 0):.2f}')
else:
    print('none')
" 2>/dev/null
}

divider() {
  echo ""
  echo -e "${DIM}$(printf '%.0s─' {1..60})${NC}"
  echo ""
}

# ===== SETUP =====

echo ""
echo -e "${BOLD}  DONNA LOOPS${NC}"
echo -e "${DIM}  Protocols that remember. Identity that shapes.${NC}"
echo ""

echo -e "${DIM}  Saving protocols...${NC}"
for f in examples/content-refine.json examples/task-breakdown.json; do
  if [ -f "$f" ]; then
    curl -s -X POST "$URL/protocols" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$f" > /dev/null
  fi
done
echo -e "${DIM}  Done.${NC}"

divider

# ===== ACT 1: ATTACH IDENTITY =====

echo -e "${MAGENTA}  ACT 1: ATTACH IDENTITY${NC}"
echo ""
echo -e "${DIM}  Tell the system who you are. Every protocol adapts to this.${NC}"
echo ""

IDENTITY_1="Developer advocate at a startup. I write technical blog posts for other developers. I value clarity over cleverness and prefer concrete examples over abstract theory."

echo -e "${BOLD}  Setting identity:${NC}"
echo -e "  ${CYAN}\"$IDENTITY_1\"${NC}"
echo ""

curl -s -X PUT "$URL/identity" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"identity\": \"$IDENTITY_1\"}" > /dev/null

echo -e "  ${GREEN}Identity stored.${NC} Every protocol will now be shaped by this."

divider

# ===== ACT 2: COMPOUNDING =====

echo -e "${MAGENTA}  ACT 2: COMPOUNDING${NC}"
echo ""
echo -e "${DIM}  Run the same protocol twice. The second run finds the first${NC}"
echo -e "${DIM}  run's self-critique and makes different improvements.${NC}"
echo ""

INPUT_TEXT="Our new API lets you do stuff with data. It has endpoints for getting things and putting things. The authentication uses tokens. Contact us for more info."

echo -e "${BOLD}  Input text:${NC}"
echo -e "  ${DIM}\"$INPUT_TEXT\"${NC}"
echo ""

# --- Run 1 ---

echo -e "  ${CYAN}RUN 1${NC} ${DIM}(no prior memory)${NC}"
echo -e "${DIM}  Running...${NC}"

RUN1=$(curl -s -X POST "$URL/run" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"protocol_key\": \"content_refine\", \"context\": {\"text\": \"$INPUT_TEXT\"}}")

RUN1_SUCCESS=$(echo "$RUN1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success','?'))" 2>/dev/null)
RUN1_MS=$(echo "$RUN1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('duration_ms','?'))" 2>/dev/null)

echo -e "  ${GREEN}$RUN1_SUCCESS${NC} in ${RUN1_MS}ms"
echo ""
echo -e "  ${BOLD}Refined text:${NC}"
echo -e "  $(extract "$RUN1" refined_text)"
echo ""
echo -e "  ${BOLD}Self-evaluation:${NC}"
echo -e "  ${YELLOW}$(extract "$RUN1" self_evaluation)${NC}"
echo ""
echo -e "  ${BOLD}What to do differently next time:${NC}"
echo -e "  $(extract "$RUN1" what_id_do_differently_next_time)"

echo ""
sleep 1

# --- Run 2 ---

echo -e "  ${CYAN}RUN 2${NC} ${DIM}(same input, same protocol — but now there's memory)${NC}"
echo -e "${DIM}  Running...${NC}"

RUN2=$(curl -s -X POST "$URL/run" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"protocol_key\": \"content_refine\", \"context\": {\"text\": \"$INPUT_TEXT\"}}")

RUN2_SUCCESS=$(echo "$RUN2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success','?'))" 2>/dev/null)
RUN2_MS=$(echo "$RUN2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('duration_ms','?'))" 2>/dev/null)
RUN2_SIM=$(similarity "$RUN2")

echo -e "  ${GREEN}$RUN2_SUCCESS${NC} in ${RUN2_MS}ms — found prior run ${GREEN}(similarity: $RUN2_SIM)${NC}"
echo ""
echo -e "  ${BOLD}What it learned from Run 1:${NC}"
echo -e "  ${CYAN}$(extract "$RUN2" prior_run_improvements)${NC}"
echo ""
echo -e "  ${BOLD}Refined text (different from Run 1):${NC}"
echo -e "  $(extract "$RUN2" refined_text)"
echo ""
echo -e "  ${BOLD}New self-evaluation (new critique):${NC}"
echo -e "  ${YELLOW}$(extract "$RUN2" self_evaluation)${NC}"

divider

# ===== ACT 3: IDENTITY SHIFT =====

echo -e "${MAGENTA}  ACT 3: IDENTITY SHIFT${NC}"
echo ""
echo -e "${DIM}  Same protocol, same input text. Different person.${NC}"
echo ""

IDENTITY_2="Startup CEO writing investor updates. I need to convey traction, market opportunity, and strategic vision. Investors care about metrics and defensibility, not technical details."

echo -e "${BOLD}  New identity:${NC}"
echo -e "  ${CYAN}\"$IDENTITY_2\"${NC}"
echo ""

curl -s -X PUT "$URL/identity" -H "$AUTH" -H "Content-Type: application/json" \
  -d "$(python3 -c "import json; print(json.dumps({'identity': '$IDENTITY_2'}))")" > /dev/null

echo -e "  ${GREEN}Identity changed.${NC}"
echo ""

echo -e "  ${CYAN}RUN 3${NC} ${DIM}(same input text, new identity)${NC}"
echo -e "${DIM}  Running...${NC}"

RUN3=$(curl -s -X POST "$URL/run" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"protocol_key\": \"content_refine\", \"context\": {\"text\": \"$INPUT_TEXT\"}}")

RUN3_SUCCESS=$(echo "$RUN3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success','?'))" 2>/dev/null)
RUN3_MS=$(echo "$RUN3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('duration_ms','?'))" 2>/dev/null)

echo -e "  ${GREEN}$RUN3_SUCCESS${NC} in ${RUN3_MS}ms"
echo ""
echo -e "  ${BOLD}Refined text (as startup CEO):${NC}"
echo -e "  $(extract "$RUN3" refined_text)"
echo ""
echo -e "  ${BOLD}Improvements made:${NC}"
echo "$(extract "$RUN3" improvements_made)"

divider

# ===== SUMMARY =====

echo -e "${BOLD}  WHAT JUST HAPPENED${NC}"
echo ""
echo -e "  ${CYAN}Act 1:${NC} Stored an identity. The system now knows who you are."
echo -e "  ${CYAN}Act 2:${NC} Ran a protocol twice. Run 2 found Run 1's self-critique"
echo -e "        and made different improvements. Real compounding."
echo -e "  ${CYAN}Act 3:${NC} Changed identity. Same input, same protocol."
echo -e "        Output shifted from developer docs to investor narrative."
echo ""
echo -e "  Three things to notice:"
echo -e "    1. The identity was set ${BOLD}once${NC} — protocols read it automatically"
echo -e "    2. Run 2 ${BOLD}explicitly quoted${NC} what Run 1 said was weak"
echo -e "    3. The CEO version is ${BOLD}fundamentally different${NC} — not just reworded"
echo ""
echo -e "  ${DIM}Same five steps. Same input. Identity + memory = different system.${NC}"
echo ""
