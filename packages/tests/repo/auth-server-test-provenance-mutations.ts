import type { AuthTestProvenanceInput } from './auth-server-test-provenance-validation.ts';

export const identityMutationCases = [
  ['wrong base', 'manifest.base-commit', mutateManifestBase],
  ['wrong predecessor blob', 'manifest.predecessor-blob', mutateManifestBlob],
  ['wrong target order', 'manifest.final-owners', reverseSplitOwners],
  ['extra target', 'manifest.final-owners', addFinalOwner],
  ['missing target', 'manifest.final-owners', removeFinalOwner],
  ['extra predecessor', 'manifest.predecessors', addPredecessor],
  ['missing predecessor', 'manifest.predecessors', removePredecessor],
] as const;

export const semanticMutationCases = [
  [
    'registration title',
    "it('changed context', () => { expect(value).toBe(ready); }, 500);",
    'registration',
  ],
  [
    'registration modifier',
    "it.only('preserved context', () => { expect(value).toBe(ready); }, 500);",
    'registration',
  ],
  [
    'registration timeout',
    "it('preserved context', () => { expect(value).toBe(ready); }, 600);",
    'registration',
  ],
  [
    'duplicate setup expression',
    "it('preserved context', () => { prepare(); expect(value).toBe(ready); }, 500);",
    'setup-expression',
  ],
  [
    'assignment operator',
    "it('preserved context', () => { count -= step; expect(value).toBe(ready); }, 500);",
    'mutation-expression',
  ],
  [
    'complete expectation',
    "it('preserved context', () => { expect(value).toStrictEqual(other); }, 500);",
    'assertion',
  ],
] as const;

export function toMutableProvenanceInput(
  input: AuthTestProvenanceInput,
): Mutable<AuthTestProvenanceInput> {
  return structuredClone(input) as Mutable<AuthTestProvenanceInput>;
}

function mutateManifestBase(input: AuthTestProvenanceInput): AuthTestProvenanceInput {
  const mutated = toMutableProvenanceInput(input);
  mutated.manifest.baseCommit = '0000000000000000000000000000000000000000';
  return mutated;
}

function mutateManifestBlob(input: AuthTestProvenanceInput): AuthTestProvenanceInput {
  const mutated = toMutableProvenanceInput(input);
  mutated.manifest.predecessors[0].blob = 'wrong-blob';
  return mutated;
}

function reverseSplitOwners(input: AuthTestProvenanceInput): AuthTestProvenanceInput {
  const mutated = toMutableProvenanceInput(input);
  mutated.manifest.predecessors[1].finalOwners.reverse();
  return mutated;
}

function addFinalOwner(input: AuthTestProvenanceInput): AuthTestProvenanceInput {
  const mutated = toMutableProvenanceInput(input);
  mutated.manifest.predecessors[0].finalOwners.push(
    'packages/tests/shared-server/auth/extra.test.ts',
  );
  return mutated;
}

function removeFinalOwner(input: AuthTestProvenanceInput): AuthTestProvenanceInput {
  const mutated = toMutableProvenanceInput(input);
  mutated.manifest.predecessors[0].finalOwners.pop();
  return mutated;
}

function addPredecessor(input: AuthTestProvenanceInput): AuthTestProvenanceInput {
  const mutated = toMutableProvenanceInput(input);
  mutated.manifest.predecessors.push({
    path: 'packages/tests/shared-server/extra.test.ts',
    blob: 'extra',
    finalOwners: ['packages/tests/shared-server/auth/extra.test.ts'],
  });
  return mutated;
}

function removePredecessor(input: AuthTestProvenanceInput): AuthTestProvenanceInput {
  const mutated = toMutableProvenanceInput(input);
  mutated.manifest.predecessors.pop();
  return mutated;
}

type Mutable<T> = T extends readonly (infer Value)[]
  ? Mutable<Value>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
