import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  expectedAuthorizedWebSocketTimeline,
  expectedComputeAndResultTimeline,
  expectedConstructionTimeline,
  expectedExpiryTimeline,
  expectedPersistenceTimeline,
  expectedQueryCacheTimeline,
  expectedRuntimeTimeline,
} from './client-state-navigation-trace-evidence.js';

const repoRoot = process.cwd();
const navigationPath = 'packages/shared-server/rallar-system/client-state/README.md';
const architecturePath = 'packages/shared-server/architecture.md';
const planPath = 'plans/rallar-client-state-server-structure-plan.md';
const expiryReconciliationPath = '../group-state/presence/reconcile-expired-group-presence.ts';
const prACohortLinks = [
  ['./client-state-contract-validation.ts', 'function validateClientPrincipal('],
  ['./client-mutation-receipt-validation.ts', 'function validateClientMutationReceipt('],
  ['./client-state-semantic-equality.ts', 'function sameClientPrincipalState('],
  ['./client-state-validation-primitives.ts', 'class ClientMutationRejectedError'],
  ['./mutation/client-mutation-contracts.ts', 'type ClientMutationCommand ='],
  ['./mutation/client-mutation-command.ts', 'function toClientMutationCommand('],
  ['./mutation/client-mutation-authority.ts', 'function toClientMutationIssuedSessionAuthority('],
  [
    './mutation/validate-client-expired-session-authority.ts',
    'function validateClientExpiredSessionAuthority(',
  ],
  [
    './mutation/command-validation/validate-client-mutation-command.ts',
    'function validateClientMutationCommand(',
  ],
  [
    './mutation/command-validation/validate-client-mutation-operation-input.ts',
    'function validateClientMutationOperationInput(',
  ],
  [
    './mutation/command-validation/validate-client-mutation-request.ts',
    'function validateClientMutationRequest(',
  ],
  ['./mutation/compute/compute-client-mutation.ts', 'function computeClientMutation('],
  ['./mutation/compute/compute-client-mutation-result.ts', 'function computeClientMutationResult('],
  ['./mutation/compute/compute-client-mutation-state.ts', 'function bumpClientPrincipal('],
  [
    './mutation/compute/compute-client-principal-mutation.ts',
    'function computeClientPrincipalMutation(',
  ],
  [
    './mutation/compute/compute-client-instance-mutation.ts',
    'function computeClientInstanceMutation(',
  ],
  ['./mutation/compute/compute-client-session-connect.ts', 'function computeClientSessionConnect('],
  [
    './mutation/compute/compute-client-session-heartbeat.ts',
    'function computeClientSessionHeartbeat(',
  ],
  [
    './mutation/compute/compute-client-session-disconnect.ts',
    'function computeClientSessionDisconnect(',
  ],
  ['./mutation/compute/compute-client-session-expiry.ts', 'function computeClientSessionExpiry('],
  [
    './mutation/result-validation/validate-client-mutation-read.ts',
    'function validateClientMutationRead(',
  ],
  [
    './mutation/result-validation/validate-client-mutation-authority-policy.ts',
    'function validateClientMutationAuthorityPolicy(',
  ],
  [
    './mutation/result-validation/validate-client-mutation-result.ts',
    'function validateClientMutationResult(',
  ],
  ['./mutation/result-validation/validate-client-mutation.ts', 'function validateClientMutation('],
] as const;

const prBPersistenceCohortLinks = [
  ['./client-presence-state.ts', 'function toClientPresenceState('],
  [
    './persistence/client-state-persistence-contracts.ts',
    'class ClientStateRepositoryInvariantCorruptionError',
  ],
  ['./persistence/client-state-runtime-namespaces.ts', 'const CLIENT_STATE_PRINCIPALS_NAMESPACE'],
  ['./persistence/client-state-storage-keys.ts', 'function clientStatePrincipalStorageKey('],
  [
    './persistence/validate-persisted-client-state.ts',
    'function validatePersistedClientPrincipal(',
  ],
  [
    './persistence/client-state-persistence-codec.ts',
    'function normalizePersistedClientPrincipal(',
  ],
  ['./persistence/client-state-repository-reads.ts', 'class ClientStateRepositoryReads'],
  ['./persistence/assemble-client-state-snapshot.ts', 'function assembleClientStateSnapshot('],
  ['./persistence/client-state-snapshot-repository.ts', 'class ClientStateSnapshotRepository'],
  ['./persistence/client-state-repository.ts', 'class ClientStateRepository'],
] as const;

const prBOrdinaryTransactionCohortLinks = [
  ['./client-state-service-contracts.ts', 'type ClientStateService ='],
  ['./client-state-service.ts', 'function createClientStateService('],
  ['./client-state-service-timing.ts', 'function createTimedClientStateService('],
  ['./mutation/read/read-client-mutation.ts', 'function readClientMutation('],
  ['./mutation/write/write-client-mutation.ts', 'function writeClientMutation('],
  ['./inbox/app-client-inbox-contracts.ts', 'const CLIENT_STATE_INBOX_REGISTRATION_TYPES'],
  ['./inbox/authenticated-client-mutation-ingress.ts', 'function readClientMutationAuthority<'],
  ['./inbox/authorised-ws-client-app-inbox.ts', 'function toAuthorisedWsClientConnectEnqueue('],
  ['./inbox/client-state-inbox-handler.ts', 'class ClientStateInboxHandler'],
  ['./inbox/app-client-inbox-service.ts', 'class AppClientInboxService'],
  ['./inbox/app-client-inbox-service.ts', 'public async processAuthorisedWsClientConnect('],
  ['./inbox/app-client-inbox-service.ts', 'public async processAuthorisedWsClientDisconnect('],
  ['./inbox/client-state-inbox-handler.ts', 'async processAuthorisedWsConnect('],
  ['./inbox/client-state-inbox-handler.ts', 'private async writeInactiveGeneration('],
  ['./inbox/client-state-inbox-handler.ts', 'async processAuthorisedWsDisconnect('],
  ['./inbox/client-state-inbox-handler.ts', 'private async writeMissingSessionDisconnect('],
  [expiryReconciliationPath, 'export async function initPresenceExpiryReconciliation('],
  [expiryReconciliationPath, 'export async function enqueuePresenceExpiryReconciliation('],
  ['../../../shared/resilience/TryWith.ts', 'export function tryRunInIntervals<'],
  ['./inbox/app-client-inbox-service.ts', 'private registerExpiredClientSessions(): void'],
  ['./inbox/client-state-inbox-handler.ts', 'async processExpiredSessionCommands('],
  ['./inbox/client-state-inbox-handler.ts', 'private async computeExpiredSessionMutations('],
] as const;

const prBQueryCacheCohortLinks = [
  ['./snapshot/cached-client-state-service.ts', 'function createCachedClientStateService('],
  [
    './snapshot/client-state-snapshot-read-through-cache.ts',
    'class ClientStateSnapshotReadThroughCache',
  ],
] as const;

const expectedCompatibilityRows = [
  {
    compatibilityPath: 'client-presence-state.ts',
    canonicalOwner: 'client-state/client-presence-state.ts',
    removalCondition:
      'Internal direct-import proof plus no external/deep consumer, or a breaking release.',
  },
  {
    compatibilityPath: 'client-state-storage-keys.ts',
    canonicalOwner: 'client-state/persistence/client-state-storage-keys.ts',
    removalCondition:
      'Internal direct-import proof plus no external/deep consumer, or a breaking release.',
  },
  {
    compatibilityPath: 'repositories/ClientStateRepository.ts',
    canonicalOwner: 'client-state/persistence/client-state-repository.ts',
    removalCondition: 'A breaking release or separately approved public migration.',
  },
  {
    compatibilityPath: 'services/client-state-service.ts',
    canonicalOwner: 'client-state/client-state-service.ts',
    removalCondition:
      'A breaking release or separately approved consumer migration proving no active import.',
  },
  {
    compatibilityPath: 'services/AppClientInboxService.ts',
    canonicalOwner: 'client-state/inbox/app-client-inbox-service.ts',
    removalCondition: 'A breaking release or separately approved consumer migration.',
  },
  {
    compatibilityPath: 'services/client-state-mutations.ts',
    canonicalOwner: 'client-state/mutation/* and canonical validation owners',
    removalCondition:
      'All internal callers migrate and a separately approved API/public removal completes.',
  },
  {
    compatibilityPath: 'services/authorised-ws-client-app-inbox.ts',
    canonicalOwner: 'client-state/inbox/authorised-ws-client-app-inbox.ts',
    removalCondition:
      'The future API-v1 client-state route child migrates its callers and proves no other import.',
  },
  {
    compatibilityPath: 'services/client-mutation-authority.ts',
    canonicalOwner: 'client-state/mutation/client-mutation-authority.ts',
    removalCondition:
      'All internal callers migrate and an active-import scan proves no external consumer.',
  },
  {
    compatibilityPath: 'services/client-expired-state-authority.ts',
    canonicalOwner: 'client-state/mutation/validate-client-expired-session-authority.ts',
    removalCondition:
      'Canonical internal import proof and an active-import scan proving no external consumer.',
  },
  {
    compatibilityPath: 'services/client-state-semantic-equality.ts',
    canonicalOwner: 'client-state/client-state-semantic-equality.ts',
    removalCondition:
      'Canonical internal import proof and an active-import scan proving no external consumer.',
  },
  {
    compatibilityPath: 'services/cached-client-state-service.ts',
    canonicalOwner: 'client-state/snapshot/cached-client-state-service.ts',
    removalCondition: 'A breaking release or separately approved consumer migration.',
  },
  {
    compatibilityPath: 'services/client-state-snapshot-read-through-cache.ts',
    canonicalOwner: 'client-state/snapshot/client-state-snapshot-read-through-cache.ts',
    removalCondition: 'A breaking release or separately approved consumer migration.',
  },
] as const;

describe('client-state navigation map integrity', () => {
  it('links every PR A owner to its named primary symbol', () => {
    const readme = read(navigationPath);
    for (const [target, declaration] of prACohortLinks) {
      expect(readme, target).toContain(`](${target})`);
      const resolved = path.resolve(path.dirname(absolute(navigationPath)), target);
      expect(existsSync(resolved), target).toBe(true);
      expect(readFileSync(resolved, 'utf8'), declaration).toContain(declaration);
    }
  });

  it('links every PR B persistence owner to its named primary symbol', () => {
    const readme = read(navigationPath);
    for (const [target, declaration] of prBPersistenceCohortLinks) {
      expect(readme, target).toContain(`](${target})`);
      const resolved = path.resolve(path.dirname(absolute(navigationPath)), target);
      expect(existsSync(resolved), target).toBe(true);
      expect(readFileSync(resolved, 'utf8'), declaration).toContain(declaration);
    }
  });

  it('links every PR B ordinary transaction owner to its named primary symbol', () => {
    const readme = read(navigationPath);
    for (const [target, declaration] of prBOrdinaryTransactionCohortLinks) {
      expect(readme, target).toContain(`](${target})`);
      const resolved = path.resolve(path.dirname(absolute(navigationPath)), target);
      expect(existsSync(resolved), target).toBe(true);
      expect(readFileSync(resolved, 'utf8'), declaration).toContain(declaration);
    }
  });

  it('links every PR B query and cache owner to its named primary symbol', () => {
    const readme = read(navigationPath);
    for (const [target, declaration] of prBQueryCacheCohortLinks) {
      expect(readme, target).toContain(`](${target})`);
      const resolved = path.resolve(path.dirname(absolute(navigationPath)), target);
      expect(existsSync(resolved), target).toBe(true);
      expect(readFileSync(resolved, 'utf8'), declaration).toContain(declaration);
    }
  });

  it('records the direct compute and result-validation path', () => {
    const readme = read(navigationPath);
    expect(readTimeline(readme, 'PR A compute and result timeline')).toEqual(
      expectedComputeAndResultTimeline,
    );
  });

  it('records the current and cohort target mutation timelines', () => {
    const readme = read(navigationPath);
    expect(readme).toContain('## Construction, registration, and enqueue timeline');
    expect(readme).toContain('## Runtime invocation and transaction timeline');
    expect(readme).toContain('## PR A command and validation timeline');
    expect(readme).toContain('AppInboxService');
    expect(readme).toContain('validateClientMutationCommand');
    expect(readme).toContain('toClientMutationCommand');
  });

  it('lists every retained compatibility path with its direct canonical owner', () => {
    expect(readCompatibilityRows(read(navigationPath))).toEqual(expectedCompatibilityRows);
  });

  it('keeps source-derived traces separate from an unavailable navigation-time sample', () => {
    expect(read(navigationPath)).toContain(
      'No controlled human navigation-time sample is recorded in this map.',
    );
  });

  it('records the persistence stable-read ownership timeline', () => {
    const readme = read(navigationPath);
    expect(readTimeline(readme, 'PR B persistence and stable-read timeline')).toEqual(
      expectedPersistenceTimeline,
    );
  });

  it('records the query, snapshot, event, and cache ownership timeline', () => {
    const readme = read(navigationPath);
    expect(readTimeline(readme, 'PR B query, snapshot, event, and cache timeline')).toEqual(
      expectedQueryCacheTimeline,
    );
  });

  it('keeps enqueue wake before later invocation and post-commit observation', () => {
    const readme = read(navigationPath);
    expect(readTimeline(readme, 'Construction, registration, and enqueue timeline')).toEqual(
      expectedConstructionTimeline,
    );
    expect(readTimeline(readme, 'Runtime invocation and transaction timeline')).toEqual(
      expectedRuntimeTimeline,
    );
  });

  it('records the authorized-WebSocket entry, decisions, and exits', () => {
    expect(readTimeline(read(navigationPath), 'Authorized WebSocket family')).toEqual(
      expectedAuthorizedWebSocketTimeline,
    );
  });

  it('records the expiry-maintenance entry, decisions, and exits', () => {
    expect(readTimeline(read(navigationPath), 'Expiry maintenance family')).toEqual(
      expectedExpiryTimeline,
    );
  });

  it('names the implemented target handler construction and ordinary entry', () => {
    const plan = read(planPath);
    expect(plan).toContain(`-> new AppClientInboxService(existing public constructor preserved)
  -> AppInboxService constructs AppInboxTransactionWriter
  -> AppClientInboxService constructs new ClientStateInboxHandler(...)
  -> register the same eight AppInbox types in predecessor order`);
    expect(plan).toContain('-> ClientStateInboxHandler.processCommand');
    expect(plan).toContain(
      '-> tryRunInIntervals immediately invokes enqueuePresenceExpiryReconciliation',
    );
    expect(plan).not.toContain('createClientStateInboxHandler');
    expect(plan).not.toContain('ClientStateInboxHandler.processClientStateMutation');
  });

  it('keeps the navigation owner reachable once from shared-server architecture', () => {
    const architecture = read(architecturePath);
    expect(architecture.match(/\.\/rallar-system\/client-state\/README\.md/g)).toHaveLength(1);
  });
});

function absolute(filePath: string): string {
  return path.join(repoRoot, filePath);
}
function read(filePath: string): string {
  return readFileSync(absolute(filePath), 'utf8');
}
function readTimeline(readme: string, heading: string): readonly string[] {
  const section = readme.match(
    new RegExp(
      `^## ${heading}\\n\\n(?:[^\\n]*\\n)*?\\x60\\x60\\x60text\\n([\\s\\S]+?)\\n\\x60\\x60\\x60`,
      'm',
    ),
  )?.[1];
  if (!section) throw new Error(`Missing structured timeline: ${heading}`);
  return section.split('\n').map((line) => line.replace(/^\d+\. /, ''));
}

function readCompatibilityRows(readme: string): readonly {
  readonly compatibilityPath: string;
  readonly canonicalOwner: string;
  readonly removalCondition: string;
}[] {
  const section = readme.match(
    new RegExp(
      '^## Compatibility paths and removal conditions\\n\\n[\\s\\S]+?\\n\\n' +
        '(\\| Compatibility path[\\s\\S]+?)\\n\\n',
      'm',
    ),
  )?.[1];
  if (!section) throw new Error('Missing compatibility path table');

  return section
    .split('\n')
    .slice(2)
    .map((row) => row.slice(1, -1).split('|').map(toCompatibilityCell))
    .map(([compatibilityPath, canonicalOwner, removalCondition]) => ({
      compatibilityPath,
      canonicalOwner,
      removalCondition,
    }));
}

function toCompatibilityCell(value: string): string {
  return value.trim().replaceAll('`', '');
}
