import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

import {
  approvedBase,
  authPrALineages,
  authPrAProductionTargets,
  type AuthPrALineage,
} from './auth-server-pr-a-lineage-inventory.ts';

const repoRoot = process.cwd();

describe('auth server PR A lineage provenance', () => {
  it('binds every source owner to the exact approved base blob and declared symbols', () => {
    validateLineages(authPrALineages);
  });

  it('covers every PR A production target without transferring historical style debt', () => {
    const targetPaths = authPrALineages.flatMap((lineage) =>
      lineage.targets.map((target) => target.path),
    );

    expect([...new Set(targetPaths)].toSorted()).toEqual([...authPrAProductionTargets].toSorted());
    expect(
      authPrALineages.flatMap((lineage) =>
        lineage.targets.flatMap((target) => target.inheritedStyleFindings),
      ),
    ).toEqual([]);
    expect(authLineageManifestTargets()).toEqual([]);
  });

  it('fails closed for the base, source blob, symbols, target inventory, and debt capacity', () => {
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
    const inheritedDebt = structuredClone(authPrALineages);
    inheritedDebt[0].targets[0].inheritedStyleFindings = ['function.length'];

    for (const [fixture, message] of [
      [wrongBase, 'approved base'],
      [wrongBlob, 'source blob'],
      [missingSourceSymbol, 'source symbol'],
      [missingTargetSymbol, 'target symbol'],
      [missingTarget, 'target path'],
      [inheritedDebt, 'historical style debt'],
    ] as const) {
      expect(() => validateLineages(fixture), message).toThrow(message);
    }
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
      requireSymbols(readFileSync(absolute(target.path), 'utf8'), target.symbols, 'target symbol');
      if (target.inheritedStyleFindings.length > 0) throw new Error('historical style debt');
    }
  }
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

function authLineageManifestTargets(): readonly string[] {
  const directory = absolute('plans/repo-style-lineages');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const manifest = JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as {
        lineages?: Array<{ targets?: string[] }>;
      };
      return (manifest.lineages ?? []).flatMap((lineage) => lineage.targets ?? []);
    })
    .filter((target) => authPrAProductionTargets.includes(target as never));
}

function readBase(filePath: string): string {
  return git(['show', `${approvedBase}:${filePath}`], false);
}

function git(args: readonly string[], trim = true): string {
  const result = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return trim ? result.trim() : result;
}

function absolute(filePath: string): string {
  return path.join(repoRoot, filePath);
}
