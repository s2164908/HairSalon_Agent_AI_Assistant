# salon-assistant

Build pipeline and tests for `../salon-assistant-v2.json` (the n8n workflow). See `../PLAN.md` §11 for the local setup and findings, `../CLAUDE.md` for commands.

- `code/` — one file per Code node / Code Tool (`validate.js` is the guardrail + renderer)
- `build.js` — assembles the workflow JSON (prompt, schemas, wiring live here)
- `verify.js`, `verify2.js` — logic-level checks (88), run against the built JSON
- `run_chat.js` — 18 live conversations against the local webhook; writes `chat_results.json`
- `make_tables.js` → `tables.json` — Data Table definitions + rows derived from `../mockdata.jsonc`
- `serve.js` — one-file localhost server used to hand the built JSON to a browser-side deploy script
- `netdiag.js` — container-side reproduction of the OpenAI connect-timeout issue (run with `docker compose exec -T n8n node - < netdiag.js`)
