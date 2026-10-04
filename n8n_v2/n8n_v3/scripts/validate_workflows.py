"""Validate the generated n8n workflow JSON before it is imported.

Two jobs:

1. **Structural** - is this a well-formed n8n workflow? The connection shape
   `{nodeName: {outputType: [[edge, ...]]}}` is checked explicitly: a connection
   nested one level too deep is accepted by `json.loads`, shows no error anywhere,
   and silently drops every edge on import.

2. **Invariants** - the things that must not silently regress. Node names are
   referenced *inside expressions* (`$('Normalize input')`), and a Custom Code Tool's
   name **is** the LLM's tool name, so a rename breaks the workflow at runtime with
   nothing pointing at the cause. These checks resolve every reference instead.

Run:  python3 scripts/validate_workflows.py
Exit: 0 = importable and consistent, 1 = something above is a lie.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True  # keep the tree free of __pycache__

import workflow_spec as spec  # noqa: E402

WF_DIR = ROOT / "workflows"
ASSETS = WF_DIR / "assets"
V2_PATH = ROOT / "salon-assistant-v2.json"

MAIN_FILE = WF_DIR / "salon-assistant-v3.json"
ERROR_FILE = WF_DIR / "salon-assistant-error-handler.json"

MAIN_NODE_TYPES = {
    "n8n-nodes-base.code",
    "n8n-nodes-base.if",
    "n8n-nodes-base.dataTable",
    "n8n-nodes-base.noOp",
    "n8n-nodes-base.stickyNote",
    "n8n-nodes-base.evaluation",
    "@n8n/n8n-nodes-langchain.chatTrigger",
    "@n8n/n8n-nodes-langchain.agent",
    "@n8n/n8n-nodes-langchain.lmChatOpenAi",
    "@n8n/n8n-nodes-langchain.memoryBufferWindow",
    "@n8n/n8n-nodes-langchain.outputParserStructured",
    "@n8n/n8n-nodes-langchain.toolCode",
}
ERROR_NODE_TYPES = MAIN_NODE_TYPES | {"n8n-nodes-base.errorTrigger"}

NODE_REFERENCE = re.compile(r"\$\(\s*'([^']+)'\s*\)")

failures: list[str] = []
checks: list[tuple[str, str]] = []


def ok(label: str, detail: str = "") -> None:
    checks.append(("PASS", f"{label}{(' - ' + detail) if detail else ''}"))


def bad(label: str, detail: str) -> None:
    checks.append(("FAIL", f"{label} - {detail}"))
    failures.append(f"{label} - {detail}")


def walk_strings(value):
    """Yield every string inside nested dicts/lists/values."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from walk_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_strings(item)


def edges_of(connections: dict):
    """Yield (source, output_type, branch_index, target) for n8n's real shape."""
    for source, outputs in connections.items():
        if not isinstance(outputs, dict):
            continue
        for output_type, branches in outputs.items():
            if not isinstance(branches, list):
                continue
            for branch_index, branch in enumerate(branches):
                for edge in branch or []:
                    if isinstance(edge, dict):
                        yield source, output_type, branch_index, edge.get("node")


def envelope_keys(code: str) -> set:
    """Top-level keys of the `return [{ json: { ... } }]` envelope at indent 2.

    Matches camelCase as well as snake_case, because normalize-input.js emits keys like
    `chatInput` and `forceEscalate` while the render nodes emit `session_id`.
    """
    if "return [{ json: {" not in code:
        return set()
    tail = code.split("return [{ json: {", 1)[1]
    keys = set()
    for line in tail.splitlines():
        match = re.match(r"^  ([A-Za-z_][A-Za-z0-9_]*)[,:]", line)
        if match:
            keys.add(match.group(1))
        elif line.strip() in {"} }];", "}]}];", "};", "]];"} or line.startswith("  } }]"):
            break
    return keys


def metric_keys(code: str) -> set:
    match = re.search(r"metrics:\s*\{([^}]*)\}", code)
    if not match:
        return set()
    return set(re.findall(r"([a-z_]+)\s*:", match.group(1)))


def check_workflow(path: Path, allowed_types: set, label: str) -> dict | None:
    """Structural checks that apply to any n8n workflow file."""
    if not path.exists():
        bad(f"{label}: file exists", f"{path.name} missing - run generate_workflows.py")
        return None
    try:
        wf = json.loads(path.read_text())
    except Exception as exc:  # noqa: BLE001
        bad(f"{label}: valid JSON", str(exc))
        return None
    ok(f"{label}: valid JSON")

    nodes = wf.get("nodes", [])
    conns = wf.get("connections", {})
    names = [n.get("name") for n in nodes]
    name_set = set(names)

    extra_keys = [k for k in ("id", "versionId", "meta") if k in wf]
    if extra_keys:
        bad(
            f"{label}: no instance-specific keys",
            f"{extra_keys} would make v3 overwrite v2 on the source instance",
        )
    else:
        ok(f"{label}: no instance-specific keys", "imports alongside v2, not over it")

    execution_order = wf.get("settings", {}).get("executionOrder")
    if execution_order != "v1":
        bad(f"{label}: settings.executionOrder", f"expected 'v1', got {execution_order!r}")
    else:
        ok(f"{label}: settings.executionOrder is v1")

    schema_problems = []
    for node in nodes:
        for field in ("name", "type", "typeVersion", "position", "parameters"):
            if field not in node:
                schema_problems.append(f"{node.get('name')!r} missing {field}")
        if node.get("type") not in allowed_types:
            schema_problems.append(f"{node.get('name')!r} type {node.get('type')!r}")
        if not isinstance(node.get("position"), list) or len(node["position"]) != 2:
            schema_problems.append(f"{node.get('name')!r} bad position")
    if schema_problems:
        bad(f"{label}: node schema", "; ".join(schema_problems[:8]))
    else:
        ok(f"{label}: node schema", f"{len(nodes)} nodes")

    if len(names) != len(name_set):
        dupes = sorted({n for n in names if names.count(n) > 1})
        bad(f"{label}: unique node names", f"duplicates: {dupes}")
    else:
        ok(f"{label}: unique node names", f"{len(names)}")

    # The connection shape n8n actually parses. A one-level-too-deep nesting is the
    # classic silent failure: valid JSON, zero edges after import.
    conn_problems = []
    known_output_types = {"main", "ai_languageModel", "ai_memory", "ai_outputParser", "ai_tool"}
    for source, outputs in conns.items():
        if source not in name_set:
            conn_problems.append(f"source {source!r} is not a node")
        if not isinstance(outputs, dict) or not outputs:
            conn_problems.append(f"{source!r} declares no output")
            continue
        if source in outputs:
            conn_problems.append(f"{source!r} is nested twice - n8n would drop every edge")
        for output_type in outputs:
            if output_type not in known_output_types:
                conn_problems.append(f"{source!r} output type {output_type!r}")
    for source, _output_type, _branch, target in edges_of(conns):
        if target not in name_set:
            conn_problems.append(f"{source!r} -> {target!r}: target is not a node")
    if conn_problems:
        bad(f"{label}: connection shape", "; ".join(conn_problems[:8]))
    else:
        ok(f"{label}: connection shape", f"{len(list(edges_of(conns)))} edges, no double nesting")

    mixed = [
        source
        for source, outputs in conns.items()
        if isinstance(outputs, dict) and "main" in outputs and len(outputs) > 1
    ]
    if mixed:
        bad(f"{label}: no mixed main/sub outputs", str(mixed))
    else:
        ok(f"{label}: no mixed main/sub outputs")

    # Every $('Node name') inside an expression must resolve. This is the check that
    # catches a rename - which n8n only reports at runtime, as a wrong answer.
    refs: dict = {}
    for node in nodes:
        for text in walk_strings(node.get("parameters", {})):
            for ref in NODE_REFERENCE.findall(text):
                refs.setdefault(ref, set()).add(node["name"])
    dangling = {r: sorted(v) for r, v in refs.items() if r not in name_set}
    if dangling:
        bad(f"{label}: $('Node') references resolve", f"dangling: {dangling}")
    else:
        ok(f"{label}: $('Node') references resolve", f"{len(refs)} distinct nodes referenced")

    node_ids = {n["id"] for n in nodes}
    group_problems = []
    for group in wf.get("nodeGroups", []):
        missing = [i for i in group.get("nodeIds", []) if i not in node_ids]
        if missing:
            group_problems.append(f"{group.get('name')!r} unresolved nodeIds {missing}")
    if group_problems:
        bad(f"{label}: canvas groups resolve", "; ".join(group_problems))
    else:
        ok(f"{label}: canvas groups resolve", f"{len(wf.get('nodeGroups', []))} groups")

    # Sticky notes must not sit on top of nodes - the spec claims that by construction.
    sticky_boxes, content_boxes = [], []
    for node in nodes:
        x, y = node["position"]
        if node["type"] == spec.STICKY:
            params = node["parameters"]
            sticky_boxes.append((node["name"], x, y, x + params["width"], y + params["height"]))
        else:
            content_boxes.append((node["name"], x, y, x + 110, y + 130))
    overlaps = []
    for s_name, sx1, sy1, sx2, sy2 in sticky_boxes:
        for n_name, nx1, ny1, nx2, ny2 in content_boxes:
            if sx1 < nx2 and nx1 < sx2 and sy1 < ny2 and ny1 < sy2:
                overlaps.append(f"{s_name} covers {n_name}")
    if overlaps:
        bad(f"{label}: sticky notes do not cover nodes", "; ".join(overlaps[:5]))
    else:
        ok(f"{label}: sticky notes do not cover nodes", f"{len(sticky_boxes)} notes")

    # Data Table nodes: explicit resource/operation, addressed by name.
    table_problems = []
    for node in nodes:
        if node["type"] != "n8n-nodes-base.dataTable":
            continue
        params = node["parameters"]
        if params.get("resource") != "row":
            table_problems.append(f"{node['name']!r} resource={params.get('resource')!r}")
        if params.get("operation") not in ("get", "insert", "update", "upsert", "delete"):
            table_problems.append(f"{node['name']!r} operation={params.get('operation')!r}")
        locator = params.get("dataTableId") or {}
        if locator.get("mode") != "name" or not locator.get("value"):
            table_problems.append(f"{node['name']!r} must address the table by name")
        if params.get("operation") == "get" and not params.get("returnAll"):
            table_problems.append(f"{node['name']!r} read without returnAll")
    if table_problems:
        bad(f"{label}: Data Table nodes are explicit", "; ".join(table_problems))
    else:
        ok(f"{label}: Data Table nodes are explicit")

    managed = [
        node["name"]
        for node in nodes
        if any("__aiGatewayManaged" in cred for cred in (node.get("credentials") or {}).values())
    ]
    if managed:
        bad(
            f"{label}: no Cloud-only managed credentials",
            f"{managed} cannot resolve on a self-hosted stack",
        )
    else:
        ok(f"{label}: no Cloud-only managed credentials")

    node_bin = shutil.which("node")
    if not node_bin:
        ok(f"{label}: jsCode parses", "node not on PATH - skipped")
    else:
        code_problems = []
        with tempfile.TemporaryDirectory() as tmp:
            for node in nodes:
                code = node["parameters"].get("jsCode")
                if not code:
                    continue
                scratch = Path(tmp) / (re.sub(r"[^A-Za-z0-9]+", "_", node["name"]) + ".js")
                scratch.write_text(code)
                proc = subprocess.run([node_bin, "--check", str(scratch)], capture_output=True, text=True)
                if proc.returncode:
                    lines = proc.stderr.strip().splitlines() or ["syntax error"]
                    code_problems.append(f"{node['name']}: {lines[-1]}")
        if code_problems:
            bad(f"{label}: jsCode parses", "; ".join(code_problems))
        else:
            ok(f"{label}: jsCode parses", "node --check on every Code node")

    return wf


def check_invariants(wf: dict) -> None:
    """The 'must not silently regress' set, for the main workflow only."""
    by_name = {n["name"]: n for n in wf["nodes"]}
    conns = wf["connections"]

    def targets(source: str, branch: int) -> list:
        branches = conns.get(source, {}).get("main", [])
        return [e["node"] for e in (branches[branch] if branch < len(branches) else [])]

    # --- branch order ---------------------------------------------------------
    # A wrong branch index sends live traffic down the evaluation path, or sends a
    # health question to the model. Assert all four explicitly.
    expected_branches = [
        ("Risk pre-screen", 0, ["Render safety draft"], "true -> safety bypass"),
        ("Risk pre-screen", 1, ["Read Services"], "false -> normal path"),
        ("Check if evaluating", 0, ["Set metrics"], "0 = Evaluation"),
        ("Check if evaluating", 1, ["Queue for staff review"], "1 = Normal"),
    ]
    branch_problems = [
        f"{src}[{idx}] is {targets(src, idx)}, expected {want}"
        for src, idx, want, _note in expected_branches
        if targets(src, idx) != want
    ]
    if branch_problems:
        bad("branch order", "; ".join(branch_problems))
    else:
        ok("branch order", "IF/Switch outputs wired to the intended branches")

    # --- the agent's tunables -------------------------------------------------
    agent = by_name.get("Salon Tools Agent")
    if not agent:
        bad("agent node present", "Salon Tools Agent missing")
        return
    options = agent["parameters"]["options"]
    system_message = options.get("systemMessage", "")

    if options.get("enableStreaming") is not False:
        bad("agent: streaming off", f"enableStreaming={options.get('enableStreaming')!r}; the guardrail needs the complete output")
    else:
        ok("agent: streaming off")
    if options.get("returnIntermediateSteps") is not True:
        bad("agent: intermediate steps on", "without them the guardrail has no tool evidence to verify")
    else:
        ok("agent: intermediate steps on")

    max_iterations = options.get("maxIterations")
    if not isinstance(max_iterations, int) or max_iterations < len(spec.TOOLS):
        bad(
            "agent: maxIterations vs tool count",
            f"maxIterations={max_iterations!r} with {len(spec.TOOLS)} tools; v2 ran 8 and run2_output.md "
            "recorded a 9-call turn being silently truncated",
        )
    else:
        ok("agent: maxIterations vs tool count", f"{max_iterations} >= {len(spec.TOOLS)} tools")

    # --- tool names are the LLM's API -----------------------------------------
    declared = re.search(r"TOOLS:\s*(.+)", system_message)
    declared_tools = [t.strip().rstrip(".") for t in declared.group(1).split(",") if t.strip()] if declared else []
    workflow_tools = [n["name"] for n in wf["nodes"] if n["type"] == spec.TOOL]

    if declared_tools != workflow_tools:
        bad(
            "tool names match the system message",
            f"system message lists {declared_tools}, workflow has {workflow_tools}",
        )
    else:
        ok("tool names match the system message", f"{len(workflow_tools)} tools")

    if workflow_tools != spec.TOOLS:
        bad("tool names match the spec", f"{workflow_tools} != {spec.TOOLS}")
    else:
        ok("tool names match the spec")

    # --- v2 regression: the tuned payloads must be byte-identical -------------
    v2 = json.loads(V2_PATH.read_text())
    v2_by_name = {n["name"]: n for n in v2["nodes"]}
    drift = []
    v2_agent = v2_by_name.get("Salon Tools Agent", {})
    if system_message != v2_agent.get("parameters", {}).get("options", {}).get("systemMessage"):
        drift.append("agent systemMessage")
    for tool in spec.TOOLS:
        mine = by_name.get(tool, {}).get("parameters", {})
        theirs = v2_by_name.get(tool, {}).get("parameters", {})
        for field in ("jsCode", "description", "inputSchema"):
            if mine.get(field) != theirs.get(field):
                drift.append(f"{tool}.{field}")
    if drift:
        bad("v2 payloads unchanged", f"drifted: {drift}")
    else:
        ok(
            "v2 payloads unchanged",
            f"system message + {len(spec.TOOLS)} tools x (jsCode, description, inputSchema)",
        )

    # The snapshot / receipt bodies are pure carriers. Asserting byte-identity is what
    # stops a well-meaning rename or a stray edit from desynchronising them from the
    # tool bodies that call them by name.
    carried_drift = []
    for node_name, (asset_file, v2_name) in spec.CARRIED_CODE.items():
        if node_name == "Normalize and screen input":
            continue  # deliberately changed - contract-checked below instead
        mine = by_name.get(node_name, {}).get("parameters", {}).get("jsCode")
        theirs = v2_by_name.get(v2_name, {}).get("parameters", {}).get("jsCode")
        if theirs is None:
            carried_drift.append(f"{node_name}: v2 has no node {v2_name!r}")
        elif mine != theirs:
            carried_drift.append(f"{node_name} ({asset_file}) differs from v2 {v2_name!r}")
    if carried_drift:
        bad("carried Code bodies unchanged", "; ".join(carried_drift))
    else:
        ok(
            "carried Code bodies unchanged",
            f"{len(spec.CARRIED_CODE) - 1} snapshot/receipt bodies byte-identical to v2",
        )

    # normalize-input.js is the one deliberate behaviour change, so assert its contract
    # instead of its bytes: every key the rest of the graph reads must still be emitted.
    normalize = by_name.get("Normalize and screen input", {}).get("parameters", {}).get("jsCode", "")
    missing_keys = set(spec.NORMALIZE_CONTRACT) - envelope_keys(normalize)
    if missing_keys:
        bad("Normalize output contract", f"missing keys {sorted(missing_keys)}")
    else:
        ok(
            "Normalize output contract",
            f"{len(spec.NORMALIZE_CONTRACT)} keys; script-ratio language detection replaces v2's bare CJK test",
        )

    if "detectLanguage" not in normalize:
        bad("Normalize keeps script-ratio language detection", "detectLanguage() is gone")
    else:
        ok("Normalize keeps script-ratio language detection")



    # --- the shared envelope contract ----------------------------------------
    render = by_name["Render draft"]["parameters"]["jsCode"]
    safety = by_name["Render safety draft"]["parameters"]["jsCode"]
    render_keys, safety_keys = envelope_keys(render), envelope_keys(safety)
    if render_keys != safety_keys:
        bad(
            "both render paths emit the same envelope",
            f"only in Render draft: {sorted(render_keys - safety_keys)}; "
            f"only in Render safety draft: {sorted(safety_keys - render_keys)}",
        )
    else:
        ok("both render paths emit the same envelope", f"{len(render_keys)} keys")

    wanted_metrics = set(spec.METRICS)
    metric_problems = []
    for node_name, code in (("Render draft", render), ("Render safety draft", safety)):
        got = metric_keys(code)
        if got != wanted_metrics:
            metric_problems.append(
                f"{node_name}: missing {sorted(wanted_metrics - got)}, extra {sorted(got - wanted_metrics)}"
            )
    if metric_problems:
        bad("metrics keys complete in both paths", "; ".join(metric_problems))
    else:
        ok(
            "metrics keys complete in both paths",
            f"{len(wanted_metrics)} metrics - v2's bypass path was missing tool_failures",
        )

    queue_columns = {col for col, _type in spec.QUEUE_COLUMNS}
    if not queue_columns <= render_keys:
        bad("queue columns present in the envelope", f"missing {sorted(queue_columns - render_keys)}")
    else:
        ok("queue columns present in the envelope", f"{len(queue_columns)} columns")

    metrics_node = by_name.get("Set metrics")
    if metrics_node:
        mapped = {a["name"] for a in metrics_node["parameters"].get("metrics", {}).get("assignments", [])}
        if mapped != wanted_metrics:
            bad("Set metrics maps every metric", f"{sorted(mapped)} != {sorted(wanted_metrics)}")
        else:
            ok("Set metrics maps every metric", f"{len(mapped)} assignments")

    # --- memory keyed explicitly ---------------------------------------------
    memory = by_name.get("Memory: 6 turns", {}).get("parameters", {})
    if memory.get("sessionIdType") != "customKey" or not str(memory.get("sessionKey", "")).startswith("="):
        bad(
            "memory session is keyed explicitly",
            "v2 relied on fromInput, which only worked because four nodes forwarded sessionId",
        )
    else:
        ok("memory session is keyed explicitly", "customKey -> $('Normalize and screen input')")


def main() -> int:
    print("Workflows under test:")
    for path in (MAIN_FILE, ERROR_FILE):
        print(f"  {path.relative_to(ROOT)}")
    print()

    main_wf = check_workflow(MAIN_FILE, MAIN_NODE_TYPES, "v3")
    error_wf = check_workflow(ERROR_FILE, ERROR_NODE_TYPES, "error-handler")

    if main_wf:
        check_invariants(main_wf)

    if error_wf:
        nodes = error_wf["nodes"]
        if not any(n["type"] == "n8n-nodes-base.errorTrigger" for n in nodes):
            bad("error-handler has an Error Trigger", "no errorTrigger node")
        else:
            ok("error-handler has an Error Trigger")
        if "errorWorkflow" in error_wf.get("settings", {}):
            bad("error-handler has no error workflow of its own", "a retry failure could loop")
        else:
            ok("error-handler has no error workflow of its own", "a failure cannot loop")
        context_node = next((n for n in nodes if n["name"] == "Build error context"), None)
        if context_node:
            keys = envelope_keys(context_node["parameters"]["jsCode"])
            missing = {col for col, _ in spec.QUEUE_COLUMNS} - keys
            if missing:
                bad("error row matches the queue columns", f"missing {sorted(missing)}")
            else:
                ok("error row matches the queue columns", f"{len(keys)} keys")

    print("\nChecks")
    print("------")
    for status, line in checks:
        print(f"  [{status}] {line}")

    print()
    if failures:
        print(f"{len(failures)} FAILED check(s):")
        for line in failures:
            print(f"  - {line}")
        return 1
    print(f"All {len(checks)} checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())




