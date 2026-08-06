import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
    expect(readTimeline(readme, 'PR A compute and result timeline')).toEqual([
      'computeClientMutation validates the command, persisted facts, and stable read before making a decision.',
      'An existing idempotency record exits as exact replay or exact hash conflict before operation-family dispatch.',
      'The exhaustive operation switch calls exactly one named principal, instance, connect, heartbeat, disconnect, or expiry owner.',
      'The family owner makes the pure state decision and delegates shared audit, revision, candidate, snapshot, event, receipt, state-sync, and outbox construction to the named compute-state and compute-result owners.',
      'validateClientMutation validates, in order, the command, facts, computed result, command identity, stable read, durable authority, and session identity; an idempotency conflict exits next, receipt identity follows, and non-write results then return.',
      'Writes continue through effectful result correlations, exact outbox validation, the principal guard, the session guard and causal generation, then the instance guard before the unchanged write phase.',
    ]);
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
    expect(readTimeline(readme, 'PR B persistence and stable-read timeline')).toEqual([
      'ClientStateRepository constructs one RuntimeStateJsonStore-backed canonical repository with the existing event-store selection.',
      'Read owners decode the canonical storage key, validate the persisted value against its decoded scope, and fail closed with ClientStateRepositoryInvariantCorruptionError on corruption.',
      'readPrincipalSnapshot reads the principal before and after its child instances and sessions; equal principal revisions assemble one canonical snapshot, while changed principals retry through readStableStateSnapshot.',
      'listSnapshots performs the same before/after principal guard for a scoped aggregate list and falls back to an individual stable snapshot when a principal changes.',
      'Snapshot assembly filters logically active sessions, orders instances and sessions by canonical storage key, validates the authoritative snapshot, and returns the existing public shape.',
      'The existing repository write methods retain their namespaces, conditional writes, event-store use, and transaction-bound construction; mutation and AppInbox owners still call the same public repository surface.',
    ]);
  });

  it('records the query, snapshot, event, and cache ownership timeline', () => {
    const readme = read(navigationPath);
    expect(readTimeline(readme, 'PR B query, snapshot, event, and cache timeline')).toEqual([
      'API, admin, statistics, and state-sync callers invoke a named ClientStateService query or a snapshot-cache operation.',
      'ClientStateRepository reads the durable aggregate, event page, or stable before-and-after snapshot through the canonical persistence owners.',
      'Persistence decoding validates stored contracts and snapshot assembly preserves canonical instance and active-session ordering.',
      'ClientStateSnapshotReadThroughCache may reuse only a presence-fresh snapshot that satisfies the requested minimum revision; otherwise it loads or refreshes durable state.',
      'Cache observation preserves monotonic snapshot identity and conflict behavior, while CachedClientStateService observes explicit committed snapshots and list results.',
      'The cache remains a latest-value view rather than mutation authority, and the unchanged snapshot, event, error, and caller result exits to the original consumer.',
    ]);
  });

  it('keeps enqueue wake before later invocation and post-commit observation', () => {
    const readme = read(navigationPath);
    expect(readTimeline(readme, 'Construction, registration, and enqueue timeline')).toEqual([
      'API composition creates the durable repositories, database, canonical client-state service, timing sink, and queue-engine wake capability before constructing AppClientInboxService.',
      'RallarMiddleware creates InboxQueueReader and invokes the canonical AppClientInboxService factory with the already-created queue reader and wake capability.',
      'AppInboxService constructs its transaction writer and stores the enqueue-time owning-queue wake capability before AppClientInboxService constructs ClientStateInboxHandler.',
      'AppClientInboxService passes that existing writer and every required service capability to ClientStateInboxHandler, then registers the same eight callbacks through AppInboxService.onStateMessage in their established order.',
      'A route, authorized-WebSocket adapter, or maintenance producer first asks AppClientInboxService to validate ingress and project the payload or authority.',
      'AppInboxService serializes the command, durably reserves or reuses the AppInbox entry, invokes the owning-queue wake immediately after persistence, then asserts matching command identity before returning the entry.',
      'A synchronous producer waits by polling the durable result; there is no post-commit queue wake in the client-state path.',
    ]);
    expect(readTimeline(readme, 'Runtime invocation and transaction timeline')).toEqual([
      'InboxQueueReader later claims the durable entry and invokes the registered AppClientInboxService callback once for that processing attempt.',
      'AppInboxService validates the durable command identity and begins attempt finalization before invoking the registered callback.',
      'AppClientInboxService delegates to ClientStateInboxHandler, which projects the command then visibly runs client-state read, compute, and validate from fresh state for that attempt.',
      'ClientStateInboxHandler selects the ordinary, inactive WebSocket, active WebSocket, missing-session disconnect, or expiry transaction path; AppInboxTransactionWriter owns the transaction and receives the exact durable result separately from private committed snapshots.',
      'ClientStateService performs the conditional state, receipt, event, and final outbox writes; AppInboxTransactionWriter writes the byte-compatible durable result, completes the reservation, and commits them together.',
      'The writer returns only after confirmed commit, then ClientStateInboxHandler observes its private committed snapshots; observation is not a queue wake.',
      'The registered callback returns the confirmed result, and a waiting producer reads the same durable result for its caller-visible outcome.',
      'A retryable failure leaves the entry for ResourceInbox retry; the next claimed attempt re-enters identity validation and the complete command/read/compute/validate path without repeating the original enqueue wake.',
    ]);
  });

  it('records the authorized-WebSocket entry, decisions, and exits', () => {
    expect(readTimeline(read(navigationPath), 'Authorized WebSocket family')).toEqual([
      'Authorized WebSocket upgrade or close projects the connect or disconnect enqueue; AppInbox persists it and performs the only queue wake.',
      'The registered callback later invokes processAuthorisedWsConnect or processAuthorisedWsDisconnect once for the ResourceInbox attempt.',
      'Connect reads generation authority; a closed generation exits through writeInactiveGeneration, while an active generation computes and validates the client mutation and lifecycle guard.',
      'Disconnect computes the closed lifecycle; a missing session exits through writeMissingSessionDisconnect, while an existing session computes and validates the client mutation.',
      'commitComputed gives lifecycle and client writes to AppInboxTransactionWriter; after confirmed commit it observes the exact snapshot without another queue wake and returns the durable result.',
      'Retryable failures re-enter the complete family path; terminal failures finalize durably, transaction failures roll back, and no family-local cleanup replaces ResourceInbox recovery.',
    ]);
  });

  it('records the expiry-maintenance entry, decisions, and exits', () => {
    expect(readTimeline(read(navigationPath), 'Expiry maintenance family')).toEqual([
      'initPresenceExpiryReconciliation delegates to tryRunInIntervals, which invokes enqueuePresenceExpiryReconciliation immediately.',
      'The initialization promise resolves after the first successful client and group enqueue work; only then does tryRunInIntervals retain the next interval.',
      'When producer failure occurs before an AppInbox entry exists, tryRunInIntervals owns retry and backoff; this path does not enter client candidate discovery.',
      'The registered CLIENT_EXPIRED_SESSIONS callback later invokes processExpiredSessionCommands once for the ResourceInbox attempt.',
      'computeExpiredSessionMutations reads candidates and runs every fresh mutation phase in order; an empty or all-no-write batch exits with an empty durable list.',
      'AppInboxTransactionWriter commits writes and the durable result before ordered observation; a waiting caller receives the durable list, terminal failures finalize, and transaction failures roll back.',
      'Later ResourceInbox retries re-enter candidate discovery and every mutation phase from fresh state; the initialization API exposes no cancellation or cleanup handle.',
    ]);
  });

  it('names the implemented target handler construction and ordinary entry', () => {
    const plan = read(planPath);
    expect(plan).toContain('-> new ClientStateInboxHandler(...)');
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
    /^## Compatibility paths and removal conditions\n\n[\s\S]+?\n\n(\| Compatibility path[\s\S]+?)\n\n/m,
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
