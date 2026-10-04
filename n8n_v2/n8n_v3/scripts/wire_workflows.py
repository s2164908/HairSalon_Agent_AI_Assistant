"""Wire up the parts of an n8n workflow that a portable export cannot carry.

Two things cannot be expressed in a JSON file that works on any instance:

1. **`settings.errorWorkflow`** addresses another workflow by *id*, and that id is
   assigned when the workflow is imported into a specific instance.
2. **`credentials`** reference a credential by *id* too, and credentials are never
   part of an export at all (PLAN.md §9 - "凭证 不随 workflow JSON 导出").

So generate_workflows.py deliberately emits neither, and this script fills them in
after import. It exits non-zero rather than writing a reference it could not resolve,
because a dangling `errorWorkflow` id means failures silently stop being recorded.

Usage
-----
    # preview, using a hand-written id map
    python3 scripts/wire_workflows.py --ids workflows/workflow_ids.json --dry-run

    # write wired copies to build/wired/
    python3 scripts/wire_workflows.py --ids workflows/workflow_ids.json

    # rewrite workflows/*.json in place
    python3 scripts/wire_workflows.py --ids workflows/workflow_ids.json --in-place

    # with an API key, no id map needed - and this is also the only way to
    # attach a credential, since credential ids are instance-specific
    N8N_BASE_URL=http://localhost:5678 N8N_API_KEY=... \\
        python3 scripts/wire_workflows.py --from-api --credential "OpenAI account"

`workflows/workflow_ids.json` is a small file you create yourself and never commit:

    {
      "Salon Assistant - Error Handler": "<workflow id>",
      "Salon Assistant - Guarded Shadow Draft v3": "<workflow id>"
    }
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True  # keep the tree free of __pycache__

import workflow_spec as spec  # noqa: E402

WF_DIR = ROOT / "workflows"
MAIN_FILE = WF_DIR / "salon-assistant-v3.json"
ERROR_FILE = WF_DIR / "salon-assistant-error-handler.json"
DEFAULT_OUT = ROOT / "build" / "wired"

MODEL_NODE = "Model: replaceable"
CREDENTIAL_TYPE = "openAiApi"


def api_get(path: str, base_url: str, api_key: str) -> dict:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        headers={"X-N8N-API-KEY": api_key, "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
        return json.loads(response.read().decode())


def list_workflows(base_url: str, api_key: str) -> dict:
    return {w["name"]: w["id"] for w in api_get("/api/v1/workflows?limit=250", base_url, api_key)["data"]}


def list_credentials(base_url: str, api_key: str) -> dict:
    return {
        c["name"]: c["id"]
        for c in api_get("/api/v1/credentials?limit=250", base_url, api_key)["data"]
        if c.get("type") == CREDENTIAL_TYPE
    }


def display(path: Path) -> str:
    """Relative when it is inside the project, absolute when the user pointed elsewhere."""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def wire_main(workflow: dict, error_workflow_id: str, credential: tuple | None) -> list:
    """Apply the two non-portable references. Returns a list of change descriptions."""
    changes = []
    settings = workflow.setdefault("settings", {})
    if settings.get("errorWorkflow") != error_workflow_id:
        settings["errorWorkflow"] = error_workflow_id
        changes.append(f"settings.errorWorkflow = {error_workflow_id}")

    if credential:
        cred_id, cred_name = credential
        for node in workflow["nodes"]:
            if node["name"] != MODEL_NODE:
                continue
            node.setdefault("credentials", {})[CREDENTIAL_TYPE] = {"id": cred_id, "name": cred_name}
            changes.append(f"{MODEL_NODE}.credentials.{CREDENTIAL_TYPE} = {cred_name!r}")
    return changes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ids", type=Path, help="JSON map of workflow name -> id")
    parser.add_argument("--from-api", action="store_true", help="resolve ids from the n8n REST API instead")
    parser.add_argument("--credential", help=f"attach this {CREDENTIAL_TYPE} credential to {MODEL_NODE!r} (needs --from-api)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="where to write wired copies (default build/wired)")
    parser.add_argument("--in-place", action="store_true", help="rewrite workflows/*.json instead of writing copies")
    parser.add_argument("--dry-run", action="store_true", help="report the changes without writing anything")
    args = parser.parse_args()

    if not args.from_api and not args.ids:
        parser.error("pass --ids FILE or --from-api")
    if args.credential and not args.from_api:
        parser.error("--credential needs --from-api: credential ids are instance-specific and cannot be guessed")

    ids: dict = {}
    if args.ids:
        if not args.ids.exists():
            print(f"error: {args.ids} does not exist", file=sys.stderr)
            return 1
        ids = json.loads(args.ids.read_text())
    if args.from_api:
        base_url = os.environ.get("N8N_BASE_URL")
        api_key = os.environ.get("N8N_API_KEY")
        if not base_url or not api_key:
            print("error: --from-api needs N8N_BASE_URL and N8N_API_KEY in the environment", file=sys.stderr)
            return 1
        try:
            ids = list_workflows(base_url, api_key)
        except urllib.error.URLError as exc:
            print(f"error: could not reach {base_url}: {exc}", file=sys.stderr)
            return 1
        print(f"resolved {len(ids)} workflow id(s) from {base_url}")

    # The error workflow's id is the one thing we cannot fake: without it, failures
    # stop being recorded entirely, so refuse rather than emit a dangling reference.
    error_id = ids.get(spec.ERROR_WORKFLOW_NAME)
    if not error_id:
        print(
            f"error: no id for {spec.ERROR_WORKFLOW_NAME!r}.\n"
            f"       Import that workflow first, then add its id to {args.ids or 'the id map'}.\n"
            f"       Known names: {sorted(ids) or 'none'}",
            file=sys.stderr,
        )
        return 1

    credential = None
    if args.credential:
        try:
            credentials = list_credentials(base_url, api_key)
        except urllib.error.URLError as exc:
            print(f"error: could not list credentials: {exc}", file=sys.stderr)
            return 1
        if args.credential not in credentials:
            print(
                f"error: no {CREDENTIAL_TYPE} credential named {args.credential!r}.\n"
                f"       Found: {sorted(credentials) or 'none'}",
                file=sys.stderr,
            )
            return 1
        credential = (credentials[args.credential], args.credential)

    main_workflow = json.loads(MAIN_FILE.read_text())
    changes = wire_main(main_workflow, error_id, credential)

    if args.dry_run:
        print("dry run - nothing written")
    elif args.in_place:
        MAIN_FILE.write_text(json.dumps(main_workflow, indent=2, ensure_ascii=False) + "\n")
        print(f"rewrote {display(MAIN_FILE)}")
    else:
        args.out.mkdir(parents=True, exist_ok=True)
        target = args.out / MAIN_FILE.name
        target.write_text(json.dumps(main_workflow, indent=2, ensure_ascii=False) + "\n")
        print(f"wrote {display(target)}")

    if changes:
        for change in changes:
            print(f"  {change}")
    else:
        print("  already wired - nothing to change")

    # The error handler must NOT point at an error workflow: a failure while recording
    # a failure would recurse. Assert it rather than trusting it.
    error_workflow = json.loads(ERROR_FILE.read_text())
    if error_workflow.setdefault("settings", {}).get("errorWorkflow"):
        print(f"error: {ERROR_FILE.name} has its own errorWorkflow set - that can loop", file=sys.stderr)
        return 1

    print(f"\nNext: import {ERROR_FILE.name} and {MAIN_FILE.name}, then activate the chat trigger.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

