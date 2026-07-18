import type {
    ClientEvent,
    ClientPrincipalRef,
    ClientSnapshot,
} from '@shared/api/client-types.ts';
import type {
    GroupEvent,
    GroupRef,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { stableJsonStringify } from '@shared/repository/state-utils.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';

export const STATE_MUTATION_OUTBOX_NAMESPACE = 'state-mutation:outbox';
const STATE_MUTATION_OUTBOX_KEY_PREFIX = 'intent:';
const STATE_MUTATION_OUTBOX_EFFECT_ORDER: readonly StateMutationOutboxEffect[] = [
    'client-state-sync',
    'group-state-sync',
    'group-presence-summary',
    'rtc-topology-recompute',
];

export type StateMutationOutboxEffect =
    | 'client-state-sync'
    | 'group-state-sync'
    | 'group-presence-summary'
    | 'rtc-topology-recompute';

export type ClientStateMutationCausalRevision = Readonly<{
    kind: 'client';
    stateRevision: number;
    snapshotVersion: number;
    presenceVersion: number;
}>;

export type GroupStateMutationCausalRevision = Readonly<{
    kind: 'group';
    stateRevision: number;
    snapshotVersion: number;
    metadataVersion: number;
    rosterVersion: number;
    presenceVersion: number;
}>;

export type StateMutationOutboxEvent =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'client'; event: ClientEvent }>
    | Readonly<{ kind: 'group'; event: GroupEvent }>;

export type StateMutationOutboxLastAttempt =
    | Readonly<{ status: 'never-attempted' }>
    | Readonly<{
        status: 'failed';
        attemptedAtEpochMs: number;
        error: string;
    }>
    | Readonly<{
        status: 'succeeded';
        attemptedAtEpochMs: number;
    }>;

export type StateMutationOutboxAttempts = Readonly<{
    count: number;
    last: StateMutationOutboxLastAttempt;
}>;

export type StateMutationOutboxDeliveryState =
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'retryable' }>
    | Readonly<{
        status: 'delivered';
        deliveredAtEpochMs: number;
        deliveredSnapshotRevision: number;
    }>;

type StateMutationOutboxRecordBase = Readonly<{
    outboxId: string;
    commandId: string;
    commandHash: string;
    createdAtEpochMs: number;
    effects: readonly StateMutationOutboxEffect[];
    attempts: StateMutationOutboxAttempts;
    delivery: StateMutationOutboxDeliveryState;
}>;

export type ClientStateMutationOutboxRecord =
    & StateMutationOutboxRecordBase
    & Readonly<{
        kind: 'client';
        aggregateRef: ClientPrincipalRef;
        acceptedCausalRevision: ClientStateMutationCausalRevision;
        event:
            | Readonly<{ kind: 'none' }>
            | Readonly<{ kind: 'client'; event: ClientEvent }>;
    }>;

export type GroupStateMutationOutboxRecord =
    & StateMutationOutboxRecordBase
    & Readonly<{
        kind: 'group';
        aggregateRef: GroupRef;
        acceptedCausalRevision: GroupStateMutationCausalRevision;
        event:
            | Readonly<{ kind: 'none' }>
            | Readonly<{ kind: 'group'; event: GroupEvent }>;
    }>;

export type StateMutationOutboxRecord =
    | ClientStateMutationOutboxRecord
    | GroupStateMutationOutboxRecord;

type CreateStateMutationOutboxRecordBase = Readonly<{
    commandId: string;
    commandHash: string;
    effects: readonly StateMutationOutboxEffect[];
    createdAtEpochMs: number;
}>;

export type CreateStateMutationOutboxRecordInput =
    | (CreateStateMutationOutboxRecordBase & Readonly<{
        kind: 'client';
        aggregateRef: ClientPrincipalRef;
        acceptedCausalRevision: ClientStateMutationCausalRevision;
        event:
            | Readonly<{ kind: 'none' }>
            | Readonly<{ kind: 'client'; event: ClientEvent }>;
    }>)
    | (CreateStateMutationOutboxRecordBase & Readonly<{
        kind: 'group';
        aggregateRef: GroupRef;
        acceptedCausalRevision: GroupStateMutationCausalRevision;
        event:
            | Readonly<{ kind: 'none' }>
            | Readonly<{ kind: 'group'; event: GroupEvent }>;
    }>);

export type StoredStateMutationOutboxRecord = Readonly<{
    record: StateMutationOutboxRecord;
    storageRevision: number;
}>;

export type PutStateMutationOutboxResult = StoredStateMutationOutboxRecord &
    Readonly<{ inserted: boolean }>;

export type StateMutationOutboxPendingPage = Readonly<{
    records: readonly StoredStateMutationOutboxRecord[];
    nextAfterKey: string | null;
}>;

export type WriteStateMutationOutboxDeliveryInput = Readonly<{
    outboxId: string;
    expectedStorageRevision: number;
    attempts: StateMutationOutboxAttempts;
    delivery: StateMutationOutboxDeliveryState;
}>;

export type WriteStateMutationOutboxDeliveryResult =
    | Readonly<{
        status: 'applied';
        stored: StoredStateMutationOutboxRecord;
    }>
    | Readonly<{
        status: 'conflict';
        current: StoredStateMutationOutboxRecord | null;
    }>;

export class StateMutationOutboxInvariantCorruptionError extends Error {
    readonly code = 'state-mutation-outbox-invariant-corruption';

    constructor(readonly outboxId: string) {
        super(`State mutation outbox immutable content differs for ${outboxId}`);
        this.name = 'StateMutationOutboxInvariantCorruptionError';
    }
}

export class StateMutationOutboxRepository extends RuntimeStateJsonStore {
    constructor(
        repository: RuntimeStateOptimisticTransactionalRepositoryLike,
    ) {
        super(repository);
    }

    async putOrLoad(
        record: StateMutationOutboxRecord,
    ): Promise<PutStateMutationOutboxResult> {
        validateStateMutationOutboxRecord(record);
        const key = toStateMutationOutboxKey(record.outboxId);
        const inserted = await this.putValueIfAbsent(
            STATE_MUTATION_OUTBOX_NAMESPACE,
            key,
            record,
            NEVER_EXPIRE_AT_TIMESTAMP,
        );
        if (inserted.status === 'applied') {
            return {
                record,
                storageRevision: inserted.revision,
                inserted: true,
            };
        }

        const winner = await this.find(record.outboxId);
        if (!winner) {
            throw new Error(
                `State mutation outbox insert conflicted without a winner: ${record.outboxId}`,
            );
        }
        if (!sameStateMutationOutboxIntent(winner.record, record)) {
            throw new StateMutationOutboxInvariantCorruptionError(
                record.outboxId,
            );
        }
        return {
            ...winner,
            inserted: false,
        };
    }

    async find(
        outboxId: string,
    ): Promise<StoredStateMutationOutboxRecord | undefined> {
        const stored = await this.getEntryValue<StateMutationOutboxRecord>(
            STATE_MUTATION_OUTBOX_NAMESPACE,
            toStateMutationOutboxKey(outboxId),
        );
        if (!stored) {
            return undefined;
        }
        validateStateMutationOutboxRecord(stored.value);
        return {
            record: stored.value,
            storageRevision: stored.entry.revision,
        };
    }

    async listPendingPage(
        options: Readonly<{ afterKey?: string; limit: number }>,
    ): Promise<StateMutationOutboxPendingPage> {
        const limit = Math.max(1, Math.floor(options.limit));
        const pending: StoredStateMutationOutboxRecord[] = [];
        let afterKey = options.afterKey;

        while (pending.length < limit) {
            const entries = await this.listEntriesPage(
                STATE_MUTATION_OUTBOX_NAMESPACE,
                STATE_MUTATION_OUTBOX_KEY_PREFIX,
                { afterKey, limit },
            );
            if (entries.length === 0) {
                return { records: pending, nextAfterKey: null };
            }

            for (const entry of entries) {
                afterKey = entry.key;
                const record = await this.toLiveValue<StateMutationOutboxRecord>(
                    STATE_MUTATION_OUTBOX_NAMESPACE,
                    entry,
                );
                if (!record) {
                    continue;
                }
                validateStateMutationOutboxRecord(record);
                if (record.delivery.status !== 'delivered') {
                    pending.push({
                        record,
                        storageRevision: entry.revision,
                    });
                    if (pending.length === limit) {
                        return {
                            records: pending,
                            nextAfterKey: afterKey ?? null,
                        };
                    }
                }
            }

            if (entries.length < limit) {
                return { records: pending, nextAfterKey: null };
            }
        }

        return {
            records: pending,
            nextAfterKey: afterKey ?? null,
        };
    }

    async writeDelivery(
        input: WriteStateMutationOutboxDeliveryInput,
    ): Promise<WriteStateMutationOutboxDeliveryResult> {
        const repository = this.repository as
            RuntimeStateOptimisticTransactionalRepositoryLike;
        return await repository.begin(async (transaction) => {
            const transactional = new StateMutationOutboxRepository(transaction);
            const current = await transactional.find(input.outboxId);
            if (
                !current ||
                current.storageRevision !== input.expectedStorageRevision
            ) {
                return {
                    status: 'conflict',
                    current: current ?? null,
                };
            }
            validateDeliveryTransition(current.record, input);
            const record: StateMutationOutboxRecord = {
                ...current.record,
                attempts: input.attempts,
                delivery: input.delivery,
            } as StateMutationOutboxRecord;
            const written = await transactional.putValueIfRevision(
                STATE_MUTATION_OUTBOX_NAMESPACE,
                toStateMutationOutboxKey(input.outboxId),
                record,
                NEVER_EXPIRE_AT_TIMESTAMP,
                input.expectedStorageRevision,
            );
            if (written.status === 'conflict') {
                return {
                    status: 'conflict',
                    current: (await transactional.find(input.outboxId)) ?? null,
                };
            }
            return {
                status: 'applied',
                stored: {
                    record,
                    storageRevision: written.revision,
                },
            };
        });
    }
}

export function createStateMutationOutboxRecord(
    input: CreateStateMutationOutboxRecordInput,
): StateMutationOutboxRecord {
    const outboxId = toStateMutationOutboxId(input);
    const record = {
        ...input,
        outboxId,
        effects: canonicalStateMutationOutboxEffects(input.effects),
        attempts: {
            count: 0,
            last: { status: 'never-attempted' },
        },
        delivery: { status: 'pending' },
    } as StateMutationOutboxRecord;
    validateStateMutationOutboxRecord(record);
    return record;
}

export function toStateMutationOutboxId(
    input: Pick<
        CreateStateMutationOutboxRecordInput,
        'commandId' | 'kind' | 'aggregateRef' | 'acceptedCausalRevision'
    >,
): string {
    return `state-mutation-${fnv1a64(stableJsonStringify({
        commandId: input.commandId,
        kind: input.kind,
        aggregateRef: input.aggregateRef,
        acceptedCausalRevision: input.acceptedCausalRevision,
    }))}`;
}

export function hashStateMutationCommand(command: unknown): string {
    return `fnv1a64:${fnv1a64(stableJsonStringify(command))}`;
}

export function toClientStateMutationCausalRevision(
    snapshot: ClientSnapshot,
): ClientStateMutationCausalRevision {
    return {
        kind: 'client',
        stateRevision: snapshot.stateRevision,
        snapshotVersion: snapshot.principal.snapshotVersion,
        presenceVersion: snapshot.principal.presenceVersion,
    };
}

export function toGroupStateMutationCausalRevision(
    snapshot: GroupSnapshot,
): GroupStateMutationCausalRevision {
    return {
        kind: 'group',
        stateRevision: snapshot.stateRevision,
        snapshotVersion: snapshot.group.snapshotVersion,
        metadataVersion: snapshot.group.metadataVersion,
        rosterVersion: snapshot.group.rosterVersion,
        presenceVersion: snapshot.group.presenceVersion,
    };
}

function sameStateMutationOutboxIntent(
    left: StateMutationOutboxRecord,
    right: StateMutationOutboxRecord,
): boolean {
    return stableJsonStringify(toImmutableIntent(left)) ===
        stableJsonStringify(toImmutableIntent(right));
}

function toImmutableIntent(record: StateMutationOutboxRecord): unknown {
    return {
        outboxId: record.outboxId,
        commandId: record.commandId,
        commandHash: record.commandHash,
        kind: record.kind,
        aggregateRef: record.aggregateRef,
        acceptedCausalRevision: record.acceptedCausalRevision,
        event: record.event,
        effects: canonicalStateMutationOutboxEffects(record.effects),
        createdAtEpochMs: record.createdAtEpochMs,
    };
}

function validateStateMutationOutboxRecord(
    record: StateMutationOutboxRecord,
): void {
    if (!record.commandId || !record.commandHash || !record.outboxId) {
        throw new TypeError('State mutation outbox identity fields are required');
    }
    assertSafeNonNegativeInteger(record.createdAtEpochMs, 'created time');
    assertSafeNonNegativeInteger(record.attempts.count, 'attempt count');
    if (record.effects.length === 0) {
        throw new TypeError('State mutation outbox effects are required');
    }
    if (new Set(record.effects).size !== record.effects.length) {
        throw new TypeError('State mutation outbox effects must be unique');
    }
    const expectedId = toStateMutationOutboxId(record);
    if (record.outboxId !== expectedId) {
        throw new TypeError(`Invalid state mutation outbox id: ${record.outboxId}`);
    }

    if (record.kind === 'client') {
        if (
            record.acceptedCausalRevision.kind !== 'client' ||
            record.effects.some((effect) => effect !== 'client-state-sync')
        ) {
            throw new TypeError('Invalid client state mutation outbox intent');
        }
        validateClientRef(record.aggregateRef);
        validateClientCausalRevision(record.acceptedCausalRevision);
        if (record.event.kind === 'client') {
            if (!record.effects.includes('client-state-sync')) {
                throw new TypeError(
                    'Client outbox events require client-state-sync',
                );
            }
            validateClientRef(record.event.event);
        }
    } else {
        if (
            record.acceptedCausalRevision.kind !== 'group' ||
            record.effects.some((effect) => effect === 'client-state-sync')
        ) {
            throw new TypeError('Invalid group state mutation outbox intent');
        }
        validateGroupRef(record.aggregateRef);
        validateGroupCausalRevision(record.acceptedCausalRevision);
        if (record.event.kind === 'group') {
            if (!record.effects.includes('group-state-sync')) {
                throw new TypeError(
                    'Group outbox events require group-state-sync',
                );
            }
            validateGroupRef(record.event.event);
        }
    }

    if (record.attempts.last.status === 'never-attempted') {
        if (record.attempts.count !== 0) {
            throw new TypeError('Never-attempted outbox metadata must have zero attempts');
        }
    } else {
        assertSafeNonNegativeInteger(
            record.attempts.last.attemptedAtEpochMs,
            'last attempt time',
        );
        if (record.attempts.count === 0) {
            throw new TypeError('Attempted outbox metadata must have a positive count');
        }
    }
    switch (record.delivery.status) {
        case 'pending':
            if (record.attempts.last.status !== 'never-attempted') {
                throw new TypeError(
                    'Pending outbox state requires never-attempted metadata',
                );
            }
            break;
        case 'retryable':
            if (record.attempts.last.status !== 'failed') {
                throw new TypeError(
                    'Retryable outbox state requires failed attempt metadata',
                );
            }
            break;
        case 'delivered':
            if (record.attempts.last.status !== 'succeeded') {
                throw new TypeError(
                    'Delivered outbox state requires successful attempt metadata',
                );
            }
            assertSafeNonNegativeInteger(
                record.delivery.deliveredAtEpochMs,
                'delivered time',
            );
            assertSafeNonNegativeInteger(
                record.delivery.deliveredSnapshotRevision,
                'delivered snapshot revision',
            );
            if (
                record.delivery.deliveredSnapshotRevision <
                    record.acceptedCausalRevision.stateRevision
            ) {
                throw new TypeError(
                    'Delivered outbox snapshot revision is older than its intent',
                );
            }
            break;
    }
}

function validateDeliveryTransition(
    current: StateMutationOutboxRecord,
    input: WriteStateMutationOutboxDeliveryInput,
): void {
    if (current.delivery.status === 'delivered') {
        throw new TypeError('Delivered state mutation outbox rows are immutable');
    }
    if (input.attempts.count !== current.attempts.count + 1) {
        throw new TypeError('State mutation outbox attempt count must advance once');
    }
    if (input.attempts.last.status === 'never-attempted') {
        throw new TypeError('State mutation outbox delivery writes require an attempt');
    }
    if (
        input.delivery.status === 'delivered' &&
        input.attempts.last.status !== 'succeeded'
    ) {
        throw new TypeError('Delivered outbox state requires a successful attempt');
    }
    if (
        input.delivery.status === 'retryable' &&
        input.attempts.last.status !== 'failed'
    ) {
        throw new TypeError('Retryable outbox state requires a failed attempt');
    }
}

function validateClientCausalRevision(
    revision: ClientStateMutationCausalRevision,
): void {
    assertSafeNonNegativeInteger(revision.stateRevision, 'client state revision');
    assertSafeNonNegativeInteger(revision.snapshotVersion, 'client snapshot version');
    assertSafeNonNegativeInteger(revision.presenceVersion, 'client presence version');
}

function validateGroupCausalRevision(
    revision: GroupStateMutationCausalRevision,
): void {
    assertSafeNonNegativeInteger(revision.stateRevision, 'group state revision');
    assertSafeNonNegativeInteger(revision.snapshotVersion, 'group snapshot version');
    assertSafeNonNegativeInteger(revision.metadataVersion, 'group metadata version');
    assertSafeNonNegativeInteger(revision.rosterVersion, 'group roster version');
    assertSafeNonNegativeInteger(revision.presenceVersion, 'group presence version');
}

function validateClientRef(ref: ClientPrincipalRef): void {
    if (!ref.applicationId || !ref.principalId) {
        throw new TypeError('Invalid client aggregate ref');
    }
}

function validateGroupRef(ref: GroupRef): void {
    if (!ref.applicationId || !ref.groupId) {
        throw new TypeError('Invalid group aggregate ref');
    }
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        throw new TypeError(`Invalid state mutation outbox ${label}: ${value}`);
    }
}

function toStateMutationOutboxKey(outboxId: string): string {
    return `${STATE_MUTATION_OUTBOX_KEY_PREFIX}${outboxId}`;
}

function canonicalStateMutationOutboxEffects(
    effects: readonly StateMutationOutboxEffect[],
): readonly StateMutationOutboxEffect[] {
    const effectSet = new Set(effects);
    return STATE_MUTATION_OUTBOX_EFFECT_ORDER.filter((effect) =>
        effectSet.has(effect)
    );
}

function fnv1a64(value: string): string {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= BigInt(value.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * prime);
    }
    return hash.toString(36);
}
