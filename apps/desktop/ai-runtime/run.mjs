#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.join(runtimeRoot, 'skills');
const skillCatalogPath = path.join(runtimeRoot, 'skill-catalog.json');
const patchPath = path.join(runtimeRoot, 'fnzsafe.patch.yml');
const web3McpPath = path.join(runtimeRoot, 'plugins', 'web3-market-mcp.mjs');
const MAX_INPUT_BYTES = 512 * 1024;
const RUN_TIMEOUT_MS = 180_000;
const execFileAsync = promisify(execFile);

const text = (value) => String(value ?? '').trim();

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('AI runtime input exceeds 512 KiB');
    chunks.push(chunk);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isRecord(parsed)) throw new Error('AI runtime input must be an object');
  return parsed;
}

function requiredString(input, name, maxLength) {
  const value = text(input[name]);
  if (!value) throw new Error(`${name} is required`);
  if (value.length > maxLength) throw new Error(`${name} is too long`);
  return value;
}

function optionalSessionId(input) {
  const value = text(input.sessionId);
  if (!value) return undefined;
  if (value.length > 160 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('sessionId is invalid');
  return value;
}

function runtimeEnvironment(input, workspaceRoot, dshHome, model) {
  const inherited = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR'];
  const env = Object.fromEntries(inherited.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
  return {
    ...env,
    DEEPSEEK_API_KEY: requiredString(input, 'apiKey', 16_384),
    DEEPSEEK_BASE_URL: requiredString(input, 'baseUrl', 2_048).replace(/\/+$/u, ''),
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: 'read-only',
    DSH_TELEMETRY_DISABLED: '1',
    FNZSAFE_DSH_MODEL: model,
    FNZSAFE_DSH_SKILL_ROOT: skillRoot,
    FNZSAFE_DSH_SYSTEM_PROMPT: requiredString(input, 'systemPrompt', 80_000),
    FNZSAFE_WEB3_MCP_SERVER_PATH: web3McpPath,
    FNZSAFE_AI_WORKSPACE: workspaceRoot,
    ...(process.env.FNZSAFE_WALLET_API_URL ? { FNZSAFE_WALLET_API_URL: process.env.FNZSAFE_WALLET_API_URL } : {}),
    ...(process.env.FNZSAFE_WALLET_API_TOKEN ? { FNZSAFE_WALLET_API_TOKEN: process.env.FNZSAFE_WALLET_API_TOKEN } : {}),
  };
}

async function runHarness(input) {
  const workspaceRoot = requiredString(input, 'workspaceRoot', 4_096);
  const dshHome = requiredString(input, 'dshHome', 4_096);
  const model = requiredString(input, 'model', 160);
  const sessionId = optionalSessionId(input);
  await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(dshHome, { recursive: true, mode: 0o700 });

  const harness = new DeepSeekHarness({
    cwd: workspaceRoot,
    processCwd: workspaceRoot,
    profile: 'sdk-minimal',
    patches: [patchPath],
    dshHome,
    env: runtimeEnvironment(input, workspaceRoot, dshHome, model),
    provider: 'deepseek-official',
    model,
    maxTokens: 4096,
    initializeTimeoutMs: 30_000,
    requestTimeoutMs: RUN_TIMEOUT_MS,
    shutdownTimeoutMs: 1_000,
    disposeEofGraceMs: 6_000,
    disposeGraceMs: 3_000,
  });

  let timeout;
  try {
    const run = harness.run(requiredString(input, 'prompt', 240_000), {
      ...(sessionId ? { sessionId } : {}),
    });
    const result = await Promise.race([
      run,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`AI runtime timed out after ${RUN_TIMEOUT_MS}ms`)), RUN_TIMEOUT_MS);
      }),
    ]);
    const answer = text(result.finalResponse);
    if (!answer) throw new Error('AI runtime returned an empty answer');
    const toolsUsed = result.notifications
      .filter((item) => item?.method === 'session.event' && item.params?.event?.type === 'tool/call')
      .map((item) => text(item.params?.event?.data?.name || item.params?.event?.data?.toolName))
      .filter(Boolean);
    return {
      answer,
      sessionId: result.sessionId,
      runtime: 'deepseek-harness',
      toolsUsed: [...new Set(toolsUsed)],
    };
  } finally {
    clearTimeout(timeout);
    await harness.close();
  }
}

async function selfTest() {
  const skillEntries = await fs.readdir(skillRoot, { withFileTypes: true });
  const skills = skillEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  await Promise.all([patchPath, web3McpPath, skillCatalogPath, ...skills.map((name) => path.join(skillRoot, name, 'SKILL.md'))].map((file) => fs.access(file)));

  const catalog = JSON.parse(await fs.readFile(skillCatalogPath, 'utf8'));
  const catalogEntries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  const catalogIds = catalogEntries.map((entry) => text(entry?.id));
  if (!Number.isInteger(catalog?.version) || catalog.version < 1) throw new Error('AI skill catalog version is invalid');
  if (catalogEntries.length === 0 || catalogIds.some((id) => !id)) throw new Error('AI skill catalog is empty or contains an invalid ID');
  if (new Set(catalogIds).size !== catalogIds.length) throw new Error('AI skill catalog contains duplicate IDs');
  const categories = new Set(['market', 'defi', 'risk', 'intelligence', 'research', 'role']);
  const invalidEntry = catalogEntries.find((entry) => !isRecord(entry)
    || !['skill', 'role'].includes(entry.kind)
    || !categories.has(entry.category)
    || !text(entry.icon)
    || !text(entry.name?.zh) || !text(entry.name?.en)
    || !text(entry.description?.zh) || !text(entry.description?.en)
    || !Array.isArray(entry.useCases?.zh) || entry.useCases.zh.length === 0
    || !Array.isArray(entry.useCases?.en) || entry.useCases.en.length === 0
    || !Array.isArray(entry.sources) || entry.sources.some((source) => !text(source))
    || !Array.isArray(entry.tools) || entry.tools.some((tool) => !text(tool)));
  if (invalidEntry) throw new Error(`AI skill catalog entry is invalid: ${text(invalidEntry.id) || 'unknown'}`);
  const missingCatalogEntries = skills.filter((id) => !catalogIds.includes(id));
  const missingSkillDirectories = catalogIds.filter((id) => !skills.includes(id));
  if (missingCatalogEntries.length || missingSkillDirectories.length) {
    throw new Error(`AI skill catalog mismatch: missing entries [${missingCatalogEntries.join(', ')}], missing directories [${missingSkillDirectories.join(', ')}]`);
  }

  const { stdout } = await execFileAsync(process.execPath, [web3McpPath, '--self-test'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const mcp = JSON.parse(stdout.trim());
  if (!mcp?.ok || !Array.isArray(mcp?.tools)) throw new Error('Web3 MCP self-test failed');
  const referencedTools = [...new Set(catalogEntries.flatMap((entry) => Array.isArray(entry?.tools) ? entry.tools : []))];
  const missingTools = referencedTools.filter((name) => !mcp.tools.includes(name));
  if (missingTools.length) throw new Error(`AI skill catalog references unavailable tools: ${missingTools.join(', ')}`);

  return {
    ok: true,
    runtime: 'deepseek-harness',
    node: process.version,
    catalogVersion: catalog.version,
    skills,
    tools: mcp.tools,
  };
}

try {
  const result = process.argv.includes('--self-test') ? await selfTest() : await runHarness(await readInput());
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message, runtime: 'deepseek-harness' })}\n`);
  process.exitCode = 1;
}
