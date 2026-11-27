import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { auditEnvironmentCache } from "../scripts/cache-audit.mjs";
import { buildMcpConfigObject } from "../scripts/install.mjs";
import { ContextModeStore } from "../context/lib/store.js";
import { evaluateCacheAlerts } from "../hooks/pre-invocation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function sendContextRpc(messages, env = {}) {
  const input = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  const res = spawnSync(process.execPath, [path.join(ROOT, "context", "server.js")], {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    env: {
      ...process.env,
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      ...env
    }
  });
  assert.equal(res.status, 0, `context/server.js failed: ${res.stderr}`);
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeBloatedMockMcp(scriptPath) {
  const src = `
import readline from "node:readline";
const tools = Array.from({ length: 18 }, (_, i) => ({
  description: "Verbose enterprise schema description ".repeat(14) + "tool_" + String(i).padStart(2, "0"),
  inputSchema: {
    properties: {
      argA: { description: "Detailed parameter documentation ".repeat(6), type: "string" },
      argB: { description: "Additional nested constraint text ".repeat(6), type: "string" }
    },
    type: "object"
  },
  name: "bloated_tool_" + String(i).padStart(2, "0")
}));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock-bloat", version: "1.0.0" } }
    }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } }) + "\\n");
  }
});
`;
  fs.writeFileSync(scriptPath, src, "utf8");
}

test("Wave2-1 (P0-4): cache-audit discovers .agents/ & .antigravity-plugin, evaluates rule triggers/24KB/20k limits, PostInvocation, and separates lazy vs eager MCP schemas", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w2-audit-"));
  const geminiRoot = path.join(baseDir, ".gemini");
  const configDir = path.join(geminiRoot, "config");
  const repoRoot = path.join(baseDir, "repo");
  const workspaceDir = path.join(repoRoot, "packages", "app");
  const mockMcp = path.join(baseDir, "mock-bloat-mcp.mjs");

  try {
    fs.mkdirSync(path.join(configDir, "plugins", "ext-ag", ".antigravity-plugin"), { recursive: true });
    fs.mkdirSync(path.join(configDir, "plugins", "ext-ag", "rules"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".agents", "rules"), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    // Global standalone ~/.gemini/AGENTS.md and ~/.gemini/config/GEMINI.md
    fs.writeFileSync(path.join(geminiRoot, "AGENTS.md"), "# Global Gemini AGENTS\nStay concise.\n", "utf8");
    fs.writeFileSync(path.join(configDir, "GEMINI.md"), "# Config GEMINI\nKeep cache warm.\n", "utf8");

    // Plugin with .antigravity-plugin/plugin.json (preferred over root)
    fs.writeFileSync(
      path.join(configDir, "plugins", "ext-ag", ".antigravity-plugin", "plugin.json"),
      JSON.stringify({ name: "ext-ag-manifest" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(configDir, "plugins", "ext-ag", "rules", "always.md"),
      "---\ntrigger: always_on\n---\nKeep outputs short.\n",
      "utf8"
    );

    // Workspace ancestor .agents/AGENTS.md + trigger variants in .agents/rules/
    fs.writeFileSync(path.join(repoRoot, ".agents", "AGENTS.md"), "# Repo Agents\nRun tests.\n", "utf8");
    fs.writeFileSync(
      path.join(repoRoot, ".agents", "rules", "model-dec.md"),
      "---\ntrigger: model_decision\ndescription: Short pointer\n---\n" + "Heavy body line.\n".repeat(400),
      "utf8"
    );
    fs.writeFileSync(
      path.join(repoRoot, ".agents", "rules", "glob-only.md"),
      "---\ntrigger: glob\nglobs: \"**/*.sql\"\n---\n" + "SQL guideline.\n".repeat(400),
      "utf8"
    );
    fs.writeFileSync(
      path.join(repoRoot, ".agents", "rules", "bad-trigger.md"),
      "---\ntrigger: always\n---\nTypo trigger gets silently dropped by host.\n",
      "utf8"
    );

    // 25 KB always_on rule -> triggers rule_truncation_limit (>24,000 B)
    fs.writeFileSync(
      path.join(repoRoot, ".agents", "rules", "huge-25kb.md"),
      "---\ntrigger: always_on\n---\n" + "a".repeat(24500) + "\n",
      "utf8"
    );

    // Workspace .agents/hooks.json with PostInvocation hook
    fs.writeFileSync(
      path.join(repoRoot, ".agents", "hooks.json"),
      JSON.stringify({
        "demo-hooks": {
          PostInvocation: [{ type: "command", command: "node -e \"console.log('{}')\"" }]
        }
      }),
      "utf8"
    );

    // Workspace .agents/mcp_config.json with BOTH lazy bloated server (must NOT warn) and eager bloated server (MUST warn)
    writeBloatedMockMcp(mockMcp);
    fs.writeFileSync(
      path.join(repoRoot, ".agents", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          "lazy-huge": { command: "node", args: [mockMcp] },
          "eager-huge": {
            command: "node",
            args: [mockMcp],
            tools: Object.fromEntries(
              Array.from({ length: 18 }, (_, i) => [`bloated_tool_${String(i).padStart(2, "0")}`, { eager: true }])
            )
          }
        }
      }),
      "utf8"
    );

    const report = await auditEnvironmentCache({
      workspace: workspaceDir,
      configDir,
      live: true,
      timeoutMs: 6000
    });

    // Plugin manifest discovered under .antigravity-plugin/plugin.json
    assert.ok(
      report.hooks.activePlugins.some((p) => p.name === "ext-ag-manifest"),
      "Must discover .antigravity-plugin/plugin.json plugin name"
    );

    // Standalone global & ancestor .agents/AGENTS.md discovered
    assert.ok(report.prefix.items.some((i) => i.scope === "global" && i.name === "AGENTS.md"));
    assert.ok(report.prefix.items.some((i) => i.scope === "global" && i.name === "GEMINI.md"));
    assert.ok(report.prefix.items.some((i) => i.name.includes(".agents/AGENTS.md")));

    // model_decision counts only compact pointer at Turn 0; glob-only does not enter Turn 0 items
    const modelDecItem = report.prefix.items.find((i) => i.name.includes("model-dec.md"));
    assert.ok(modelDecItem, "model_decision rule pointer must appear in Turn-0 items");
    assert.ok(modelDecItem.tokens < 50, `model_decision must count only pointer tokens, got ${modelDecItem.tokens}`);
    assert.ok(modelDecItem.bodyTokens > 1000);
    assert.equal(
      report.prefix.items.some((i) => i.name.includes("glob-only.md")),
      false,
      "glob rule must NOT inflate Turn-0 items"
    );
    assert.ok(report.prefix.onDemandRuleCount >= 2);
    assert.ok(report.prefix.onDemandRuleTokens > 2000);

    // Invalid trigger & 24 KB truncation findings emitted
    assert.ok(
      report.findings.some((f) => f.code === "invalid_rule_trigger" && f.target.includes("bad-trigger.md")),
      "Typo trigger must emit invalid_rule_trigger"
    );
    assert.ok(
      report.findings.some((f) => f.code === "rule_truncation_limit" && f.target.includes("huge-25kb.md")),
      ">24,000-byte always_on rule must emit rule_truncation_limit"
    );

    // PostInvocation hook discovered from ancestor .agents/hooks.json
    assert.ok(
      report.hooks.entries.some((e) => e.event === "PostInvocation"),
      "Must discover PostInvocation hook from .agents/hooks.json"
    );

    // Lazy bloated MCP server does NOT emit bloated_mcp_schema; eager bloated MCP server DOES
    const lazySrv = report.mcp.servers.find((s) => s.name === "lazy-huge");
    const eagerSrv = report.mcp.servers.find((s) => s.name === "eager-huge");
    assert.ok(lazySrv && lazySrv.eagerTokens === 0 && lazySrv.lazyCatalogTokens > 3000);
    assert.ok(eagerSrv && eagerSrv.eagerTokens > 3000 && eagerSrv.eagerToolCount === 18);
    assert.equal(
      report.findings.some((f) => f.code === "bloated_mcp_schema" && f.target.includes("lazy-huge")),
      false,
      "Default lazy MCP server must NOT trigger bloated_mcp_schema"
    );
    assert.equal(
      report.findings.some((f) => f.code === "bloated_mcp_schema" && f.target.includes("eager-huge")),
      true,
      "Eager bloated MCP server MUST trigger bloated_mcp_schema"
    );

    // Aggregate 20,000-token rules budget check
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "这是一段用于触发两万聚合规则预算告警的测试文本。".repeat(900), "utf8");
    const aggReport = await auditEnvironmentCache({ workspace: workspaceDir, configDir, live: false });
    assert.ok(
      aggReport.findings.some((f) => f.code === "rules_aggregate_budget_exceeded"),
      "Combined >20,000-token always_on rules must emit rules_aggregate_budget_exceeded"
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Wave2-2 (P1-1): built-in subagents declare eager fast tools and check root AGENTS.md", () => {
  for (const [name, expectedTools] of [
    ["dart-coder", ["batch_search", "read_slices", "apply_edits", "run_checks"]],
    ["dart-reviewer", ["batch_search", "read_slices", "run_checks"]]
  ]) {
    const src = fs.readFileSync(path.join(ROOT, "agents", `${name}.md`), "utf8");
    for (const tool of expectedTools) {
      assert.match(
        src,
        new RegExp(`${tool}:\\s*\\{\\s*eager:\\s*true\\s*\\}`),
        `${name} must mark ${tool} eager: true`
      );
    }
    assert.match(src, /AGENTS\.md/, `${name} must remind subagent to check root AGENTS.md`);
  }
});

test("Wave2-3 (P1-3): mcp_config.json/install.mjs set context timeoutSeconds=310 and context/server.js aligns MCP protocol & initialize.instructions", () => {
  const mcpCfg = JSON.parse(fs.readFileSync(path.join(ROOT, "mcp_config.json"), "utf8"));
  assert.equal(mcpCfg.mcpServers.context.timeoutSeconds, 310);

  for (const mode of ["fast-eager", "lazy", "eager"]) {
    const built = buildMcpConfigObject(mode);
    assert.equal(built.mcpServers.context.timeoutSeconds, 310, `buildMcpConfigObject(${mode}) must set timeoutSeconds=310`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w2-ctx-"));
  const dbPath = path.join(tmpDir, "context.db");
  try {
    const resps = sendContextRpc(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "w2-test", version: "1.0" } }
        },
        { jsonrpc: "2.0", id: 2, method: "resources/list" },
        { jsonrpc: "2.0", id: 3, method: "resources/templates/list" },
        { jsonrpc: "2.0", id: 4, method: "prompts/list" }
      ],
      { AGY_DART_DB_PATH: dbPath }
    );
    const init = resps.find((r) => r.id === 1)?.result;
    assert.equal(init.protocolVersion, "2025-11-25");
    assert.equal(typeof init.instructions, "string");
    assert.ok(init.instructions.includes("ctx_execute") && init.instructions.includes("ctx_resume"));
    assert.deepEqual(resps.find((r) => r.id === 2)?.result, { resources: [] });
    assert.deepEqual(resps.find((r) => r.id === 3)?.result, { resourceTemplates: [] });
    assert.deepEqual(resps.find((r) => r.id === 4)?.result, { prompts: [] });

    // Unknown protocol version falls back safely to DEFAULT_PROTOCOL_VERSION (2025-03-26)
    const fallbackResps = sendContextRpc(
      [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01", capabilities: {} } }],
      { AGY_DART_DB_PATH: dbPath }
    );
    assert.equal(fallbackResps[0]?.result?.protocolVersion, "2025-03-26");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Wave2-4 (P2-1): plugin.json includes official schema, license, keywords, and concise 120-160 char Marketplace description", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
  assert.equal(manifest.$schema, "https://antigravity.google/schemas/v1/plugin.json");
  assert.equal(manifest.license, "MIT");
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length >= 5 && manifest.keywords.length <= 12);
  assert.ok(
    manifest.description.length >= 120 && manifest.description.length <= 160,
    `Expected description 120..160 chars, got ${manifest.description.length}`
  );
});

test("Wave2-5 (P2-2 + P1-5 docs): PreInvocation alerts guide /compact <focus> & /btw, and SKILL/error-playbook document /context & cliFilter: false", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w2-alerts-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });
  try {
    const critEn = evaluateCacheAlerts(
      {
        watermark: "critical",
        currentContextTokens: 170000,
        criticalTokens: 160000,
        windowTokens: 200000,
        weightedHitRate: 0.85,
        compactAdvice: "critical_compact",
        ttlStatus: "warm",
        cacheTtlSec: 300
      },
      { sessionId: "w2-en", store, uiLang: "en" }
    );
    assert.ok(critEn[0].includes("/compact <focus>"), `Expected /compact <focus> in EN critical alert: ${critEn[0]}`);

    const coldZh = evaluateCacheAlerts(
      {
        watermark: "warn",
        currentContextTokens: 140000,
        warnTokens: 130000,
        windowTokens: 200000,
        weightedHitRate: 0.4,
        compactAdvice: "opportunistic_cold_compact",
        ttlStatus: "expired",
        cacheTtlSec: 300
      },
      { sessionId: "w2-zh", store, uiLang: "zh" }
    );
    assert.ok(coldZh[0].includes("/compact <focus>") && coldZh[0].includes("/btw"), `Expected /compact <focus> & /btw in ZH cold alert: ${coldZh[0]}`);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  const skillMd = fs.readFileSync(path.join(ROOT, "skills", "agy-dart", "SKILL.md"), "utf8");
  const playbookMd = fs.readFileSync(path.join(ROOT, "skills", "agy-dart", "references", "error-playbook.md"), "utf8");
  for (const needle of ["/compact <focus>", "/btw <question>", "/context", "cliFilter"]) {
    assert.ok(skillMd.includes(needle), `SKILL.md must mention ${needle}`);
    assert.ok(playbookMd.includes(needle), `error-playbook.md must mention ${needle}`);
  }
});
