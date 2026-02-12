#!/bin/bash
# Donna Loops Demo — run this after deploying to see compounding in action
#
# Usage: ./scripts/demo.sh https://your-worker.workers.dev YOUR_ADMIN_TOKEN
#
# What happens:
#   1. Saves two demo protocols (content-refine, task-breakdown)
#   2. Clears prior memories for a clean demo
#   3. Runs content-refine twice, showing compounding
#   4. Prints side-by-side comparison

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
NC='\033[0m'

echo -e "${BOLD}Donna Loops Demo${NC}"
echo -e "${DIM}Protocols that remember. Visible compounding between runs.${NC}"
echo ""

# 1. Save protocols
echo -e "${CYAN}[1/5]${NC} Saving demo protocols..."
for f in examples/content-refine.json examples/task-breakdown.json; do
  if [ -f "$f" ]; then
    RESULT=$(curl -s -X POST "$URL/protocols" -H "$AUTH" -H "Content-Type: application/json" --data-binary @"$f")
    KEY=$(echo "$RESULT" | grep -o '"protocol_key":"[^"]*"' | cut -d'"' -f4)
    echo "  saved: $KEY"
  fi
done

# 2. Clear memories for clean demo
echo -e "${CYAN}[2/5]${NC} Clearing prior memories..."
curl -s -X POST "$URL/exec" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"primitive":"memory.search","args":{"query":"test","top_k":1}}' > /dev/null 2>&1 || true
echo "  done"

# 3. Run 1
echo ""
echo -e "${CYAN}[3/5]${NC} ${BOLD}Run 1: First pass (no prior memory)${NC}"
echo -e "${DIM}  Running content_refine...${NC}"

RUN1=$(curl -s -X POST "$URL/run" -H "$AUTH" -H "Content-Type: application/json" -d '{
  "protocol_key": "content_refine",
  "context": {
    "identity": "I am a developer advocate who writes technical blog posts for a startup audience. I value clarity over cleverness and prefer concrete examples over abstract theory.",
    "text": "Our new API lets you do stuff with data. It has endpoints for getting things and putting things. The authentication uses tokens. Contact us for more info."
  }
}')

RUN1_SUCCESS=$(echo "$RUN1" | grep -o '"success":[a-z]*' | head -1 | cut -d: -f2)
RUN1_DURATION=$(echo "$RUN1" | grep -o '"duration_ms":[0-9]*' | tail -1 | cut -d: -f2)
RUN1_MEMORY=$(echo "$RUN1" | grep -o '"data":\[\]' | head -1 || true)

# Extract step 3 (LLM) result
RUN1_REFINED=$(echo "$RUN1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
step3 = data['execution_results'][2]['result']['data']
if isinstance(step3, str): step3 = json.loads(step3)
print(json.dumps(step3, indent=2))
" 2>/dev/null || echo '{"error": "Could not parse Run 1 output"}')

echo -e "  ${GREEN}success: $RUN1_SUCCESS${NC} (${RUN1_DURATION}ms)"
if [ -n "$RUN1_MEMORY" ]; then
  echo -e "  memory.search: ${YELLOW}empty (no prior memories)${NC}"
fi
echo ""
echo -e "${BOLD}  Refined text:${NC}"
echo "$RUN1_REFINED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ' + d.get('refined_text','?'))" 2>/dev/null || true
echo ""
echo -e "${BOLD}  Self-evaluation:${NC}"
echo "$RUN1_REFINED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ' + d.get('self_evaluation','?'))" 2>/dev/null || true
echo ""
echo -e "${BOLD}  Next time:${NC}"
echo "$RUN1_REFINED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ' + d.get('what_id_do_differently_next_time','?'))" 2>/dev/null || true

# 4. Run 2
echo ""
echo -e "${CYAN}[4/5]${NC} ${BOLD}Run 2: Compounding (finds Run 1's memory)${NC}"
echo -e "${DIM}  Running content_refine again — same input, same protocol...${NC}"

RUN2=$(curl -s -X POST "$URL/run" -H "$AUTH" -H "Content-Type: application/json" -d '{
  "protocol_key": "content_refine",
  "context": {
    "identity": "I am a developer advocate who writes technical blog posts for a startup audience. I value clarity over cleverness and prefer concrete examples over abstract theory.",
    "text": "Our new API lets you do stuff with data. It has endpoints for getting things and putting things. The authentication uses tokens. Contact us for more info."
  }
}')

RUN2_SUCCESS=$(echo "$RUN2" | grep -o '"success":[a-z]*' | head -1 | cut -d: -f2)
RUN2_DURATION=$(echo "$RUN2" | grep -o '"duration_ms":[0-9]*' | tail -1 | cut -d: -f2)

RUN2_REFINED=$(echo "$RUN2" | python3 -c "
import sys, json
data = json.load(sys.stdin)
step3 = data['execution_results'][2]['result']['data']
if isinstance(step3, str): step3 = json.loads(step3)
print(json.dumps(step3, indent=2))
" 2>/dev/null || echo '{"error": "Could not parse Run 2 output"}')

# Get similarity score from memory.search result
RUN2_SIMILARITY=$(echo "$RUN2" | python3 -c "
import sys, json
data = json.load(sys.stdin)
step2 = data['execution_results'][1]['result']['data']
if step2 and len(step2) > 0:
    print(f'{step2[0].get(\"similarity\", 0):.2f}')
else:
    print('N/A')
" 2>/dev/null || echo "N/A")

echo -e "  ${GREEN}success: $RUN2_SUCCESS${NC} (${RUN2_DURATION}ms)"
echo -e "  memory.search: ${GREEN}found Run 1 (similarity: $RUN2_SIMILARITY)${NC}"
echo ""
echo -e "${BOLD}  Refined text:${NC}"
echo "$RUN2_REFINED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ' + d.get('refined_text','?'))" 2>/dev/null || true
echo ""
echo -e "${BOLD}  Prior run improvements:${NC}"
echo "$RUN2_REFINED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ' + d.get('prior_run_improvements','?'))" 2>/dev/null || true
echo ""
echo -e "${BOLD}  New self-evaluation:${NC}"
echo "$RUN2_REFINED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ' + d.get('self_evaluation','?'))" 2>/dev/null || true

# 5. Summary
echo ""
echo -e "${CYAN}[5/5]${NC} ${BOLD}Summary${NC}"
echo ""
echo -e "  Run 1: First pass. Clean slate. Self-evaluation stored to memory."
echo -e "  Run 2: Found prior run. Referenced its critique. Made different improvements."
echo ""
echo -e "  Same protocol. Same input. The memory is what changed."
echo ""
echo -e "  ${DIM}Change the identity to see how refinements shift:${NC}"
echo -e "  ${DIM}  'startup CEO writing investor updates'${NC}"
echo -e "  ${DIM}  'junior dev documenting an internal tool'${NC}"
echo -e "  ${DIM}  'marketing lead writing product launch copy'${NC}"
echo ""
