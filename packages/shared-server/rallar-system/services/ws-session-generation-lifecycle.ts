import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '../../postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import type {
  RuntimeStateEntry,
  RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';

const SESSION_GENERATION_LIFECYCLE_NAMESPACE = 'ws-session-generation-lifecycle';
const SESSION_GENERATION_LIFECYCLE_EXPIRE_AT_EPOCH_MS = 253_402_300_799_999;

export interface WsSessionGenerationFacts {
  readonly sessionId: string;
  readonly generationId: string;
  readonly generationStartedAtEpochMs: number;
}

export interface WsSessionGenerationCloseFacts extends WsSessionGenerationFacts {
  readonly disconnectedAtEpochMs: number;
  readonly reason: string;
}

export type WsSessionGenerationLifecycleState = Readonly<{
  version: 1;
  sessionId: string;
  generationId: string;
  generationStartedAtEpochMs: number;
  status: 'open' | 'closed';
  disconnectedAtEpochMs: number | null;
  reason: string | null;
}>;

export type WsSessionGenerationLifecycleRead = Readonly<{
  key: string;
  entry: RuntimeStateEntry | null;
  state: WsSessionGenerationLifecycleState | null;
}>;

export type WsSessionGenerationLifecycleComputed = Readonly<{
  outcome: 'none' | 'insert' | 'update';
  key: string;
  expectedRevision: number | null;
  state: WsSessionGenerationLifecycleState;
}>;

export interface WsSessionGenerationLifecycleService {
  read(facts: WsSessionGenerationFacts): Promise<WsSessionGenerationLifecycleRead>;
  computeOpen(
    facts: WsSessionGenerationFacts,
    read: WsSessionGenerationLifecycleRead,
  ): WsSessionGenerationLifecycleComputed;
  computeClosed(
    facts: WsSessionGenerationCloseFacts,
    read: WsSessionGenerationLifecycleRead,
  ): WsSessionGenerationLifecycleComputed;
  write(
    transaction: PSqlTransactionSql,
    computed: WsSessionGenerationLifecycleComputed,
  ): Promise<void>;
}

export function createWsSessionGenerationLifecycleService(
  repository: RuntimeStateOptimisticTransactionalRepositoryLike,
): WsSessionGenerationLifecycleService {
  return {
    read: async (facts) => {
      validateFacts(facts);
      const key = toLifecycleKey(facts);
      const entry = await repository.findEntry(SESSION_GENERATION_LIFECYCLE_NAMESPACE, key);
      return {
        key,
        entry: entry ?? null,
        state: entry ? readLifecycleState(entry.value, facts) : null,
      };
    },
    computeOpen: (facts, read) => {
      validateRead(facts, read);
      const open = toOpenState(facts);
      if (!read.entry) return toComputed('insert', read, open);
      if (read.state?.status === 'closed') return toComputed('none', read, read.state);
      return toComputed('update', read, open);
    },
    computeClosed: (facts, read) => {
      validateCloseFacts(facts);
      validateRead(facts, read);
      const closed = toClosedState(facts);
      if (!read.entry) return toComputed('insert', read, closed);
      if (read.state?.status === 'closed') {
        if (!sameLifecycleState(read.state, closed)) {
          throw new TypeError('WebSocket session generation close facts differ');
        }
        return toComputed('none', read, read.state);
      }
      return toComputed('update', read, closed);
    },
    write: async (transaction, computed) => {
      if (computed.outcome === 'none') return;
      const target = new PSqlRuntimeStateRepository(transaction);
      const value = JSON.stringify(computed.state);
      const result = computed.outcome === 'insert'
        ? await target.insertIfAbsent(
          SESSION_GENERATION_LIFECYCLE_NAMESPACE,
          computed.key,
          value,
          SESSION_GENERATION_LIFECYCLE_EXPIRE_AT_EPOCH_MS,
        )
        : await target.upsertIfRevision(
          SESSION_GENERATION_LIFECYCLE_NAMESPACE,
          computed.key,
          value,
          SESSION_GENERATION_LIFECYCLE_EXPIRE_AT_EPOCH_MS,
          requireExpectedRevision(computed),
        );
      if (result.status === 'conflict') throw new RuntimeStateWriteConflictError();
    },
  };
}

function toComputed(
  outcome: WsSessionGenerationLifecycleComputed['outcome'],
  read: WsSessionGenerationLifecycleRead,
  state: WsSessionGenerationLifecycleState,
): WsSessionGenerationLifecycleComputed {
  return {
    outcome,
    key: read.key,
    expectedRevision: read.entry?.revision ?? null,
    state,
  };
}

function toOpenState(facts: WsSessionGenerationFacts): WsSessionGenerationLifecycleState {
  return {
    version: 1,
    ...facts,
    status: 'open',
    disconnectedAtEpochMs: null,
    reason: null,
  };
}

function toClosedState(
  facts: WsSessionGenerationCloseFacts,
): WsSessionGenerationLifecycleState {
  return {
    version: 1,
    sessionId: facts.sessionId,
    generationId: facts.generationId,
    generationStartedAtEpochMs: facts.generationStartedAtEpochMs,
    status: 'closed',
    disconnectedAtEpochMs: facts.disconnectedAtEpochMs,
    reason: facts.reason,
  };
}

function readLifecycleState(
  value: string,
  facts: WsSessionGenerationFacts,
): WsSessionGenerationLifecycleState {
  const state = JSON.parse(value) as WsSessionGenerationLifecycleState;
  if (
    state.version !== 1 ||
    state.sessionId !== facts.sessionId ||
    state.generationId !== facts.generationId ||
    state.generationStartedAtEpochMs !== facts.generationStartedAtEpochMs ||
    !['open', 'closed'].includes(state.status) ||
    (state.status === 'open' &&
      (state.disconnectedAtEpochMs !== null || state.reason !== null)) ||
    (state.status === 'closed' &&
      (!Number.isSafeInteger(state.disconnectedAtEpochMs) || !state.reason))
  ) {
    throw new TypeError('WebSocket session generation lifecycle state is invalid');
  }
  return state;
}

function validateRead(
  facts: WsSessionGenerationFacts,
  read: WsSessionGenerationLifecycleRead,
): void {
  validateFacts(facts);
  if (read.key !== toLifecycleKey(facts) || (read.entry === null) !== (read.state === null)) {
    throw new TypeError('WebSocket session generation lifecycle read is invalid');
  }
}

function validateFacts(facts: WsSessionGenerationFacts): void {
  if (
    !facts.sessionId ||
    !facts.generationId ||
    !Number.isSafeInteger(facts.generationStartedAtEpochMs) ||
    facts.generationStartedAtEpochMs < 0
  ) {
    throw new TypeError('WebSocket session generation facts are invalid');
  }
}

function validateCloseFacts(facts: WsSessionGenerationCloseFacts): void {
  validateFacts(facts);
  if (
    !Number.isSafeInteger(facts.disconnectedAtEpochMs) ||
    facts.disconnectedAtEpochMs < facts.generationStartedAtEpochMs ||
    !facts.reason
  ) {
    throw new TypeError('WebSocket session generation close facts are invalid');
  }
}

function toLifecycleKey(facts: WsSessionGenerationFacts): string {
  return [facts.sessionId, facts.generationId].map(encodeURIComponent).join(':');
}

function requireExpectedRevision(computed: WsSessionGenerationLifecycleComputed): number {
  if (computed.expectedRevision === null) {
    throw new TypeError('WebSocket session generation update revision is missing');
  }
  return computed.expectedRevision;
}

function sameLifecycleState(
  left: WsSessionGenerationLifecycleState,
  right: WsSessionGenerationLifecycleState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
