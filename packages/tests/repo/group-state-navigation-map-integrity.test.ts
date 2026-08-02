import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const navigationMapPath = 'packages/shared-server/rallar-system/group-state/README.md';
const architecturePath = 'packages/shared-server/architecture.md';
const architectureNavigationLink = {
  label: 'Group-state server navigation map',
  target: './rallar-system/group-state/README.md',
} as const;

const navigationSourceLinks = [
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
    symbol: 'init',
    sourcePath: '../../../../apps/api-v1/src/routes/group-state-routes.ts',
    declaration: 'export function init(',
  },
  {
    symbol: 'readStrictReadAuthSession',
    sourcePath: '../../../../apps/api-v1/src/routes/group-state-routes.ts',
    declaration: 'async function readStrictReadAuthSession',
  },
  {
    symbol: 'assertCanReadGroupRef',
    sourcePath: '../../../../apps/api-v1/src/routes/group-state-routes.ts',
    declaration: 'async function assertCanReadGroupRef',
  },
  {
    symbol: 'assertCanReadGroupState',
    sourcePath: '../../../../apps/api-v1/src/routes/group-state-routes.ts',
    declaration: 'async function assertCanReadGroupState',
  },
  {
    symbol: 'hydrateGroupSnapshots',
    sourcePath: '../../../../apps/api-v1/src/routes/group-state-routes.ts',
    declaration: 'function hydrateGroupSnapshots',
  },
  {
    symbol: 'listRecentGroupEventsForArrayRoute',
    sourcePath: '../../../../apps/api-v1/src/routes/group-state-routes.ts',
    declaration: 'async function listRecentGroupEventsForArrayRoute',
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
    symbol: 'readGroupStateInboxResult',
    sourcePath: './inbox/group-state-inbox-result.ts',
    declaration: 'export async function readGroupStateInboxResult',
  },
  {
    symbol: 'AppInboxService',
    sourcePath: '../services/AppInboxService.ts',
    declaration: 'export class AppInboxService',
  },
  {
    symbol: 'AppInboxTransactionWriter',
    sourcePath: '../services/app-inbox-transaction-writer.ts',
    declaration: 'export class AppInboxTransactionWriter',
  },
  {
    symbol: 'createGroupStateService',
    sourcePath: './group-state-service.ts',
    declaration: 'export function createGroupStateService',
  },
  {
    symbol: 'createQueryOperations',
    sourcePath: './group-state-service.ts',
    declaration: 'function createQueryOperations(',
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
    symbol: 'initWsLifecycle',
    sourcePath: '../services/ws-lifecycle-service.ts',
    declaration: 'export function initWsLifecycle',
  },
  {
    symbol: 'initPresenceExpiryReconciliation',
    sourcePath: './presence/reconcile-expired-group-presence.ts',
    declaration: 'export async function initPresenceExpiryReconciliation',
  },
  {
    symbol: 'enqueuePresenceExpiryReconciliation',
    sourcePath: './presence/reconcile-expired-group-presence.ts',
    declaration: 'export async function enqueuePresenceExpiryReconciliation',
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
  {
    symbol: 'canReadGroupSnapshot',
    sourcePath: '../group-policy.ts',
    declaration: 'export function canReadGroupSnapshot',
  },
  {
    symbol: 'toGroupStateErrorResponse',
    sourcePath: '../../../../apps/api-v1/src/routes/group-state-route-errors.ts',
    declaration: 'export function toGroupStateErrorResponse',
  },
  {
    symbol: 'createRallarServer',
    sourcePath: '../../../../apps/api-v1/src/create-rallar-server.ts',
    declaration: 'export function createRallarServer',
  },
] as const;

describe('group-state navigation map integrity', () => {
  it('links every named source owner to its current declaration', () => {
    const navigationMap = readRepo(navigationMapPath);
    const sourceLinks = uniqueSourceLinks(readMarkdownLinks(navigationMap));

    expect(sortMarkdownLinks(sourceLinks)).toEqual(
      sortMarkdownLinks(
        navigationSourceLinks.map(({ symbol, sourcePath }) => ({
          label: symbol,
          target: sourcePath,
        })),
      ),
    );

    for (const link of navigationSourceLinks) {
      const source = readRelativeToNavigationMap(link.sourcePath);
      expect(source, `${link.sourcePath} (${link.symbol})`).toContain(link.declaration);
    }
  });

  it('keeps the map reachable once from shared-server architecture', () => {
    const architecture = readRepo(architecturePath);
    expect(readArchitectureNavigationLinks(architecture)).toEqual([architectureNavigationLink]);
  });

  it('finds the required architecture link without forbidding unrelated links', () => {
    const architecture = [
      '[Group-state server navigation map](./rallar-system/group-state/README.md)',
      '[Repository guide](./rallar-server-repositories.md)',
    ].join('\n');

    expect(readArchitectureNavigationLinks(architecture)).toEqual([architectureNavigationLink]);
  });

  it('records cache construction before runtime-state and auth-session repositories', () => {
    const navigationMap = readRepo(navigationMapPath);
    const construction = readMarkdownSection(navigationMap, '## Construction And Registration');

    expect(construction).toContain(
      'creates the group repository and its GroupStateSnapshotReadThroughCache first',
    );
    expect(construction).toContain(
      'then creates the runtime-state repository and auth-session repository',
    );
  });
});

function readMarkdownLinks(source: string): readonly Readonly<{ label: string; target: string }>[] {
  return [...source.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((match) => ({
    label: match[1],
    target: match[2],
  }));
}

function readArchitectureNavigationLinks(
  source: string,
): readonly Readonly<{ label: string; target: string }>[] {
  return readMarkdownLinks(source).filter(
    (link) =>
      link.label === architectureNavigationLink.label &&
      link.target === architectureNavigationLink.target,
  );
}

function uniqueSourceLinks(
  links: readonly Readonly<{ label: string; target: string }>[],
): readonly Readonly<{ label: string; target: string }>[] {
  return links.filter(
    (link, index) =>
      link.target.endsWith('.ts') &&
      links.findIndex(
        (candidate) => candidate.label === link.label && candidate.target === link.target,
      ) === index,
  );
}

function sortMarkdownLinks(
  links: readonly Readonly<{ label: string; target: string }>[],
): readonly Readonly<{ label: string; target: string }>[] {
  return [...links].toSorted((left, right) =>
    `${left.label}\u0000${left.target}`.localeCompare(`${right.label}\u0000${right.target}`),
  );
}

function readMarkdownSection(source: string, heading: string): string {
  const start = source.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const nextHeading = source.indexOf('\n## ', start + heading.length);
  return source.slice(start, nextHeading < 0 ? source.length : nextHeading);
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
