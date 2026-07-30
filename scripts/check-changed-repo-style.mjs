#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  collectProductionSources,
  isProductionCodeFile,
  scanProductionSources,
} from './repo-style-check/repository-scan.mjs';

const worktreeTarget = 'WORKTREE';
const [baseReference, targetReference = worktreeTarget] = process.argv.slice(2);

async function main() {
  if (baseReference === undefined) {
    failUsage('A base reference is required.');
    return;
  }

  const repoRoot = runGit(['rev-parse', '--show-toplevel']).trim();
  const baseCommit = resolveCommit(baseReference, 'base');
  if (baseCommit === undefined) {
    return;
  }
  const headCommit = runGit(['rev-parse', 'HEAD']).trim();
  const targetCommit =
    targetReference === worktreeTarget
      ? headCommit
      : resolveCommit(targetReference, 'target');
  if (targetCommit === undefined) {
    return;
  }
  if (targetReference !== worktreeTarget && targetCommit !== headCommit) {
    failUsage('The explicit target must resolve to the currently checked-out HEAD.');
    return;
  }

  const mergeBase = runGit(['merge-base', baseCommit, targetCommit]).trim();
  const changes = readChanges(mergeBase, targetReference, repoRoot);
  const targetSources = await collectProductionSources([repoRoot]);
  const governedTargetSources =
    targetReference === worktreeTarget
      ? targetSources
      : targetSources.filter((source) => isTrackedAtHead(repoRoot, source.file));
  const baseSources = toBaseSources({
    repoRoot,
    mergeBase,
    targetSources: governedTargetSources,
    changes,
  });
  const options = {
    layoutOnly: false,
    layoutDetails: true,
    outputContracts: true,
    objectInterfaces: true,
  };
  const baseFindings = scanProductionSources({ repoRoot, sources: baseSources, options }).findings;
  const targetFindings = scanProductionSources({
    repoRoot,
    sources: governedTargetSources,
    options,
  }).findings;
  const newFindings = subtractExistingFindings({
    repoRoot,
    baseFindings,
    targetFindings,
    renameByTargetPath: toRenameMap(changes),
  });

  if (newFindings.length === 0) {
    console.log(
      `PASS: no new repository style findings (${mergeBase} -> ${targetReference}).`,
    );
    return;
  }

  console.log(
    `FAIL: ${newFindings.length} new or worsened repository style finding` +
      `${newFindings.length === 1 ? '' : 's'} (${mergeBase} -> ${targetReference}):`,
  );
  for (const finding of newFindings) {
    console.log(`${toRelativePath(repoRoot, finding.file)} [${finding.ruleId}]`);
    console.log(`  ${finding.message}`);
  }
  process.exitCode = 1;
}

function readChanges(mergeBase, targetReference, repoRoot) {
  const args = ['diff', '--name-status', '--find-renames', mergeBase];
  if (targetReference !== worktreeTarget) {
    args.push(targetReference);
  }
  const changes = parseNameStatus(runGit(args));
  if (targetReference === worktreeTarget) {
    const untracked = runGit(['ls-files', '--others', '--exclude-standard'])
      .split('\n')
      .filter(Boolean);
    changes.push(...untracked.map((file) => ({ kind: 'A', source: undefined, target: file })));
  }
  return changes.filter((change) =>
    [change.source, change.target]
      .filter(Boolean)
      .some((file) => isProductionCodeFile(path.join(repoRoot, file))),
  );
}

function parseNameStatus(source) {
  return source
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, firstPath, secondPath] = line.split('\t');
      const kind = status[0];
      if (kind === 'R' || kind === 'C') {
        return { kind, source: firstPath, target: secondPath };
      }
      return {
        kind,
        source: kind === 'A' ? undefined : firstPath,
        target: kind === 'D' ? undefined : firstPath,
      };
    });
}

function toBaseSources(input) {
  const sourceByPath = new Map(
    input.targetSources.map((source) => [toRelativePath(input.repoRoot, source.file), source]),
  );
  for (const change of input.changes) {
    if (change.target !== undefined && change.kind !== 'M' && change.kind !== 'T') {
      sourceByPath.delete(change.target);
    }
    if (change.source === undefined) {
      continue;
    }
    const baseSource = readRevisionFile(input.mergeBase, change.source);
    if (
      baseSource !== undefined &&
      isProductionCodeFile(path.join(input.repoRoot, change.source))
    ) {
      sourceByPath.set(change.source, {
        file: path.join(input.repoRoot, change.source),
        raw: baseSource,
      });
    }
  }
  return [...sourceByPath.values()].sort((left, right) => left.file.localeCompare(right.file));
}

function subtractExistingFindings(input) {
  const baseCounts = countByKey(
    input.baseFindings.map((finding) => findingKey(input.repoRoot, finding, new Map())),
  );
  const newFindings = [];
  for (const finding of input.targetFindings) {
    const renameMap = finding.ruleId.startsWith('layout.')
      ? new Map()
      : input.renameByTargetPath;
    const key = findingKey(input.repoRoot, finding, renameMap);
    const remaining = baseCounts.get(key) ?? 0;
    if (remaining > 0) {
      baseCounts.set(key, remaining - 1);
    } else {
      newFindings.push(finding);
    }
  }
  return newFindings;
}

function findingKey(repoRoot, finding, renameByTargetPath) {
  const targetPath = toRelativePath(repoRoot, finding.file);
  const logicalPath = renameByTargetPath.get(targetPath) ?? targetPath;
  return [logicalPath, finding.ruleId, normalizeMessage(finding.message)].join('\0');
}

function normalizeMessage(message) {
  return message
    .replace(/from line \d+ to \d+/giu, 'from line <n> to <n>')
    .replace(/starting line \d+/giu, 'starting line <n>')
    .replace(/at line \d+/giu, 'at line <n>')
    .replace(/Line \d+ exceeds/gu, 'Line <n> exceeds');
}

function countByKey(keys) {
  const counts = new Map();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function toRenameMap(changes) {
  return new Map(
    changes
      .filter((change) => change.kind === 'R')
      .map((change) => [change.target, change.source]),
  );
}

function isTrackedAtHead(repoRoot, file) {
  const relativePath = toRelativePath(repoRoot, file);
  return runGitResult(['cat-file', '-e', `HEAD:${relativePath}`]).status === 0;
}

function readRevisionFile(revision, file) {
  const result = runGitResult(['show', `${revision}:${file}`]);
  return result.status === 0 ? result.stdout : undefined;
}

function resolveCommit(reference, role) {
  const result = runGitResult(['rev-parse', '--verify', `${reference}^{commit}`]);
  if (result.status === 0) {
    return result.stdout.trim();
  }
  console.error(`Could not resolve ${role} reference: ${reference}`);
  process.exitCode = 2;
  return undefined;
}

function runGit(args) {
  const result = runGitResult(args);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function runGitResult(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function toRelativePath(repoRoot, file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

function failUsage(message) {
  console.error(message);
  console.error(
    'Usage: node scripts/check-changed-repo-style.mjs <base-ref> [HEAD|WORKTREE]',
  );
  process.exitCode = 2;
}

main().catch((error) => {
  console.error('changed repository style check failed:', error.message);
  process.exitCode = 2;
});
