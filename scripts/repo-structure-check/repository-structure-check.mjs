import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { isProductionAuthoredCodePath, readRepositoryFiles } from './repository-files.mjs';
import { readAdaptivePlans } from '../plan-adaptation/active-plan-registry.mjs';
import { validateAdaptivePlanRecord } from '../plan-adaptation/adaptive-plan-record.mjs';
import {
  computeAffectedCodeDigest,
  readChangedPaths,
} from '../plan-adaptation/plan-change-facts.mjs';
import { collectRepositoryStyleFacts } from '../repo-style-check/structural-facts.mjs';
import { validateCapabilityDeclarations } from './capability-declarations.mjs';
import { readStructureExceptions } from './structure-exceptions.mjs';
import {
  collectSemanticDepthFacts,
  validateStructuralDispositions,
} from './structural-dispositions.mjs';

export function resolveRepositoryStructureBase(repoRoot) {
  return readRequiredStructurePlan(repoRoot).record.facts.diffBase;
}

export function checkRepositoryStructure(input) {
  const activePlan = readRequiredStructurePlan(input.repoRoot);
  if (input.base !== activePlan.record.facts.diffBase) {
    throw new Error('repository structure base must match the active plan diffBase');
  }
  const repository = readRepositoryFiles(input.repoRoot, input.base);
  const affectedCodeDigest = computeAffectedCodeDigest(
    input.repoRoot,
    input.base,
    readChangedPaths(input.repoRoot, input.base),
  );
  const targetDirectories = toCodeDirectories(repository.targetFiles);
  const baseDirectories = toCodeDirectories(repository.baseFiles);
  const exceptionRegistry = readStructureExceptions(input.repoRoot);
  const findings = [
    ...exceptionRegistry.issues.map((message) => ({
      target: 'docs/repo-structure-exceptions.json',
      ruleId: 'exception.invalid',
      message,
    })),
    ...collectCapabilityFindings(input.repoRoot, activePlan, repository.targetFiles),
    ...collectSingletonFindings({
      repository,
      targetDirectories,
      baseDirectories,
      exceptions: exceptionRegistry.exceptions,
    }),
    ...collectRedundantChainFindings(targetDirectories, baseDirectories),
    ...collectDispositionFindings({
      repoRoot: input.repoRoot,
      repository,
      activePlan,
      affectedCodeDigest,
    }),
  ];

  return {
    mergeBase: repository.mergeBase,
    findings: findings.toSorted(compareFindings),
  };
}

function collectCapabilityFindings(repoRoot, activePlan, authoredFiles) {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return validateCapabilityDeclarations({
    repoRoot,
    capabilities: activePlan.record.capabilities,
    authoredFiles,
    packageScripts: packageJson.scripts ?? {},
    readFile: (file) => readRepositoryText(repoRoot, file),
    coldNavigationEvidence: activePlan.record.coldNavigationEvidence,
  }).map((message) => ({
    target: activePlan.planPath,
    ruleId: 'capability.declaration',
    message,
  }));
}

function collectSingletonFindings(input) {
  const findings = [];
  const { repository, targetDirectories, baseDirectories, exceptions } = input;
  for (const [directory, descendants] of targetDirectories) {
    const materiallyChanged = repository.changes.some(
      (change) =>
        change.material &&
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
      ((!baseDirectories.has(directory) && !pathOnlyLineage) || materiallyChanged)
    ) {
      const finding = {
        target: directory,
        ruleId: 'topology.singleton-subtree',
        message:
          `${baseDirectories.has(directory) ? 'Materially changed' : 'New'} authored-code ` +
          `subtree has one code descendant (${descendants[0]}). ` +
          'A README does not create another code responsibility.',
      };
      if (!isApprovedException(exceptions, finding, isProductionAuthoredCodePath(descendants[0]))) {
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

function collectDispositionFindings(input) {
  const { repoRoot, repository, activePlan, affectedCodeDigest } = input;
  const capabilities = activePlan.record.capabilities;
  const structuralFacts = [
    ...readChangedRepositoryStyleFacts(repoRoot, repository),
    ...collectSemanticDepthFacts({
      capabilities,
      authoredFiles: repository.targetFiles,
    }).filter((fact) => isFactOnMateriallyChangedSurface(fact, repository.changes)),
  ];
  const declaredDispositions = activePlan.record.structuralDispositions;
  return validateStructuralDispositions({
    facts: structuralFacts,
    affectedCodeDigest,
    declaredDispositions,
  }).map((message) => ({
    target: 'plans',
    ruleId: 'structure.disposition-required',
    message,
  }));
}

function readRequiredStructurePlan(repoRoot) {
  const plans = readAdaptivePlans(repoRoot);
  const schemaIssues = plans.flatMap(({ planPath, record }) =>
    validateAdaptivePlanRecord(record).map((issue) => `${planPath}: ${issue}`),
  );
  if (schemaIssues.length > 0) {
    throw new Error(`invalid adaptive plan record: ${schemaIssues.join('; ')}`);
  }
  const activePlans = plans.filter(({ record }) => record.status === 'active');
  if (activePlans.length !== 1) {
    throw new Error('repository structure requires exactly one active plan');
  }
  return activePlans[0];
}

function readChangedRepositoryStyleFacts(repoRoot, repository) {
  const affectedDirectories = new Set(
    repository.changes
      .filter((change) => change.material)
      .flatMap((change) => [change.source, change.target])
      .filter(Boolean)
      .filter(isProductionAuthoredCodePath)
      .map((file) => path.posix.dirname(file)),
  );
  const targetSources = repository.targetFiles
    .filter(isProductionAuthoredCodePath)
    .filter(isRepositoryStyleSource)
    .filter((file) => affectedDirectories.has(path.posix.dirname(file)))
    .map((file) => ({ file: path.join(repoRoot, file), raw: repository.readTargetFile(file) }));
  const materiallyChangedTargets = new Set(
    repository.changes.filter((change) => change.material).map((change) => change.target),
  );
  return collectRepositoryStyleFacts({ repoRoot, sources: targetSources }).filter((fact) => {
    if (fact.ruleId === 'file.length') {
      return materiallyChangedTargets.has(fact.target);
    }
    return true;
  });
}

const isRepositoryStyleSource = (file) => /(?:\.d)?\.(?:ts|tsx|mts|cts|mjs)$/u.test(file);

function isFactOnMateriallyChangedSurface(fact, changes) {
  return changes.some(
    (change) =>
      change.material &&
      [change.source, change.target]
        .filter(Boolean)
        .some((file) => file === fact.target || file.startsWith(`${fact.target}/`)),
  );
}

function readRepositoryText(repoRoot, file) {
  const absolutePath = path.join(repoRoot, file);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : undefined;
}

function isApprovedException(exceptions, finding, isProduction) {
  return (
    isProduction &&
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

function compareFindings(left, right) {
  return Buffer.compare(
    Buffer.from(`${left.target}\0${left.ruleId}`),
    Buffer.from(`${right.target}\0${right.ruleId}`),
  );
}
