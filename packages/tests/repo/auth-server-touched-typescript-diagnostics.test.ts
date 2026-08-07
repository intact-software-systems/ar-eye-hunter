import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readDiagnosticRegressions,
  readTouchedTypeScriptDiagnostics,
  type TypeScriptDiagnostic,
} from './auth-server-touched-typescript-diagnostics-validation.ts';

const validationPath =
  'packages/tests/repo/auth-server-touched-typescript-diagnostics-validation.ts';

it('requires exact base-to-head diagnostics for every touched test path', () => {
  expect(existsSync(path.join(process.cwd(), validationPath)), validationPath).toBe(true);
});

it('keeps the broad tests compiler honestly red without new or worsened diagnostics', () => {
  const evidence = readTouchedTypeScriptDiagnostics();

  expect(evidence.baseSha).toBe('8152de39faf2d630158143366596d61346e20457');
  expect(evidence.baseStatus).not.toBe(0);
  expect(evidence.headStatus).not.toBe(0);
  expect(evidence.touchedPaths).toHaveLength(evidence.pathEvidence.length);
  expect(evidence.baseDiagnostics).toHaveLength(18);
  expect(evidence.headDiagnostics).toHaveLength(7);
  expect(readDiagnosticRegressions(evidence.baseDiagnostics, evidence.headDiagnostics)).toEqual([]);
}, 30_000);

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

  it('rejects a worsened duplicate count', () => {
    expect(readDiagnosticRegressions([inherited], [inherited, inherited])).toEqual([inherited]);
  });
});

function diagnostic(overrides: Partial<TypeScriptDiagnostic> = {}): TypeScriptDiagnostic {
  return {
    code: 2305,
    message: "Module 'fixture' has no exported member 'Value'.",
    owner: '<module>',
    path: 'packages/tests/shared-server/fixture.test.ts',
    ...overrides,
  };
}
