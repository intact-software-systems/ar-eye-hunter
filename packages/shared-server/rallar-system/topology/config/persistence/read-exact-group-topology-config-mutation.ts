import type {
    StoredGroupTopologyConfig,
    StoredGroupTopologyOverride
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { resolveRuntimeStateReadBatchLiveValues } from '../../../../runtime-state/read-batch/resolve-runtime-state-read-batch-live-values.ts';
import {
    type RuntimeStateReadBatchSelection,
    type RuntimeStateReadBatchSelector
} from '../../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import { validateRuntimeStateReadBatchResult } from '../../../../runtime-state/read-batch/validate-runtime-state-read-batch-result.ts';
import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateRepositoryLike
} from '../../../../runtime-state/runtime-state-repository.ts';
import type {
    GroupTopologyConfigGeneration,
    GroupTopologyConfigGenerationTarget,
    GroupTopologyConfigInvariantGeneration,
    GroupTopologyConfigMutationRecord
} from '../mutation/group-topology-config-mutation-contracts.ts';

type ExactReadLocation = Readonly<{
    namespace: string;
    key: string;
}>;

export type GroupTopologyMutationExactReadLocations = Readonly<{
    invariant: ExactReadLocation;
    config: ExactReadLocation;
    override: ExactReadLocation;
    configGeneration: ExactReadLocation;
    overrideGeneration: ExactReadLocation;
    idempotency: ExactReadLocation | null;
}>;

type ExactReadDecoder<T> = Readonly<{
    validateRaw(entry: RuntimeStateEntry): void;
    decodeLive(entry: RuntimeStateEntryValue<unknown>): RuntimeStateEntryValue<T>;
}>;

export type GroupTopologyMutationExactReadDecoders = Readonly<{
    invariant: ExactReadDecoder<GroupTopologyConfigInvariantGeneration>;
    config: ExactReadDecoder<StoredGroupTopologyConfig>;
    override: ExactReadDecoder<StoredGroupTopologyOverride>;
    configGeneration: ExactReadDecoder<GroupTopologyConfigGeneration>;
    overrideGeneration: ExactReadDecoder<GroupTopologyConfigGeneration>;
    idempotency: ExactReadDecoder<GroupTopologyConfigMutationRecord>;
}>;

export type GroupTopologyMutationExactReadKeyProvider = Readonly<{
    invariantGenerationKey(ref: GroupRef): string;
    configKey(ref: GroupRef): string;
    overrideKey(ref: GroupRef): string;
    generationKey(ref: GroupRef, target: GroupTopologyConfigGenerationTarget): string;
    mutationKey(ref: GroupRef, requestId: string): string;
}>;

export type GroupTopologyMutationExactReadNamespaces = Readonly<{
    invariant: string;
    config: string;
    override: string;
    generation: string;
    idempotency: string;
}>;

export type GroupTopologyMutationExactReadCodecs = Readonly<{
    validateSourceRaw(
        entry: RuntimeStateEntry,
        target: GroupTopologyConfigGenerationTarget,
        ref: GroupRef
    ): void;
    decodeConfigLive(
        stored: RuntimeStateEntryValue<unknown>,
        ref: GroupRef
    ): RuntimeStateEntryValue<StoredGroupTopologyConfig>;
    decodeOverrideLive(
        stored: RuntimeStateEntryValue<unknown>,
        ref: GroupRef
    ): RuntimeStateEntryValue<StoredGroupTopologyOverride>;
    validateInvariantRaw(entry: RuntimeStateEntry, ref: GroupRef): void;
    validateInvariantLive(entry: RuntimeStateEntry, value: unknown, ref: GroupRef): void;
    validateGenerationRaw(
        entry: RuntimeStateEntry,
        ref: GroupRef,
        target: GroupTopologyConfigGenerationTarget
    ): void;
    validateGenerationLive(
        entry: RuntimeStateEntry,
        value: unknown,
        ref: GroupRef,
        target: GroupTopologyConfigGenerationTarget
    ): void;
    validateMutationRaw(entry: RuntimeStateEntry, ref: GroupRef, requestId: string): void;
    validateMutationLive(
        entry: RuntimeStateEntry,
        value: unknown,
        ref: GroupRef,
        requestId: string
    ): void;
    assertRetained(entry: RuntimeStateEntry, label: string): void;
}>;

export type GroupTopologyMutationExactReadResult =
    | Readonly<{ status: 'concurrent-change'; }>
    | Readonly<{
        status: 'stable';
        invariant: RuntimeStateEntryValue<GroupTopologyConfigInvariantGeneration> | null;
        config: RuntimeStateEntryValue<StoredGroupTopologyConfig> | null;
        override: RuntimeStateEntryValue<StoredGroupTopologyOverride> | null;
        configGeneration: RuntimeStateEntryValue<GroupTopologyConfigGeneration> | null;
        overrideGeneration: RuntimeStateEntryValue<GroupTopologyConfigGeneration> | null;
        idempotency: RuntimeStateEntryValue<GroupTopologyConfigMutationRecord> | null;
    }>;

export function createGroupTopologyMutationExactReadLocations(
    keyProvider: GroupTopologyMutationExactReadKeyProvider,
    namespaces: GroupTopologyMutationExactReadNamespaces,
    ref: GroupRef,
    requestId: string | null
): GroupTopologyMutationExactReadLocations {
    return {
        invariant: {
            namespace: namespaces.invariant,
            key: keyProvider.invariantGenerationKey(ref)
        },
        config: {
            namespace: namespaces.config,
            key: keyProvider.configKey(ref)
        },
        override: {
            namespace: namespaces.override,
            key: keyProvider.overrideKey(ref)
        },
        configGeneration: {
            namespace: namespaces.generation,
            key: keyProvider.generationKey(ref, 'config')
        },
        overrideGeneration: {
            namespace: namespaces.generation,
            key: keyProvider.generationKey(ref, 'override')
        },
        idempotency: requestId === null
            ? null
            : {
                namespace: namespaces.idempotency,
                key: keyProvider.mutationKey(ref, requestId)
            }
    };
}

export function createGroupTopologyMutationExactReadDecoders(
    ref: GroupRef,
    requestId: string | null,
    codecs: GroupTopologyMutationExactReadCodecs
): GroupTopologyMutationExactReadDecoders {
    const generation = (
        target: GroupTopologyConfigGenerationTarget
    ): ExactReadDecoder<GroupTopologyConfigGeneration> => ({
        validateRaw: (entry) => {
            codecs.validateGenerationRaw(entry, ref, target);
            codecs.assertRetained(entry, 'target generation');
        },
        decodeLive: (stored) => {
            codecs.validateGenerationLive(stored.entry, stored.value, ref, target);
            return stored as RuntimeStateEntryValue<GroupTopologyConfigGeneration>;
        }
    });
    return {
        invariant: {
            validateRaw: (entry) => {
                codecs.validateInvariantRaw(entry, ref);
                codecs.assertRetained(entry, 'invariant generation');
            },
            decodeLive: (stored) => {
                codecs.validateInvariantLive(stored.entry, stored.value, ref);
                return stored as RuntimeStateEntryValue<GroupTopologyConfigInvariantGeneration>;
            }
        },
        config: {
            validateRaw: (entry) => codecs.validateSourceRaw(entry, 'config', ref),
            decodeLive: (stored) => codecs.decodeConfigLive(stored, ref)
        },
        override: {
            validateRaw: (entry) => codecs.validateSourceRaw(entry, 'override', ref),
            decodeLive: (stored) => codecs.decodeOverrideLive(stored, ref)
        },
        configGeneration: generation('config'),
        overrideGeneration: generation('override'),
        idempotency: {
            validateRaw: (entry) => {
                const trustedRequestId = requireRequestId(requestId);
                codecs.validateMutationRaw(entry, ref, trustedRequestId);
                codecs.assertRetained(entry, 'mutation record');
            },
            decodeLive: (stored) => {
                codecs.validateMutationLive(stored.entry, stored.value, ref, requireRequestId(requestId));
                return stored as RuntimeStateEntryValue<GroupTopologyConfigMutationRecord>;
            }
        }
    };
}

export async function readGroupTopologyMutationExactEntries(
    repository: RuntimeStateRepositoryLike,
    locations: GroupTopologyMutationExactReadLocations,
    toLiveEntryValue: (
        namespace: string,
        entry: RuntimeStateEntry
    ) => Promise<RuntimeStateEntryValue<unknown> | undefined>,
    decoders: GroupTopologyMutationExactReadDecoders
): Promise<GroupTopologyMutationExactReadResult> {
    const selectors = createExactReadSelectors(locations);
    const selections = validateRuntimeStateReadBatchResult(
        selectors,
        await repository.readRuntimeStateBatch(selectors)
    );

    prevalidateSelection(selections[0], decoders.invariant);
    prevalidateSelection(selections[1], decoders.config);
    prevalidateSelection(selections[2], decoders.override);
    prevalidateSelection(selections[3], decoders.configGeneration);
    prevalidateSelection(selections[4], decoders.overrideGeneration);
    if (locations.idempotency !== null) {
        prevalidateSelection(selections[5], decoders.idempotency);
    }

    const resolved = await resolveRuntimeStateReadBatchLiveValues(
        selectors,
        selections,
        toLiveEntryValue
    );
    if (resolved.status === 'changed') {
        return { status: 'concurrent-change' };
    }

    return {
        status: 'stable',
        invariant: decodeSelection(resolved.selections[0], decoders.invariant),
        config: decodeSelection(resolved.selections[1], decoders.config),
        override: decodeSelection(resolved.selections[2], decoders.override),
        configGeneration: decodeSelection(resolved.selections[3], decoders.configGeneration),
        overrideGeneration: decodeSelection(resolved.selections[4], decoders.overrideGeneration),
        idempotency: locations.idempotency === null
            ? null
            : decodeSelection(resolved.selections[5], decoders.idempotency)
    };
}

function createExactReadSelectors(
    locations: GroupTopologyMutationExactReadLocations
): readonly RuntimeStateReadBatchSelector[] {
    const selectors: RuntimeStateReadBatchSelector[] = [
        toSelector('topology-invariant', locations.invariant),
        toSelector('topology-config', locations.config),
        toSelector('topology-override', locations.override),
        toSelector('topology-generation-config', locations.configGeneration),
        toSelector('topology-generation-override', locations.overrideGeneration)
    ];
    if (locations.idempotency !== null) {
        selectors.push(toSelector('topology-idempotency', locations.idempotency));
    }
    return selectors;
}

function toSelector(
    selectorId: string,
    location: ExactReadLocation
): RuntimeStateReadBatchSelector {
    return {
        selectorId,
        kind: 'key',
        namespace: location.namespace,
        key: location.key
    };
}

function prevalidateSelection<T>(
    selection: RuntimeStateReadBatchSelection,
    decoder: ExactReadDecoder<T>
): void {
    const entry = selection.entries[0];
    if (entry !== undefined) {
        decoder.validateRaw(entry);
    }
}

function decodeSelection<T>(
    selection: Readonly<{
        selectorId: string;
        entries: readonly RuntimeStateEntryValue<unknown>[];
    }>,
    decoder: ExactReadDecoder<T>
): RuntimeStateEntryValue<T> | null {
    const entry = selection.entries[0];
    return entry === undefined ? null : decoder.decodeLive(entry);
}

function requireRequestId(requestId: string | null): string {
    if (requestId === null) {
        throw new TypeError('Topology mutation request ID is required for this slot');
    }
    return requestId;
}
