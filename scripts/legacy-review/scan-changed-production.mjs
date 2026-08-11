import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { isNonProductionPath, isProductionCodeFile } from '../repo-style-check/repository-scan.mjs';
import { candidate, deduplicateAndSort } from './candidate-report.mjs';

const vocabularyPattern =
  /(?:legacy|deprecated|compatibility|compat|fallback|shim|bridge|rollback)/iu;
const predecessorNamePattern = /(?:^|[-_])(old|new|legacy|previous|v\d+)(?:[-_]|$)/iu;
const modePattern =
  /(?:flag|mode|variant|version)\w*\s*(?:===|==|=|:)\s*['"](?:legacy|old|previous|v\d+)['"]/iu;

export function scanChangedProduction(input) {
  const changes = readChanges(input.mergeBase, input.head);
  const changedFiles = changedProductionFiles(changes, input);
  const linesByPath = new Map(
    changedFiles.map((change) => [change.path, readRevisionLines(change.revision, change.path)]),
  );
  const candidates = [];

  for (const { path: file, kind } of changedFiles) {
    const lines = linesByPath.get(file) ?? [];
    addFileCandidates({ candidates, file, kind, lines });
  }

  candidates.push(...parallelPathCandidates(changedFiles, linesByPath, input.head));
  candidates.push(...duplicateTargetCandidates(linesByPath));
  return {
    ...input,
    changedFiles: changedFiles.map((change) => change.path),
    candidates: deduplicateAndSort(candidates),
  };
}

function addFileCandidates({ candidates, file, kind, lines }) {
  const source = lines.map(({ text }) => text).join('\n');
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
  addVocabularyCandidates({ candidates, file, lines });
  addSplitModeCandidate({ candidates, file, source });
  addExportAliasCandidates({ candidates, file, lines });
  addInlineModeCandidates({ candidates, file, lines });
}

function addVocabularyCandidates({ candidates, file, lines }) {
  for (const line of lines) {
    if (!vocabularyPattern.test(line.text)) {
      continue;
    }
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

function addSplitModeCandidate({ candidates, file, source }) {
  const splitPredecessorMode = new RegExp(
    '\\b(?:(?:old|legacy|previous)\\w*(?:enabled|flag|mode)?|' +
      '\\w*(?:flag|mode|variant|version)\\w*)\\s*:\\s*\\n\\s*' +
      '(?:true|[\'"](?:old|legacy|previous)[\'"])',
    'iu',
  );
  if (!splitPredecessorMode.test(source)) {
    return;
  }
  candidates.push(
    candidate({
      kind: 'predecessor-mode',
      path: file,
      line: 1,
      symbol: 'split-mode-declaration',
      reason: 'feature flag or mode retaining a predecessor',
      detail: 'split declaration',
    }),
  );
}

function addExportAliasCandidates({ candidates, file, lines }) {
  for (const alias of readExportAliases(lines)) {
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

function addInlineModeCandidates({ candidates, file, lines }) {
  for (const line of lines) {
    if (
      !modePattern.test(line.text) &&
      !/\b(?:old|legacy|previous)\w*(?:enabled|flag|mode)\b/iu.test(line.text)
    ) {
      continue;
    }
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
    for (const file of [change.source, change.target].filter(Boolean)) {
      if (!isChangedProductionFile(file)) continue;
      const revision = file === change.target ? input.head : input.mergeBase;
      revisionsByPath.set(`${revision}\0${file}`, { path: file, revision, kind: change.kind });
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
  if ((!isRuntime && !isOperational) || isNonProductionPath(normalized)) {
    return false;
  }
  const base = path.basename(normalized).toLowerCase();
  return (
    (isProductionCodeFile(normalized) || /\.(?:mjs|cjs|js)$/iu.test(base)) &&
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
    const files = pathsByFamily.get(familyKey) ?? [];
    files.push(file);
    pathsByFamily.set(familyKey, files);
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
    const source = lines.map(({ text }) => text).join('\n');
    for (const match of source.matchAll(/\bexport\s*\{[\s\S]*?\}\s*from\s*['"]([^'"]+)['"]/gu)) {
      const line = source.slice(0, match.index).split('\n').length;
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

function readSymbol(line) {
  const match = line.match(/\b(?:const|let|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/u);
  return match?.[1] ?? 'unclassified-symbol';
}

function compareOccurrence(left, right) {
  return `${left.file}\0${left.line}`.localeCompare(`${right.file}\0${right.line}`);
}

function runGit(args) {
  return runGitBuffer(args).toString('utf8');
}

function runGitBuffer(args) {
  try {
    return execFileSync('git', args);
  } catch {
    console.log(`FAIL: could not read Git evidence: git ${args.join(' ')}`);
    process.exit(1);
  }
}
