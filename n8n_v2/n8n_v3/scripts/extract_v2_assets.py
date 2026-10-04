"""Derive Code-node payloads from salon-assistant-v2.json into workflows/assets/.

The v3 workflow keeps every Code-node body in a real `.js` file instead of a
JSON string blob. That makes them diffable, greppable and syntax-checkable
without parsing 60 KB of JSON, and it means a rename of a node cannot silently
desynchronise from the code that references it by name.

This script exists so the v2 -> assets step is reproducible and auditable rather
than a one-off copy nobody can verify. It only writes files it owns: the
hand-authored v3 bodies (guardrail-verify.js, render-draft.js,
render-safety-draft.js) are never touched.

Run:  python3 scripts/extract_v2_assets.py
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
V2 = ROOT / "salon-assistant-v2.json"
ASSETS = ROOT / "workflows" / "assets"

# v2 node name -> path under workflows/assets/. These bodies are carried into v3
# unchanged, so they live here verbatim.
#
# "Normalize and screen input" is extracted to a `_v2-` reference rather than to
# `normalize-input.js`, because v3 deliberately diverges from it: v2 chose the draft
# language with a bare /[CJK]/ test, which flipped whole English drafts to Chinese when
# the customer used a single Chinese word. Keeping the v2 original next to the authored
# v3 file means the divergence stays visible and re-extraction can never silently revert
# the fix. workflow_spec.CARRIED_CODE is the authoritative list of what must stay
# byte-identical.
CODE_NODES = {
    "Normalize and screen input": "code/_v2-normalize-reference.js",
    "Services snapshot": "code/snapshot-services.js",
    "Promotions snapshot": "code/snapshot-promotions.js",
    "Stylists snapshot": "code/snapshot-stylists.js",
    "Taxonomy snapshot": "code/snapshot-taxonomy.js",
    "Return internal draft receipt": "code/return-receipt.js",
    # Superseded in v3, kept as the reference for the behaviour-equivalence test.
    "Validate evidence and render draft": "code/_v2-validate-reference.js",
    "Risk bypass draft": "code/_v2-safety-draft-reference.js",
}

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


def main() -> int:
    workflow = json.loads(V2.read_text())
    by_name = {n["name"]: n for n in workflow["nodes"]}

    written: list[str] = []

    def write(rel: str, text: str) -> None:
        dest = ASSETS / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text)
        written.append(f"{rel}  ({len(text.encode())} bytes)")

    for node_name, rel in CODE_NODES.items():
        node = by_name.get(node_name)
        if node is None:
            raise SystemExit(f"v2 has no node named {node_name!r}")
        code = node["parameters"].get("jsCode")
        if not isinstance(code, str):
            raise SystemExit(f"{node_name!r} has no jsCode")
        write(rel, code)

    for tool in TOOLS:
        node = by_name.get(tool)
        if node is None or node["type"] != "@n8n/n8n-nodes-langchain.toolCode":
            raise SystemExit(f"v2 has no Custom Code Tool named {tool!r}")
        write(f"tools/{tool}.js", node["parameters"]["jsCode"])
        # PLAN.md §3: the tool description is the main lever on planning quality, so
        # it lives in its own reviewable file rather than buried in the spec module.
        write(f"tools/{tool}.description.txt", node["parameters"]["description"])

    agent = by_name["Salon Tools Agent"]["parameters"]["options"]
    write("agent-system-message.txt", agent["systemMessage"])

    parser = by_name["Evidence reference schema"]["parameters"]
    schema = json.loads(parser["inputSchema"])
    write("draft-schema.json", json.dumps(schema, indent=2, ensure_ascii=False) + "\n")

    tool_schemas = {
        t: json.loads(by_name[t]["parameters"]["inputSchema"]) for t in TOOLS
    }
    write(
        "tool-input-schemas.json",
        json.dumps(tool_schemas, indent=2, ensure_ascii=False) + "\n",
    )

    print(f"wrote {len(written)} asset files under {ASSETS.relative_to(ROOT)}/")
    for line in written:
        print("  " + line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
