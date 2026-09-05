import type {
    GroupTopologyConfigAcceptedCausalRevision,
    GroupTopologyConfigMutationReceipt
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import {
    assertAcceptedTopologyConfig,
    assertTopologyAcceptedCausalRevision,
    assertTopologyCausalRevision,
    assertTopologyConfigExactKeys,
    assertTopologyConfigObject,
    assertTopologyGroupRef,
    assertTopologyPositiveInteger,
    assertTopologyStorageRevision,
    requireTopologyString,
    sameTopologyGroupRef
} from './topology-config-mutation-validation-values.ts';

export function assertTopologyConfigReceipt(
    candidate: GroupTopologyConfigMutationReceipt,
    expectedRef: GroupRef
): GroupTopologyConfigMutationReceipt {
    const receipt = candidate;
    assertTopologyConfigObject(receipt, 'Topology config receipt');
    assertTopologyConfigReceiptIdentity(receipt, expectedRef);
    assertTopologyConfigReceiptAcceptedState(receipt);
    assertTopologyConfigReceiptEffect(receipt);
    assertTopologyConfigReceiptCausalRevision(receipt);
    assertTopologyConfigReceiptTimestamps(receipt);
    return receipt;
}

function assertTopologyConfigReceiptIdentity(
    receipt: GroupTopologyConfigMutationReceipt,
    expectedRef: GroupRef
): void {
    assertTopologyConfigExactKeys(receipt, topologyConfigReceiptKeys, 'Topology config receipt');
    requireTopologyString(receipt.commandId, 'Topology config receipt commandId');
    if (receipt.requestId !== null) {
        requireTopologyString(receipt.requestId, 'Topology config receipt requestId');
    }
    assertTopologyPositiveInteger(receipt.attemptCount, 'Topology config receipt attemptCount');
    if (!/^sha256:[0-9a-f]{64}$/.test(String(receipt.commandHash))) {
        throw new TypeError('Topology config receipt hash is invalid');
    }
    if (!topologyConfigOperations.includes(String(receipt.operation))) {
        throw new TypeError('Topology config receipt operation is invalid');
    }
    if (receipt.outcome !== 'applied' && receipt.outcome !== 'no-op') {
        throw new TypeError('Topology config receipt outcome is invalid');
    }
    assertTopologyGroupRef(receipt.groupRef, 'Topology config receipt groupRef');
    if (!sameTopologyGroupRef(receipt.groupRef, expectedRef)) {
        throw new TypeError('Topology config receipt has the wrong groupRef');
    }
    if (receipt.target !== 'config' && receipt.target !== 'override') {
        throw new TypeError('Topology config receipt target is invalid');
    }
}

function assertTopologyConfigReceiptAcceptedState(
    receipt: GroupTopologyConfigMutationReceipt
): void {
    const expectsConfig = receipt.operation === 'putConfig' || receipt.operation === 'deleteConfig';
    if ((expectsConfig ? 'config' : 'override') !== receipt.target) {
        throw new TypeError('Topology config receipt operation target is invalid');
    }
    const isPut = receipt.operation === 'putConfig' || receipt.operation === 'putOverride';
    if (isPut && receipt.outcome !== 'applied') {
        throw new TypeError('Topology config PUT receipt must be applied');
    }
    assertTopologyStorageRevision(receipt.acceptedVersion, 'Topology config accepted version');
    if (receipt.acceptedStorageRevision !== null) {
        assertTopologyStorageRevision(
            receipt.acceptedStorageRevision,
            'Topology config accepted storage revision'
        );
    }
    for (const [field, label] of acceptedReceiptTimeFields) {
        if (receipt[field] !== null) {
            assertTopologyStorageRevision(receipt[field], label);
        }
    }
    if (receipt.acceptedConfig !== null) {
        assertAcceptedTopologyConfig(
            receipt.acceptedConfig,
            'Topology config receipt accepted config'
        );
    }
    if (isPut !== (receipt.acceptedConfig !== null)) {
        throw new TypeError('Topology config receipt accepted config does not match operation');
    }
}

function assertTopologyConfigReceiptEffect(receipt: GroupTopologyConfigMutationReceipt): void {
    if (receipt.eventId !== null) {
        throw new TypeError('Topology config receipt eventId must be null');
    }
    if (
        !Array.isArray(receipt.outboxIds) ||
        receipt.outboxIds.some((outboxId) => typeof outboxId !== 'string') ||
        receipt.outboxIds.length !== (receipt.outcome === 'applied' ? 1 : 0)
    ) {
        throw new TypeError('Topology config receipt outboxIds are invalid');
    }
    for (const outboxId of receipt.outboxIds) {
        requireTopologyString(outboxId, 'Topology config outboxId');
    }
    if (
        receipt.outcome === 'applied' &&
        (Number(receipt.acceptedVersion) <= 0 ||
            receipt.acceptedStorageRevision === null ||
            receipt.acceptedCausalRevision === null ||
            receipt.outboxIds.length !== 1)
    ) {
        throw new TypeError('Topology config applied receipt is incomplete');
    }
    if (
        (receipt.outcome === 'applied') !== (receipt.acceptedCausalRevision !== null)
    ) {
        throw new TypeError('Topology config receipt effect does not match outboxIds');
    }
}

function assertTopologyConfigReceiptCausalRevision(
    receipt: GroupTopologyConfigMutationReceipt
): void {
    if (receipt.acceptedCausalRevision === null) {
        return;
    }
    const accepted = receipt.acceptedCausalRevision;
    assertTopologyAcceptedCausalRevision(accepted, 'Topology config accepted causal revision');
    assertTopologyConfigExactKeys(
        accepted,
        topologyConfigAcceptedCausalRevisionKeys,
        'Topology config accepted causal revision'
    );
    for (const field of causalReceiptRevisionFields) {
        assertTopologyStorageRevision(
            accepted[field],
            `Topology config accepted causal revision ${field}`
        );
    }
    assertTopologyCausalRevision(
        accepted.causalRevision,
        'Topology config accepted causal revision tuple'
    );
    const causalRevision = accepted.causalRevision as GroupStateCausalRevision;
    const expectedOutboxId = [
        String(receipt.commandId),
        'rtc-topology-recompute',
        'group-revision',
        `group=${causalRevision.groupRevision};presence=${causalRevision.presenceRevision}`
    ].join(':');
    if (receipt.outboxIds[0] !== expectedOutboxId) {
        throw new TypeError('Topology config receipt outbox identity is invalid');
    }
}

function assertTopologyConfigReceiptTimestamps(
    receipt: GroupTopologyConfigMutationReceipt
): void {
    const isPut = receipt.operation === 'putConfig' || receipt.operation === 'putOverride';
    if (
        receipt.outcome === 'no-op' &&
        Number(receipt.acceptedVersion) === 0 &&
        receipt.acceptedStorageRevision !== null
    ) {
        throw new TypeError('Topology config absent no-op receipt is invalid');
    }
    if (
        isPut !==
            (receipt.acceptedCreatedAtEpochMs !== null && receipt.acceptedUpdatedAtEpochMs !== null)
    ) {
        throw new TypeError('Topology config receipt timestamps do not match operation');
    }
    if (
        receipt.acceptedCreatedAtEpochMs !== null &&
        Number(receipt.acceptedUpdatedAtEpochMs) < Number(receipt.acceptedCreatedAtEpochMs)
    ) {
        throw new TypeError('Topology config receipt update precedes creation');
    }
    if ((receipt.operation === 'putOverride') !== (receipt.acceptedExpiresAtEpochMs !== null)) {
        throw new TypeError('Topology config receipt expiry does not match operation');
    }
    if (
        receipt.acceptedExpiresAtEpochMs !== null &&
        Number(receipt.acceptedExpiresAtEpochMs) <= Number(receipt.acceptedUpdatedAtEpochMs)
    ) {
        throw new TypeError('Topology config receipt expiry does not follow update');
    }
}

const topologyConfigOperations = ['putConfig', 'deleteConfig', 'putOverride', 'deleteOverride'];
const topologyConfigReceiptKeys = [
    'commandId',
    'requestId',
    'commandHash',
    'operation',
    'outcome',
    'attemptCount',
    'groupRef',
    'target',
    'acceptedVersion',
    'acceptedStorageRevision',
    'acceptedCreatedAtEpochMs',
    'acceptedUpdatedAtEpochMs',
    'acceptedExpiresAtEpochMs',
    'acceptedConfig',
    'acceptedCausalRevision',
    'eventId',
    'outboxIds'
];
const topologyConfigAcceptedCausalRevisionKeys = [
    'causalRevision',
    'snapshotVersion',
    'metadataVersion',
    'rosterVersion',
    'presenceVersion'
];
const acceptedReceiptTimeFields = [
    ['acceptedCreatedAtEpochMs', 'Topology config accepted creation time'],
    ['acceptedUpdatedAtEpochMs', 'Topology config accepted update time'],
    ['acceptedExpiresAtEpochMs', 'Topology config accepted expiry']
] as const;
const causalReceiptRevisionFields = [
    'snapshotVersion',
    'metadataVersion',
    'rosterVersion',
    'presenceVersion'
] as const;
