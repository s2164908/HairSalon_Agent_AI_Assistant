"""Generate the importable n8n workflow JSON files.

Input:  scripts/workflow_spec.py  (the graph)  +  workflows/assets/  (the payloads)
Output: workflows/salon-assistant-v3.json
        workflows/salon-assistant-error-handler.json

Why a generator instead of hand-editing the JSON:
  * The tuned parts - the agent system message, all 11 tool bodies, the tool
    descriptions - are carried over from v2 byte-for-byte and are checked as such
    by validate_workflows.py. A hand-edit cannot prove that.
  * Node names appear inside expressions (`$('Normalize input')`). Renaming a node
    by hand silently breaks the workflow at runtime; the validator resolves every
    `$('...')` reference instead.
  * Node ids are uuid5 of the node name, so regenerating produces a stable diff.

Run:  python3 scripts/generate_workflows.py
"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

sys.dont_write_bytecode = True  # keep the tree free of __pycache__

import workflow_spec as spec  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "workflows" / "assets"
OUT_DIR = ROOT / "workflows"
V2_PATH = ROOT / "salon-assistant-v2.json"

# Fixed namespace so node/group ids are deterministic across runs and machines.
NS = uuid.UUID("5a1c0f5e-0f5a-4a2b-9c3d-1a2b3c4d5e6f")


def nid(kind: str, name: str) -> str:
    return str(uuid.uuid5(NS, f"{kind}:{name}"))


def asset(rel: str) -> str:
    path = ASSETS / rel
    if not path.exists():
        raise SystemExit(f"missing asset {rel} - run scripts/extract_v2_assets.py first")
    return path.read_text()


def compact(obj) -> str:
    """n8n stores JSON schema parameters as a compact single-line string."""
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def table_locator(table_name: str) -> dict:
    """Address a Data Table by NAME, not by instance id.

    v2 hard-coded the n8n Cloud instance's opaque ids (m7OzE8m6hDvMdeZ7 ...), which
    simply do not exist on this self-hosted stack. `mode: "name"` lets n8n resolve
    the table on whatever instance the file is imported into, which is what makes one
    JSON portable between Cloud and self-hosted (PLAN.md §1 #8, §9).
    """
    return {"__rl": True, "mode": "name", "value": table_name, "cachedResultName": table_name}


def cell(column: str, col_type: str) -> dict:
    return {
        "id": column,
        "displayName": column,
        "type": col_type,
        "display": True,
        "required": False,
        "defaultMatch": False,
        "canBeUsedToMatch": True,
    }


def build_node(entry: dict, tool_schemas: dict, v2_by_name: dict) -> dict:
    name = entry["name"]
    params: dict = dict(entry.get("params") or {})

    # --- payloads carried verbatim from the assets on disk -------------------
    if entry.get("code"):
        # spec.code() takes a bare filename; all Code-node bodies live in assets/code/.
        params["jsCode"] = asset(f"code/{entry['code']}")

    if entry.get("tool_asset"):
        params["jsCode"] = asset(entry["tool_asset"])
        params["description"] = asset(entry["desc_asset"])
        params["specifyInputSchema"] = True
        params["schemaType"] = "manual"
        params["inputSchema"] = compact(tool_schemas[entry["schema_key"]])

    if entry.get("system_message_asset"):
        params.setdefault("options", {})["systemMessage"] = asset(entry["system_message_asset"])

    if entry.get("schema_asset"):
        params["inputSchema"] = compact(json.loads(asset(entry["schema_asset"])))

    # --- data tables ---------------------------------------------------------
    if entry.get("table"):
        params["dataTableId"] = table_locator(entry["table"])
    if entry.get("op"):
        # v2 omitted both of these and rode the node defaults (resource=row,
        # operation=insert). Explicit is cheap; a changed default is not.
        params["resource"] = "row"
        params["operation"] = entry["op"]
    if entry.get("return_all"):
        params["returnAll"] = True
    if entry.get("columns"):
        params["columns"] = {
            "mappingMode": "defineBelow",
            "value": {col: "={{ $json." + col + " }}" for col, _ in entry["columns"]},
            "schema": [cell(col, t) for col, t in entry["columns"]],
        }
        params.setdefault("options", {})

    if entry.get("metrics_assignments"):
        params["metrics"] = {
            "assignments": [
                {
                    "id": nid("metric", metric),
                    "name": metric,
                    "value": "={{ $json.metrics." + metric + " }}",
                    "type": "number",
                }
                for metric in spec.METRICS
            ]
        }

    node: dict = {
        "parameters": params,
        "id": nid("node", name),
        "name": name,
        "type": entry["type"],
        "typeVersion": entry["tv"],
        "position": list(entry["pos"]),
    }

    if entry.get("on_error"):
        node["onError"] = entry["on_error"]
    if entry.get("retry"):
        tries, wait_ms = entry["retry"]
        node["retryOnFail"] = True
        node["maxTries"] = tries
        node["waitBetweenTries"] = wait_ms
    if entry.get("execute_once"):
        node["executeOnce"] = True
    if entry.get("always_output"):
        node["alwaysOutputData"] = True
    if entry.get("notes"):
        node["notes"] = entry["notes"]
        node["notesInFlow"] = bool(entry.get("notes_in_flow"))

    if entry.get("webhook_from_v2"):
        source = v2_by_name.get(entry["webhook_from_v2"])
        if not source or "webhookId" not in source:
            raise SystemExit(f"v2 has no webhookId to reuse for {name!r}")
        node["webhookId"] = source["webhookId"]

    return node


def build_connections(edges, sub_edges) -> dict:
    """n8n's connection shape is {source: {outputType: [[edge, ...], ...]}}.

    The outer array is indexed by output branch, so the position of each inner array
    IS the branch - an IF node's "true" output is index 0, not a named property.
    Getting this shape wrong (one level too deep) makes n8n drop every edge on import
    without an error, so validate_workflows.py re-checks it.
    """
    conns: dict = {}

    for source, branch, target in edges:
        branches = conns.setdefault(source, {}).setdefault("main", [])
        while len(branches) <= branch:
            branches.append([])
        branches[branch].append({"node": target, "type": "main", "index": 0})

    for source, conn_type, target in sub_edges:
        conns.setdefault(source, {}).setdefault(conn_type, [[]])[0].append(
            {"node": target, "type": conn_type, "index": 0}
        )

    return conns


def build_groups(groups, nodes_by_name: dict) -> list:
    out = []
    for group_name, members in groups:
        missing = [m for m in members if m not in nodes_by_name]
        if missing:
            raise SystemExit(f"group {group_name!r} references unknown nodes: {missing}")
        out.append(
            {
                "id": nid("group", group_name),
                "name": group_name,
                "nodeIds": [nodes_by_name[m]["id"] for m in members],
            }
        )
    return out


def build_stickies(stickies) -> list:
    nodes = []
    for index, (content, pos, width, height, color) in enumerate(stickies, start=1):
        nodes.append(
            {
                "parameters": {"content": content, "height": height, "width": width, "color": color},
                "id": nid("sticky", f"{index}:{content.splitlines()[0]}"),
                "name": f"Note {index}",
                "type": spec.STICKY,
                "typeVersion": 1,
                "position": list(pos),
            }
        )
    return nodes


def build_workflow(name: str, nodes: list, connections: dict, groups: list) -> dict:
    """Assemble one workflow.

    `id`, `versionId` and `meta.instanceId` are deliberately NOT written: they are
    properties of the instance that produced v2, and carrying them over would make
    v3 overwrite v2 on import instead of importing alongside it. Leaving them out is
    what lets you A/B the two versions on one dataset.
    """
    return {
        "name": name,
        "nodes": nodes,
        "connections": connections,
        "settings": {"executionOrder": "v1", "binaryMode": "separate", "availableInMCP": True},
        "active": False,
        "pinData": {},
        "tags": [],
        "nodeGroups": groups,
    }


def main() -> int:
    if not V2_PATH.exists():
        raise SystemExit(f"{V2_PATH} is required (webhookId reuse + regression checks)")
    v2 = json.loads(V2_PATH.read_text())
    v2_by_name = {n["name"]: n for n in v2["nodes"]}
    tool_schemas = json.loads(asset("tool-input-schemas.json"))

    # --- main workflow -------------------------------------------------------
    main_nodes = [build_node(e, tool_schemas, v2_by_name) for e in spec.NODES]
    main_nodes += build_stickies(spec.STICKIES)
    main_by_name = {n["name"]: n for n in main_nodes}
    main_conns = build_connections(spec.EDGES, spec.SUB_EDGES)
    main_groups = build_groups(spec.GROUPS, main_by_name)

    # Fail loudly rather than emitting an edge n8n would silently drop.
    for source in main_conns:
        if source not in main_by_name:
            raise SystemExit(f"connection source {source!r} is not a node")
    for branches in main_conns.values():
        for conn_type, outs in branches.items():
            for branch in outs:
                for edge in branch:
                    if edge["node"] not in main_by_name:
                        raise SystemExit(
                            f"edge {conn_type} -> {edge['node']!r} is not a node"
                        )

    # --- error workflow ------------------------------------------------------
    err_nodes = [build_node(e, tool_schemas, v2_by_name) for e in spec.ERROR_NODES]
    err_nodes += build_stickies(spec.ERROR_STICKIES)
    err_by_name = {n["name"]: n for n in err_nodes}
    err_conns = build_connections(spec.ERROR_EDGES, [])
    err_groups = build_groups(spec.ERROR_GROUPS, err_by_name)

    outputs = [
        ("salon-assistant-v3.json", build_workflow(spec.MAIN_WORKFLOW_NAME, main_nodes, main_conns, main_groups)),
        ("salon-assistant-error-handler.json", build_workflow(spec.ERROR_WORKFLOW_NAME, err_nodes, err_conns, err_groups)),
    ]

    for filename, workflow in outputs:
        dest = OUT_DIR / filename
        dest.write_text(json.dumps(workflow, indent=2, ensure_ascii=False) + "\n")
        edges = sum(
            len(branch)
            for conns in workflow["connections"].values()
            for outs in conns.values()
            for branch in outs
        )
        sub = sum(
            len(branch)
            for conns in workflow["connections"].values()
            for conn_type, outs in conns.items()
            if conn_type != "main"
            for branch in outs
        )
        print(
            f"{filename}: {len(workflow['nodes'])} nodes, {edges - sub} main edges, "
            f"{sub} sub-node edges, {len(workflow['nodeGroups'])} groups"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

