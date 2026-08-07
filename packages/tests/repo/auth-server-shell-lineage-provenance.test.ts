import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { findUnknownUsages } from '../../../scripts/repo-style-check/contract-rules.mjs';
import {
  authShellBoundaryEvidence,
  authShellLineages,
  authShellManifestPath,
  validateAuthShellLineage,
} from './auth-server-shell-lineage-validation.ts';

const serviceTarget = 'packages/shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
const handlerTarget = 'packages/shared-server/rallar-system/auth/inbox/auth-inbox-handler.ts';

describe('auth authoritative shell lineage inventory', () => {
  it('binds both inherited unknown boundaries to exact source and target owners', () => {
    expect(JSON.parse(read(authShellManifestPath))).toEqual({
      version: 1,
      lineages: authShellLineages,
    });
    expect(
      authShellBoundaryEvidence.map((entry) => ({
        id: entry.id,
        ruleId: entry.ruleId,
        sourceOwner: entry.source.owner,
        sourceSpan: entry.source.span,
        sourceUsageLine: entry.source.usageLine,
        targetPath: entry.target.path,
        targetOwner: entry.target.owner,
        targetSpan: entry.target.span,
        targetUsageLine: entry.target.usageLine,
      })),
    ).toEqual([
      {
        id: 'registered-command-boundary',
        ruleId: 'boundary.unknown',
        sourceOwner: 'AppAuthInboxService.constructor',
        sourceSpan: '63-92',
        sourceUsageLine: 87,
        targetPath: serviceTarget,
        targetOwner: 'AppAuthInboxService.constructor',
        targetSpan: '71-106',
        targetUsageLine: 100,
      },
      {
        id: 'decoded-command-boundary',
        ruleId: 'boundary.unknown',
        sourceOwner: 'AppAuthInboxService.processCommand',
        sourceSpan: '290-313',
        sourceUsageLine: 291,
        targetPath: handlerTarget,
        targetOwner: 'AuthInboxHandler.processAuthMutation',
        targetSpan: '28-53',
        targetUsageLine: 29,
      },
    ]);
    expect(() => validateAuthShellLineage()).not.toThrow();
  });
});

describe('auth authoritative shell manifest identity', () => {
  it('fails closed for the wrong base, source blob, or target inventory', () => {
    const wrongBase = [{ ...authShellLineages[0], mergeBase: '0'.repeat(40) }];
    const wrongBlob = [
      { ...authShellLineages[0], source: { ...authShellLineages[0].source, blob: '0'.repeat(40) } },
    ];
    const wrongTarget = [{ ...authShellLineages[0], targets: [handlerTarget] }];

    expect(() => validateAuthShellLineage({ lineages: wrongBase })).toThrow('shell base');
    expect(() => validateAuthShellLineage({ lineages: wrongBlob })).toThrow('shell source blob');
    expect(() => validateAuthShellLineage({ lineages: wrongTarget })).toThrow(
      'shell target inventory',
    );
  });
});

describe('auth authoritative shell derivation', () => {
  it('fails closed for semantic-owner substitution, content drift, and rule drift', () => {
    const handler = read(handlerTarget);
    const semanticOwnerSubstitution = handler.replace(
      'async processAuthMutation(',
      'async processUnrelatedMutation(',
    );
    const contentDrift = handler.replace(
      'Auth AppInbox command identity differs from queue key',
      'Changed auth queue identity failure',
    );
    const wrongRule = authShellBoundaryEvidence.map((entry, index) =>
      index === 0 ? { ...entry, ruleId: 'function.length' } : entry,
    );

    expect(() =>
      validateAuthShellLineage({
        targetOverrides: new Map([[handlerTarget, semanticOwnerSubstitution]]),
      }),
    ).toThrow('shell target owner');
    expect(() =>
      validateAuthShellLineage({ targetOverrides: new Map([[handlerTarget, contentDrift]]) }),
    ).toThrow('shell target content');
    expect(() => validateAuthShellLineage({ evidence: wrongRule })).toThrow('shell inherited rule');
  });

  it('rejects an equal-magnitude unknown in a new owner and all semantically new code', () => {
    const handler = read(handlerTarget);
    const unrelatedUnknown = handler
      .replace('commandCandidate: unknown', 'commandCandidate: object')
      .concat(
        '\nfunction unrelatedAuthBoundary(value: unknown): object {\n',
        '  return value as object;\n',
        '}\n',
      );
    const semanticAddition = `${handler}\nexport const unrelatedShellPolicy = true;\n`;

    expect(findUnknownUsages(unrelatedUnknown.split('\n'))).toHaveLength(
      findUnknownUsages(handler.split('\n')).length,
    );
    expect(() =>
      validateAuthShellLineage({
        targetOverrides: new Map([[handlerTarget, unrelatedUnknown]]),
      }),
    ).toThrow('shell boundary inventory');
    expect(() =>
      validateAuthShellLineage({
        targetOverrides: new Map([[handlerTarget, semanticAddition]]),
      }),
    ).toThrow('shell target file content');
  });
});

describe('auth authoritative shell style capacity', () => {
  it('grants zero capacity to every style rule outside the two inherited boundaries', () => {
    const handler = read(handlerTarget);
    const unrelatedLongLine = `${handler}\nexport const unrelatedShellPolicy = '${'x'.repeat(110)}';\n`;

    expect(() =>
      validateAuthShellLineage({
        targetOverrides: new Map([[handlerTarget, unrelatedLongLine]]),
      }),
    ).toThrow('shell style finding inventory');
  });
});

function read(filePath: string): string {
  return readFileSync(path.join(process.cwd(), filePath), 'utf8');
}
