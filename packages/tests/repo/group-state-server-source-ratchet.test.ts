import { parse } from '@babel/parser';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanProductionSources } from '../../../scripts/repo-style-check/repository-scan.mjs';
import {
  expectedGroupStateTestTree,
  prBChangedTypeScriptOwners,
  readRuntimeCycles,
  reviewedPredecessorFunctionSizes,
  taskFiveReviewedPredecessorFunctionSizes,
  taskNineLayoutProductionOwners,
  taskSevenRepairProductionOwners,
  taskSevenRepairTestOwners,
} from './group-state-server-source-ratchet-inventory.ts';
import {
  readEveryFunctionSize,
  readNamedFunctionSizes,
} from './group-state-source-ratchet-function-sizes.ts';

const repoRoot = process.cwd();
const groupStateProductionRoot = path.join(
  repoRoot,
  'packages/shared-server/rallar-system/group-state',
);
const groupStateTestRoot = path.join(repoRoot, 'packages/tests/shared-server/group-state');

const expectedGroupStateProductionTree = [
  'group-mutation-authority.ts',
  'group-mutation-command.ts',
  'group-presence-mutation-command.ts',
  'group-state-service-contracts.ts',
  'group-state-service.ts',
  'group-state-validation-primitives.ts',
  'inbox/group-state-inbox-contracts.ts',
  'inbox/group-state-inbox-handler.ts',
  'inbox/group-state-inbox-result.ts',
  'inbox/to-group-mutation-descriptor.ts',
  'mutation/aggregate/compute-group-aggregate-mutation.ts',
  'mutation/aggregate/create-initial-group-mutation.ts',
  'mutation/aggregate/group-aggregate-mutation-policy.ts',
  'mutation/command-validation/group-mutation-request-validation.ts',
  'mutation/command-validation/validate-group-mutation-command.ts',
  'mutation/command-validation/validate-group-mutation-operation-input.ts',
  'mutation/group-mutation-contracts.ts',
  'mutation/group-mutation-result.ts',
  'mutation/group-state-crypto.ts',
  'mutation/membership/compute-group-membership-mutation.ts',
  'mutation/membership/group-membership-mutation-policy.ts',
  'mutation/membership/transition-group-member-lifecycle.ts',
  'mutation/orchestration/compute-group-mutation.ts',
  'mutation/orchestration/resolve-group-mutation-target.ts',
  'mutation/presence/compute-group-presence-admission.ts',
  'mutation/presence/compute-group-presence-mutation.ts',
  'mutation/read/read-group-mutation-related-entries.ts',
  'mutation/read/read-group-mutation.ts',
  'mutation/read/resolve-group-mutation-read-identities.ts',
  'mutation/result-validation/validate-computed-group-mutation-write.ts',
  'mutation/result-validation/validate-computed-group-mutation.ts',
  'mutation/result-validation/validate-group-mutation-result.ts',
  'mutation/state-validation/validate-computed-roster-facts.ts',
  'mutation/state-validation/validate-group-mutation-read.ts',
  'mutation/state-validation/validate-group-mutation.ts',
  'mutation/write/compute-group-membership-write.ts',
  'mutation/write/write-group-state-mutation.ts',
  'persistence/assemble-group-state-snapshot.ts',
  'persistence/group-aggregate-repository.ts',
  'persistence/group-membership-repository.ts',
  'persistence/group-presence-repository.ts',
  'persistence/group-state-persistence-codec.ts',
  'persistence/group-state-persistence-contracts.ts',
  'persistence/group-state-repository-reads.ts',
  'persistence/group-state-repository.ts',
  'persistence/group-state-runtime-namespaces.ts',
  'persistence/group-state-snapshot-repository.ts',
  'persistence/group-state-storage-keys.ts',
  'persistence/group-state-write-descriptors.ts',
  'persistence/read-exact-group-state-mutation.ts',
  'persistence/read-group-state-authority.ts',
  'persistence/validate-persisted-group-presence.ts',
  'persistence/validate-persisted-group.ts',
  'presence/compute-group-presence-summary.ts',
  'presence/decode-canonical-group-presence-summary-work.ts',
  'presence/group-expired-state-authority.ts',
  'presence/group-initial-presence-summary.ts',
  'presence/group-presence-service.ts',
  'presence/group-presence-session-cleanup-app-inbox-payload.ts',
  'presence/group-presence-summary-work.ts',
  'presence/group-session-cleanup.ts',
  'presence/reconcile-expired-group-presence.ts',
  'presence/validate-group-presence-summary-read-collections.ts',
  'snapshot/cached-group-state-service.ts',
  'snapshot/group-state-snapshot-read-through-cache.ts',
  'snapshot/validate-persisted-group-snapshot.ts',
] as const;

const taskSixProductionOwners = [
  'packages/shared-server/rallar-system/services/AppGroupInboxService.ts',
  'packages/shared-server/rallar-system/topology/inbox/topology-app-inbox-authority.ts',
  'packages/shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts',
  'packages/shared-server/rallar-system/topology/inbox/topology-app-inbox-contracts.ts',
  'packages/shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts',
  'packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-authority.ts',
  'packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts',
  'packages/shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-handler.ts',
] as const;

const taskSixTestOwners = [
  'packages/tests/shared-server/group-state-persistence-mutation-read-fixtures.ts',
  'packages/tests/shared-server/group-state-persistence-ownership.test.ts',
  'packages/tests/shared-server/mutation-routing-inventory.ts',
  'packages/tests/shared-server/mutation-routing-owner-inventory.ts',
  'packages/tests/shared-server/mutation-routing-reachability.ts',
  'packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts',
  'packages/tests/shared-server/authoritative-mutation-source-analysis.ts',
  'packages/tests/shared-server/topology-app-inbox-ownership.test.ts',
] as const;

const mechanicalRuleIds = new Set([
  'contract.optional-command',
  'factory.hidden-defaults',
  'factory.spacing',
  'file.length',
  'function.input-contract',
  'function.output-contract',
  'layout.filename-style',
  'layout.generic-filename',
  'layout.generic-route-init',
  'layout.primary-export-name',
  'layout.server-group-state-vocabulary',
  'line.width',
]);

describe('authoritative group-state server source ratchet', () => {
  it('keeps the exact production owner tree and the mirrored test tree', () => {
    expect(readRelativeFileTree(groupStateProductionRoot)).toEqual(
      expectedGroupStateProductionTree,
    );
    expect(readRelativeFileTree(groupStateTestRoot)).toEqual([...expectedGroupStateTestTree]);
    expect(taskSixProductionOwners.filter((filePath) => !existsSync(filePath))).toEqual([]);
    expect(taskSixTestOwners.filter((filePath) => !existsSync(filePath))).toEqual([]);
    expect(taskSevenRepairProductionOwners.filter((filePath) => !existsSync(filePath))).toEqual([]);
    expect(taskNineLayoutProductionOwners.filter((filePath) => !existsSync(filePath))).toEqual([]);
    expect(taskSevenRepairTestOwners.filter((filePath) => !existsSync(filePath))).toEqual([]);
  });

  it('keeps every ratcheted source within the mechanical code-standard tiers', () => {
    const productionFindings = scanProductionSources({
      repoRoot,
      sources: readProductionSources(),
      options: {
        constructionDetails: false,
        layoutDetails: true,
        layoutOnly: false,
        objectInterfaces: true,
        outputContracts: true,
      },
    }).findings.filter((finding) => mechanicalRuleIds.has(finding.ruleId));
    const testFindings = scanProductionSources({
      repoRoot,
      sources: readTestSources(),
      options: {
        constructionDetails: false,
        layoutDetails: false,
        layoutOnly: false,
        objectInterfaces: true,
        outputContracts: true,
      },
    }).findings.filter(
      (finding) =>
        !finding.ruleId.startsWith('layout.') &&
        finding.ruleId !== 'line.width' &&
        mechanicalRuleIds.has(finding.ruleId),
    );
    const findings = [...productionFindings, ...testFindings];
    const reviewedFindings = findings.filter(isReviewedMechanicalFinding);
    const unreviewedFindings = findings.filter((finding) => !isReviewedMechanicalFinding(finding));

    expect(
      unreviewedFindings.map((finding) => ({
        filePath: path.relative(repoRoot, finding.file),
        ruleId: finding.ruleId,
        message: finding.message,
      })),
    ).toEqual([]);
    expect(reviewedFindings).toHaveLength(3);
  });

  it('keeps every named general function within 60 physical lines', () => {
    const oversizedFunctions = readRatchetedSources()
      .flatMap(({ file, raw }) => readNamedFunctionSizes({ repoRoot, filePath: file, source: raw }))
      .filter(({ lines }) => lines > 60);

    expect(oversizedFunctions).toEqual(reviewedPredecessorFunctionSizes);
  });

  it('keeps every PR B changed module and function within physical-line limits', () => {
    expect(readPrBChangedTypeScriptOwners()).toEqual([...prBChangedTypeScriptOwners]);

    const sources = readSources(prBChangedTypeScriptOwners);
    const oversizedModules = sources
      .filter(({ raw }) => raw.trimEnd().split(/\r?\n/).length > 400)
      .map(({ file, raw }) => ({
        filePath: path.relative(repoRoot, file),
        lines: raw.trimEnd().split(/\r?\n/).length,
      }));
    const oversizedFunctions = sources
      .flatMap(({ file, raw }) => readEveryFunctionSize({ repoRoot, filePath: file, source: raw }))
      .filter(({ lines }) => lines > 60);

    expect(oversizedModules).toEqual([]);
    expect(oversizedFunctions).toEqual(taskFiveReviewedPredecessorFunctionSizes);
  });

  it('keeps imports first and runtime dependencies acyclic', () => {
    const sources = readRatchetedSources();
    const misplacedImports = sources
      .filter(({ raw }) => hasImportAfterDeclaration(raw))
      .map(({ file }) => path.relative(repoRoot, file));

    expect(misplacedImports).toEqual([]);
    expect(readRuntimeCycles({ repoRoot, sources })).toEqual([]);
  });

  it('normalizes managed-readiness failures without asserting Error values', () => {
    const source = readRepoSource(
      'packages/shared-test/black-box-runner/managed-api/api-v1-managed-api-readiness.mts',
    );

    expect(source).not.toContain('(error: Error) => settleUnexpectedManagedApiError');
    expect(source).not.toContain('error as Error');
    expect(source).not.toContain('as Error;');
  });

  it('delegates PostgreSQL evidence queries without a production query assertion', () => {
    const source = readRepoSource(
      'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-source.ts',
    );

    expect(source).not.toContain('as ApiV1StateWriteEvidenceQuery');
  });

  it('detects runtime re-export cycles and ignores type-only re-exports', () => {
    const fixtureRoot = path.join(repoRoot, 'packages/tests/repo/runtime-re-export-cycle');
    const firstPath = path.join(fixtureRoot, 'first.ts');
    const secondPath = path.join(fixtureRoot, 'second.ts');
    expect(
      readRuntimeCycles({
        repoRoot,
        sources: [
          { file: firstPath, raw: "export { secondValue } from './second.ts';" },
          { file: secondPath, raw: "export * from './first.ts';" },
        ],
      }),
    ).toEqual([
      'packages/tests/repo/runtime-re-export-cycle/first.ts -> ' +
        'packages/tests/repo/runtime-re-export-cycle/second.ts -> ' +
        'packages/tests/repo/runtime-re-export-cycle/first.ts',
      'packages/tests/repo/runtime-re-export-cycle/second.ts -> ' +
        'packages/tests/repo/runtime-re-export-cycle/first.ts -> ' +
        'packages/tests/repo/runtime-re-export-cycle/second.ts',
    ]);
    expect(
      readRuntimeCycles({
        repoRoot,
        sources: [
          { file: firstPath, raw: "export type { SecondType } from './second.ts';" },
          { file: secondPath, raw: "export type * from './first.ts';" },
        ],
      }),
    ).toEqual([]);
  });
});

function readRatchetedSources(): readonly { readonly file: string; readonly raw: string }[] {
  return [...readProductionSources(), ...readTestSources()];
}

function readProductionSources(): readonly { readonly file: string; readonly raw: string }[] {
  const relativePaths = [
    ...expectedGroupStateProductionTree.map((filePath) =>
      path.relative(repoRoot, path.join(groupStateProductionRoot, filePath)),
    ),
    ...taskSixProductionOwners,
    ...taskSevenRepairProductionOwners,
  ];

  return readSources(relativePaths);
}

function readTestSources(): readonly { readonly file: string; readonly raw: string }[] {
  const relativePaths = [
    ...readRelativeFileTree(groupStateTestRoot).map((filePath) =>
      path.relative(repoRoot, path.join(groupStateTestRoot, filePath)),
    ),
    ...taskSixTestOwners,
    ...taskSevenRepairTestOwners,
  ];

  return readSources(relativePaths);
}

function readSources(
  relativePaths: readonly string[],
): readonly { readonly file: string; readonly raw: string }[] {
  return relativePaths.map((filePath) => ({
    file: path.join(repoRoot, filePath),
    raw: readFileSync(path.join(repoRoot, filePath), 'utf8'),
  }));
}

function readRepoSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readPrBChangedTypeScriptOwners(): readonly string[] {
  const base = 'a7a5f488cd185a7f2cc6bd814c319f97d5401d03';
  const tracked = execFileSync('git', ['diff', '--name-only', base, '--', '*.ts', '*.mts'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const untracked = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', '*.ts', '*.mts'],
    { cwd: repoRoot, encoding: 'utf8' },
  );

  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean))].sort();
}

function readRelativeFileTree(directoryPath: string, prefix = ''): readonly string[] {
  return readdirSync(directoryPath, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.posix.join(prefix, entry.name);
      const absolutePath = path.join(directoryPath, entry.name);
      return entry.isDirectory()
        ? readRelativeFileTree(absolutePath, relativePath)
        : [relativePath];
    })
    .sort();
}

interface MechanicalFinding {
  readonly file: string;
  readonly ruleId: string;
  readonly message: string;
}
function isReviewedMechanicalFinding(finding: MechanicalFinding): boolean {
  const relativePath = path.relative(repoRoot, finding.file);
  if (
    relativePath ===
      'packages/shared-server/rallar-system/group-state/group-mutation-authority.ts' &&
    finding.ruleId === 'function.input-contract'
  ) {
    return true;
  }
  if (
    relativePath === 'packages/shared-server/rallar-system/services' &&
    finding.ruleId === 'layout.filename-style'
  ) {
    return true;
  }
  if (
    relativePath === 'packages/shared-server/rallar-system/services/AppAdminInboxService.ts' &&
    finding.ruleId === 'layout.primary-export-name'
  ) {
    return true;
  }
  if (
    relativePath ===
      'packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-derivation.ts' &&
    finding.ruleId === 'function.input-contract'
  ) {
    return true;
  }
  return false;
}

function hasImportAfterDeclaration(source: string): boolean {
  const syntaxTree = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const firstDeclaration = syntaxTree.program.body.findIndex(
    (statement) => statement.type !== 'ImportDeclaration',
  );
  return (
    firstDeclaration >= 0 &&
    syntaxTree.program.body
      .slice(firstDeclaration)
      .some((statement) => statement.type === 'ImportDeclaration')
  );
}
