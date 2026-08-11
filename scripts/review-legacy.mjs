#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  readReviewRecord,
  validateSuppliedEvidence,
} from './legacy-review/validate-supplied-evidence.mjs';

const vocabularyPattern =
  /(?:legacy|deprecated|compatibility|compat|fallback|shim|bridge|rollback)/iu;
const predecessorNamePattern = /(?:^|[-_])(old|new|legacy|previous|v\d+)(?:[-_]|$)/iu;
const modePattern =
  /(?:flag|mode|variant|version)\w*\s*(?:===|==|=|:)\s*['"](?:legacy|old|previous|v\d+)['"]/iu;
const exportTargetPattern = /\bexport\s*\{[^}]+\}\s*from\s*['"]([^'"]+)['"]/u;

const input = readInput(process.argv.slice(2));
const result = input.isExempt
  ? { ...input, changedFiles: [], candidates: [], exempt: true }
  : scanChangedProduction(input);

printReport(result);
const validationErrors = validateSuppliedEvidence(input, result.candidates);
if (validationErrors.length > 0) {
  for (const error of validationErrors) {
    console.log(`FAIL: ${error}`);
  }
  process.exitCode = 1;
} else if (input.reviewRecord) {
  console.log('PASS: supplied final review ledger disposes every reported candidate');
}

function readInput(args) {
  const [baseReference, headReference, ...optionArgs] = args;
  if (!baseReference || !headReference) {
    failUsage(
      'usage: npm run review:legacy -- <base> <head> ' +
        '[--review-record file] [--registry file] [--stage stage]',
    );
  }
  const options = readOptions(optionArgs);
  if (options.registry && !options['review-record']) {
    failUsage('--registry requires --review-record');
  }
  const base = resolveCommit(baseReference, 'base');
  const head = resolveCommit(headReference, 'head');
  const isExempt = readExemptScope(options['review-record']);
  return {
    base,
    head,
    mergeBase: runGit(['merge-base', base, head]).trim(),
    reviewRecord: options['review-record'],
    registry: options.registry,
    stage: options.stage,
    isExempt,
  };
}

function readExemptScope(reviewRecordPath) {
  if (!reviewRecordPath) return false;
  try {
    return readReviewRecord(readFileSync(reviewRecordPath, 'utf8'))?.scope === 'exempt';
  } catch {
    return false;
  }
}

function readOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith('--') || value === undefined) {
      failUsage('options must use --name value pairs');
    }
    const name = option.slice(2);
    if (!['review-record', 'registry', 'stage'].includes(name) || options[name] !== undefined) {
      failUsage(`unsupported or repeated option: ${option}`);
    }
    options[name] = value;
  }
  if (options.stage && !['initial', 'milestone', 'final'].includes(options.stage)) {
    failUsage('--stage must be initial, milestone, or final');
  }
  return options;
}

function resolveCommit(reference, name) {
  const output = tryGit(['rev-parse', '--verify', `${reference}^{commit}`]);
  if (!output) {
    failUsage(`${name} reference does not resolve to a commit: ${reference}`);
  }
  return output.toString('utf8').trim();
}

function scanChangedProduction(input) {
  const changes = readChanges(input.mergeBase, input.head);
  const changedFiles = changedProductionFiles(changes, input);
  const linesByPath = new Map(
    changedFiles.map((change) => [change.path, readRevisionLines(change.revision, change.path)]),
  );
  const candidates = [];

  for (const { path: file, kind } of changedFiles) {
    const lines = linesByPath.get(file) ?? [];
    if (vocabularyPattern.test(file) || predecessorNamePattern.test(path.basename(file))) {
      candidates.push(
        candidate({
          kind: 'legacy-path',
          path: file,
          line: 1,
          symbol: path.basename(file, path.extname(file)),
          reason: kind === 'D' ? 'removed predecessor or compatibility path' : 'predecessor path',
          detail: `${kind}:${file}`,
        }),
      );
    }
    for (const line of lines) {
      if (vocabularyPattern.test(line.text)) {
        candidates.push(
          candidate({
            kind: 'vocabulary',
            path: file,
            line: line.line,
            symbol: readSymbol(line.text),
            reason: 'compatibility vocabulary',
            detail: line.text.trim(),
          }),
        );
      }
    }
    for (const alias of readExportAliases(lines)) {
      if (alias) {
        candidates.push(
          candidate({
            kind: 'export-alias',
            path: file,
            line: alias.line,
            symbol: alias.symbol,
            reason: 'compatibility export alias',
            detail: alias.target,
          }),
        );
      }
    }
    for (const line of lines) {
      if (
        modePattern.test(line.text) ||
        /\b(?:old|legacy|previous)\w*(?:enabled|flag|mode)\b/iu.test(line.text)
      ) {
        candidates.push(
          candidate({
            kind: 'predecessor-mode',
            path: file,
            line: line.line,
            symbol: readSymbol(line.text),
            reason: 'feature flag or mode retaining a predecessor',
            detail: line.text.trim(),
          }),
        );
      }
    }
  }

  candidates.push(...parallelPathCandidates(changedFiles, linesByPath, input.head));
  candidates.push(...duplicateTargetCandidates(linesByPath));
  return {
    ...input,
    changedFiles: changedFiles.map((change) => change.path),
    candidates: deduplicateAndSort(candidates),
  };
}

function readChanges(mergeBase, head) {
  const fields = runGitBuffer([
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    '--find-copies',
    mergeBase,
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
    changes.push({ kind, source, target });
  }
  return changes;
}

function changedProductionFiles(changes, input) {
  const revisionsByPath = new Map();
  for (const change of changes) {
    for (const path of [change.source, change.target].filter(Boolean)) {
      if (!isChangedProductionFile(path)) continue;
      const revision = path === change.target ? input.head : input.mergeBase;
      revisionsByPath.set(`${revision}\0${path}`, { path, revision, kind: change.kind });
    }
  }
  return [...revisionsByPath.values()].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function isChangedProductionFile(file) {
  const normalized = file.replace(/\\/gu, '/');
  const isRuntime = normalized.startsWith('apps/') || normalized.startsWith('packages/');
  const isOperational =
    normalized.startsWith('scripts/deploy/') || normalized.startsWith('scripts/github-actions/');
  if (!isRuntime && !isOperational) {
    return false;
  }
  const pathParts = normalized.toLowerCase().split('/');
  if (
    pathParts.some((part) =>
      [
        'test',
        'tests',
        '__tests__',
        'fixture',
        'fixtures',
        'mock',
        'mocks',
        'stories',
        'generated',
      ].includes(part),
    )
  ) {
    return false;
  }
  const base = path.basename(normalized).toLowerCase();
  return (
    /\.(?:[cm]?[jt]sx?|mjs|cjs)$/iu.test(base) &&
    !/[\w-]+\.(?:test|spec|mock|fixture|stories)\.(?:d\.[cm]?ts|[cm]?ts|tsx|jsx|js)$/u.test(base)
  );
}

function readRevisionLines(revision, file) {
  const source = runGit(['show', `${revision}:${file}`]);
  return source.split('\n').map((text, index) => ({ line: index + 1, text }));
}

function parallelPathCandidates(changedFiles, linesByPath, head) {
  const pathsByFamily = new Map();
  for (const { path: file } of changedFiles) {
    const base = path.basename(file, path.extname(file));
    if (!predecessorNamePattern.test(base)) {
      continue;
    }
    const family = base.replace(/(?:^|[-_])(old|new|legacy|previous|v\d+)(?=[-_]|$)/giu, '');
    const familyKey = `${path.dirname(file)}\0${family}`;
    const paths = pathsByFamily.get(familyKey) ?? [];
    paths.push(file);
    pathsByFamily.set(familyKey, paths);
  }
  const candidates = [];
  for (const [familyKey, files] of pathsByFamily) {
    const directory = path.dirname(files[0]);
    const family = familyKey.split('\0')[1];
    const siblings = readTreePaths(head, directory).filter((candidatePath) => {
      const candidateFamily = path
        .basename(candidatePath, path.extname(candidatePath))
        .replace(/(?:^|[-_])(old|new|legacy|previous|v\d+)(?=[-_]|$)/giu, '');
      return (
        candidateFamily === family && predecessorNamePattern.test(path.basename(candidatePath))
      );
    });
    if (siblings.length < 2) {
      continue;
    }
    const sortedFiles = siblings.toSorted();
    const firstFile = sortedFiles[0];
    candidates.push(
      candidate({
        kind: 'parallel-path',
        path: firstFile,
        line: linesByPath.get(firstFile)?.[0]?.line ?? 1,
        symbol: family || path.basename(firstFile),
        reason: 'parallel old/new entry points',
        detail: sortedFiles.join(','),
      }),
    );
  }
  return candidates;
}

function duplicateTargetCandidates(linesByPath) {
  const pathsByTarget = new Map();
  for (const [file, lines] of linesByPath) {
    for (const { line, text } of lines) {
      const match = text.match(exportTargetPattern);
      if (!match) continue;
      const occurrences = pathsByTarget.get(match[1]) ?? [];
      occurrences.push({ file, line });
      pathsByTarget.set(match[1], occurrences);
    }
  }
  const candidates = [];
  for (const [target, occurrences] of pathsByTarget) {
    const uniqueFiles = [...new Set(occurrences.map(({ file }) => file))].toSorted();
    if (uniqueFiles.length < 2) {
      continue;
    }
    const first = occurrences.toSorted(compareOccurrence)[0];
    candidates.push(
      candidate({
        kind: 'duplicate-target',
        path: first.file,
        line: first.line,
        symbol: target,
        reason: 'duplicate adapter or route target',
        detail: uniqueFiles.join(','),
      }),
    );
  }
  return candidates;
}

function readExportAliases(lines) {
  const source = lines.map(({ text }) => text).join('\n');
  const aliases = [];
  const pattern = /\bexport\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const line = source.slice(0, match.index).split('\n').length;
    for (const alias of match[1].matchAll(/\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/gu)) {
      aliases.push({ line, symbol: alias[2], target: match[2] });
    }
  }
  return aliases;
}

function readTreePaths(revision, directory) {
  return runGitBuffer(['ls-tree', '-rz', '--name-only', revision, '--', directory])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter(isChangedProductionFile);
}

function candidate(input) {
  const identity = JSON.stringify({
    kind: input.kind,
    path: input.path,
    line: input.line,
    symbol: input.symbol,
    detail: input.detail,
  });
  const idHash = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return {
    id: `production-legacy-candidate-${idHash}`,
    ...input,
  };
}

function deduplicateAndSort(candidates) {
  const byId = new Map(candidates.map((item) => [item.id, item]));
  return [...byId.values()].toSorted((left, right) =>
    [left.path, left.line, left.reason, left.id]
      .join('\0')
      .localeCompare([right.path, right.line, right.reason, right.id].join('\0')),
  );
}

function readSymbol(line) {
  const match = line.match(/\b(?:const|let|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/u);
  return match?.[1] ?? 'unclassified-symbol';
}

function printReport(result) {
  console.log(`Legacy candidate review: ${result.mergeBase} -> ${result.head}`);
  console.log(
    'WARN: legacy candidate review is heuristic evidence. ' +
      'It does not approve retained legacy or judge legitimacy.',
  );
  console.log(
    'WARN: a clean scan does not prove the absence of production legacy; ' +
      'final review traces changed production call paths.',
  );
  if (result.exempt) {
    console.log('PASS: explicit PR-review exemption skips legacy candidate scanning');
    return;
  }
  if (result.candidates.length === 0) {
    console.log('PASS: no changed production legacy candidates');
    return;
  }
  console.log(
    `WARN: ${result.candidates.length} changed production legacy candidate(s) ` +
      'require human disposition:',
  );
  for (const item of result.candidates) {
    console.log(
      `CANDIDATE ${item.id} | ${item.path}:${item.line} | ${item.symbol} | ${item.reason}`,
    );
  }
  console.log(
    'WARN: copy every candidate into the final PR Human Review Record v1 ledger ' +
      'with exactly one disposition.',
  );
}

function compareOccurrence(left, right) {
  return `${left.file}\0${left.line}`.localeCompare(`${right.file}\0${right.line}`);
}

function runGit(args) {
  return runGitBuffer(args).toString('utf8');
}

function runGitBuffer(args) {
  const output = tryGit(args);
  if (!output) {
    failUsage(`could not read Git evidence: git ${args.join(' ')}`);
  }
  return output;
}

function tryGit(args) {
  try {
    return execFileSync('git', args);
  } catch {
    return undefined;
  }
}

function failUsage(message) {
  console.log(`FAIL: ${message}`);
  process.exit(1);
}
