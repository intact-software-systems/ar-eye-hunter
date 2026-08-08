import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as diagnosticValidation from './auth-server-touched-typescript-diagnostics-validation.ts';
import {
  readDiagnosticRegressions,
  readTouchedTypeScriptDiagnostics,
  type TypeScriptDiagnostic,
} from './auth-server-touched-typescript-diagnostics-validation.ts';

const validationPath =
  'packages/tests/repo/auth-server-touched-typescript-diagnostics-validation.ts';
const authPrCBaseCommit = '8152de39faf2d630158143366596d61346e20457';
const authPrCMergedCommit = 'eb0c58c9ffbeb290dafa5cfaba6e5a005b2418b2';
const acceptedDisposition = 'accepted inherited debt';
const scannerPath = '<repo>/scripts/repo-style-check/repository-scan.mjs';
const scannerDiagnosticMessage =
  `Could not find a declaration file for module '${scannerPath}'. ` +
  `'${scannerPath}' implicitly has an 'any' type.`;
const clientStateModule = '"@shared-server/rallar-system/client-state/client-state-service.ts"';
const missingClientMutationMessage =
  `Module '${clientStateModule}' has no exported member ` + "'ClientMutationWritten'.";
const missingClientStateMessage =
  `Module '${clientStateModule}' has no exported member ` + "'ClientStateWritten'.";
const missingClientStateServiceMessage =
  `'${clientStateModule}' has no exported member named 'ClientStateService'. ` +
  "Did you mean 'createClientStateService'?";
const layoutRulesPath = '<repo>/scripts/repo-style-check/layout-rules.mjs';
const layoutRulesDiagnosticMessage =
  `Could not find a declaration file for module '${layoutRulesPath}'. ` +
  `'${layoutRulesPath}' implicitly has an 'any' type.`;
const implicitFindingMessage = "Parameter 'finding' implicitly has an 'any' type.";
const implicitItemMessage = "Parameter 'item' implicitly has an 'any' type.";
const ratchetOwner = 'it:keeps every ratcheted source within the mechanical code-standard tiers';
const ratchetPath = 'packages/tests/repo/group-state-server-source-ratchet.test.ts';
const layoutRulesTestPath = 'packages/tests/repo/repo-style-layout-rules.test.ts';
const untypedScannerRationale =
  'Repo-style governance consumes the untyped JavaScript scanner findings.';
const untypedScannerRemoval = 'Remove when the scanner publishes a checked declaration.';
const inheritedDiagnosticLedger = [
  disposition({
    column: 39,
    code: 7016,
    message: scannerDiagnosticMessage,
    ownerRelativeLine: 5,
    path: 'packages/tests/repo/auth-server-shell-lineage-validation.ts',
    responsibility: 'Auth shell-lineage governance consumes the repository source scanner.',
    rationale: 'The JavaScript scanner has no TypeScript declaration in the exact PR C base.',
    removalCondition: 'Remove when the scanner publishes a checked declaration or typed entry.',
  }),
  untypedScannerDisposition({
    column: 25,
    code: 7006,
    message: implicitFindingMessage,
    owner: ratchetOwner,
    ownerRelativeLine: 11,
    path: ratchetPath,
    responsibility: 'The group-state ratchet filters untyped scanner findings by tier.',
  }),
  untypedScannerDisposition({
    column: 8,
    code: 7006,
    message: implicitFindingMessage,
    owner: ratchetOwner,
    ownerRelativeLine: 23,
    path: ratchetPath,
    responsibility: 'The group-state ratchet reports untyped scanner findings on failure.',
  }),
  untypedScannerDisposition({
    column: 39,
    code: 7016,
    message: scannerDiagnosticMessage,
    ownerRelativeLine: 6,
    path: ratchetPath,
    responsibility: 'The group-state ratchet consumes the repository source scanner.',
  }),
  untypedScannerDisposition({
    column: 34,
    code: 7006,
    message: implicitFindingMessage,
    owner: 'details',
    ownerRelativeLine: 2,
    path: layoutRulesTestPath,
    responsibility: 'details renders untyped layout-rule findings for assertion messages.',
  }),
  untypedScannerDisposition({
    column: 27,
    code: 7006,
    message: implicitFindingMessage,
    owner: 'findingsFor',
    ownerRelativeLine: 1,
    path: layoutRulesTestPath,
    responsibility: 'findingsFor selects untyped layout-rule findings by rule name.',
  }),
  untypedScannerDisposition({
    column: 26,
    code: 7006,
    message: implicitItemMessage,
    owner: 'it:recognizes all server group-state module criteria and whole identifier tokens',
    ownerRelativeLine: 17,
    path: layoutRulesTestPath,
    responsibility: 'The module-criteria case maps untyped scanner cluster members.',
  }),
  untypedScannerDisposition({
    column: 28,
    code: 7006,
    message: implicitItemMessage,
    owner: 'it:reproduces the 22-cluster planning count deterministically',
    ownerRelativeLine: 4,
    path: layoutRulesTestPath,
    responsibility: 'The cluster-count case filters untyped scanner cluster members.',
  }),
  untypedScannerDisposition({
    column: 34,
    code: 7006,
    message: implicitItemMessage,
    owner: 'it:reproduces the 22-cluster planning count deterministically',
    ownerRelativeLine: 5,
    path: layoutRulesTestPath,
    responsibility: 'The cluster-count case maps untyped scanner cluster members.',
  }),
  untypedScannerDisposition({
    column: 60,
    code: 7006,
    message: implicitItemMessage,
    owner: 'it:sorts findings by code units across punctuation and non-ASCII paths',
    ownerRelativeLine: 4,
    path: layoutRulesTestPath,
    responsibility: 'The ordering case projects untyped scanner findings to paths.',
  }),
  untypedScannerDisposition({
    column: 8,
    code: 7016,
    message: layoutRulesDiagnosticMessage,
    ownerRelativeLine: 8,
    path: layoutRulesTestPath,
    responsibility: 'Layout-rule governance consumes the JavaScript layout-rule module.',
  }),
  disposition({
    column: 8,
    code: 2305,
    message: missingClientMutationMessage,
    ownerRelativeLine: 23,
    path: 'packages/tests/shared-server/client-state/app-client-inbox-authorised-ws.test.ts',
    responsibility: 'The authorised WebSocket fixture models a client mutation result.',
    rationale: 'The touched fixture inherits a stale test-only type name absent from the export.',
    removalCondition: 'Remove when the fixture uses the canonical mutation-written contract.',
  }),
  disposition({
    column: 8,
    code: 2305,
    message: missingClientStateMessage,
    ownerRelativeLine: 24,
    path: 'packages/tests/shared-server/client-state/app-client-inbox-authorised-ws.test.ts',
    responsibility: 'The authorised WebSocket fixture models persisted client state.',
    rationale: 'The touched fixture inherits a stale test-only type name absent from the export.',
    removalCondition: 'Remove when the fixture uses the canonical client-state write contract.',
  }),
  disposition({
    column: 8,
    code: 7006,
    message: "Parameter 'error' implicitly has an 'any' type.",
    owner: 'requireClientMutationWritten',
    ownerRelativeLine: 5,
    path: 'packages/tests/shared-server/client-state/app-client-inbox-authorised-ws.test.ts',
    responsibility: 'requireClientMutationWritten narrows the fixture failure branch.',
    rationale: 'The missing mutation-written export prevents contextual typing of this callback.',
    removalCondition: 'Remove when the canonical mutation-written contract types the callback.',
  }),
  disposition({
    column: 8,
    code: 7006,
    message: "Parameter 'value' implicitly has an 'any' type.",
    owner: 'requireClientMutationWritten',
    ownerRelativeLine: 8,
    path: 'packages/tests/shared-server/client-state/app-client-inbox-authorised-ws.test.ts',
    responsibility: 'requireClientMutationWritten narrows the fixture success branch.',
    rationale: 'The missing mutation-written export prevents contextual typing of this callback.',
    removalCondition: 'Remove when the canonical mutation-written contract types the callback.',
  }),
  disposition({
    column: 8,
    code: 2305,
    message: missingClientStateMessage,
    ownerRelativeLine: 11,
    path: 'packages/tests/shared-server/client-state/app-client-inbox-expiry.test.ts',
    responsibility: 'The expiry fixture models the client-state write result.',
    rationale: 'The touched fixture inherits a stale test-only type name absent from the export.',
    removalCondition: 'Remove when the fixture uses the canonical client-state write contract.',
  }),
  disposition({
    column: 8,
    code: 2724,
    message: missingClientStateServiceMessage,
    ownerRelativeLine: 10,
    path: 'packages/tests/shared-server/client-state/app-client-inbox-expiry.test.ts',
    responsibility: 'The expiry fixture types its client-state service dependency.',
    rationale: 'The touched fixture inherits a stale service type name absent from the export.',
    removalCondition: 'Remove when the fixture uses the canonical service capability type.',
  }),
] as const;

it('requires exact base-to-head diagnostics for every touched test path', () => {
  expect(existsSync(path.join(process.cwd(), validationPath)), validationPath).toBe(true);
});

it('keeps the broad tests compiler honestly red without new or worsened diagnostics', () => {
  const evidence = readTouchedTypeScriptDiagnostics();
  const dispositionEvidence = evidence as typeof evidence & {
    readonly inheritedDiagnosticLedger?: readonly DiagnosticDisposition[];
    readonly diagnosticDispositionViolations?: readonly string[];
  };

  expect(evidence.baseSha).toBe('8152de39faf2d630158143366596d61346e20457');
  expect(evidence.baseStatus).not.toBe(0);
  expect(evidence.headStatus).not.toBe(0);
  expect(evidence.touchedPaths).toHaveLength(evidence.pathEvidence.length);
  expect(evidence.baseDiagnostics).toHaveLength(28);
  expect(evidence.headDiagnostics).toHaveLength(17);
  expect(readDiagnosticRegressions(evidence.baseDiagnostics, evidence.headDiagnostics)).toEqual([]);
  expect(dispositionEvidence.inheritedDiagnosticLedger).toEqual(inheritedDiagnosticLedger);
  expect(dispositionEvidence.diagnosticDispositionViolations).toEqual([]);
}, 30_000);

it('freezes the auth diagnostic cohort at the merged PR C test range', () => {
  const evidence = readTouchedTypeScriptDiagnostics();

  expect(evidence.touchedPaths).toEqual(readAuthPrCTouchedTypeScriptPaths());
  expect(evidence.touchedPaths).not.toContain(
    'packages/tests/shared-server/rest-state-snapshot-read-selectors.test.ts',
  );
}, 30_000);

it('excludes an unrelated untracked test from the auth diagnostic cohort', () => {
  withTemporaryAuthDiagnosticProbe((unrelatedPath) => {
    expect(readTouchedTypeScriptDiagnostics().touchedPaths).not.toContain(unrelatedPath);
  });
}, 30_000);

it('keeps existing untracked files intact while creating a diagnostic cohort probe', () => {
  const protectedDirectory = mkdtempSync(
    path.join(process.cwd(), 'packages/tests/repo/.auth-diagnostic-cohort-protected-'),
  );
  const protectedPath = path.join(protectedDirectory, 'pre-existing-untracked-test.ts');
  writeFileSync(protectedPath, 'export const preserved = true;\n');

  try {
    const probePaths = [
      withTemporaryAuthDiagnosticProbe((unrelatedPath) => unrelatedPath),
      withTemporaryAuthDiagnosticProbe((unrelatedPath) => unrelatedPath),
    ];

    expect(new Set(probePaths)).toHaveLength(2);
    expect(readFileSync(protectedPath, 'utf8')).toBe('export const preserved = true;\n');
  } finally {
    rmSync(protectedDirectory, { force: true, recursive: true });
  }
});

describe('inherited diagnostic disposition ledger fixtures', () => {
  const diagnostics = inheritedDiagnosticLedger.map(toDiagnostic);

  it('accepts only the exact candidate diagnostic multiset and complete ledger', () => {
    expect(readDispositionViolations(diagnostics, inheritedDiagnosticLedger)).toEqual([]);
  });

  it.each([
    { label: 'unexpected diagnostic', diagnostics: [...diagnostics, diagnostic({ code: 9999 })] },
    { label: 'missing diagnostic', diagnostics: diagnostics.slice(1) },
    { label: 'changed owner', diagnostics: replaceDiagnostic(diagnostics, 0, { owner: 'other' }) },
    {
      label: 'changed message',
      diagnostics: replaceDiagnostic(diagnostics, 0, { message: 'changed diagnostic' }),
    },
    { label: 'duplicate drift', diagnostics: [...diagnostics, diagnostics[0]] },
  ])('rejects $label', ({ diagnostics: changed }) => {
    expect(readDispositionViolations(changed, inheritedDiagnosticLedger)).not.toEqual([]);
  });

  it('rejects an absent or wrong disposition', () => {
    const { disposition: omitted, ...withoutDisposition } = inheritedDiagnosticLedger[0];
    const absent = [withoutDisposition, ...inheritedDiagnosticLedger.slice(1)];
    const wrong = [
      { ...inheritedDiagnosticLedger[0], disposition: 'temporary waiver' },
      ...inheritedDiagnosticLedger.slice(1),
    ];

    expect(omitted).toBe(acceptedDisposition);
    expect(readDispositionViolations(diagnostics, absent)).not.toEqual([]);
    expect(readDispositionViolations(diagnostics, wrong)).not.toEqual([]);
  });

  it.each(['path', 'code', 'message', 'owner', 'ownerRelativeLine', 'column'] as const)(
    'reports an absent %s identity field',
    (field) => {
      const { [field]: omitted, ...incomplete } = inheritedDiagnosticLedger[0];
      const ledger = [incomplete, ...inheritedDiagnosticLedger.slice(1)];

      expect(omitted).toBeDefined();
      expect(readDispositionViolations(diagnostics, ledger)).toContain(`ledger[0]:${field}`);
    },
  );
});

describe('diagnostic multiset fixtures', () => {
  const inherited = diagnostic({ owner: 'it:keeps inherited behavior' });

  it('accepts improvements and exact inherited duplicates', () => {
    expect(readDiagnosticRegressions([inherited, inherited], [inherited])).toEqual([]);
    expect(readDiagnosticRegressions([inherited, inherited], [inherited, inherited])).toEqual([]);
  });

  it.each([
    diagnostic({ code: 9999 }),
    diagnostic({ message: 'changed diagnostic' }),
    diagnostic({ owner: 'it:moved diagnostic' }),
    diagnostic({ path: 'packages/tests/shared-server/other.test.ts' }),
  ])('rejects a new or changed $code diagnostic identity', (changed) => {
    expect(readDiagnosticRegressions([inherited], [changed])).toEqual([changed]);
  });

  it.each([
    { label: 'owner-relative line', replacement: { ownerRelativeLine: 4 } },
    { label: 'column', replacement: { column: 12 } },
  ])('rejects same-owner relocation by $label', ({ replacement }) => {
    const changed = diagnostic({ owner: inherited.owner, ...replacement });

    expect(readDiagnosticRegressions([inherited], [changed])).toEqual([changed]);
  });

  it('rejects a worsened duplicate count', () => {
    expect(readDiagnosticRegressions([inherited], [inherited, inherited])).toEqual([inherited]);
  });
});

interface LocatedDiagnostic extends TypeScriptDiagnostic {
  readonly column: number;
  readonly ownerRelativeLine: number;
}

function diagnostic(overrides: Partial<LocatedDiagnostic> = {}): LocatedDiagnostic {
  return {
    column: 8,
    code: 2305,
    message: "Module 'fixture' has no exported member 'Value'.",
    owner: '<module>',
    ownerRelativeLine: 3,
    path: 'packages/tests/shared-server/fixture.test.ts',
    ...overrides,
  };
}

function readAuthPrCTouchedTypeScriptPaths(): readonly string[] {
  const paths = execFileSync(
    'git',
    [
      'diff',
      '--name-only',
      '--diff-filter=ACMRD',
      authPrCBaseCommit,
      authPrCMergedCommit,
      '--',
      'packages/tests',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  )
    .split(/\r?\n/u)
    .filter((filePath) => /\.(?:[cm]?ts|tsx)$/u.test(filePath));

  return [...new Set(paths)].sort();
}

function withTemporaryAuthDiagnosticProbe<T>(
  operation: (unrelatedPath: string) => T,
): T {
  const repoRoot = process.cwd();
  const probeDirectory = mkdtempSync(
    path.join(repoRoot, 'packages/tests/repo/.auth-diagnostic-cohort-'),
  );
  const unrelatedPath = path.relative(
    repoRoot,
    path.join(probeDirectory, 'unrelated-later-test.ts'),
  );
  writeFileSync(path.join(repoRoot, unrelatedPath), 'export {};\n');

  try {
    return operation(unrelatedPath);
  } finally {
    rmSync(probeDirectory, { force: true, recursive: true });
  }
}

interface DiagnosticDisposition extends LocatedDiagnostic {
  readonly disposition: string;
  readonly responsibility: string;
  readonly rationale: string;
  readonly removalCondition: string;
}

function disposition(overrides: Partial<DiagnosticDisposition>): DiagnosticDisposition {
  return {
    ...diagnostic(),
    disposition: acceptedDisposition,
    responsibility: 'Fixture owner.',
    rationale: 'Fixture inherited debt.',
    removalCondition: 'Remove when the fixture is typed.',
    ...overrides,
  };
}

function untypedScannerDisposition(
  overrides: Partial<DiagnosticDisposition>,
): DiagnosticDisposition {
  return disposition({
    rationale: untypedScannerRationale,
    removalCondition: untypedScannerRemoval,
    ...overrides,
  });
}

function toDiagnostic(entry: DiagnosticDisposition): TypeScriptDiagnostic {
  return {
    column: entry.column,
    code: entry.code,
    message: entry.message,
    owner: entry.owner,
    ownerRelativeLine: entry.ownerRelativeLine,
    path: entry.path,
  };
}

function replaceDiagnostic(
  diagnostics: readonly TypeScriptDiagnostic[],
  index: number,
  replacement: Partial<TypeScriptDiagnostic>,
): readonly TypeScriptDiagnostic[] {
  return diagnostics.map((item, itemIndex) =>
    itemIndex === index ? { ...item, ...replacement } : item,
  );
}

function readDispositionViolations(
  diagnostics: readonly TypeScriptDiagnostic[],
  ledger: readonly Partial<DiagnosticDisposition>[],
): readonly string[] {
  const validation = diagnosticValidation as unknown as {
    readonly readDiagnosticDispositionViolations?: (
      candidate: readonly TypeScriptDiagnostic[],
      dispositions: readonly Partial<DiagnosticDisposition>[],
    ) => readonly string[];
  };
  return (
    validation.readDiagnosticDispositionViolations?.(diagnostics, ledger) ?? [
      'diagnostic disposition validator is missing',
    ]
  );
}
