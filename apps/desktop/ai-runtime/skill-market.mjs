#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';

const SOURCE = 'binance/binance-skills-hub';
const SOURCE_URL = `https://github.com/${SOURCE}`;
const API_ROOT = `https://api.github.com/repos/${SOURCE}`;
const RAW_ROOT = `https://raw.githubusercontent.com/${SOURCE}`;
const CATALOG_VERSION = 2;
const CATALOG_TTL_MS = 60 * 60 * 1000;
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_INDEX_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_SKILL_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_FILES = 64;
const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const SKILL_SOURCE_PATH = /^skills\/(binance-web3|binance)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/u;

const text = (value) => String(value ?? '').trim();

function dataRoot() {
  const root = text(process.env.FNZSAFE_SKILL_MARKET_DATA_ROOT);
  if (!root || !path.isAbsolute(root)) throw new Error('Binance skill market data directory is invalid');
  return root;
}

function paths() {
  const root = dataRoot();
  return {
    root,
    installed: path.join(root, 'binance-skills'),
    staging: path.join(root, 'binance-skill-staging'),
    backups: path.join(root, 'binance-skill-backups'),
    cache: path.join(root, 'binance-skill-market', 'catalog.json'),
  };
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('skill market input exceeds 32 KiB');
    chunks.push(chunk);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('skill market input must be an object');
  return parsed;
}

async function fetchText(url, maxBytes) {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'FnzSafe-Binance-Skill-Market' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Binance Skills Hub request returned HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('Binance Skills Hub response exceeds the size limit');
  const body = await response.text();
  if (Buffer.byteLength(body) > maxBytes) throw new Error('Binance Skills Hub response exceeds the size limit');
  return body;
}

async function fetchJson(url, maxBytes = MAX_INDEX_BYTES) {
  return JSON.parse(await fetchText(url, maxBytes));
}

function parseFrontmatter(source, fallbackId) {
  const normalized = String(source).replace(/\r\n/gu, '\n');
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1] || '';
  const unquote = (value) => {
    const trimmed = text(value);
    if (trimmed.length >= 2 && ((trimmed.startsWith("'") && trimmed.endsWith("'"))
      || (trimmed.startsWith('"') && trimmed.endsWith('"')))) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  };
  const name = unquote(frontmatter.match(/^name:\s*(.*?)\s*$/mu)?.[1] || fallbackId);
  const rawDescription = text(frontmatter.match(/^description:\s*(.*?)\s*$/mu)?.[1]);
  let description = rawDescription === '|' || rawDescription === '>' ? '' : unquote(rawDescription);
  if (!description && (rawDescription === '|' || rawDescription === '>')) {
    const lines = frontmatter.split('\n');
    const start = lines.findIndex((line) => /^description:\s*[>|]\s*$/u.test(line));
    const collected = [];
    for (const line of lines.slice(start + 1)) {
      if (!/^\s+/u.test(line)) break;
      collected.push(line.trim());
    }
    description = collected.join(' ');
  }
  const version = unquote(frontmatter.match(/^\s+version:\s*(.*?)\s*$/mu)?.[1] || 'unversioned');
  return {
    name: name.slice(0, 120),
    description: description.replace(/\s+/gu, ' ').slice(0, 600),
    version: version.slice(0, 40),
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
}

async function installationState(id) {
  if (!SKILL_ID.test(id) || id.length > 100) {
    return { installed: false, installedVersion: '', installedCommit: '' };
  }
  const manifest = await readJson(path.join(paths().installed, id, '.fnzsafe-source.json'));
  return {
    installed: Boolean(manifest?.source === SOURCE && COMMIT_SHA.test(text(manifest?.commit))),
    installedVersion: text(manifest?.version),
    installedCommit: text(manifest?.commit),
  };
}

async function withInstallationState(catalog) {
  return {
    ...catalog,
    skills: await Promise.all(catalog.skills.map(async (skill) => {
      const state = await installationState(text(skill?.id));
      return {
        ...skill,
        ...state,
        updateAvailable: state.installed && state.installedCommit !== catalog.commit,
      };
    })),
  };
}

async function githubIndex(commit) {
  const index = await fetchJson(`${API_ROOT}/git/trees/${commit}?recursive=1`);
  if (!Array.isArray(index?.tree)) throw new Error('Binance Skills Hub returned an invalid repository index');
  return index.tree;
}

async function syncCatalog(force = false) {
  const location = paths();
  await fs.mkdir(location.installed, { recursive: true, mode: 0o700 });
  const cached = await readJson(location.cache);
  if (!force && cached?.catalogVersion === CATALOG_VERSION && cached?.source === SOURCE && COMMIT_SHA.test(text(cached?.commit))
    && Date.now() - Number(cached?.fetchedAt || 0) < CATALOG_TTL_MS && Array.isArray(cached?.skills)) {
    return withInstallationState(cached);
  }

  const commitResponse = await fetchJson(`${API_ROOT}/commits/main`, 1024 * 1024);
  const commit = text(commitResponse?.sha);
  if (!COMMIT_SHA.test(commit)) throw new Error('Binance Skills Hub returned an invalid commit');
  const tree = await githubIndex(commit);
  const skillFiles = tree
    .filter((entry) => entry?.type === 'blob' && SKILL_SOURCE_PATH.test(text(entry?.path)))
    .sort((left, right) => text(left.path).localeCompare(text(right.path)));
  if (skillFiles.length === 0 || skillFiles.length > 100) throw new Error('Binance Skills Hub skill count is invalid');

  const skills = await Promise.all(skillFiles.map(async (entry) => {
    const sourcePath = text(entry.path);
    const match = sourcePath.match(SKILL_SOURCE_PATH);
    if (!match) throw new Error('Binance skill path is invalid');
    const [, collection, id] = match;
    const source = await fetchText(`${RAW_ROOT}/${commit}/${entry.path}`, MAX_SKILL_FILE_BYTES);
    const metadata = parseFrontmatter(source, id);
    const prefix = `${sourcePath.slice(0, -'SKILL.md'.length)}`;
    const hasRemoteCode = tree.some((candidate) => {
      const candidatePath = text(candidate?.path);
      const relative = candidatePath.slice(prefix.length);
      return candidate?.type === 'blob'
        && candidatePath.startsWith(prefix)
        && (/^scripts\//u.test(relative) || /\.(?:cjs|js|mjs|py|sh|ts)$/u.test(relative));
    });
    return {
      id,
      ...metadata,
      collection,
      sourcePath,
      runtimeMode: 'knowledge',
      hasRemoteCode,
    };
  }));
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) {
    throw new Error('Binance Skills Hub contains duplicate skill IDs');
  }
  const catalog = { catalogVersion: CATALOG_VERSION, source: SOURCE, sourceUrl: SOURCE_URL, commit, fetchedAt: Date.now(), skills };
  await writeJsonAtomic(location.cache, catalog);
  return withInstallationState(catalog);
}

function isInstallableDocumentation(relative) {
  return relative === 'SKILL.md'
    || /^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/u.test(relative)
    || /^references\/[A-Za-z0-9][A-Za-z0-9_-]*\.md$/u.test(relative);
}

function installableFiles(tree, id, sourcePath) {
  const match = text(sourcePath).match(SKILL_SOURCE_PATH);
  if (!match || match[2] !== id) throw new Error('invalid Binance skill source path');
  const prefix = sourcePath.slice(0, -'SKILL.md'.length);
  const files = tree.filter((entry) => {
    const relative = text(entry?.path).slice(prefix.length);
    return entry?.type === 'blob'
      && text(entry?.path).startsWith(prefix)
      && isInstallableDocumentation(relative);
  });
  if (!files.some((entry) => text(entry.path) === `${prefix}SKILL.md`)) throw new Error('Binance skill is missing SKILL.md');
  if (files.length > MAX_SKILL_FILES) throw new Error('Binance skill contains too many documentation files');
  const total = files.reduce((sum, entry) => sum + Number(entry?.size || 0), 0);
  if (files.some((entry) => Number(entry?.size || 0) > MAX_SKILL_FILE_BYTES) || total > MAX_SKILL_TOTAL_BYTES) {
    throw new Error('Binance skill documentation exceeds the size limit');
  }
  return files;
}

async function installSkill(idValue, commitValue, sourcePathValue) {
  const id = text(idValue);
  const commit = text(commitValue);
  const sourcePath = text(sourcePathValue);
  if (!SKILL_ID.test(id) || id.length > 100) throw new Error('invalid Binance skill ID');
  if (!COMMIT_SHA.test(commit)) throw new Error('invalid Binance skill commit');
  if (!SKILL_SOURCE_PATH.test(sourcePath) || !sourcePath.endsWith(`/${id}/SKILL.md`)) {
    throw new Error('invalid Binance skill source path');
  }
  const tree = await githubIndex(commit);
  if (!tree.some((entry) => entry?.type === 'blob' && text(entry?.path) === sourcePath)) {
    throw new Error('Binance skill source does not exist at this commit');
  }
  const files = installableFiles(tree, id, sourcePath);
  const location = paths();
  await Promise.all([
    fs.mkdir(location.installed, { recursive: true, mode: 0o700 }),
    fs.mkdir(location.staging, { recursive: true, mode: 0o700 }),
    fs.mkdir(location.backups, { recursive: true, mode: 0o700 }),
  ]);
  const stage = path.join(location.staging, `${id}-${randomBytes(8).toString('hex')}`);
  await fs.mkdir(stage, { recursive: false, mode: 0o700 });
  let metadata;
  let downloadedBytes = 0;
  for (const entry of files) {
    const relative = text(entry.path).slice(sourcePath.length - 'SKILL.md'.length);
    const destination = path.join(stage, ...relative.split('/'));
    if (!destination.startsWith(`${stage}${path.sep}`)) throw new Error('invalid Binance skill file path');
    const source = await fetchText(`${RAW_ROOT}/${commit}/${entry.path}`, MAX_SKILL_FILE_BYTES);
    downloadedBytes += Buffer.byteLength(source);
    if (downloadedBytes > MAX_SKILL_TOTAL_BYTES) throw new Error('Binance skill documentation exceeds the size limit');
    if (relative === 'SKILL.md') {
      metadata = parseFrontmatter(source, id);
    }
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, source, { encoding: 'utf8', mode: 0o600 });
  }
  const installedAt = Date.now();
  await writeJsonAtomic(path.join(stage, '.fnzsafe-source.json'), {
    source: SOURCE,
    sourceUrl: SOURCE_URL,
    sourcePath,
    commit,
    version: metadata?.version || 'unversioned',
    installedAt,
  });
  const destination = path.join(location.installed, id);
  try {
    await fs.access(destination);
    await fs.rename(destination, path.join(location.backups, `${id}-${installedAt}`));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.rename(stage, destination);
  return {
    ok: true,
    source: SOURCE,
    skill: { id, ...metadata, installed: true, installedVersion: metadata?.version || 'unversioned', installedCommit: commit, updateAvailable: false },
  };
}

async function selfTest() {
  const parsed = parseFrontmatter(`---\nname: binance-test\ndescription: |\n  Test Binance skill.\nmetadata:\n  version: '1.2.3'\n---\n`, 'binance-test');
  if (parsed.name !== 'binance-test' || parsed.version !== '1.2.3' || parsed.description !== 'Test Binance skill.') {
    throw new Error('Binance skill metadata parser self-test failed');
  }
  const files = installableFiles([
    { type: 'blob', path: 'skills/binance-web3/binance-test/SKILL.md', size: 100 },
    { type: 'blob', path: 'skills/binance-web3/binance-test/README.md', size: 100 },
    { type: 'blob', path: 'skills/binance-web3/binance-test/knowledge.md', size: 100 },
    { type: 'blob', path: 'skills/binance-web3/binance-test/references/usage.md', size: 100 },
    { type: 'blob', path: 'skills/binance-web3/binance-test/scripts/install.mjs', size: 100 },
  ], 'binance-test', 'skills/binance-web3/binance-test/SKILL.md');
  if (files.length !== 4 || files.some((file) => file.path.includes('/scripts/'))) {
    throw new Error('Binance skill path filter self-test failed');
  }
  process.stdout.write(`${JSON.stringify({ ok: true, source: SOURCE })}\n`);
}

async function main() {
  const input = await readInput();
  if (input.action === 'sync') return syncCatalog(input.force === true);
  if (input.action === 'install') return installSkill(input.skillId, input.commit, input.sourcePath);
  throw new Error('unsupported Binance skill market action');
}

try {
  if (process.argv.includes('--self-test')) await selfTest();
  else process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
