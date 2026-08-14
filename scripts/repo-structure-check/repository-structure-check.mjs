import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { isProductionAuthoredCodePath, readRepositoryFiles } from './repository-files.mjs';
import {
  evaluateAdaptivePlanCatalogRecovery,
  readAdaptivePlanCatalog,
  readAdaptivePlanCatalogAtRevision,
} from '../plan-adaptation/adaptive-plan-catalog.mjs';
import { validateAdaptivePlanRecord } from '../plan-adaptation/adaptive-plan-record.mjs';
import { isPlannedCapability } from '../plan-adaptation/adaptive-plan-record.mjs';
// prettier-ignore
import { readAuthenticatedPlanTransitionChanges } from
  '../plan-adaptation/plan-transition-authentication.mjs';
import {
  computeAffectedCodeDigest,
  hasCurrentPlanFacts,
  readChangedPaths,
  selectPlanChanges,
} from '../plan-adaptation/plan-change-facts.mjs';
import { collectRepositoryStyleFacts } from '../repo-style-check/structural-facts.mjs';
import { validateCapabilityDeclarations } from './capability-declarations.mjs';
import {
  createRepositoryNavigationEvidence,
  readSafeRepositoryFile,
  selectNavigationCapability,
} from './navigation-evidence.mjs';
import { readStructureExceptions } from './structure-exceptions.mjs';
import {
  collectSemanticDepthFacts,
  validateStructuralDispositions,
} from './structural-dispositions.mjs';

export function resolveRepositoryStructureBase(repoRoot) {
  const activePlans = readValidatedStructureCatalog(repoRoot).activePlans;
  const bases = new Set(activePlans.map(({ record }) => record.facts.diffBase));
  return bases.size === 1 ? [...bases][0] : 'origin/main';
}

export function checkRepositoryStructure(input) {
  const catalog = readStructureCatalog(input.repoRoot);
  const activePlans = catalog.activePlans;
  const authenticatedChanges = authenticatePlanTransitions(input);
  if (catalog.issues.length > 0) {
    const recovery = evaluateAdaptivePlanCatalogRecovery({
      baseCatalog: readAdaptivePlanCatalogAtRevision(input.repoRoot, input.base),
      candidateCatalog: catalog,
      authenticatedDisposition: authenticatedChanges.authenticatedDispositions.length > 0,
      changedPaths: readChangedPaths(input.repoRoot, input.base)
        .flatMap((change) => [change.oldPath, change.path])
        .filter(Boolean),
    });
    if (recovery.allowed) {
      return { mergeBase: input.base, findings: [] };
    }
    throw new Error([...catalog.issues, ...recovery.issues].join('; '));
  }
  if (activePlans.length === 0) {
    const repository = readRepositoryFiles(input.repoRoot, input.base);
    return { mergeBase: repository.mergeBase, findings: [] };
  }
  const plannedRoots = activePlans
    .flatMap(({ record }) => record.capabilities)
    .filter(isPlannedCapability)
    .flatMap(toPlannedCapabilityRoots);
  const exceptionRegistry = readStructureExceptions(input.repoRoot);
  const findings = [
    ...exceptionRegistry.issues.map((message) => ({
      target: 'docs/repo-structure-exceptions.json',
      ruleId: 'exception.invalid',
      message,
    })),
  ];
  const mergeBases = new Set();
  for (const [planIndex, activePlan] of activePlans.entries()) {
    const base = activePlan.record.facts.diffBase;
    const repository = readRepositoryFiles(input.repoRoot, base);
    mergeBases.add(repository.mergeBase);
    const factChanges = selectPlanChanges({
      changes: readChangedPaths(input.repoRoot, base),
      catalog,
      planPath: activePlan.planPath,
    });
    const capabilityFindings = collectCapabilityFindings(input.repoRoot, activePlan, repository);
    if (capabilityFindings.length > 0) {
      findings.push(...capabilityFindings);
      continue;
    }
    const structureChanges =
      planIndex === 0
        ? selectPlanChanges({
            repoRoot: input.repoRoot,
            base,
            changes: readChangedPaths(input.repoRoot, base),
            catalog,
            planPath: activePlan.planPath,
            includeUnassigned: 'all',
          })
        : factChanges;
    const changedPaths = new Set(
      structureChanges.flatMap((change) => [change.oldPath, change.path]).filter(Boolean),
    );
    const targetFiles = repository.targetFiles.filter(
      (file) => !isUnderPlannedRoot(file, plannedRoots),
    );
    const baseFiles = repository.baseFiles.filter(
      (file) => !isUnderPlannedRoot(file, plannedRoots),
    );
    const changes = repository.changes
      .filter((change) =>
        [change.source, change.target].filter(Boolean).some((file) => changedPaths.has(file)),
      )
      .flatMap((change) => toActiveEndpointChanges(change, plannedRoots));
    const scopedRepository = { ...repository, baseFiles, changes, targetFiles };
    const targetDirectories = toCodeDirectories(targetFiles);
    const baseDirectories = toCodeDirectories(baseFiles);
    const affectedCodeDigest = computeAffectedCodeDigest({
      repoRoot: input.repoRoot,
      changes: factChanges,
      record: activePlan.record,
    });
    findings.push(
      ...collectSingletonFindings({
        repository: scopedRepository,
        targetDirectories,
        baseDirectories,
        exceptions: exceptionRegistry.exceptions,
      }),
      ...collectRedundantChainFindings(targetDirectories, baseDirectories),
      ...collectDispositionFindings({
        repoRoot: input.repoRoot,
        repository: scopedRepository,
        activePlan,
        affectedCodeDigest,
      }),
    );
  }

  return {
    mergeBase: mergeBases.size === 1 ? [...mergeBases][0] : 'plan-scoped',
    findings: uniqueFindings(findings).toSorted(compareFindings),
  };
}

export function readRepositoryNavigationEvidence(input) {
  const context = readNavigationStructurePlan(input.repoRoot, input.owner, input.planPath);
  const { activePlan, base, catalog } = context;
  const changes = selectPlanChanges({
    changes: readChangedPaths(input.repoRoot, base),
    catalog,
    planPath: activePlan.planPath,
  });
  const repository = readRepositoryFiles(input.repoRoot, base);
  const packageJson = JSON.parse(
    readSafeRepositoryFile(input.repoRoot, 'package.json', input.fileOperations),
  );
  const declarationIssues = validateCapabilityDeclarations({
    repoRoot: input.repoRoot,
    capabilities: activePlan.record.capabilities,
    authoredFiles: repository.targetFiles,
    repositoryFiles: repository.targetRepositoryFiles,
    packageScripts: packageJson.scripts ?? {},
    readFile: (file) => readSafeRepositoryFile(input.repoRoot, file, input.fileOperations),
    coldNavigationEvidence: activePlan.record.coldNavigationEvidence,
  });
  if (declarationIssues.length > 0) {
    throw new Error(
      'navigation evidence requires valid capability declarations: ' +
        declarationIssues.sort().join('; '),
    );
  }
  if (
    !hasCurrentPlanFacts({
      repoRoot: input.repoRoot,
      base,
      changes,
      record: activePlan.record,
      planPath: activePlan.planPath,
    })
  ) {
    throw new Error(`${activePlan.planPath} computed facts are stale`);
  }
  const capability = selectNavigationCapability(activePlan.record.capabilities, input.owner);
  const evidence = createRepositoryNavigationEvidence({
    repoRoot: input.repoRoot,
    capability,
    repositoryFiles: repository.targetRepositoryFiles,
    packageScripts: packageJson.scripts ?? {},
    affectedCodeDigest: activePlan.record.facts.affectedCodeDigest,
    fileOperations: input.fileOperations,
  });
  input.afterEvidenceComposed?.();
  const finalChanges = selectPlanChanges({
    changes: readChangedPaths(input.repoRoot, base),
    catalog,
    planPath: activePlan.planPath,
  });
  if (
    !hasCurrentPlanFacts({
      repoRoot: input.repoRoot,
      base,
      changes: finalChanges,
      record: activePlan.record,
      planPath: activePlan.planPath,
    })
  ) {
    throw new Error('computed facts changed while reading navigation evidence');
  }
  return evidence;
}

function collectCapabilityFindings(repoRoot, activePlan, repository) {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return validateCapabilityDeclarations({
    repoRoot,
    capabilities: activePlan.record.capabilities,
    authoredFiles: repository.targetFiles,
    repositoryFiles: repository.targetRepositoryFiles,
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
      capabilities: capabilities.filter((capability) => !isPlannedCapability(capability)),
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

function toPlannedCapabilityRoots(capability) {
  if (capability.kind === 'guidance') {
    const roots = [capability.contractTestRoot, capability.evaluationRoot];
    if (capability.guidanceRole !== 'router') {
      roots.push(capability.skillRoot);
    }
    return roots.filter(Boolean);
  }
  return [capability.root, capability.testRoot].filter(Boolean);
}

function isUnderPlannedRoot(file, plannedRoots) {
  return plannedRoots.some((root) => file === root || file.startsWith(`${root}/`));
}

function toActiveEndpointChanges(change, plannedRoots) {
  const sourcePlanned =
    change.source !== undefined && isUnderPlannedRoot(change.source, plannedRoots);
  const targetPlanned =
    change.target !== undefined && isUnderPlannedRoot(change.target, plannedRoots);
  if (sourcePlanned && targetPlanned) {
    return [];
  }
  if (sourcePlanned) {
    return [{ ...change, kind: 'A', source: undefined }];
  }
  if (targetPlanned) {
    return [{ ...change, kind: 'D', target: undefined }];
  }
  return [change];
}

function readNavigationStructurePlan(repoRoot, owner, requestedPlanPath) {
  const catalog = readValidatedStructureCatalog(repoRoot);
  const candidates = catalog.activePlans.filter(
    (plan) =>
      (requestedPlanPath === undefined || plan.planPath === requestedPlanPath) &&
      plan.record.capabilities.some(
        (capability) =>
          !isPlannedCapability(capability) &&
          capability.kind !== 'guidance' &&
          capability.owner === owner,
      ),
  );
  if (candidates.length === 0) {
    throw new Error(`navigation evidence owner ${owner} is not owned by an active plan`);
  }
  if (candidates.length > 1) {
    throw new Error(`navigation evidence owner ${owner} is ambiguous; supply --plan`);
  }
  const activePlan = candidates[0];
  return { activePlan, base: activePlan.record.facts.diffBase, catalog };
}

function readValidatedStructureCatalog(repoRoot) {
  const catalog = readStructureCatalog(repoRoot);
  if (catalog.issues.length > 0) throw new Error(catalog.issues.join('; '));
  return catalog;
}

function readStructureCatalog(repoRoot) {
  const catalog = readAdaptivePlanCatalog(repoRoot);
  const schemaIssues = catalog.plans.flatMap(({ planPath, record }) =>
    validateAdaptivePlanRecord(record).map((issue) => `${planPath}: ${issue}`),
  );
  if (schemaIssues.length > 0)
    throw new Error(`invalid adaptive plan record: ${schemaIssues.join('; ')}`);
  return catalog;
}

function authenticatePlanTransitions(input) {
  const changes = readChangedPaths(input.repoRoot, input.base);
  if (!changes.some((change) => /^plans\/.+\.md$/u.test(change.path))) {
    return { authenticatedDispositions: [], changes, issues: [] };
  }
  const closure = readAuthenticatedPlanTransitionChanges({
    repoRoot: input.repoRoot,
    base: input.base,
    changes,
    readDecisionAdmissionEvidence: input.readDecisionAdmissionEvidence,
  });
  if (closure.issues.length > 0) throw new Error(closure.issues.join('; '));
  const unauthenticatedDeletion = closure.changes.find(
    (change) => change.status.startsWith('D') && /^plans\/.+\.md$/u.test(change.path),
  );
  if (unauthenticatedDeletion)
    throw new Error(`${unauthenticatedDeletion.path} close-out is not authenticated`);
  return closure;
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
