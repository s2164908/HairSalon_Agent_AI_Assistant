#!/usr/bin/env node
// Independent audit of the generated workflow JSON.
//
// validate_workflows.py is Python and checks the generated files against
// workflow_spec.py's intent. This is a second opinion in a different language with a
// different implementation, so the two do not share a blind spot: it re-derives
// everything from the raw JSON and asserts nothing about what the generator *meant*.
//
// Run:  node scripts/audit_workflows.mjs
// Exit 0 = clean.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  { file: join(ROOT, 'workflows', 'salon-assistant-v3.json'), label: 'v3', tools: 11 },
  { file: join(ROOT, 'workflows', 'salon-assistant-error-handler.json'), label: 'error-handler', tools: 0 },
];

const EXPECTED_BRANCHES = {
  'Risk pre-screen': [['Render safety draft'], ['Read Services']],
  'Check if evaluating': [['Set metrics'], ['Queue for staff review']],
};

let problems = 0;
const fail = (message) => {
  console.log(`  FAIL ${message}`);
  problems += 1;
};

const stringsIn = (value) =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsIn)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(stringsIn)
        : [];

function audit({ file, label, tools: expectedTools }) {
  const wf = JSON.parse(readFileSync(file, 'utf8'));
  const names = wf.nodes.map((n) => n.name);
  const nameSet = new Set(names);
  const idSet = new Set(wf.nodes.map((n) => n.id));

  if (nameSet.size !== names.length) fail(`${label}: duplicate node names`);
  for (const key of ['id', 'versionId', 'meta']) {
    if (key in wf) fail(`${label}: carries instance-specific '${key}'`);
  }
  if (wf.settings?.executionOrder !== 'v1') fail(`${label}: executionOrder is not v1`);

  // --- connections, exactly as n8n parses them ------------------------------
  let mainEdges = 0;
  let subEdges = 0;
  for (const [source, outputs] of Object.entries(wf.connections)) {
    if (!nameSet.has(source)) fail(`${label}: connection source '${source}' is not a node`);
    if (source in outputs) fail(`${label}: '${source}' is nested twice`);
    for (const [type, branches] of Object.entries(outputs)) {
      for (const branch of branches) {
        for (const edge of branch) {
          if (!nameSet.has(edge.node)) fail(`${label}: '${source}' -> dangling '${edge.node}'`);
          if (edge.type !== type) fail(`${label}: '${source}' edge type mismatch`);
          if (type === 'main') mainEdges += 1;
          else subEdges += 1;
        }
      }
    }
  }
  const toolNodes = wf.nodes.filter((n) => n.type.endsWith('toolCode'));
  console.log(`  ${label}: ${wf.nodes.length} nodes, ${mainEdges} main edges, ${subEdges} sub edges`);
  for (const tool of toolNodes) {
    if (!wf.connections[tool.name]?.ai_tool) fail(`${label}: tool '${tool.name}' is not wired to the agent`);
  }

  // --- every $('Node') reference resolves ------------------------------------
  let references = 0;
  for (const node of wf.nodes) {
    for (const text of stringsIn(node.parameters)) {
      for (const match of text.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) {
        references += 1;
        if (!nameSet.has(match[1])) fail(`${label}: ${node.name} references missing node '${match[1]}'`);
      }
    }
  }
  console.log(`  ${label}: ${references} node references, all resolve`);

  // --- Code bodies parse ------------------------------------------------------
  const scratch = mkdtempSync(join(tmpdir(), 'n8n-audit-'));
  let codeBodies = 0;
  for (const node of wf.nodes) {
    const code = node.parameters?.jsCode;
    if (!code) continue;
    codeBodies += 1;
    const scratchFile = join(scratch, `${node.name.replace(/[^A-Za-z0-9]/g, '_')}.js`);
    writeFileSync(scratchFile, code);
    try {
      execFileSync(process.execPath, ['--check', scratchFile], { stdio: 'pipe' });
    } catch {
      fail(`${label}: ${node.name} jsCode does not parse`);
    }
  }
  console.log(`  ${label}: ${codeBodies} Code bodies pass node --check`);

  // --- credentials and canvas groups -----------------------------------------
  for (const node of wf.nodes) {
    for (const credential of Object.values(node.credentials ?? {})) {
      if (credential.__aiGatewayManaged) fail(`${label}: ${node.name} uses a Cloud-only managed credential`);
    }
  }
  for (const group of wf.nodeGroups ?? []) {
    for (const id of group.nodeIds) {
      if (!idSet.has(id)) fail(`${label}: group '${group.name}' has an unresolved nodeId`);
    }
  }

  // --- branch order -----------------------------------------------------------
  for (const [source, expected] of Object.entries(EXPECTED_BRANCHES)) {
    if (!nameSet.has(source)) continue;
    expected.forEach((want, index) => {
      const got = (wf.connections[source]?.main?.[index] ?? []).map((e) => e.node);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        fail(`${label}: ${source} output ${index} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      }
    });
  }

  // --- the agent's tool contract ---------------------------------------------
  if (expectedTools) {
    const agent = wf.nodes.find((n) => n.name === 'Salon Tools Agent');
    const declared = agent.parameters.options.systemMessage
      .match(/TOOLS:\s*(.+)/)[1]
      .split(',')
      .map((t) => t.trim().replace(/\.$/, ''));
    const actual = toolNodes.map((n) => n.name);
    if (actual.length !== expectedTools) fail(`${label}: ${actual.length} tools, expected ${expectedTools}`);
    if (JSON.stringify(actual) !== JSON.stringify(declared)) fail(`${label}: tool names differ from the system message`);
    if (agent.parameters.options.enableStreaming !== false) fail(`${label}: streaming must be off for the guardrail`);
    if (agent.parameters.options.returnIntermediateSteps !== true) fail(`${label}: intermediate steps must be on`);
    if (agent.parameters.options.maxIterations < actual.length) {
      fail(`${label}: maxIterations ${agent.parameters.options.maxIterations} < ${actual.length} tools`);
    }
    console.log(`  ${label}: ${actual.length} tools named, wired, matching the system message`);
  }

  // --- data tables ------------------------------------------------------------
  for (const node of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.dataTable')) {
    if (!node.parameters.resource || !node.parameters.operation) {
      fail(`${label}: ${node.name} relies on Data Table defaults`);
    }
    if (node.parameters.dataTableId?.mode !== 'name') {
      fail(`${label}: ${node.name} does not address its table by name`);
    }
  }
}

console.log('Independent audit (second implementation, not a re-run of validate_workflows.py)');
for (const target of TARGETS) audit(target);
console.log(problems === 0 ? '\nINDEPENDENT AUDIT: clean' : `\nINDEPENDENT AUDIT: ${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);

