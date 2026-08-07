import { readAuthTestSemanticFacts } from './auth-server-test-semantic-facts.ts';
import type {
  AuthTestSemanticFact,
  AuthTestSemanticFactKind,
} from './auth-server-test-semantic-contracts.ts';

export interface AuthTestProvenanceEntry {
  readonly path: string;
  readonly blob: string;
  readonly finalOwners: readonly string[];
}

export interface AuthTestProvenanceManifest {
  readonly baseCommit: string;
  readonly predecessors: readonly AuthTestProvenanceEntry[];
}

export interface AuthTestProvenanceSnapshot {
  readonly baseCommit: string;
  readonly predecessorBlobs: Readonly<Record<string, string>>;
  readonly predecessorSources: Readonly<Record<string, string>>;
  readonly finalSources: Readonly<Record<string, string>>;
}

export interface AuthTestProvenanceInput {
  readonly manifest: AuthTestProvenanceManifest;
  readonly snapshot: AuthTestProvenanceSnapshot;
}

export const AUTH_TEST_PROVENANCE_MANIFEST: AuthTestProvenanceManifest = {
  baseCommit: '8152de39faf2d630158143366596d61346e20457',
  predecessors: [
    {
      path: 'packages/tests/shared-server/app-auth-conflict-inbox.test.ts',
      blob: '9efc2a219ba1326f718e5a49894759f0c346375c',
      finalOwners: ['packages/tests/shared-server/auth/auth-ticket-conflict.test.ts'],
    },
    {
      path: 'packages/tests/shared-server/app-auth-inbox-service.test.ts',
      blob: '3c35ca92dfc2e1878eb06e1582f8d7e70e61ea68',
      finalOwners: [
        'packages/tests/shared-server/auth/auth-command-and-result-codecs.test.ts',
        'packages/tests/shared-server/auth/auth-inbox-registration-and-routing.test.ts',
      ],
    },
    {
      path: 'packages/tests/shared-server/app-auth-inbox-test-harness.ts',
      blob: 'c3c93377ad5091cbb7e6c6956af6ec0c80975162',
      finalOwners: ['packages/tests/shared-server/auth/auth-app-inbox-test-runtime.ts'],
    },
    {
      path: 'packages/tests/shared-server/app-auth-legacy-cutoff.test.ts',
      blob: 'df3070f84248415295ab110777df69e5d24fa696',
      finalOwners: ['packages/tests/shared-server/auth/auth-legacy-cutoff.test.ts'],
    },
    {
      path: 'packages/tests/shared-server/app-auth-legacy-replay-inbox.test.ts',
      blob: 'adda7eeebf501ccc7a7ec20d1c78e7f35c7d3bd3',
      finalOwners: ['packages/tests/shared-server/auth/auth-legacy-replay.test.ts'],
    },
    {
      path: 'packages/tests/shared-server/app-auth-persistence-inbox.test.ts',
      blob: 'ead9212d82fdef35a59e93c6dc77b997db396b6b',
      finalOwners: ['packages/tests/shared-server/auth/auth-persistence-security.test.ts'],
    },
    {
      path: 'packages/tests/shared-server/app-auth-public-routing-inbox.test.ts',
      blob: 'bbe882759769473148a9c2d97aa0b59446266e57',
      finalOwners: ['packages/tests/shared-server/auth/auth-public-command-routing.test.ts'],
    },
    {
      path: 'packages/tests/shared-server/app-auth-transaction-inbox.test.ts',
      blob: 'ef6acc5f7848222bc95b55a8e48a2d87192750d3',
      finalOwners: ['packages/tests/shared-server/auth/auth-transaction-boundary.test.ts'],
    },
    {
      path: 'packages/tests/shared-server/auth-fixture.ts',
      blob: 'f2d6ee904a358829cd1a19429449ebddaa01edbf',
      finalOwners: ['packages/tests/shared-server/auth/auth-test-fixtures.ts'],
    },
    {
      path: 'packages/tests/shared-server/auth-login-service.test.ts',
      blob: '34e47b711c43247148f02665fe0d9ac96566ace4',
      finalOwners: ['packages/tests/shared-server/auth/auth-credential-login.test.ts'],
    },
    {
      path: 'packages/tests/shared-server/request-auth-service.test.ts',
      blob: 'd3d31d43cd2b312b91ffb72e4ceae755c5d5ab9f',
      finalOwners: ['packages/tests/shared-server/auth/auth-request-proof.test.ts'],
    },
  ],
};

const contributingKinds = new Set<AuthTestSemanticFactKind>([
  'assertion',
  'declaration',
  'mutation-expression',
  'registration',
  'setup-expression',
]);

export function validateAuthTestProvenance(input: AuthTestProvenanceInput): readonly string[] {
  const issues = [
    ...validateManifestIdentity(input.manifest),
    ...validateSnapshotIdentity(input.snapshot),
  ];
  if (issues.some(isSnapshotSourceSetIssue)) return issues;

  for (const entry of AUTH_TEST_PROVENANCE_MANIFEST.predecessors) {
    issues.push(...validateEntrySemantics(entry, input.snapshot));
  }
  return issues;
}

function validateManifestIdentity(manifest: AuthTestProvenanceManifest): readonly string[] {
  const issues: string[] = [];
  if (manifest.baseCommit !== AUTH_TEST_PROVENANCE_MANIFEST.baseCommit) {
    issues.push(`manifest.base-commit:expected=${AUTH_TEST_PROVENANCE_MANIFEST.baseCommit}`);
  }
  const actualPaths = manifest.predecessors.map(({ path }) => path);
  const expectedPaths = AUTH_TEST_PROVENANCE_MANIFEST.predecessors.map(({ path }) => path);
  if (!sameOrderedValues(actualPaths, expectedPaths)) {
    issues.push('manifest.predecessors:exact ordered predecessor paths changed');
  }
  AUTH_TEST_PROVENANCE_MANIFEST.predecessors.forEach((expected, index) => {
    const actual = manifest.predecessors[index];
    if (actual === undefined || actual.path !== expected.path) return;
    if (actual.blob !== expected.blob) {
      issues.push(`manifest.predecessor-blob:${expected.path}:expected=${expected.blob}`);
    }
    if (!sameOrderedValues(actual.finalOwners, expected.finalOwners)) {
      issues.push(`manifest.final-owners:${expected.path}:exact order changed`);
    }
  });
  return issues;
}

function validateSnapshotIdentity(snapshot: AuthTestProvenanceSnapshot): readonly string[] {
  const issues: string[] = [];
  if (snapshot.baseCommit !== AUTH_TEST_PROVENANCE_MANIFEST.baseCommit) {
    issues.push(`snapshot.base-commit:expected=${AUTH_TEST_PROVENANCE_MANIFEST.baseCommit}`);
  }
  const predecessorPaths = AUTH_TEST_PROVENANCE_MANIFEST.predecessors.map(({ path }) => path);
  const finalPaths = AUTH_TEST_PROVENANCE_MANIFEST.predecessors.flatMap(
    ({ finalOwners }) => finalOwners,
  );
  if (!sameValueSet(Object.keys(snapshot.predecessorSources), predecessorPaths)) {
    issues.push('snapshot.predecessor-source-set:must equal exact manifest predecessor paths');
  }
  if (!sameValueSet(Object.keys(snapshot.predecessorBlobs), predecessorPaths)) {
    issues.push('snapshot.predecessor-blob-set:must equal exact manifest predecessor paths');
  }
  if (!sameValueSet(Object.keys(snapshot.finalSources), finalPaths)) {
    issues.push('snapshot.final-source-set:must equal exact manifest final owner paths');
  }
  for (const entry of AUTH_TEST_PROVENANCE_MANIFEST.predecessors) {
    if (snapshot.predecessorBlobs[entry.path] !== entry.blob) {
      issues.push(`snapshot.predecessor-blob:${entry.path}:expected=${entry.blob}`);
    }
  }
  return issues;
}

function validateEntrySemantics(
  entry: AuthTestProvenanceEntry,
  snapshot: AuthTestProvenanceSnapshot,
): readonly string[] {
  const predecessorRead = readAuthTestSemanticFacts({
    ownerPath: entry.path,
    source: snapshot.predecessorSources[entry.path] ?? '',
    supportingSources: snapshot.predecessorSources,
  });
  const ownerReads = entry.finalOwners.map((ownerPath) => ({
    ownerPath,
    read: readAuthTestSemanticFacts({
      ownerPath,
      source: snapshot.finalSources[ownerPath] ?? '',
      supportingSources: snapshot.finalSources,
    }),
  }));
  const issues = [...predecessorRead.issues, ...ownerReads.flatMap(({ read }) => read.issues)];
  if (issues.length > 0) return issues;

  const predecessorCounts = toFactCounts(predecessorRead.facts);
  const finalFacts = ownerReads.flatMap(({ read }) => read.facts);
  const finalCounts = toFactCounts(finalFacts);
  issues.push(...readMissingFactIssues(entry.path, predecessorCounts, finalCounts));
  for (const owner of ownerReads) {
    if (!contributesFacts(predecessorCounts, owner.read.facts)) {
      issues.push(`owner.noncontributing:${entry.path}:${owner.ownerPath}`);
    }
  }
  return issues;
}

function toFactCounts(facts: readonly AuthTestSemanticFact[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const fact of facts) {
    const key = `${fact.kind}\u0000${fact.value}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function readMissingFactIssues(
  predecessorPath: string,
  predecessorCounts: ReadonlyMap<string, number>,
  finalCounts: ReadonlyMap<string, number>,
): readonly string[] {
  const issues: string[] = [];
  for (const [key, expectedCount] of predecessorCounts) {
    const actualCount = finalCounts.get(key) ?? 0;
    if (actualCount >= expectedCount) continue;
    const separator = key.indexOf('\u0000');
    const kind = key.slice(0, separator);
    const value = key.slice(separator + 1);
    const counts = `expected=${expectedCount}:actual=${actualCount}`;
    issues.push(`semantic.missing:${kind}:${predecessorPath}:${counts}:${JSON.stringify(value)}`);
  }
  return issues;
}

function contributesFacts(
  predecessorCounts: ReadonlyMap<string, number>,
  ownerFacts: readonly AuthTestSemanticFact[],
): boolean {
  return ownerFacts.some(
    (fact) =>
      contributingKinds.has(fact.kind) && predecessorCounts.has(`${fact.kind}\u0000${fact.value}`),
  );
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameValueSet(left: readonly string[], right: readonly string[]): boolean {
  return sameOrderedValues([...left].sort(), [...right].sort());
}

function isSnapshotSourceSetIssue(issue: string): boolean {
  return (
    issue.startsWith('snapshot.predecessor-source-set') ||
    issue.startsWith('snapshot.final-source-set')
  );
}
