import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import {
  createPassingProvenanceInput,
  replaceFinalSource,
  replacePredecessorSource,
  toSingleCaseSource,
} from './auth-server-test-provenance-fixtures.ts';
import {
  AUTH_TEST_PROVENANCE_MANIFEST,
  type AuthTestProvenanceInput,
  validateAuthTestProvenance,
} from './auth-server-test-provenance-validation.ts';
import {
  identityMutationCases,
  semanticMutationCases,
  toMutableProvenanceInput,
} from './auth-server-test-provenance-mutations.ts';

it('accepts formatting changes, static path relocation, and removed describe ownership', () => {
  expect(validateAuthTestProvenance(createPassingProvenanceInput())).toEqual([]);
});

it('normalizes quotes, numeric separators, trailing commas, and redundant parentheses', () => {
  const base = `
    it("preserved context", () => {
      prepare((1_000),);
      expect((value)).toEqual({ answer: 1_000, });
    },);
  `;
  const changed = `
    it('preserved context', () => {
      prepare(1000);
      expect(value).toEqual({ answer: 1000 });
    });
  `;
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input)).toEqual([]);
});

it('normalizes removed describe ownership when its title is a resolved constant', () => {
  const base = `
    const predecessorOwner = 'removed predecessor owner';
    describe(predecessorOwner, () => {
      it('preserved context', () => {
        prepare();
        expect(value).toBe(ready);
      });
    });
  `;
  const changed = `
    it('preserved context', () => {
      prepare();
      expect(value).toBe(ready);
    });
  `;
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input)).toEqual([]);
});

it('normalizes extracted helper, binding, and fixture ownership refactors', () => {
  const base = `
    it('preserved context', () => {
      verify(runtime, 'preserved');
      verify(runtime, 'preserved');
      expect(results.allEntries()).toEqual({ sessionId: session.sessionId });
    });
    function verify(actual, expected) {
      waitForQueuedEntry(actual);
      total += step + 2;
      expect(actual).toEqual(
        expect.objectContaining({ state: expected, codes: [7, /proof/gi] }),
      );
    }
  `;
  const changed = `
    it('preserved context', () => {
      check(fixture.runtime, 'preserved');
      check(fixture.runtime, 'preserved');
      expect(fixture.auth.results.allEntries()).toEqual({
        sessionId: fixture.session.sessionId,
      });
    });
    function check(subject, wanted) {
      waitForAuthInboxEntry(subject);
      count += amount + 2;
      expect(subject).toEqual(
        expect.objectContaining({ state: wanted, codes: [7, /proof/gi] }),
      );
    }
  `;
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input)).toEqual([]);
});

it.each(identityMutationCases)('rejects %s in the exact provenance manifest', (_, code, mutate) => {
  expect(validateAuthTestProvenance(mutate(createPassingProvenanceInput())).join('\n')).toContain(
    code,
  );
});

it('rejects a snapshot resolved from the wrong base commit', () => {
  const input = toMutableProvenanceInput(createPassingProvenanceInput());
  input.snapshot.baseCommit = '0000000000000000000000000000000000000000';
  expect(validateAuthTestProvenance(input).join('\n')).toContain('snapshot.base-commit');
});

it('rejects a predecessor whose observed blob differs from the locked blob', () => {
  const input = toMutableProvenanceInput(createPassingProvenanceInput());
  const predecessor = input.manifest.predecessors[0];
  input.snapshot.predecessorBlobs[predecessor.path] = 'wrong-blob';
  expect(validateAuthTestProvenance(input).join('\n')).toContain('snapshot.predecessor-blob');
});

it('rejects extra or missing snapshot sources', () => {
  const extra = toMutableProvenanceInput(createPassingProvenanceInput());
  extra.snapshot.finalSources['packages/tests/shared-server/auth/unowned.test.ts'] = 'it.todo("x")';
  expect(validateAuthTestProvenance(extra).join('\n')).toContain('snapshot.final-source-set');

  const missing = toMutableProvenanceInput(createPassingProvenanceInput());
  delete missing.snapshot.predecessorSources[missing.manifest.predecessors[0].path];
  expect(validateAuthTestProvenance(missing).join('\n')).toContain(
    'snapshot.predecessor-source-set',
  );
});

it('rejects parse errors in predecessor and final owners', () => {
  const predecessor = replacePredecessorSource(createPassingProvenanceInput(), 'it("broken"');
  expect(validateAuthTestProvenance(predecessor).join('\n')).toContain('source.parse');

  const final = replaceFinalSource(createPassingProvenanceInput(), 'it("broken"');
  expect(validateAuthTestProvenance(final).join('\n')).toContain('source.parse');
});

it('rejects a syntactically valid final owner that contributes no predecessor facts', () => {
  const input = replaceFinalSource(createPassingProvenanceInput(), "it.todo('unrelated case');");
  expect(validateAuthTestProvenance(input).join('\n')).toContain('owner.noncontributing');
});

it.each(semanticMutationCases)('rejects a changed %s occurrence', (_, finalSource, factKind) => {
  const baseBody = [
    'prepare();',
    'prepare();',
    'count += step;',
    'expect(value).toBe(ready);',
  ].join('\n');
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), finalSource),
    toSingleCaseSource(baseBody),
  );
  expect(validateAuthTestProvenance(input).join('\n')).toContain(`semantic.missing:${factKind}`);
});

it('rejects a changed nested asymmetric matcher in the complete expectation', () => {
  const base = toSingleCaseSource(
    'expect(value).toEqual(expect.objectContaining({ nested: expect.arrayContaining([needle]) }));',
  );
  const changed = toSingleCaseSource(
    'expect(value).toEqual(expect.objectContaining({ nested: expect.stringContaining(needle) }));',
  );
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input).join('\n')).toContain('semantic.missing:assertion');
});

it('rejects a changed expected literal passed through a helper parameter', () => {
  const base = helperExpectationSource("verify(value, 'preserved');");
  const changed = helperExpectationSource("verify(value, 'changed');");
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input).join('\n')).toContain('semantic.missing:assertion');
});

it('rejects a changed literal inside the received call', () => {
  const base = toSingleCaseSource("expect(repository.findBySessionId('session-1')).toBeDefined();");
  const changed = toSingleCaseSource(
    "expect(repository.findBySessionId('wrong-session')).toBeDefined();",
  );
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input).join('\n')).toContain('semantic.missing:assertion');
});

it('rejects a changed mutation RHS after local ownership is normalized', () => {
  const base = toSingleCaseSource('count += step + 2; expect(value).toBe(ready);');
  const changed = toSingleCaseSource('total += amount + 3; expect(value).toBe(ready);');
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input).join('\n')).toContain(
    'semantic.missing:mutation-expression',
  );
});

it('rejects a changed mutation inside an expression-bodied callback', () => {
  const base = toSingleCaseSource(
    'install(() => void (conflict.rollbackCount += 1)); expect(value).toBe(ready);',
  );
  const changed = toSingleCaseSource(
    'install(() => void (conflict.rollbackCount += 2)); expect(value).toBe(ready);',
  );
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input).join('\n')).toContain(
    'semantic.missing:mutation-expression',
  );
});

it('rejects changing a setup callee outside the approved helper aliases', () => {
  const base = toSingleCaseSource('prepare(value); expect(value).toBe(ready);');
  const changed = toSingleCaseSource('destroy(value); expect(value).toBe(ready);');
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input).join('\n')).toContain(
    'semantic.missing:setup-expression',
  );
});

it('rejects losing a duplicate helper invocation and its semantic occurrences', () => {
  const base = helperExpectationSource('verify(value, 7); verify(value, 7);');
  const changed = helperExpectationSource('verify(value, 7);');
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input).join('\n')).toContain('semantic.missing:assertion');
});

it('rejects an otherwise complete expectation moved to another test context', () => {
  const base = "it('first', () => { expect(value).toBe(ready); }); it('second', () => {});";
  const changed = "it('first', () => {}); it('second', () => { expect(value).toBe(ready); });";
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input).join('\n')).toContain('semantic.missing:assertion');
});

it.each([
  ['string', "const first = 'same'; const second = 'same';", "const first = 'same';"],
  ['numeric', 'const first = 7; const second = 7;', 'const first = 7;'],
  ['regex', 'const first = /proof/gi; const second = /proof/gi;', 'const first = /proof/gi;'],
] as const)('rejects loss of a duplicate %s literal', (kind, base, changed) => {
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input).join('\n')).toContain(
    `semantic.missing:${kind}-literal`,
  );
});

it.each([
  ['pattern', 'const proof = /changed/gi;'],
  ['flags', 'const proof = /proof/g;'],
] as const)('rejects a changed regex %s', (_, changed) => {
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    'const proof = /proof/gi;',
  );
  expect(validateAuthTestProvenance(input).join('\n')).toContain('semantic.missing:regex-literal');
});

it('allows a static import path to change without treating it as a semantic fact', () => {
  const base = "import { value } from './same.ts'; prepare();";
  const changed = "import { value } from '../different.ts'; prepare();";
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input)).toEqual([]);
});

it('allows dynamic, require, and TypeScript import-equals paths to change', () => {
  const base = `
    const lazy = import('./before.ts');
    const loaded = require('./before.cjs');
    import Legacy = require('./before-legacy.ts');
    prepare();
  `;
  const changed = `
    const lazy = import('../after.ts');
    const loaded = require('../after.cjs');
    import Legacy = require('../after-legacy.ts');
    prepare();
  `;
  const input = replacePredecessorSource(
    replaceFinalSource(createPassingProvenanceInput(), changed),
    base,
  );
  expect(validateAuthTestProvenance(input)).toEqual([]);
});

it('preserves every exact-base fact in the mapped real auth owners', () => {
  const violations = validateAuthTestProvenance(readRealTreeInput());
  expect(violations, violations.join('\n')).toEqual([]);
});

function readRealTreeInput(): AuthTestProvenanceInput {
  const predecessorBlobs: Record<string, string> = {};
  const predecessorSources: Record<string, string> = {};
  const finalSources: Record<string, string> = {};
  for (const entry of AUTH_TEST_PROVENANCE_MANIFEST.predecessors) {
    predecessorBlobs[entry.path] = readGit([
      'rev-parse',
      `${AUTH_TEST_PROVENANCE_MANIFEST.baseCommit}:${entry.path}`,
    ]);
    predecessorSources[entry.path] = readGit(['show', entry.blob], false);
    for (const owner of entry.finalOwners) {
      finalSources[owner] = readFileSync(path.join(process.cwd(), owner), 'utf8');
    }
  }
  return {
    manifest: AUTH_TEST_PROVENANCE_MANIFEST,
    snapshot: {
      baseCommit: readGit(['rev-parse', `${AUTH_TEST_PROVENANCE_MANIFEST.baseCommit}^{commit}`]),
      predecessorBlobs,
      predecessorSources,
      finalSources,
    },
  };
}

function helperExpectationSource(invocations: string): string {
  return `
    it('preserved context', () => { ${invocations} });
    function verify(actual, expected) {
      prepare(actual);
      count += 1;
      expect(actual).toEqual(expect.objectContaining({ expected }));
    }
  `;
}

function readGit(arguments_: readonly string[], trim = true): string {
  const output = execFileSync('git', arguments_, { encoding: 'utf8' });
  return trim ? output.trim() : output;
}
