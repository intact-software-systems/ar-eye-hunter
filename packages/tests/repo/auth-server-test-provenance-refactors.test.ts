import { expect, it } from 'vitest';

import {
  createPassingProvenanceInput,
  replaceFinalSource,
  replacePredecessorSource,
  toSingleCaseSource,
} from './auth-server-test-provenance-fixtures.ts';
import {
  type AuthTestProvenanceInput,
  validateAuthTestProvenance,
} from './auth-server-test-provenance-validation.ts';
import { toMutableProvenanceInput } from './auth-server-test-provenance-mutations.ts';

it('normalizes a single-return helper against its inline received expression', () => {
  const base = toSingleCaseSource(`
    expect([...runtime.data.keys()].filter((key) => key.startsWith('auth-session:'))).toEqual([]);
  `);
  const changed = `${toSingleCaseSource(`
      expect(sessionStorageKeys(runtime)).toEqual([]);
    `)}
    function sessionStorageKeys(repository) {
      return [...repository.data.keys()].filter((key) => key.startsWith('auth-session:'));
    }
  `;
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input)).toEqual([]);
});

it('normalizes a const received binding against an extracted single-return helper', () => {
  const base = toSingleCaseSource(`
    const reads = calls.filter(([namespace]) => namespace === 'auth-user');
    expect(reads).toHaveLength(4);
  `);
  const changed = `${toSingleCaseSource(`
      expect(policyReadCalls(calls)).toHaveLength(4);
    `)}
    function policyReadCalls(allCalls) {
      return allCalls.filter(([namespace]) => namespace === 'auth-user');
    }
  `;
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input)).toEqual([]);
});

it('rejects a changed expression returned by an extracted assertion helper', () => {
  const base = `${toSingleCaseSource('expect(select(values)).toEqual(expected);')}
    function select(items) { return items.filter(predicate); }
  `;
  const changed = `${toSingleCaseSource('expect(select(values)).toEqual(expected);')}
    function select(items) { return items.map(predicate); }
  `;
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input).join('\n')).toContain('semantic.missing:assertion');
});

it('accepts equivalent facts reached through each locked snapshot module graph', () => {
  expect(validateAuthTestProvenance(createModuleGraphFixture(true))).toEqual([]);
});

it('rejects losing a named support binding instead of pooling reachable module facts', () => {
  expect(validateAuthTestProvenance(createModuleGraphFixture(false)).join('\n')).toContain(
    'semantic.missing:string-literal',
  );
});

function createModuleGraphFixture(includeFinalImport: boolean): AuthTestProvenanceInput {
  const input = toMutableProvenanceInput(createPassingProvenanceInput());
  const first = input.manifest.predecessors[0];
  const helper = input.manifest.predecessors.find(({ path }) =>
    path.endsWith('/app-auth-inbox-test-harness.ts'),
  );
  if (helper === undefined) throw new Error('fixture requires the locked predecessor helper');
  input.snapshot.predecessorSources[first.path] = `
    import { readHelperServiceId } from './app-auth-inbox-test-harness.ts';
    ${toSingleCaseSource('prepare(readHelperServiceId()); expect(value).toBe(ready);')}
  `;
  input.snapshot.finalSources[first.finalOwners[0]] = `
    ${
      includeFinalImport
        ? "import { readHelperServiceId } from './auth-app-inbox-test-runtime.ts';"
        : "import './auth-app-inbox-test-runtime.ts';"
    }
    ${toSingleCaseSource('prepare(readHelperServiceId()); expect(value).toBe(ready);')}
  `;
  input.snapshot.predecessorSources[helper.path] = `
    export function readHelperServiceId() { return 'auth-test-service'; }
  `;
  input.snapshot.finalSources[helper.finalOwners[0]] = `
    export function readHelperServiceId() { return 'auth-test-service'; }
  `;
  return input;
}
