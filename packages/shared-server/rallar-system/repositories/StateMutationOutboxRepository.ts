import type {
    ClientEvent,
    ClientEventType,
    ClientPrincipalRef,
    ClientSnapshot,
} from '@shared/api/client-types.ts';
import type {
    GroupEvent,
    GroupEventType,
    GroupRef,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
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
const STATE_MUTATION_COMMAND_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CLIENT_EVENT_TYPES: Readonly<Record<ClientEventType, true>> = {
    'principal-created': true,
    'principal-updated': true,
    'principal-disabled': true,
    'principal-deleted': true,
    'instance-registered': true,
    'instance-updated': true,
    'instance-revoked': true,
    'session-authenticated': true,
    'session-connected': true,
    'session-heartbeat': true,
    'session-disconnected': true,
    'session-expired': true,
};
const GROUP_EVENT_TYPES: Readonly<Record<GroupEventType, true>> = {
    'group-created': true,
    'group-updated': true,
    'group-archived': true,
    'group-deleted': true,
    'member-invited': true,
    'member-joined': true,
    'member-left': true,
    'member-removed': true,
    'member-banned': true,
    'member-unbanned': true,
    'member-role-changed': true,
    'ownership-transferred': true,
    'session-connected': true,
    'session-heartbeat': true,
    'session-disconnected': true,
};

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
        /**
         * Guaranteed delivered lower bound. Duplicate or legacy void adapters
         * may prove only the accepted revision even when their payload is newer.
         */
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

export class StateMutationOutboxCollisionError extends Error {
    readonly code = 'state-mutation-outbox-collision';
    readonly status = 409;

    constructor(readonly outboxId: string) {
        super(`State mutation outbox already exists: ${outboxId}`);
        this.name = 'StateMutationOutboxCollisionError';
    }
}

export class StateMutationOutboxRepository extends RuntimeStateJsonStore {
    constructor(
        repository: RuntimeStateOptimisticTransactionalRepositoryLike,
    ) {
        super(repository);
    }

    async insertForAuthoritativeWrite(
        record: StateMutationOutboxRecord,
    ): Promise<StoredStateMutationOutboxRecord> {
        validateStateMutationOutboxRecord(record);
        validateInitialStateMutationOutboxRecord(record);
        const inserted = await this.putValueIfAbsent(
            STATE_MUTATION_OUTBOX_NAMESPACE,
            toStateMutationOutboxKey(record.outboxId),
            record,
            NEVER_EXPIRE_AT_TIMESTAMP,
        );
        if (inserted.status !== 'applied') {
            throw new StateMutationOutboxCollisionError(record.outboxId);
        }
        return {
            record,
            storageRevision: inserted.revision,
        };
    }

    async putOrLoad(
        record: StateMutationOutboxRecord,
    ): Promise<PutStateMutationOutboxResult> {
        validateStateMutationOutboxRecord(record);
        validateInitialStateMutationOutboxRecord(record);
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
        validateStateMutationOutboxDeliveryInput(input);
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
            const record: StateMutationOutboxRecord = {
                ...current.record,
                attempts: input.attempts,
                delivery: input.delivery,
            } as StateMutationOutboxRecord;
            validateStateMutationOutboxRecord(record);
            validateDeliveryTransition(current.record, input);
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
    validateStateMutationOutboxInput(input);
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
    validateStateMutationOutboxIdentity(input, 'identity input');
    return `state-mutation-${fnv1a64(serializeCanonicalJson({
        commandId: input.commandId,
        kind: input.kind,
        aggregateRef: input.aggregateRef,
        acceptedCausalRevision: input.acceptedCausalRevision,
    }))}`;
}

export async function hashStateMutationCommand(
    command: unknown,
): Promise<string> {
    assertJsonSafeValue(command, 'State mutation command');
    const canonicalCommand = serializeCanonicalJson(command);
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalCommand),
    );
    const hex = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    return `sha256:${hex}`;
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
    return serializeCanonicalJson(toImmutableIntent(left)) ===
        serializeCanonicalJson(toImmutableIntent(right));
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

function validateStateMutationOutboxInput(
    input: unknown,
): asserts input is CreateStateMutationOutboxRecordInput {
    if (!isObjectRecordValue(input)) {
        throw new TypeError('State mutation outbox input is required');
    }
    assertJsonSafeValue(input, 'State mutation outbox input');
    validateStateMutationOutboxIntent(input);
}

function validateStateMutationOutboxIntent(
    input: Readonly<Record<string, unknown>>,
): asserts input is Readonly<Record<string, unknown>> &
    CreateStateMutationOutboxRecordInput {
    validateStateMutationOutboxIdentity(input, 'intent');
    assertStateMutationCommandHash(input.commandHash);
    assertSafeNonNegativeInteger(input.createdAtEpochMs, 'created time');
    validateStateMutationOutboxEffects(input.effects);

    if (input.kind === 'client') {
        if (input.effects.some((effect) => effect !== 'client-state-sync')) {
            throw new TypeError('Invalid client state mutation outbox intent');
        }
        validateStateMutationOutboxEvent(input, input.effects);
    } else {
        if (input.effects.some((effect) => effect === 'client-state-sync')) {
            throw new TypeError('Invalid group state mutation outbox intent');
        }
        validateStateMutationOutboxEvent(input, input.effects);
    }
}

type StateMutationOutboxIdentityInput =
    | Pick<
        Extract<CreateStateMutationOutboxRecordInput, { kind: 'client' }>,
        'commandId' | 'kind' | 'aggregateRef' | 'acceptedCausalRevision'
    >
    | Pick<
        Extract<CreateStateMutationOutboxRecordInput, { kind: 'group' }>,
        'commandId' | 'kind' | 'aggregateRef' | 'acceptedCausalRevision'
    >;

function validateStateMutationOutboxIdentity(
    input: unknown,
    rootLabel: string,
): asserts input is Readonly<Record<string, unknown>> &
    StateMutationOutboxIdentityInput {
    if (!isObjectRecordValue(input)) {
        throw new TypeError(`State mutation outbox ${rootLabel} is required`);
    }
    assertJsonSafeValue(input, `State mutation outbox ${rootLabel}`);
    validateStateMutationOutboxKind(input.kind);
    assertNonEmptyString(input.commandId, 'command id');

    if (input.kind === 'client') {
        validateClientRef(input.aggregateRef);
        if (
            !isRecord(input.acceptedCausalRevision) ||
            input.acceptedCausalRevision.kind !== 'client'
        ) {
            throw new TypeError('Invalid client state mutation outbox intent');
        }
        validateClientCausalRevision(input.acceptedCausalRevision);
        return;
    }

    validateGroupRef(input.aggregateRef);
    if (
        !isRecord(input.acceptedCausalRevision) ||
        input.acceptedCausalRevision.kind !== 'group'
    ) {
        throw new TypeError('Invalid group state mutation outbox intent');
    }
    validateGroupCausalRevision(input.acceptedCausalRevision);
}

function validateStateMutationOutboxEvent(
    input: Readonly<Record<string, unknown>> &
        StateMutationOutboxIdentityInput,
    effects: readonly StateMutationOutboxEffect[],
): void {
    if (!isRecord(input.event)) {
        throw new TypeError(
            `${input.kind === 'client' ? 'Client' : 'Group'} state mutation outbox event is required`,
        );
    }

    if (input.kind === 'client') {
        switch (input.event.kind) {
            case 'none':
                return;
            case 'client':
                if (!effects.includes('client-state-sync')) {
                    throw new TypeError(
                        'Client outbox events require client-state-sync',
                    );
                }
                validateClientEvent(
                    input,
                    input.event.event,
                );
                return;
            default:
                throw new TypeError(
                    'Invalid client state mutation outbox event kind',
                );
        }
    }

    switch (input.event.kind) {
        case 'none':
            return;
        case 'group':
            if (!effects.includes('group-state-sync')) {
                throw new TypeError(
                    'Group outbox events require group-state-sync',
                );
            }
            validateGroupEvent(
                input,
                input.event.event,
            );
            return;
        default:
            throw new TypeError(
                'Invalid group state mutation outbox event kind',
            );
    }
}

function validateStateMutationOutboxRecord(record: unknown): void {
    if (!isObjectRecordValue(record)) {
        throw new TypeError('State mutation outbox record is required');
    }
    assertJsonSafeValue(record, 'State mutation outbox record');
    validateStateMutationOutboxIntent(record);
    assertNonEmptyString(record.outboxId, 'outbox id');

    if (!isRecord(record.attempts)) {
        throw new TypeError('State mutation outbox attempts are required');
    }
    assertSafeNonNegativeInteger(record.attempts.count, 'attempt count');
    if (!isRecord(record.attempts.last)) {
        throw new TypeError('State mutation outbox last attempt is required');
    }
    const attempts = record.attempts;
    const last = record.attempts.last;

    if (!isRecord(record.delivery)) {
        throw new TypeError('State mutation outbox delivery is required');
    }
    const delivery = record.delivery;

    const expectedId = toStateMutationOutboxId(record);
    if (record.outboxId !== expectedId) {
        throw new TypeError(`Invalid state mutation outbox id: ${record.outboxId}`);
    }

    switch (last.status) {
        case 'never-attempted':
            if (attempts.count !== 0) {
                throw new TypeError(
                    'Never-attempted outbox metadata must have zero attempts',
                );
            }
            break;
        case 'failed':
            validateAttemptedStateMutationOutboxMetadata(attempts);
            if (!isNonEmptyString(last.error)) {
                throw new TypeError(
                    'Failed state mutation outbox attempts require an error',
                );
            }
            break;
        case 'succeeded':
            validateAttemptedStateMutationOutboxMetadata(attempts);
            break;
        default:
            throw new TypeError(
                `Unknown state mutation outbox attempt status: ${String(last.status)}`,
            );
    }
    switch (delivery.status) {
        case 'pending':
            if (last.status !== 'never-attempted') {
                throw new TypeError(
                    'Pending outbox state requires never-attempted metadata',
                );
            }
            break;
        case 'retryable':
            if (last.status !== 'failed') {
                throw new TypeError(
                    'Retryable outbox state requires failed attempt metadata',
                );
            }
            break;
        case 'delivered':
            if (last.status !== 'succeeded') {
                throw new TypeError(
                    'Delivered outbox state requires successful attempt metadata',
                );
            }
            assertSafeNonNegativeInteger(
                delivery.deliveredAtEpochMs,
                'delivered time',
            );
            assertSafeNonNegativeInteger(
                delivery.deliveredSnapshotRevision,
                'delivered snapshot revision',
            );
            if (
                delivery.deliveredSnapshotRevision <
                    record.acceptedCausalRevision.stateRevision
            ) {
                throw new TypeError(
                    'Delivered outbox snapshot revision is older than its intent',
                );
            }
            break;
        default:
            throw new TypeError(
                `Unknown state mutation outbox delivery status: ${String(delivery.status)}`,
            );
    }
}

function validateStateMutationOutboxDeliveryInput(input: unknown): void {
    if (!isObjectRecordValue(input)) {
        throw new TypeError('State mutation outbox delivery input is required');
    }
    assertJsonSafeValue(input, 'State mutation outbox delivery input');
    assertNonEmptyString(input.outboxId, 'delivery outbox id');
    assertSafeNonNegativeInteger(
        input.expectedStorageRevision,
        'expected storage revision',
    );
}

function validateInitialStateMutationOutboxRecord(
    record: StateMutationOutboxRecord,
): void {
    if (
        record.delivery.status !== 'pending' ||
        record.attempts.count !== 0 ||
        record.attempts.last.status !== 'never-attempted'
    ) {
        throw new TypeError(
            'Initial state mutation outbox records must be pending and never attempted',
        );
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
    switch (input.delivery.status) {
        case 'retryable':
            if (input.attempts.last.status !== 'failed') {
                throw new TypeError(
                    'Retryable outbox state requires a failed attempt',
                );
            }
            break;
        case 'delivered':
            if (input.attempts.last.status !== 'succeeded') {
                throw new TypeError(
                    'Delivered outbox state requires a successful attempt',
                );
            }
            break;
        case 'pending':
            throw new TypeError(
                'State mutation outbox delivery writes cannot transition to pending',
            );
        default:
            throw new TypeError(
                `Unknown state mutation outbox delivery status: ${(input.delivery as { status?: unknown }).status}`,
            );
    }
}

function validateAttemptedStateMutationOutboxMetadata(
    attempts: Readonly<Record<string, unknown>>,
): void {
    const last = attempts.last as Readonly<Record<string, unknown>>;
    assertSafeNonNegativeInteger(last.attemptedAtEpochMs, 'last attempt time');
    if (attempts.count === 0) {
        throw new TypeError('Attempted outbox metadata must have a positive count');
    }
}

function validateStateMutationOutboxKind(kind: unknown): asserts kind is
    StateMutationOutboxRecord['kind'] {
    if (kind !== 'client' && kind !== 'group') {
        throw new TypeError(`Unknown state mutation outbox kind: ${kind}`);
    }
}

function validateStateMutationOutboxEffects(
    effects: unknown,
): asserts effects is readonly StateMutationOutboxEffect[] {
    if (!Array.isArray(effects) || effects.length === 0) {
        throw new TypeError('State mutation outbox effects are required');
    }
    for (const effect of effects) {
        if (!STATE_MUTATION_OUTBOX_EFFECT_ORDER.includes(effect)) {
            throw new TypeError(
                `Unknown state mutation outbox effect: ${effect}`,
            );
        }
    }
    if (new Set(effects).size !== effects.length) {
        throw new TypeError('State mutation outbox effects must be unique');
    }
}

function validateClientEvent(
    record: Pick<
        ClientStateMutationOutboxRecord,
        'aggregateRef' | 'acceptedCausalRevision'
    >,
    event: unknown,
): void {
    if (!isRecord(event)) {
        throw new TypeError('Client outbox event is required');
    }
    if (!isNonEmptyString(event.eventId)) {
        throw new TypeError('Client outbox event eventId is required');
    }
    if (!isKnownClientEventType(event.eventType)) {
        throw new TypeError(
            `Unknown client outbox event type: ${String(event.eventType)}`,
        );
    }
    validateEventTimestamp(event.occurredAtEpochMs, 'Client');
    assertSafeNonNegativeInteger(
        event.snapshotVersion,
        'client event snapshot version',
    );
    validateEventActor(event.actor, 'Client');
    validateOptionalEventString(
        event.clientInstanceId,
        'Client',
        'clientInstanceId',
    );
    validateOptionalEventString(event.sessionId, 'Client', 'sessionId');
    validateOptionalEventMetadata(event, 'Client');
    validateClientRef(event as ClientEvent);
    if (
        event.applicationId !== record.aggregateRef.applicationId ||
        event.workspaceId !== record.aggregateRef.workspaceId ||
        event.principalId !== record.aggregateRef.principalId
    ) {
        throw new TypeError(
            'Client outbox event does not match its aggregate ref',
        );
    }
    if (event.snapshotVersion !== record.acceptedCausalRevision.snapshotVersion) {
        throw new TypeError(
            'Client outbox event does not match its accepted version',
        );
    }
}

function validateGroupEvent(
    record: Pick<
        GroupStateMutationOutboxRecord,
        'aggregateRef' | 'acceptedCausalRevision'
    >,
    event: unknown,
): void {
    if (!isRecord(event)) {
        throw new TypeError('Group outbox event is required');
    }
    if (!isNonEmptyString(event.eventId)) {
        throw new TypeError('Group outbox event eventId is required');
    }
    if (!isKnownGroupEventType(event.eventType)) {
        throw new TypeError(
            `Unknown group outbox event type: ${String(event.eventType)}`,
        );
    }
    validateEventTimestamp(event.occurredAtEpochMs, 'Group');
    assertSafeNonNegativeInteger(
        event.snapshotVersion,
        'group event snapshot version',
    );
    validateEventActor(event.actor, 'Group');
    validateOptionalEventMetadata(event, 'Group');
    validateGroupRef(event as GroupEvent);
    if (
        event.applicationId !== record.aggregateRef.applicationId ||
        event.workspaceId !== record.aggregateRef.workspaceId ||
        event.groupId !== record.aggregateRef.groupId
    ) {
        throw new TypeError(
            'Group outbox event does not match its aggregate ref',
        );
    }
    if (event.snapshotVersion !== record.acceptedCausalRevision.snapshotVersion) {
        throw new TypeError(
            'Group outbox event does not match its accepted version',
        );
    }
}

function isKnownClientEventType(value: unknown): value is ClientEventType {
    return typeof value === 'string' &&
        Object.prototype.hasOwnProperty.call(CLIENT_EVENT_TYPES, value);
}

function isKnownGroupEventType(value: unknown): value is GroupEventType {
    return typeof value === 'string' &&
        Object.prototype.hasOwnProperty.call(GROUP_EVENT_TYPES, value);
}

function validateEventTimestamp(
    value: unknown,
    kind: 'Client' | 'Group',
): void {
    if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        Object.is(value, -0)
    ) {
        throw new TypeError(`Invalid ${kind.toLowerCase()} outbox event occurred time`);
    }
}

function validateEventActor(
    actor: unknown,
    kind: 'Client' | 'Group',
): void {
    if (!isRecord(actor)) {
        throw new TypeError(`${kind} outbox event actor is required`);
    }
    const fields = ['principalId', 'sessionId', 'serviceId'] as const;
    if (fields.every((field) => actor[field] === undefined)) {
        throw new TypeError(`${kind} outbox event actor identity is required`);
    }
    for (const field of fields) {
        const value = actor[field];
        if (value !== undefined && !isNonEmptyString(value)) {
            throw new TypeError(
                `Invalid ${kind.toLowerCase()} outbox event actor ${field}`,
            );
        }
    }
}

function validateOptionalEventMetadata(
    event: Readonly<Record<string, unknown>>,
    kind: 'Client' | 'Group',
): void {
    for (const field of ['reason', 'traceId', 'requestId'] as const) {
        validateOptionalEventString(event[field], kind, field);
    }
    if (event.payload !== undefined && !isRecord(event.payload)) {
        throw new TypeError(
            `Invalid ${kind.toLowerCase()} outbox event payload`,
        );
    }
}

function validateOptionalEventString(
    value: unknown,
    kind: 'Client' | 'Group',
    field: string,
): void {
    if (value !== undefined && !isNonEmptyString(value)) {
        throw new TypeError(
            `Invalid ${kind.toLowerCase()} outbox event ${field}`,
        );
    }
}

function isObjectValue(value: unknown): value is object {
    return typeof value === 'object' && value !== null;
}

function isObjectRecordValue(
    value: unknown,
): value is Readonly<Record<string, unknown>> {
    return isObjectValue(value) && !Array.isArray(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    if (!isObjectRecordValue(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function validateClientCausalRevision(
    revision: Readonly<Record<string, unknown>>,
): void {
    assertSafeNonNegativeInteger(revision.stateRevision, 'client state revision');
    assertSafeNonNegativeInteger(revision.snapshotVersion, 'client snapshot version');
    assertSafeNonNegativeInteger(revision.presenceVersion, 'client presence version');
}

function validateGroupCausalRevision(
    revision: Readonly<Record<string, unknown>>,
): void {
    assertSafeNonNegativeInteger(revision.stateRevision, 'group state revision');
    assertSafeNonNegativeInteger(revision.snapshotVersion, 'group snapshot version');
    assertSafeNonNegativeInteger(revision.metadataVersion, 'group metadata version');
    assertSafeNonNegativeInteger(revision.rosterVersion, 'group roster version');
    assertSafeNonNegativeInteger(revision.presenceVersion, 'group presence version');
}

function validateClientRef(ref: unknown): asserts ref is ClientPrincipalRef {
    if (
        !isRecord(ref) ||
        !isNonEmptyString(ref.applicationId) ||
        (ref.workspaceId !== undefined && !isNonEmptyString(ref.workspaceId)) ||
        !isNonEmptyString(ref.principalId)
    ) {
        throw new TypeError('Invalid client aggregate ref');
    }
}

function validateGroupRef(ref: unknown): asserts ref is GroupRef {
    if (
        !isRecord(ref) ||
        !isNonEmptyString(ref.applicationId) ||
        (ref.workspaceId !== undefined && !isNonEmptyString(ref.workspaceId)) ||
        !isNonEmptyString(ref.groupId)
    ) {
        throw new TypeError('Invalid group aggregate ref');
    }
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function assertNonEmptyString(
    value: unknown,
    label: string,
): asserts value is string {
    if (!isNonEmptyString(value)) {
        throw new TypeError(`Invalid state mutation outbox ${label}`);
    }
}

function assertStateMutationCommandHash(
    value: unknown,
): asserts value is string {
    if (
        !isNonEmptyString(value) ||
        !STATE_MUTATION_COMMAND_HASH_PATTERN.test(value)
    ) {
        throw new TypeError('Invalid state mutation outbox command hash');
    }
}

function assertJsonSafeValue(value: unknown, label: string): void {
    let issue: string | undefined;
    try {
        issue = findJsonSafetyIssue(value, '$', new Set<object>());
    } catch {
        issue = 'value could not be inspected without executing custom behavior';
    }
    if (issue) {
        throw new TypeError(`${label} must be JSON-safe: ${issue}`);
    }
}

function findJsonSafetyIssue(
    value: unknown,
    path: string,
    activeObjects: Set<object>,
): string | undefined {
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
    ) {
        return undefined;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return `${path} contains a non-finite number`;
        }
        if (Object.is(value, -0)) {
            return `${path} contains negative zero`;
        }
        return undefined;
    }
    if (!isObjectValue(value)) {
        return `${path} contains unsupported ${typeof value}`;
    }
    if (activeObjects.has(value)) {
        return `${path} contains a cycle`;
    }

    activeObjects.add(value);
    const issue = Array.isArray(value)
        ? findJsonArraySafetyIssue(value, path, activeObjects)
        : findJsonObjectSafetyIssue(value, path, activeObjects);
    activeObjects.delete(value);
    return issue;
}

function findJsonArraySafetyIssue(
    value: readonly unknown[],
    path: string,
    activeObjects: Set<object>,
): string | undefined {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
        return `${path} uses a non-standard array prototype`;
    }
    const keys = Reflect.ownKeys(value);
    const entryKeys: string[] = [];
    for (const key of keys) {
        if (key === 'length') {
            continue;
        }
        if (typeof key === 'symbol') {
            return `${path} contains a symbol key`;
        }
        if (!isCanonicalArrayIndex(key, value.length)) {
            return `${path} contains non-index array property ${JSON.stringify(key)}`;
        }
        entryKeys.push(key);
    }
    if (entryKeys.length !== value.length) {
        return `${path} contains a sparse array`;
    }
    for (const key of entryKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable) {
            return `${path}[${key}] is not an enumerable data property`;
        }
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            return `${path}[${key}] is an accessor property`;
        }
        const issue = findJsonSafetyIssue(
            descriptor.value,
            `${path}[${key}]`,
            activeObjects,
        );
        if (issue) {
            return issue;
        }
    }
    return undefined;
}

function findJsonObjectSafetyIssue(
    value: object,
    path: string,
    activeObjects: Set<object>,
): string | undefined {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return `${path} uses a non-plain object`;
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
            return `${path} contains a symbol key`;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const propertyPath = `${path}.${key}`;
        if (!descriptor || !descriptor.enumerable) {
            return `${propertyPath} is not an enumerable data property`;
        }
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            return `${propertyPath} is an accessor property`;
        }
        const issue = findJsonSafetyIssue(
            descriptor.value,
            propertyPath,
            activeObjects,
        );
        if (issue) {
            return issue;
        }
    }
    return undefined;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
    if (!/^(0|[1-9]\d*)$/.test(key)) {
        return false;
    }
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function serializeCanonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) as string;
    }
    if (Array.isArray(value)) {
        const entries: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(
                value,
                String(index),
            );
            entries.push(serializeCanonicalJson(descriptor?.value));
        }
        return `[${entries.join(',')}]`;
    }
    const entries = Object.keys(value)
        .sort(compareJsonKeys)
        .map((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return `${JSON.stringify(key)}:${serializeCanonicalJson(descriptor?.value)}`;
        });
    return `{${entries.join(',')}}`;
}

function compareJsonKeys(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function assertSafeNonNegativeInteger(
    value: unknown,
    label: string,
): asserts value is number {
    if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        Object.is(value, -0)
    ) {
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
