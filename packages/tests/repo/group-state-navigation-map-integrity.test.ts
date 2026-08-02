import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const navigationMapPath = 'packages/shared-server/rallar-system/group-state/README.md';
const architecturePath = 'packages/shared-server/architecture.md';

const primarySymbolLinks = [
  {
    symbol: 'initialise',
    sourcePath: '../../../../apps/api-v1/src/middleware.ts',
    declaration: 'function initialise(',
  },
  {
    symbol: 'defaultProcessGroupAppInbox',
    sourcePath: '../../../../apps/api-v1/src/routes/group-state-routes.ts',
    declaration: 'async function defaultProcessGroupAppInbox',
  },
  {
    symbol: 'AppGroupInboxService',
    sourcePath: '../services/AppGroupInboxService.ts',
    declaration: 'class AppGroupInboxService',
  },
  {
    symbol: 'GroupStateInboxHandler',
    sourcePath: './inbox/group-state-inbox-handler.ts',
    declaration: 'export class GroupStateInboxHandler',
  },
  {
    symbol: 'createGroupStateService',
    sourcePath: './group-state-service.ts',
    declaration: 'export function createGroupStateService',
  },
  {
    symbol: 'writeGroupMutation',
    sourcePath: './mutation/write/write-group-mutation.ts',
    declaration: 'export async function writeGroupMutation',
  },
  {
    symbol: 'processGroupPresenceConnect',
    sourcePath: './presence/group-presence-service.ts',
    declaration: 'export async function processGroupPresenceConnect',
  },
  {
    symbol: 'processGroupSessionCleanup',
    sourcePath: './presence/group-presence-service.ts',
    declaration: 'export async function processGroupSessionCleanup',
  },
  {
    symbol: 'GroupPresenceSummaryWork',
    sourcePath: './presence/group-presence-summary-work.ts',
    declaration: 'export class GroupPresenceSummaryWork',
  },
  {
    symbol: 'createCachedGroupStateService',
    sourcePath: './snapshot/cached-group-state-service.ts',
    declaration: 'export function createCachedGroupStateService',
  },
  {
    symbol: 'GroupStateSnapshotReadThroughCache',
    sourcePath: './snapshot/group-state-snapshot-read-through-cache.ts',
    declaration: 'export class GroupStateSnapshotReadThroughCache',
  },
] as const;

describe('group-state navigation map integrity', () => {
  it('links each read-first owner to its current source symbol', () => {
    const navigationMap = readRepo(navigationMapPath);
    const markdownLinks = readMarkdownLinks(navigationMap);

    for (const link of primarySymbolLinks) {
      const matchingLink = markdownLinks.find(
        (candidate) => candidate.label === link.symbol && candidate.target === link.sourcePath,
      );
      expect(matchingLink, `${link.symbol} link`).toBeDefined();

      const source = readRelativeToNavigationMap(link.sourcePath);
      expect(source, `${link.sourcePath} (${link.symbol})`).toContain(link.declaration);
    }
  });

  it('keeps the map reachable once from shared-server architecture', () => {
    const architecture = readRepo(architecturePath);
    const navigationLink = './rallar-system/group-state/README.md';

    expect(architecture.match(new RegExp(escapeRegExp(navigationLink), 'g'))).toHaveLength(1);
  });
});

function readMarkdownLinks(source: string): readonly Readonly<{ label: string; target: string }>[] {
  return [...source.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((match) => ({
    label: match[1],
    target: match[2],
  }));
}

function readRepo(relativePath: string): string {
  const absolutePath = path.join(repoRoot, relativePath);
  expect(existsSync(absolutePath), relativePath).toBe(true);
  return readFileSync(absolutePath, 'utf8');
}

function readRelativeToNavigationMap(relativePath: string): string {
  const absolutePath = path.resolve(repoRoot, path.dirname(navigationMapPath), relativePath);
  expect(existsSync(absolutePath), relativePath).toBe(true);
  return readFileSync(absolutePath, 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
