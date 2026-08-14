import path from 'node:path';

import { collectRepositoryStyleFacts } from '../repo-style-check/structural-facts.mjs';
import { isProductionAuthoredCodePath, readRepositoryFiles } from './repository-files.mjs';
import { readStructureExceptions } from './structure-exceptions.mjs';

export function resolveRepositoryStructureBase() {
  return 'origin/main';
}

export function checkRepositoryStructure(input) {
  const repository = readRepositoryFiles(input.repoRoot, input.base);
  const exceptionRegistry = readStructureExceptions(input.repoRoot);
  if (exceptionRegistry.issues.length > 0) {
    throw new Error(exceptionRegistry.issues.join('; '));
  }
  const targetDirectories = toCodeDirectories(repository.targetFiles);
  const baseDirectories = toCodeDirectories(repository.baseFiles);
  const findings = [
    ...collectSingletonFindings({
      repository,
      targetDirectories,
      baseDirectories,
      exceptions: exceptionRegistry.exceptions,
    }),
    ...collectRedundantChainFindings(targetDirectories, baseDirectories),
    ...collectChangedLayoutFindings(input.repoRoot, repository),
  ];
  return {
    mergeBase: repository.mergeBase,
    findings: uniqueFindings(findings).toSorted(compareFindings),
  };
}

function collectSingletonFindings(input) {
  const findings = [];
  const { repository, targetDirectories, baseDirectories, exceptions } = input;
  for (const [directory, descendants] of targetDirectories) {
    const topologyChanged = repository.changes.some(
      (change) =>
        (change.material || change.kind === 'D') &&
        [change.source, change.target]
          .filter(Boolean)
          .some((file) => file === directory || file.startsWith(`${directory}/`)),
    );
    const pathOnlyLineage = descendants.every((file) =>
      repository.changes.some(
        (change) => change.target === file && change.source !== undefined && !change.material,
      ),
    );
    if (
      descendants.length === 1 &&
      directory === path.posix.dirname(descendants[0]) &&
      ((!baseDirectories.has(directory) && !pathOnlyLineage) || topologyChanged)
    ) {
      const finding = {
        target: directory,
        ruleId: 'topology.singleton-subtree',
        message:
          `${baseDirectories.has(directory) ? 'Materially changed' : 'New'} authored-code ` +
          `subtree has one code descendant (${descendants[0]}). ` +
          'A README does not create another code responsibility.',
      };
      if (!isApprovedException(exceptions, finding, descendants[0])) {
        findings.push(finding);
      }
    }
  }
  return findings;
}

function collectRedundantChainFindings(targetDirectories, baseDirectories) {
  const findings = [];
  for (const [directory, descendants] of targetDirectories) {
    const directFiles = descendants.filter((file) => path.posix.dirname(file) === directory);
    const childDirectories = new Set(
      descendants
        .filter((file) => path.posix.dirname(file) !== directory)
        .map((file) => `${directory}/${file.slice(directory.length + 1).split('/')[0]}`),
    );
    const [childDirectory] = childDirectories;
    if (
      directFiles.length === 0 &&
      childDirectories.size === 1 &&
      (!baseDirectories.has(directory) || !baseDirectories.has(childDirectory))
    ) {
      findings.push({
        target: `${directory} -> ${childDirectory}`,
        ruleId: 'topology.redundant-chain',
        message:
          'Authored code passes through a directory with one code-bearing child and no direct ' +
          'code responsibility.',
      });
    }
  }
  return findings;
}

function collectChangedLayoutFindings(repoRoot, repository) {
  const affectedDirectories = new Set(
    repository.changes
      .filter((change) => change.material)
      .flatMap((change) => [change.source, change.target])
      .filter(Boolean)
      .filter(isProductionAuthoredCodePath)
      .map((file) => path.posix.dirname(file)),
  );
  const changedTargets = new Set(
    repository.changes.filter((change) => change.material).map((change) => change.target),
  );
  const sources = repository.targetFiles
    .filter(isProductionAuthoredCodePath)
    .filter((file) => /(?:\.d)?\.(?:ts|tsx|mts|cts|mjs)$/u.test(file))
    .filter((file) => affectedDirectories.has(path.posix.dirname(file)))
    .map((file) => ({ file: path.join(repoRoot, file), raw: repository.readTargetFile(file) }));
  return collectRepositoryStyleFacts({ repoRoot, sources })
    .filter((fact) => fact.ruleId !== 'file.length' || changedTargets.has(fact.target))
    .map((fact) => ({
      target: fact.target,
      ruleId: fact.ruleId,
      message: describeLayoutFact(fact),
    }));
}

function describeLayoutFact(fact) {
  if (fact.ruleId === 'layout.feature-prefix-cluster') {
    return `Changed directory contains ${fact.magnitude} source files sharing '${fact.identity}'.`;
  }
  if (fact.ruleId === 'layout.directory-density') {
    return `Changed directory contains ${fact.magnitude} source files.`;
  }
  return `Materially changed source has ${fact.magnitude} lines.`;
}

function isApprovedException(exceptions, finding, file) {
  return (
    isProductionAuthoredCodePath(file) &&
    exceptions.some(
      (exception) => exception.ruleId === finding.ruleId && exception.target === finding.target,
    )
  );
}

function toCodeDirectories(files) {
  const descendantsByDirectory = new Map();
  for (const file of files) {
    const root = file.split('/')[0];
    let directory = path.posix.dirname(file);
    while (directory !== '.' && directory !== root) {
      const descendants = descendantsByDirectory.get(directory) ?? [];
      descendants.push(file);
      descendantsByDirectory.set(directory, descendants);
      directory = path.posix.dirname(directory);
    }
  }
  return descendantsByDirectory;
}

function uniqueFindings(findings) {
  return [
    ...new Map(
      findings.map((finding) => [
        `${finding.target}\0${finding.ruleId}\0${finding.message}`,
        finding,
      ]),
    ).values(),
  ];
}

function compareFindings(left, right) {
  return Buffer.compare(
    Buffer.from(`${left.target}\0${left.ruleId}`),
    Buffer.from(`${right.target}\0${right.ruleId}`),
  );
}
