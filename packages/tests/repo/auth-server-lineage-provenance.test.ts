import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

import { findUnknownUsages } from '../../../scripts/repo-style-check/contract-rules.mjs';
import { readStructuralLineageMap } from '../../../scripts/repo-style-check/structural-lineage.mjs';
import {
  approvedBase,
  authPrALineages,
  authPrAProductionTargets,
  type AuthPrALineage,
} from './auth-server-pr-a-lineage-inventory.ts';

const repoRoot = process.cwd();
const manifestPath = 'plans/repo-style-lineages/rallar-auth-server-pr-a.json';
const codecSource = 'packages/shared-server/rallar-system/services/auth-state-codecs.ts';
const credentialSource = 'packages/shared-server/rallar-system/services/auth-credential-issuer.ts';
const commandTarget =
  'packages/shared-server/rallar-system/auth/mutation/decode-auth-mutation-command.ts';
const resultTarget =
  'packages/shared-server/rallar-system/auth/mutation/decode-auth-mutation-result.ts';
const credentialTarget =
  'packages/shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
const expectedManifest = {
  version: 1,
  lineages: [
    structuralLineage(codecSource, '1baa7032de313d639228de272aee6f5a0abf9d32', [
      commandTarget,
      resultTarget,
    ]),
    structuralLineage(credentialSource, '489233ca4fa42aaaa3cdf4109fe034281f9ee5d4', [
      credentialTarget,
    ]),
  ],
};
const allowedDebtByTarget = new Map([
  [commandTarget, ['boundary.unknown']],
  [resultTarget, ['boundary.unknown']],
  [credentialTarget, ['boundary.unknown']],
]);
const expectedBoundaryOwnersByTarget = new Map([
  [
    commandTarget,
    [
      'assertNoPlaintextAuthFields',
      'decodeAuthMutationCommand',
      'requireRecord',
      'requireString',
      'requireTimestamp',
      'validateAgentTicketCommands',
      'validateAuthUserContract',
      'validateSessionAuthority',
    ],
  ],
  [
    resultTarget,
    [
      'assertNoPlaintextAuthFields',
      'decodeAuthMutationResult',
      'requireRecord',
      'requireString',
      'requireTimestamp',
    ],
  ],
  [credentialTarget, ['isValidAuthCredentialSecret']],
]);
const expectedBoundaryMagnitudeByTarget = new Map([
  [commandTarget, 9],
  [resultTarget, 6],
  [credentialTarget, 1],
]);

describe('auth server PR A lineage provenance', () => {
  it('binds every source owner to the exact approved base blob and declared symbols', () => {
    validateLineages(authPrALineages);
  });

  it('limits structural capacity to the exact reviewed boundary targets', () => {
    const manifest = JSON.parse(read(manifestPath));

    expect(manifest).toEqual(expectedManifest);
    expect(readCurrentStructuralLineages()).toEqual(
      new Map([
        [commandTarget, codecSource],
        [resultTarget, codecSource],
        [credentialTarget, credentialSource],
      ]),
    );
    expect(
      authPrALineages.flatMap((lineage) =>
        lineage.targets.flatMap((target) =>
          target.inheritedStyleFindings.map((ruleId) => [target.path, ruleId]),
        ),
      ),
    ).toEqual([
      [commandTarget, 'boundary.unknown'],
      [resultTarget, 'boundary.unknown'],
      [credentialTarget, 'boundary.unknown'],
    ]);
  });

  it('keeps inherited magnitude source-derived and excludes new boundary owners', () => {
    validateBoundaryCapacity();
  });

  it('covers every PR A production target without capacity for any other rule', () => {
    const targetPaths = authPrALineages.flatMap((lineage) =>
      lineage.targets.map((target) => target.path),
    );

    expect([...new Set(targetPaths)].toSorted()).toEqual([...authPrAProductionTargets].toSorted());
    for (const lineage of authPrALineages) {
      for (const target of lineage.targets) {
        expect(target.inheritedStyleFindings).toEqual(allowedDebtByTarget.get(target.path) ?? []);
      }
    }
  });

  it('fails closed for base, blob, target, symbol, rule, magnitude, and derivation drift', () => {
    const wrongBase = structuredClone(authPrALineages);
    wrongBase[0].base = '0'.repeat(40);
    const wrongBlob = structuredClone(authPrALineages);
    wrongBlob[0].source.blob = '0'.repeat(40);
    const missingSourceSymbol = structuredClone(authPrALineages);
    missingSourceSymbol[0].source.symbols = ['missingSourceSymbol'];
    const missingTargetSymbol = structuredClone(authPrALineages);
    missingTargetSymbol[0].targets[0].symbols = ['missingTargetSymbol'];
    const missingTarget = structuredClone(authPrALineages);
    missingTarget[0].targets[0].path = 'packages/shared-server/rallar-system/auth/missing.ts';
    const wrongRule = structuredClone(authPrALineages);
    wrongRule[1].targets[0].inheritedStyleFindings = ['function.length'];

    for (const [fixture, message] of [
      [wrongBase, 'approved base'],
      [wrongBlob, 'source blob'],
      [missingSourceSymbol, 'source symbol'],
      [missingTargetSymbol, 'target symbol'],
      [missingTarget, 'target path'],
      [wrongRule, 'historical style debt'],
    ] as const) {
      expect(() => validateLineages(fixture), message).toThrow(message);
    }

    const excessMagnitude = new Map([
      [
        commandTarget,
        read(commandTarget).replace(
          'function requireTimestamp(value: unknown, label: string): asserts value is number {',
          [
            'function requireTimestamp(value: unknown, label: string): asserts value is number {',
            '  const extraBoundary: unknown = value;',
          ].join('\n'),
        ),
      ],
    ]);
    expect(() => validateBoundaryCapacity(excessMagnitude)).toThrow('boundary magnitude');

    const unrelatedOwner = new Map([
      [
        commandTarget,
        read(commandTarget).replace(
          'function validateSessionAuthority',
          'function unrelatedBoundaryOwner',
        ),
      ],
    ]);
    expect(() => validateBoundaryCapacity(unrelatedOwner)).toThrow('source derivation');
  });
});

function validateLineages(lineages: readonly AuthPrALineage[]): void {
  for (const lineage of lineages) {
    if (lineage.base !== approvedBase) throw new Error('approved base');
    const actualBlob = git(['rev-parse', `${approvedBase}:${lineage.source.path}`]);
    if (actualBlob !== lineage.source.blob) throw new Error('source blob');
    requireSymbols(readBase(lineage.source.path), lineage.source.symbols, 'source symbol');
    for (const target of lineage.targets) {
      if (!existsSync(absolute(target.path))) throw new Error('target path');
      requireSymbols(read(target.path), target.symbols, 'target symbol');
      const allowedDebt = allowedDebtByTarget.get(target.path) ?? [];
      if (target.inheritedStyleFindings.join() !== allowedDebt.join()) {
        throw new Error('historical style debt');
      }
    }
  }
}

function validateBoundaryCapacity(overrides = new Map<string, string>()): void {
  for (const [sourcePath, targetPaths] of [
    [codecSource, [commandTarget, resultTarget]],
    [credentialSource, [credentialTarget]],
  ] as const) {
    const source = readBase(sourcePath);
    const sourceOwners = new Set(boundaryOwnerNames(source));
    const sourceMagnitude = findUnknownUsages(source.split('\n')).length;
    let targetMagnitude = 0;

    for (const targetPath of targetPaths) {
      const target = overrides.get(targetPath) ?? read(targetPath);
      const targetOwners = boundaryOwnerNames(target);
      if (targetOwners.some((owner) => !sourceOwners.has(owner))) {
        throw new Error('source derivation');
      }
      if (targetOwners.join() !== expectedBoundaryOwnersByTarget.get(targetPath)?.join()) {
        throw new Error('source derivation');
      }
      const magnitude = findUnknownUsages(target.split('\n')).length;
      if (magnitude !== expectedBoundaryMagnitudeByTarget.get(targetPath)) {
        throw new Error('boundary magnitude');
      }
      targetMagnitude += magnitude;
    }
    if (targetMagnitude > sourceMagnitude) throw new Error('boundary magnitude');
    expect(targetMagnitude, sourcePath).toBe(sourceMagnitude);
  }
}

function boundaryOwnerNames(source: string): readonly string[] {
  const usages = findUnknownUsages(source.split('\n'));
  const functions = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program.body.flatMap((statement) => {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    return declaration?.type === 'FunctionDeclaration' && declaration.id && declaration.loc
      ? [
          {
            name: declaration.id.name,
            start: declaration.loc.start.line,
            end: declaration.loc.end.line,
          },
        ]
      : [];
  });
  const owners = usages.map(
    (usage) => functions.find(({ start, end }) => usage.line >= start && usage.line <= end)?.name,
  );
  if (owners.some((owner) => owner === undefined)) throw new Error('source derivation');
  return [...new Set(owners as string[])].toSorted();
}

function requireSymbols(source: string, symbols: readonly string[], message: string): void {
  const available = new Set(declaredNames(source));
  for (const symbol of symbols) {
    if (!available.has(symbol)) throw new Error(`${message}: ${symbol}`);
  }
}

function declaredNames(source: string): readonly string[] {
  const program = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program;
  return program.body.flatMap((statement) =>
    declarationNames(
      statement.type === 'ExportNamedDeclaration' && statement.declaration
        ? statement.declaration
        : statement,
    ),
  );
}

function declarationNames(declaration: { type: string; [key: string]: unknown }): string[] {
  if (declaration.type === 'VariableDeclaration') {
    return (declaration.declarations as Array<{ id: { type: string; name?: string } }>).flatMap(
      ({ id }) => (id.type === 'Identifier' && id.name ? [id.name] : []),
    );
  }
  const id = declaration.id as { type?: string; name?: string } | undefined;
  return id?.type === 'Identifier' && id.name ? [id.name] : [];
}

function readCurrentStructuralLineages(): ReadonlyMap<string, string> {
  return readStructuralLineageMap({
    repoRoot,
    mergeBase: approvedBase,
    targetReference: 'WORKTREE',
    targetCommit: git(['rev-parse', 'HEAD']),
    renameByTargetPath: new Map(),
  });
}

function structuralLineage(sourcePath: string, blob: string, targets: readonly string[]) {
  return {
    mergeBase: approvedBase,
    source: { path: sourcePath, blob },
    targets,
  };
}

function readBase(filePath: string): string {
  return git(['show', `${approvedBase}:${filePath}`], false);
}

function read(filePath: string): string {
  return readFileSync(absolute(filePath), 'utf8');
}

function git(args: readonly string[], trim = true): string {
  const result = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return trim ? result.trim() : result;
}

function absolute(filePath: string): string {
  return path.join(repoRoot, filePath);
}
