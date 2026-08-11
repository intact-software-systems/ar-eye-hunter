#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const registryPath = 'docs/test-structure-coupling-exceptions.md';
const input = readInput(process.argv.slice(2));
const reportCandidates = readReportCandidates(input);
const completeCurrentCandidates = readCompleteCurrentCandidates(input);
const registry = readRegistry(input);
const validationErrors = validateRegistry(registry, completeCurrentCandidates);

printReport({ input, reportCandidates, registry });
for (const error of validationErrors) {
  console.log(`FAIL: ${error}`);
}
if (validationErrors.length > 0) {
  process.exitCode = 1;
} else {
  console.log('PASS: registry entries are complete and current');
}

function readInput(args) {
  if (args.length === 0) return { mode: 'full' };
  if (args.length > 1 && args[0] === '--files') {
    return { mode: 'changed-files', paths: args.slice(1).filter(isTestPath).toSorted() };
  }
  if (args.length === 3 && args[0] === '--changed') {
    const base = resolveCommit(args[1], 'base');
    const head = resolveCommit(args[2], 'head');
    return { mode: 'changed-range', base, head, changes: readRangeChanges(base, head) };
  }
  failUsage(
    'usage: npm run check:test-structure-coupling ' +
      '[--files <test-file>...] [--changed <base> <head>]',
  );
}

function resolveCommit(reference, name) {
  const commit = tryGit(['rev-parse', '--verify', `${reference}^{commit}`]);
  if (!commit) failUsage(`${name} reference does not resolve to a commit: ${reference}`);
  return commit.toString('utf8').trim();
}

function readRangeChanges(base, head) {
  const fields = runGitBuffer([
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    '--find-copies',
    base,
    head,
  ])
    .toString('utf8')
    .split('\0');
  const changes = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    if (!status) continue;
    const kind = status[0];
    const source = fields[index++];
    const target =
      kind === 'R' || kind === 'C' ? fields[index++] : kind === 'D' ? undefined : source;
    if (![source, target].filter(Boolean).some(isTestPath)) continue;
    changes.push({ kind, source, target });
  }
  return changes;
}

function readReportCandidates(input) {
  if (input.mode === 'full') return scanWorkingPaths(readWorkingTestPaths());
  if (input.mode === 'changed-files')
    return scanWorkingPaths(input.paths).map(withChange('selected'));

  const candidates = [];
  for (const change of input.changes) {
    if (change.target && isTestPath(change.target)) {
      candidates.push(
        ...scanRevisionPaths(input.head, [change.target]).map(
          withChange(
            change.kind === 'R'
              ? 'renamed'
              : change.kind === 'A' || change.kind === 'C'
                ? 'new'
                : 'touched',
          ),
        ),
      );
    }
    if ((!change.target || change.kind === 'M') && isTestPath(change.source)) {
      const currentIds = new Set(
        change.target
          ? scanRevisionPaths(input.head, [change.target]).map((candidate) => candidate.id)
          : [],
      );
      candidates.push(
        ...scanRevisionPaths(input.base, [change.source])
          .filter((candidate) => !currentIds.has(candidate.id))
          .map(withChange('deleted')),
      );
    }
  }
  return candidates.toSorted(compareCandidates);
}

function readCompleteCurrentCandidates(input) {
  return input.mode === 'changed-range'
    ? scanRevisionPaths(input.head, readRevisionTestPaths(input.head))
    : scanWorkingPaths(readWorkingTestPaths());
}

function readWorkingTestPaths() {
  return runGit(['ls-files', '-z']).split('\0').filter(isTestPath).toSorted();
}

function readRevisionTestPaths(revision) {
  return runGit(['ls-tree', '-r', '-z', '--name-only', revision])
    .split('\0')
    .filter(isTestPath)
    .toSorted();
}

function scanWorkingPaths(paths) {
  return scanSources(
    paths.filter(existsSync).map((file) => ({ file, source: readFileSync(file, 'utf8') })),
  );
}

function scanRevisionPaths(revision, paths) {
  const sources = [];
  for (const file of paths) {
    const source = tryGit(['show', `${revision}:${file}`]);
    if (source) sources.push({ file, source: source.toString('utf8') });
  }
  return scanSources(sources);
}

function scanSources(sources) {
  return sources
    .flatMap(({ file, source }) => scanTestSource(file, source))
    .toSorted(compareCandidates);
}

function scanTestSource(file, source) {
  const candidates = [];
  const readAliases = readFileAliases(source);
  for (const block of findTestBlocks(source)) {
    candidates.push(...scanTestBlock(file, source, block, readAliases));
  }
  return candidates;
}

function findTestBlocks(source) {
  const blocks = [];
  const pattern = /\b(?:it|test)\s*(?:\.\w+)?\s*\([^\n]*?=>\s*\{/gu;
  for (const match of source.matchAll(pattern)) {
    const opening = match.index + match[0].lastIndexOf('{');
    const closing = findClosingBrace(source, opening);
    if (closing !== undefined) blocks.push({ start: opening + 1, end: closing });
  }
  return blocks.length > 0 ? blocks : [{ start: 0, end: source.length }];
}

function findClosingBrace(source, opening) {
  let depth = 0;
  let quote;
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
}

function scanTestBlock(file, source, block, readAliases) {
  const blockSource = source.slice(block.start, block.end);
  const productionPathVariables = readProductionPathVariables(blockSource);
  const sourceValues = new Set();
  const candidates = [];
  for (const declaration of readDeclarations(blockSource)) {
    if (!isReadExpression(declaration.expression, readAliases)) continue;
    if (!hasProductionPath(declaration.expression, productionPathVariables)) continue;
    sourceValues.add(declaration.name);
    const call = findReadCall(declaration.expression, readAliases);
    candidates.push(
      candidate({
        file,
        source,
        index: block.start + declaration.expressionStart + call.index,
        kind: 'production-source-read',
        detail: call.text,
        reason: 'reads production source text',
      }),
    );
  }
  if (sourceValues.size === 0 && !hasProductionTreeEvidence(blockSource, productionPathVariables)) {
    return candidates;
  }

  const sourceLines = lineEntries(source, block);
  for (const entry of sourceLines) {
    const values = [...sourceValues];
    if (values.length > 0 && valuePattern(values).test(entry.text)) {
      addValueDerivedCandidates(candidates, file, source, entry, values);
    }
    if (hasProductionTreeEvidence(entry.text, productionPathVariables)) {
      addAll(
        candidates,
        file,
        source,
        entry,
        /(?:readdirSync|readdir\s*\(|glob\s*\(|fast-glob|ls-tree|(?:^|[;\s])find\s*\()/gu,
        {
          kind: 'exact-file-tree',
          reason: 'pins a production file tree or source inventory',
        },
      );
    }
  }
  return candidates;
}

function readDeclarations(source) {
  const declarations = [];
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);/gu;
  for (const match of source.matchAll(pattern)) {
    if (isInsideStringLiteral(source, match.index)) continue;
    const expressionStart = match.index + match[0].indexOf(match[2]);
    declarations.push({ name: match[1], expression: match[2], expressionStart });
  }
  return declarations;
}

function readProductionPathVariables(source) {
  const variables = new Set();
  for (let iteration = 0; iteration < 4; iteration += 1) {
    for (const declaration of readDeclarations(source)) {
      if (hasProductionPath(declaration.expression, variables)) variables.add(declaration.name);
    }
  }
  return variables;
}

function hasProductionPath(expression, variables) {
  const normalized = expression.replaceAll(/\s+/gu, ' ');
  if (/[`'"](?:apps|packages)\//u.test(normalized)) return true;
  if (
    /path\.(?:join|resolve)\s*\(/u.test(normalized) &&
    /[`'"](?:apps|packages)[`'"]/u.test(normalized)
  ) {
    return true;
  }
  return [...variables].some((name) =>
    new RegExp(`\\b${escapeRegExp(name)}\\b`, 'u').test(normalized),
  );
}

function readFileAliases(source) {
  const aliases = new Set(['readFileSync', 'readFile', 'readTextFile', 'Deno.readTextFile']);
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]node:fs['"]/gu)) {
    for (const item of match[1].split(',')) {
      const alias = item.trim().match(/^(readFileSync|readFile)\s*(?:as\s*([A-Za-z_$][\w$]*))?$/u);
      if (alias) aliases.add(alias[2] ?? alias[1]);
    }
  }
  return aliases;
}

function isReadExpression(expression, aliases) {
  return findReadCall(expression, aliases).index !== -1;
}

function findReadCall(expression, aliases) {
  const names = [...aliases].map(escapeRegExp).join('|');
  const pattern = new RegExp(
    `(?:\\b(?:${names})|\\b(?:fs|promises)\\.readFile(?:Sync)?)\\s*\\(`,
    'gu',
  );
  const match = [...expression.matchAll(pattern)].find(
    (candidate) => !isInsideStringLiteral(expression, candidate.index),
  );
  return { index: match?.index ?? -1, text: match?.[0] ?? '' };
}

function isInsideStringLiteral(source, index) {
  let quote;
  for (let offset = 0; offset < index; offset += 1) {
    const character = source[offset];
    if (character === '\\') {
      offset += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "'" || character === '"' || character === '`') {
      quote = character;
    }
  }
  return quote !== undefined;
}

function addValueDerivedCandidates(candidates, file, source, entry, values) {
  const valueUse = valuePattern(values);
  if (
    /(?:createSourceFile|getSourceFile|@babel\/parser|typescript\.createSourceFile|\bparse\s*\()/u.test(
      entry.text,
    )
  ) {
    addAll(candidates, file, source, entry, /(?:createSourceFile|getSourceFile|\bparse\s*\()/gu, {
      kind: 'ast-inspection',
      reason: 'inspects a production source AST or parser model',
    });
  }
  if (
    /(?:expect\s*\([^)]*|assert\s*\().*(?:toContain|toMatch|toEqual|toStrictEqual|includes)\s*\(/u.test(
      entry.text,
    )
  ) {
    addAll(
      candidates,
      file,
      source,
      entry,
      /(?:toContain|toMatch|toEqual|toStrictEqual|includes)\s*\(/gu,
      {
        kind: 'symbol-assertion',
        reason: 'pins a production symbol or source-text fragment',
      },
    );
  }
  if (/(?:createHash|digest\s*\(|toMatch(?:Inline)?Snapshot)/u.test(entry.text)) {
    addAll(
      candidates,
      file,
      source,
      entry,
      /(?:createHash|digest\s*\(|toMatch(?:Inline)?Snapshot)/gu,
      {
        kind: 'source-hash-or-snapshot',
        reason: 'pins a production source hash or snapshot',
      },
    );
  }
  if (/(?:split\(\s*['"]\\n['"]\s*\)\.length|lineCount|countLines)/u.test(entry.text)) {
    addAll(
      candidates,
      file,
      source,
      entry,
      /(?:split\(\s*['"]\\n['"]\s*\)\.length|lineCount|countLines)/gu,
      {
        kind: 'line-count',
        reason: 'pins a production source line count',
      },
    );
  }
  if (
    /(?:indexOf\s*\(|lastIndexOf\s*\(|findIndex\s*\().*(?:toBeLessThan|toBeGreaterThan)|(?:toBeLessThan|toBeGreaterThan).*?(?:indexOf|lastIndexOf|findIndex)/u.test(
      entry.text,
    )
  ) {
    addAll(candidates, file, source, entry, /(?:indexOf\s*\(|lastIndexOf\s*\(|findIndex\s*\()/gu, {
      kind: 'call-or-import-order',
      reason: 'pins production call or import order',
    });
  }
  if (
    /(?:migration|compatibility|compat|legacy|deprecated|fallback|shim|bridge|rollback)/iu.test(
      entry.text,
    ) &&
    valueUse.test(entry.text)
  ) {
    addAll(
      candidates,
      file,
      source,
      entry,
      /(?:migration|compatibility|compat|legacy|deprecated|fallback|shim|bridge|rollback)/giu,
      {
        kind: 'migration-or-compatibility-topology',
        reason: 'pins migration or compatibility implementation topology',
      },
    );
  }
}

function hasProductionTreeEvidence(text, productionPathVariables) {
  const treeCall =
    /(?:readdirSync|readdir\s*\(|glob\s*\(|fast-glob|ls-tree|(?:^|[;\s])find\s*\()/gu;
  return (
    [...text.matchAll(treeCall)].some((match) => !isInsideStringLiteral(text, match.index)) &&
    hasProductionPath(text, productionPathVariables)
  );
}

function addAll(candidates, file, source, entry, pattern, { kind, reason }) {
  let occurrence = 0;
  for (const match of entry.text.matchAll(pattern)) {
    occurrence += 1;
    candidates.push(
      candidate({
        file,
        source,
        index: entry.index + match.index,
        kind,
        detail: match[0],
        reason,
        occurrence,
      }),
    );
  }
}

function lineEntries(source, block) {
  const before = source.slice(0, block.start);
  const lineOffset = before.split('\n').length - 1;
  return source
    .slice(block.start, block.end)
    .split('\n')
    .map((text, index) => ({
      text,
      index:
        block.start +
        source.slice(block.start, block.end).split('\n').slice(0, index).join('\n').length +
        (index === 0 ? 0 : 1),
      line: lineOffset + index + 1,
    }));
}

function valuePattern(values) {
  return new RegExp(`\\b(?:${values.map(escapeRegExp).join('|')})\\b`, 'u');
}

function candidate({ file, source, index, kind, detail, reason, occurrence = 1 }) {
  const { line, column } = readLineColumn(source, index);
  const normalizedDetail = detail.trim().replaceAll(/\s+/gu, ' ');
  const digest = createHash('sha256')
    .update(`${file}\0${line}\0${column}\0${kind}\0${occurrence}\0${normalizedDetail}`)
    .digest('hex')
    .slice(0, 16);
  return {
    id: `test-structure-coupling-${digest}`,
    path: file,
    line,
    column,
    kind,
    reason,
  };
}

function readLineColumn(source, index) {
  const before = source.slice(0, index);
  const lastNewline = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: index - lastNewline };
}

function withChange(change) {
  return (candidate) => ({ ...candidate, change });
}

function readRegistry(input) {
  const source =
    input.mode === 'changed-range'
      ? tryGit(['show', `${input.head}:${registryPath}`])?.toString('utf8')
      : existsSync(registryPath)
        ? readFileSync(registryPath, 'utf8')
        : undefined;
  if (!source) return { entries: [], errors: [`registry is missing: ${registryPath}`] };
  const matches = [
    ...source.matchAll(/```test-structure-coupling-registry-v1\s*\n([\s\S]*?)\n```/gu),
  ];
  if (matches.length !== 1)
    return { entries: [], errors: ['registry must contain exactly one v1 metadata fence'] };
  try {
    const parsed = JSON.parse(matches[0][1]);
    return isPlainObject(parsed) && parsed.version === 1 && Array.isArray(parsed.entries)
      ? { entries: parsed.entries, errors: [] }
      : { entries: [], errors: ['registry metadata must be { version: 1, entries: [] }'] };
  } catch {
    return { entries: [], errors: ['registry metadata must contain valid JSON'] };
  }
}

function validateRegistry(registry, candidates) {
  const errors = [...registry.errors];
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seenIds = new Set();
  for (const entry of registry.entries) {
    if (!isPlainObject(entry)) {
      errors.push('registry entry must be an object');
      continue;
    }
    if (!hasMeaningfulText(entry.id)) {
      errors.push('registry entry requires id');
      continue;
    }
    if (seenIds.has(entry.id)) errors.push(`registry entry has duplicate id: ${entry.id}`);
    seenIds.add(entry.id);
    const candidate = byId.get(entry.id);
    if (!candidate) {
      errors.push(`registry entry is stale: ${entry.id}`);
      continue;
    }
    for (const field of ['path', 'line', 'column', 'kind']) {
      if (entry[field] !== candidate[field])
        errors.push(`registry entry ${entry.id} has stale ${field}`);
    }
    validateDisposition(errors, entry);
  }
  return errors.toSorted();
}

function validateDisposition(errors, entry) {
  if (!hasMeaningfulText(entry.rationale) || !hasMeaningfulText(entry.semanticCoverage)) {
    errors.push(
      `registry entry ${entry.id} requires non-placeholder rationale and semanticCoverage`,
    );
  }
  if (!hasMeaningfulText(entry.owner)) {
    errors.push(
      `${entry.disposition === 'durable-boundary' ? 'durable boundary' : 'temporary ratchet'} entry requires owner: ${entry.id}`,
    );
  }
  if (entry.disposition === 'durable-boundary') {
    if (!['public', 'security', 'compatibility'].includes(entry.boundary)) {
      errors.push(
        `durable boundary entry requires public, security, or compatibility boundary: ${entry.id}`,
      );
    }
  } else if (entry.disposition === 'temporary-ratchet') {
    if (!hasMeaningfulText(entry.removalCondition))
      errors.push(`temporary ratchet entry requires removalCondition: ${entry.id}`);
  } else {
    errors.push(`registry entry has unsupported disposition: ${entry.id}`);
  }
}

function printReport({ input, reportCandidates, registry }) {
  console.log(
    'WARN: test structure-coupling review is advisory; it identifies review evidence, not failures.',
  );
  console.log(`mode=${input.mode}`);
  if (input.mode === 'changed-range') {
    console.log(`base=${input.base}`);
    console.log(`head=${input.head}`);
  }
  const entriesById = new Map(
    registry.entries.filter(isPlainObject).map((entry) => [entry.id, entry]),
  );
  for (const item of reportCandidates) {
    console.log(
      `CANDIDATE ${item.id} | ${item.path}:${item.line}:${item.column} | ${item.kind} | ${item.reason} | ` +
        `change=${item.change ?? 'current'} | evidence=${evidenceStatus(entriesById.get(item.id))}`,
    );
  }
  if (reportCandidates.length === 0)
    console.log('PASS: no current structure-coupled test candidates');
  else
    console.log(
      `WARN: ${reportCandidates.length} reported candidates await individual human classification; this command does not create a baseline or grandfather findings.`,
    );
  if (input.mode === 'changed-range')
    console.log(
      'WARN: changed-range evidence does not block changed files while the inventory is reviewed.',
    );
}

function evidenceStatus(entry) {
  if (!isPlainObject(entry)) return 'unreviewed';
  if (entry.disposition === 'durable-boundary') return `durable-${entry.boundary}-boundary`;
  if (entry.disposition === 'temporary-ratchet') return 'temporary-ratchet';
  return 'invalid-registration';
}

function hasMeaningfulText(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return (
    text.length > 0 && !/^(?:tbd|todo|none|later|\.\.\.|-)|^\[[^\]]*\]$|^<[^>]*>$/iu.test(text)
  );
}

function isTestPath(file) {
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);
}

function compareCandidates(left, right) {
  return `${left.path}:${left.line}:${left.column}:${left.kind}:${left.id}`.localeCompare(
    `${right.path}:${right.line}:${right.column}:${right.kind}:${right.id}`,
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function runGit(args) {
  return runGitBuffer(args).toString('utf8');
}

function runGitBuffer(args) {
  const output = tryGit(args);
  if (!output) failUsage(`could not read Git evidence: git ${args.join(' ')}`);
  return output;
}

function tryGit(args) {
  try {
    return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

function failUsage(message) {
  console.log(`FAIL: ${message}`);
  process.exit(1);
}
