import type {
  ClientStateSnapshotReadOptions,
  StateSnapshotReadCleanupOutcome,
  StateSnapshotReadDiagnosticEvent,
  StateSnapshotReadDiagnosticsSink,
  StateSnapshotReadResult,
  StateSnapshotReadSource,
} from '@shared/api/state-snapshot-read.ts';
import type {
  ClientPrincipalRef,
  ClientSnapshot,
} from '@shared/api/client-types.ts';
import { readClientStateRevision } from '@shared/api/group-client-views.ts';
import type { StateSnapshotObservation } from '@shared/repository/state-snapshot-revision.ts';

export interface ClientRestSnapshotReadRequest
  extends ClientStateSnapshotReadOptions {
  readonly strictMode?: boolean;
}

export interface ClientRestSnapshotReadSelector {
  read(
    ref: ClientPrincipalRef,
    request?: ClientRestSnapshotReadRequest,
  ): Promise<StateSnapshotReadResult<ClientSnapshot>>;
}

export type ClientRestSnapshotReadSelectorDependencies = Readonly<{
  durable: Readonly<{
    readSnapshot(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>;
  }>;
  cache: Readonly<{
    peek(ref: ClientPrincipalRef): ClientSnapshot | undefined;
    observe(snapshot: ClientSnapshot): StateSnapshotObservation;
    evictIfUnchanged(
      ref: ClientPrincipalRef,
      expected: ClientSnapshot,
    ): boolean;
  }>;
  diagnostics?: StateSnapshotReadDiagnosticsSink;
  now?: () => number;
}>;

interface ClientRestSnapshotReadContext {
  readonly ref: ClientPrincipalRef;
  readonly requestedFloor?: number;
  readonly strictMode: boolean;
  readonly startedAt: number;
  source: StateSnapshotReadSource;
}

class ClientRestSnapshotReadSelectorOwner
  implements ClientRestSnapshotReadSelector {
  private readonly dependencies: ClientRestSnapshotReadSelectorDependencies;

  public constructor(
    dependencies: ClientRestSnapshotReadSelectorDependencies,
  ) {
    this.dependencies = dependencies;
  }

  public async read(
    ref: ClientPrincipalRef,
    request: ClientRestSnapshotReadRequest = {},
  ): Promise<StateSnapshotReadResult<ClientSnapshot>> {
    const context = this.toContext(ref, request);
    try {
      return await this.select(context);
    } catch (error) {
      this.emit(context, {
        source: context.source,
        result: 'error',
        floorOutcome: 'not-evaluated',
        cleanupOutcome: 'not-attempted',
        strictMode: context.strictMode,
      });
      throw error;
    }
  }

  private toContext(
    ref: ClientPrincipalRef,
    request: ClientRestSnapshotReadRequest,
  ): ClientRestSnapshotReadContext {
    return {
      ref,
      requestedFloor: request.minStateRevision,
      strictMode: request.strictMode ?? false,
      startedAt: this.dependencies.now?.() ?? Date.now(),
      source: 'cache',
    };
  }

  private async select(
    context: ClientRestSnapshotReadContext,
  ): Promise<StateSnapshotReadResult<ClientSnapshot>> {
    const observed = this.dependencies.cache.peek(context.ref);
    const cached = this.selectCache(context, observed);
    if (cached) return cached;
    return await this.readDurable(context, observed);
  }

  private selectCache(
    context: ClientRestSnapshotReadContext,
    observed: ClientSnapshot | undefined,
  ): StateSnapshotReadResult<ClientSnapshot> | undefined {
    if (
      context.requestedFloor === undefined ||
      context.strictMode ||
      observed === undefined ||
      readClientStateRevision(observed) < context.requestedFloor
    ) {
      return undefined;
    }

    this.emitFound(context, 'cache', 'satisfied');
    return { status: 'found', source: 'cache', snapshot: observed };
  }

  private async readDurable(
    context: ClientRestSnapshotReadContext,
    observed: ClientSnapshot | undefined,
  ): Promise<StateSnapshotReadResult<ClientSnapshot>> {
    context.source = 'durable';
    const snapshot = await this.dependencies.durable.readSnapshot(context.ref);
    if (!snapshot) return this.toNotFound(context, observed);

    this.dependencies.cache.observe(snapshot);
    if (
      context.requestedFloor !== undefined &&
      readClientStateRevision(snapshot) < context.requestedFloor
    ) {
      this.emit(context, {
        source: 'durable',
        result: 'floor-not-satisfied',
        floorOutcome: 'not-satisfied',
        cleanupOutcome: 'not-attempted',
        strictMode: context.strictMode,
      });
      return {
        status: 'floor-not-satisfied',
        source: 'durable',
        snapshot,
      };
    }

    this.emitFound(
      context,
      'durable',
      context.requestedFloor === undefined ? 'not-requested' : 'satisfied',
    );
    return { status: 'found', source: 'durable', snapshot };
  }

  private toNotFound(
    context: ClientRestSnapshotReadContext,
    observed: ClientSnapshot | undefined,
  ): StateSnapshotReadResult<ClientSnapshot> {
    const cleanupOutcome = this.cleanup(context.ref, observed);
    this.emit(context, {
      source: 'durable',
      result: 'not-found',
      floorOutcome: context.requestedFloor === undefined
        ? 'not-requested'
        : 'not-satisfied',
      cleanupOutcome,
      strictMode: context.strictMode,
    });
    return { status: 'not-found', source: 'durable' };
  }

  private cleanup(
    ref: ClientPrincipalRef,
    observed: ClientSnapshot | undefined,
  ): StateSnapshotReadCleanupOutcome {
    if (!observed) return 'not-attempted';
    return this.dependencies.cache.evictIfUnchanged(ref, observed)
      ? 'evicted'
      : 'changed-or-absent';
  }

  private emitFound(
    context: ClientRestSnapshotReadContext,
    source: StateSnapshotReadSource,
    floorOutcome: 'not-requested' | 'satisfied',
  ): void {
    this.emit(context, {
      source,
      result: 'found',
      floorOutcome,
      cleanupOutcome: 'not-attempted',
      strictMode: context.strictMode,
    });
  }

  private emit(
    context: ClientRestSnapshotReadContext,
    event: Omit<StateSnapshotReadDiagnosticEvent, 'name' | 'durationMs'>,
  ): void {
    if (!this.dependencies.diagnostics) return;
    const finishedAt = this.dependencies.now?.() ?? Date.now();
    try {
      this.dependencies.diagnostics({
        name: 'rallar.rest.client-state-snapshot-read',
        ...event,
        durationMs: Math.max(0, finishedAt - context.startedAt),
      });
    } catch {
      // Diagnostics must not change read behavior.
    }
  }
}

export function createClientRestSnapshotReadSelector(
  dependencies: ClientRestSnapshotReadSelectorDependencies,
): ClientRestSnapshotReadSelector {
  return new ClientRestSnapshotReadSelectorOwner(dependencies);
}
