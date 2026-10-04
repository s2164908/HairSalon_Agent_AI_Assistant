"""Declarative spec for the generated salon-assistant workflows.

This module is pure data. `scripts/generate_workflows.py` turns it into
`workflows/salon-assistant-v3.json` and `workflows/salon-assistant-error-handler.json`,
so the whole graph - node parameters, canvas position, edges, groups, sticky notes -
can be reviewed and diffed as text instead of inside a 60 KB JSON blob.

Design decisions encoded here, with the reason:

* Node `id`s are derived deterministically (uuid5 of the node name), so regenerating
  does not churn the diff.
* Data tables are addressed by NAME via the resourceLocator `mode: "name"`, not by the
  opaque instance ids v2 hard-coded. Those ids only exist on the Cloud instance the
  prototype was built on; addressing by name is what lets one JSON file import and run
  on both Cloud and this self-hosted stack (PLAN.md §1 #8, §9).
* The 11 tool nodes are named exactly as the LLM sees them: for a Custom Code Tool the
  tool name IS the node name (`nodeNameToToolName` in ToolCode.node.ts). Renaming one
  silently breaks every tool call, so _validate_workflows.py asserts the tool names
  still match the TOOLS list in the agent's system message.
* The four `Read -> Snapshot` pairs stay serial. n8n >= 1.0 executes a node's outgoing
  branches one at a time ("executes each branch in turn, completing one branch before
  starting another"), so fanning out to a Merge node would buy no latency, and the
  Snapshot nodes do real work: collapse N rows to 1 item, tag the table, compute
  `degraded`.
"""

from __future__ import annotations

# ---------------------------------------------------------------- node types ---
CHAT = "@n8n/n8n-nodes-langchain.chatTrigger"
AGENT = "@n8n/n8n-nodes-langchain.agent"
MODEL = "@n8n/n8n-nodes-langchain.lmChatOpenAi"
MEMORY = "@n8n/n8n-nodes-langchain.memoryBufferWindow"
PARSER = "@n8n/n8n-nodes-langchain.outputParserStructured"
TOOL = "@n8n/n8n-nodes-langchain.toolCode"
CODE = "n8n-nodes-base.code"
IF = "n8n-nodes-base.if"
TABLE = "n8n-nodes-base.dataTable"
NOOP = "n8n-nodes-base.noOp"
STICKY = "n8n-nodes-base.stickyNote"
EVAL = "n8n-nodes-base.evaluation"
ERROR_TRIGGER = "n8n-nodes-base.errorTrigger"

MAIN_WORKFLOW_NAME = "Salon Assistant - Guarded Shadow Draft v3"
ERROR_WORKFLOW_NAME = "Salon Assistant - Error Handler"

# ------------------------------------------------------------------- tables ---
T_SERVICES = "salon_services"
T_PROMOTIONS = "salon_promotions"
T_STYLISTS = "salon_stylists"
T_TAXONOMY = "salon_style_taxonomy"
T_QUEUE = "salon_review_queue"

# -------------------------------------------------------------------- tools ---
# Order matters only in that the system message lists them in this order.
TOOLS = [
    "service_catalog",
    "get_promotions",
    "classify_style",
    "match_stylist",
    "hair_profile_read",
    "find_slots",
    "hold_slot",
    "confirm_booking",
    "cancel_reschedule",
    "hair_profile_write",
    "escalate_to_human",
]

# The six columns `Queue for staff review` writes, and the only keys the envelope
# contract guarantees. Both render paths must fill all of them.
QUEUE_COLUMNS = [
    ("session_id", "string"),
    ("request_text", "string"),
    ("draft_reply", "string"),
    ("reason", "string"),
    ("status", "string"),
    ("guardrail_pass", "boolean"),
]

# The metrics written by `Set metrics`. Names must match the keys that
# render-draft.js / render-safety-draft.js put in the `metrics` object - the
# validator checks that.


# ------------------------------------------------------------------ metrics ---
# The keys both render nodes put in their `metrics` object, and therefore exactly
# what `Set metrics` maps into n8n's Evaluations tab. validate_workflows.py asserts
# that both render nodes emit this whole set - v2's bypass node had already drifted
# to seven of the eight.
METRICS = [
    "guardrail_pass",
    "errors_count",
    "hallucination_blocked",
    "tool_call_count",
    "escalated",
    "agent_failed",
    "tool_failures",
    "not_configured_hit",
]


# --------------------------------------------------- carried verbatim from v2 ---
# Node name -> asset file. These Code bodies are copied out of v2 unchanged, and
# validate_workflows.py asserts they are still byte-identical. Two reasons:
#
#  1. They are the tuned part of the system - each carries a "FIX P0-2"-style
#     comment recording a failure that was actually observed in run2_output.md.
#     A silent edit here changes customer-facing behaviour.
#  2. It is also why certain node names cannot be renamed. These bodies reference
#     other nodes by name (`$('Services snapshot')`), and n8n resolves that at
#     runtime, so renaming the target breaks the tool with no error at the rename.
#     That is precisely what the validator caught when the raw names were first
#     normalised: 6 dangling references across the 4 snapshot nodes and 11 tools.
CARRIED_CODE = {
    # v3 node name -> (asset file, the node's name in v2).
    "Normalize and screen input": ("normalize-input.js", "Normalize and screen input"),
    "Services snapshot": ("snapshot-services.js", "Services snapshot"),
    "Promotions snapshot": ("snapshot-promotions.js", "Promotions snapshot"),
    "Stylists snapshot": ("snapshot-stylists.js", "Stylists snapshot"),
    "Taxonomy snapshot": ("snapshot-taxonomy.js", "Taxonomy snapshot"),
    # Renamed in v3 from "Return internal draft receipt" - the map carries both names
    # so validate_workflows.py can still find the v2 original to diff against.
    "Return draft receipt": ("return-receipt.js", "Return internal draft receipt"),
}

# normalize-input.js is the one carried body that is deliberately NOT byte-identical
# to v2: v2 chose the whole draft language with a bare /[CJK]/ test, so an English
# message containing one Chinese word ("I want the 波波头 look") rendered the entire
# English draft in Chinese. It now compares script counts. Only its output contract is
# asserted - every key the rest of the graph reads must still be present.
NORMALIZE_CONTRACT = [
    "chatInput",
    "truncated",
    "sessionId",
    "language",
    "forceEscalate",
    "identityVerified",
    "customerId",
    "channel",
    "shadowMode",
]


# ------------------------------------------------------------------ helpers ---
def code(name, pos, asset, **kw):
    return {"name": name, "type": CODE, "tv": 2, "pos": pos, "code": asset, **kw}


def read(name, pos, table, **kw):
    """Read-only Data Table fetch with the degrade-instead-of-throw contract."""
    return {
        "name": name,
        "type": TABLE,
        "tv": 1.1,
        "pos": pos,
        "table": table,
        "op": "get",
        "return_all": True,
        "execute_once": True,
        "always_output": True,
        "on_error": "continueRegularOutput",
        "retry": (2, 1000),
        **kw,
    }


# -------------------------------------------------------------- main: nodes ---
NODES = [
    # --- 1. intake & pre-screen ------------------------------------------------
    {
        "name": "Chat Trigger",
        "type": CHAT,
        "tv": 1.4,
        "pos": (-2600, -1600),
        "params": {"options": {"allowFileUploads": False, "responseMode": "lastNode"}},
        # Reuse v2's webhookId so the chat URL does not change between versions.
        "webhook_from_v2": "Salon test chat",
        "notes": (
            "The only entry point. v2 named it 'Salon test chat', which read like a "
            "scratch node.\n"
            "File uploads stay OFF: PLAN.md forbids photo-based hair-type inference, so "
            "there is nothing this workflow may legitimately do with a photo."
        ),
        "notes_in_flow": True,
    },
    code(
        "Normalize and screen input",
        (-2400, -1600),
        "normalize-input.js",
        notes=(
            "Caps the message at 6000 chars, decides the draft language, and raises "
            "forceEscalate for health / complaint / bargaining wording. Every downstream "
            "node reads this node's output, so it is the one place a Node rename would "
            "break the most."
        ),
        notes_in_flow=False,
    ),
    {
        "name": "Risk pre-screen",
        "type": IF,
        "tv": 2.2,
        "pos": (-2200, -1600),
        "params": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                "conditions": [
                    {
                        "id": "f0a1b2c3-0001-4000-8000-000000000010",
                        "leftValue": "={{ $json.forceEscalate }}",
                        "rightValue": "",
                        "operator": {"type": "boolean", "operation": "true", "singleValue": True},
                    }
                ],
                "combinator": "and",
            },
            "options": {},
        },
        "notes": (
            "Output 0 (true) is the safety bypass, output 1 (false) is the normal path. "
            "Health, complaint and bargaining turns never reach the model: v2 let every "
            "read tool short-circuit to human_required, so the agent burned iterations "
            "and tokens rediscovering what a regex already knew."
        ),
        "notes_in_flow": True,
    },
    code(
        "Render safety draft",
        (-2200, -1920),
        "render-safety-draft.js",
        notes=(
            "Emits the identical envelope as 'Render draft'. In v2 this path hand-built "
            "its own copy and had already drifted (its metrics block omitted "
            "tool_failures), so the staff-queue row alternated between two schemas."
        ),
        notes_in_flow=False,
    ),
    # --- 2. authoritative read-only snapshot ----------------------------------
    read("Read Services", (-2000, -1600), T_SERVICES),
    code(
        "Services snapshot",
        (-1800, -1600),
        "snapshot-services.js",
        notes=(
            "Collapses the service rows into ONE item and computes degraded. Tools then "
            "read it with $('Services snapshot').first() - n8n sub-node expressions "
            "always resolve the first item (PLAN.md §10), so one item is the contract."
        ),
        notes_in_flow=False,
    ),
    read("Read Promotions", (-1600, -1600), T_PROMOTIONS),
    code("Promotions snapshot", (-1400, -1600), "snapshot-promotions.js"),
    read("Read Stylists", (-1200, -1600), T_STYLISTS),
    code("Stylists snapshot", (-1000, -1600), "snapshot-stylists.js"),
    read("Read Taxonomy", (-800, -1600), T_TAXONOMY),
    code("Taxonomy snapshot", (-600, -1600), "snapshot-taxonomy.js"),

    # --- 3. reason: the agent and its 11 tools --------------------------------
    {
        "name": "Salon Tools Agent",
        "type": AGENT,
        "tv": 3.1,
        "pos": (-380, -1600),
        "params": {
            "promptType": "define",
            "text": "={{ $('Normalize and screen input').first().json.chatInput }}",
            "hasOutputParser": True,
            "options": {
                # v2 ran at 8 while run2_output.md recorded a 9-tool turn: the cap
                # silently truncated the turn and the customer got a booking message
                # for a promotions question. PLAN.md §10 warns about exactly this.
                "maxIterations": 15,
                "returnIntermediateSteps": True,
                "passthroughBinaryImages": False,
                "enableStreaming": False,
            },
        },
        "system_message_asset": "agent-system-message.txt",
        "on_error": "continueRegularOutput",
        "retry": (3, 2000),
        "notes": (
            "The model understands and phrases; it does not decide or calculate. Tool "
            "ranking, promotion eligibility and slot conflicts are computed inside the "
            "tools (PLAN.md §4 principle 1).\n"
            "Streaming stays OFF and intermediate steps stay ON: the guardrail needs the "
            "complete output plus the tool observations to verify against."
        ),
        "notes_in_flow": True,
    },
    {
        "name": "Model: replaceable",
        "type": MODEL,
        "tv": 1.3,
        "pos": (-380, -1300),
        "params": {
            "model": {"__rl": True, "value": "gpt-4o-mini", "mode": "list", "cachedResultName": "gpt-4o-mini"},
            "builtInTools": {},
            "options": {"timeout": 20000, "maxRetries": 2},
        },
        # Deliberately NO credentials key. v2 carried the n8n Cloud
        # __aiGatewayManaged credential (id: null), which cannot resolve on this
        # self-hosted stack, and credentials never travel in a workflow export
        # anyway (PLAN.md §9). Pick one in the UI, or run
        # `scripts/wire_workflows.py --credential <name>`.
        "notes": (
            "The single model switch point (PLAN.md §7 scheme A): change the model here "
            "and the graph is untouched. Point Base URL at a gateway for "
            "OpenRouter / LiteLLM / Ollama's /v1.\n"
            "No credential is baked into this file - set one after import."
        ),
        "notes_in_flow": True,
    },
    {
        "name": "Memory: 6 turns",
        "type": MEMORY,
        "tv": 1.4,
        "pos": (-240, -1300),
        "params": {
            "sessionIdType": "customKey",
            "sessionKey": "={{ $('Normalize and screen input').first().json.sessionId }}",
            "contextWindowLength": 6,
        },
        "notes": (
            "v2 relied on the implicit fromInput default, which only still worked because "
            "four snapshot nodes happened to spread ...ctx forward. Keyed explicitly here, "
            "so refactoring any of those cannot silently break conversation memory."
        ),
    },
    {
        "name": "Parser: draft schema",
        "type": PARSER,
        "tv": 1.3,
        "pos": (-100, -1300),
        "params": {"schemaType": "manual"},
        "schema_asset": "draft-schema.json",
        "notes": (
            "Structured output: intent plus reference IDs only. The model has no free-text "
            "field, so it cannot phrase a price even if it wanted to."
        ),
    },
    *[
        {
            "name": tool_name,
            "type": TOOL,
            "tv": 1.3,
            "pos": (40 + 130 * i, -1300),
            "tool_asset": f"tools/{tool_name}.js",
            "desc_asset": f"tools/{tool_name}.description.txt",
            "schema_key": tool_name,
            "notes": "Node name IS the LLM tool name; never rename it." if i == 0 else None,
        }
        for i, tool_name in enumerate(TOOLS)
    ],

    # --- 4. guardrail, then deterministic render ------------------------------
    code(
        "Guardrail: verify evidence",
        (-180, -1600),
        "guardrail-verify.js",
        notes=(
            "Answers one question: is every ID the model referenced backed by a "
            "SUCCESSFUL tool result from THIS turn? PLAN.md §5 - the guarantee is a node "
            "that compares against tool output, not a sentence asking the model not to lie."
        ),
        notes_in_flow=True,
    ),
    code(
        "Render draft",
        (20, -1600),
        "render-draft.js",
        notes=(
            "Supplies every factual word - price, currency, duration, promotion title, "
            "stylist name, ordering - by copying it out of tool evidence. No LLM runs in "
            "this node, which is why a draft cannot invent a price."
        ),
        notes_in_flow=True,
    ),

    # --- 5. shadow-mode delivery ----------------------------------------------
    {
        "name": "Draft ready",
        "type": NOOP,
        "tv": 1,
        "pos": (220, -1600),
        "params": {},
        "notes": "Merge point: the safety pre-screen path and the agent path converge here, both carrying the same envelope.",
    },
    {
        "name": "Check if evaluating",
        "type": EVAL,
        "tv": 4.8,
        "pos": (420, -1600),
        "params": {"operation": "checkIfEvaluating"},
        "notes": (
            "Output 0 = evaluation branch, output 1 = normal. Verified against "
            "Evaluation.node.ee.ts: checkIfEvaluating() returns [input, []] when an "
            "Evaluation Trigger is an ancestor, otherwise [[], input]. With no Evaluation "
            "Trigger present it always takes Normal, so live chat is unaffected."
        ),
    },
    {
        "name": "Set metrics",
        "type": EVAL,
        "tv": 4.8,
        "pos": (620, -1800),
        "params": {"operation": "setMetrics", "metric": "customMetrics"},
        "metrics_assignments": True,
        "notes": "Maps the metrics object both render nodes already produce into n8n's Evaluations tab (PLAN.md §6 Phase 6).",
    },
    {
        "name": "Queue for staff review",
        "type": TABLE,
        "tv": 1.1,
        "pos": (620, -1420),
        "table": T_QUEUE,
        # v2 omitted both of these and relied on the node defaults (resource=row,
        # operation=insert). Works today; breaks the day a default changes.
        "op": "insert",
        "columns": QUEUE_COLUMNS,
        "on_error": "continueRegularOutput",
        "notes": "Shadow mode: the only place a draft is recorded. Nothing is ever sent to a customer from this workflow.",
        "notes_in_flow": True,
    },
    code(
        "Return draft receipt",
        (820, -1420),
        "return-receipt.js",
        notes="Appends the queue id, or a loud warning when the queue write failed, so a lost draft is visible rather than silent.",
    ),
]

# ------------------------------------------------------------------- edges ---
# (source node, output branch index, target node). For an IF / Switch node the
# branch is decided by the array position, so these indices are the whole truth
# about branching - the validator re-reads the emitted JSON and asserts the
# true/false branches are the ones intended.
EDGES = [
    ("Chat Trigger", 0, "Normalize and screen input"),
    ("Normalize and screen input", 0, "Risk pre-screen"),
    ("Risk pre-screen", 0, "Render safety draft"),  # true  -> safety bypass, no LLM
    ("Risk pre-screen", 1, "Read Services"),        # false -> normal path
    ("Read Services", 0, "Services snapshot"),
    ("Services snapshot", 0, "Read Promotions"),
    ("Read Promotions", 0, "Promotions snapshot"),
    ("Promotions snapshot", 0, "Read Stylists"),
    ("Read Stylists", 0, "Stylists snapshot"),
    ("Stylists snapshot", 0, "Read Taxonomy"),
    ("Read Taxonomy", 0, "Taxonomy snapshot"),
    ("Taxonomy snapshot", 0, "Salon Tools Agent"),
    ("Salon Tools Agent", 0, "Guardrail: verify evidence"),
    ("Guardrail: verify evidence", 0, "Render draft"),
    ("Render draft", 0, "Draft ready"),
    ("Render safety draft", 0, "Draft ready"),
    ("Draft ready", 0, "Check if evaluating"),
    ("Check if evaluating", 0, "Set metrics"),             # 0 = "Evaluation"
    ("Check if evaluating", 1, "Queue for staff review"),  # 1 = "Normal"
    ("Queue for staff review", 0, "Return draft receipt"),
]

# Sub-node wiring. Not "main" edges; they must never appear in EDGES.
SUB_EDGES = [
    ("Model: replaceable", "ai_languageModel", "Salon Tools Agent"),
    ("Memory: 6 turns", "ai_memory", "Salon Tools Agent"),
    ("Parser: draft schema", "ai_outputParser", "Salon Tools Agent"),
    *[(tool_name, "ai_tool", "Salon Tools Agent") for tool_name in TOOLS],
]

# --------------------------------------------------------------- canvas groups ---
GROUPS = [
    (
        "Intake and pre-screen",
        ["Chat Trigger", "Normalize and screen input", "Risk pre-screen", "Render safety draft"],
    ),
    (
        "Authoritative data snapshot",
        [
            "Read Services", "Services snapshot",
            "Read Promotions", "Promotions snapshot",
            "Read Stylists", "Stylists snapshot",
            "Read Taxonomy", "Taxonomy snapshot",
        ],
    ),
    (
        "Reason and guardrail",
        [
            "Salon Tools Agent", "Model: replaceable", "Memory: 6 turns",
            "Parser: draft schema", *TOOLS,
            "Guardrail: verify evidence", "Render draft",
        ],
    ),
    (
        "Shadow-mode delivery",
        [
            "Draft ready", "Check if evaluating", "Set metrics",
            "Queue for staff review", "Return draft receipt",
        ],
    ),
]

# ------------------------------------------------------------- sticky notes ---
# (content, (x, y), width, height, color 1-7).
#
# The four header notes sit in a band at y = -2520..-2280, above every node (the
# topmost node is "Render safety draft" at y = -1920). The three legend notes sit at
# y = -1100..-660, below the lowest node row (the 11 tools at y = -1300 plus a
# ~120px node box = -1180). Neither band can overlap a node, by construction rather
# than by eyeballing coordinates.
STICKIES = [
    (
        "## 1 · Intake and pre-screen\n"
        "The message is normalised, then a regex decides whether it may reach the model at all.\n\n"
        "`forceEscalate = true` **skips the LLM entirely** (health / complaint / bargaining).\n\n"
        "**Risk pre-screen** output 0 is the safety bypass; output 1 is the normal path.",
        (-2680, -2520), 620, 240, 4,
    ),
    (
        "## 2 · Authoritative salon data (read-only)\n"
        "Four tables, addressed **by name** - not by the Cloud instance ids v2 hard-coded - so this one file "
        "imports as-is on Cloud *and* on this self-hosted stack.\n\n"
        "The pairs stay **serial on purpose**: n8n >= 1.0 runs a node's outgoing branches one at a time, so "
        "fanning out to a Merge would not be faster. Each Snapshot node does real work: N rows -> 1 item, a "
        "table tag, and the `degraded` flag.\n\n"
        "Prices and promotions have exactly one source of truth: these tables.",
        (-2040, -2520), 1560, 240, 5,
    ),
    (
        "## 3 · Reason -> guardrail -> render\n"
        "**Salon Tools Agent** chooses *which* tool to call. It never computes or phrases a price.\n\n"
        "**Guardrail: verify evidence** is a node, not a prompt (PLAN.md §5): every ID the model referenced "
        "must exist in a SUCCESSFUL tool result from *this* turn, or the turn is blocked and escalated.\n\n"
        "**Render draft** copies every factual word out of that evidence. No LLM runs there - which is why a "
        "draft cannot invent a discount.",
        (-440, -2520), 1020, 240, 6,
    ),
    (
        "## 4 · Shadow-mode delivery\n"
        "Nothing here reaches a customer. Every turn lands in `salon_review_queue` as a draft for staff.\n\n"
        "**Check if evaluating** output 0 = evaluation branch, output 1 = normal. With no Evaluation Trigger "
        "in the workflow it always takes Normal.",
        (600, -2520), 480, 240, 7,
    ),
    (
        "### Guardrail invariants\n"
        "- No price, currency or duration unless `service_catalog` returned it **this turn**.\n"
        "- No promotion unless `get_promotions` returned it **this turn**.\n"
        "- An empty tool result is a **valid answer** ('there are none') - never a fabricated one.\n"
        "- Stylist order must match `match_stylist` exactly.\n"
        "- Health, scalp, hair loss, allergy, complaint, refund, compensation, bargaining -> escalate, never answered.\n"
        "- No ethnicity, age or hair-property inference. Photos are refused (`allowFileUploads: false`).\n"
        "- `not_configured` is an expected limitation of this prototype, not a fault: staff see the precise "
        "limitation and nothing claims success.",
        (-2680, -1100), 1300, 440, 3,
    ),
    (
        "### Shadow mode (PLAN.md Phase 9)\n"
        "Widen the blast radius in this order, never all at once:\n"
        "1. read-only questions only\n"
        "2. then reschedule / cancel\n"
        "3. then new bookings\n\n"
        "`Queue for staff review` is the only sink. `Return draft receipt` warns loudly if that write failed.\n\n"
        "The 18 cases recorded in `run2_output.md` are the first dataset - re-run them after every change.",
        (-1360, -1100), 1300, 440, 3,
    ),
    (
        "### Regenerate, never hand-edit\n"
        "```bash\n"
        "python3 scripts/generate_workflows.py     # spec + assets -> these .json files\n"
        "python3 scripts/validate_workflows.py     # structure + invariants\n"
        "node scripts/verify_guardrail_split.mjs   # guardrail split is behaviour-identical\n"
        "python3 scripts/wire_workflows.py         # post-import: errorWorkflow, credential\n"
        "```\n"
        "Tool names are load-bearing: `nodeNameToToolName()` derives the LLM tool name from the **node name**, "
        "so renaming `service_catalog` breaks tool calling with no error anywhere. The validator checks the 11 "
        "names against the agent's system message.",
        (-40, -1100), 1500, 440, 3,
    ),
]

# ------------------------------------------------------- error workflow spec ---
# A separate file because n8n addresses the global error workflow by id, which only
# exists after import - scripts/wire_workflows.py sets settings.errorWorkflow for
# you. It intentionally has no errorWorkflow of its own: a failure while recording a
# failure must stop, not loop.
ERROR_NODES = [
    {
        "name": "Error Trigger",
        "type": ERROR_TRIGGER,
        "tv": 1,
        "pos": (-420, -300),
        "params": {},
        "notes": "Fires for any execution that fails anywhere, once this workflow is set as the instance/workflow error workflow.",
        "notes_in_flow": True,
    },
    code(
        "Build error context",
        (-200, -300),
        "error-context.js",
        notes=(
            "Reduces the Error Trigger payload to the same six keys the main workflow's "
            "queue row uses, so a failure lands in salon_review_queue looking exactly like "
            "a draft - reason=agent_failed is the only difference."
        ),
        notes_in_flow=True,
    ),
    {
        "name": "Queue agent failure",
        "type": TABLE,
        "tv": 1.1,
        "pos": (20, -300),
        "table": T_QUEUE,
        "op": "insert",
        "columns": QUEUE_COLUMNS,
        "on_error": "continueRegularOutput",
        "notes": "Same table, same columns as the happy path - no second place to look when triaging.",
    },
    {
        "name": "Error recorded",
        "type": NOOP,
        "tv": 1,
        "pos": (240, -300),
        "params": {},
        "notes": "Terminal node. Nothing here talks to a customer.",
    },
]

ERROR_EDGES = [
    ("Error Trigger", 0, "Build error context"),
    ("Build error context", 0, "Queue agent failure"),
    ("Queue agent failure", 0, "Error recorded"),
]

ERROR_GROUPS = []

ERROR_STICKIES = [
    (
        "## Global error workflow\n"
        "v2 had **no** error workflow: a throw in any Code node killed the chat turn and the draft "
        "disappeared with the execution.\n\n"
        "After importing both files, point the main workflow's "
        "**Settings -> Error Workflow** at this one:\n"
        "```bash\n"
        "python3 scripts/wire_workflows.py --from-api      # or a hand-written ids file\n"
        "```\n"
        "This workflow deliberately has no error workflow of its own, so a failure while recording a "
        "failure cannot loop.",
        (-460, -620), 1000, 260, 2,
    ),
]





