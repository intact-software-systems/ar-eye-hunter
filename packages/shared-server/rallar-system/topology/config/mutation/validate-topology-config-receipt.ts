// prettier-ignore
import type {
  GroupTopologyConfigAcceptedCausalRevision,
  GroupTopologyConfigMutationReceipt,
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import {
  requireTopologyString,
  sameTopologyGroupRef,
  validateAcceptedTopologyConfig,
  validateTopologyAcceptedCausalRevision,
  validateTopologyConfigExactKeys,
  validateTopologyConfigObject,
  validateTopologyCausalRevision,
  validateTopologyGroupRef,
  validateTopologyPositiveInteger,
  validateTopologyStorageRevision,
} from './topology-config-mutation-validation-values.ts';

export function validateTopologyConfigReceipt(
  candidate: GroupTopologyConfigMutationReceipt,
  expectedRef: GroupRef,
): GroupTopologyConfigMutationReceipt {
  const receipt = candidate;
  validateTopologyConfigObject(receipt, 'Topology config receipt');
  validateTopologyConfigReceiptIdentity(receipt, expectedRef);
  validateTopologyConfigReceiptAcceptedState(receipt);
  validateTopologyConfigReceiptEffect(receipt);
  validateTopologyConfigReceiptCausalRevision(receipt);
  validateTopologyConfigReceiptTimestamps(receipt);
  return receipt;
}

function validateTopologyConfigReceiptIdentity(
  receipt: GroupTopologyConfigMutationReceipt,
  expectedRef: GroupRef,
): void {
  validateTopologyConfigExactKeys(receipt, topologyConfigReceiptKeys, 'Topology config receipt');
  requireTopologyString(receipt.commandId, 'Topology config receipt commandId');
  if (receipt.requestId !== null) {
    requireTopologyString(receipt.requestId, 'Topology config receipt requestId');
  }
  validateTopologyPositiveInteger(receipt.attemptCount, 'Topology config receipt attemptCount');
  if (!/^sha256:[0-9a-f]{64}$/.test(String(receipt.commandHash))) {
    throw new TypeError('Topology config receipt hash is invalid');
  }
  if (!topologyConfigOperations.includes(String(receipt.operation))) {
    throw new TypeError('Topology config receipt operation is invalid');
  }
  if (receipt.outcome !== 'applied' && receipt.outcome !== 'no-op') {
    throw new TypeError('Topology config receipt outcome is invalid');
  }
  validateTopologyGroupRef(receipt.groupRef, 'Topology config receipt groupRef');
  if (!sameTopologyGroupRef(receipt.groupRef, expectedRef)) {
    throw new TypeError('Topology config receipt has the wrong groupRef');
  }
  if (receipt.target !== 'config' && receipt.target !== 'override') {
    throw new TypeError('Topology config receipt target is invalid');
  }
}

function validateTopologyConfigReceiptAcceptedState(
  receipt: GroupTopologyConfigMutationReceipt,
): void {
  const expectsConfig = receipt.operation === 'putConfig' || receipt.operation === 'deleteConfig';
  if ((expectsConfig ? 'config' : 'override') !== receipt.target) {
    throw new TypeError('Topology config receipt operation target is invalid');
  }
  const isPut = receipt.operation === 'putConfig' || receipt.operation === 'putOverride';
  if (isPut && receipt.outcome !== 'applied') {
    throw new TypeError('Topology config PUT receipt must be applied');
  }
  validateTopologyStorageRevision(receipt.acceptedVersion, 'Topology config accepted version');
  if (receipt.acceptedStorageRevision !== null) {
    validateTopologyStorageRevision(
      receipt.acceptedStorageRevision,
      'Topology config accepted storage revision',
    );
  }
  for (const [field, label] of acceptedReceiptTimeFields) {
    if (receipt[field] !== null) {
      validateTopologyStorageRevision(receipt[field], label);
    }
  }
  if (receipt.acceptedConfig !== null) {
    validateAcceptedTopologyConfig(
      receipt.acceptedConfig,
      'Topology config receipt accepted config',
    );
  }
  if (isPut !== (receipt.acceptedConfig !== null)) {
    throw new TypeError('Topology config receipt accepted config does not match operation');
  }
}

function validateTopologyConfigReceiptEffect(receipt: GroupTopologyConfigMutationReceipt): void {
  if (receipt.outboxId !== null) {
    requireTopologyString(receipt.outboxId, 'Topology config outboxId');
  }
  if (receipt.eventId !== null) {
    throw new TypeError('Topology config receipt eventId must be null');
  }
  if (
    !Array.isArray(receipt.outboxIds) ||
    receipt.outboxIds.some((outboxId) => typeof outboxId !== 'string') ||
    receipt.outboxIds.length !== (receipt.outboxId === null ? 0 : 1) ||
    (receipt.outboxId !== null && receipt.outboxIds[0] !== receipt.outboxId)
  ) {
    throw new TypeError('Topology config receipt outboxIds are invalid');
  }
  if (
    receipt.outcome === 'applied' &&
    (Number(receipt.acceptedVersion) <= 0 ||
      receipt.acceptedStorageRevision === null ||
      receipt.acceptedCausalRevision === null ||
      receipt.outboxId === null)
  ) {
    throw new TypeError('Topology config applied receipt is incomplete');
  }
  if (
    (receipt.outcome === 'applied') !== (receipt.outboxId !== null) ||
    (receipt.outcome === 'applied') !== (receipt.acceptedCausalRevision !== null)
  ) {
    throw new TypeError('Topology config receipt effect does not match outboxId');
  }
}

function validateTopologyConfigReceiptCausalRevision(
  receipt: GroupTopologyConfigMutationReceipt,
): void {
  if (receipt.acceptedCausalRevision === null) {
    return;
  }
  const accepted = receipt.acceptedCausalRevision;
  validateTopologyAcceptedCausalRevision(accepted, 'Topology config accepted causal revision');
  validateTopologyConfigExactKeys(
    accepted,
    topologyConfigAcceptedCausalRevisionKeys,
    'Topology config accepted causal revision',
  );
  for (const field of causalReceiptRevisionFields) {
    validateTopologyStorageRevision(
      accepted[field],
      `Topology config accepted causal revision ${field}`,
    );
  }
  validateTopologyCausalRevision(
    accepted.causalRevision,
    'Topology config accepted causal revision tuple',
  );
  const causalRevision = accepted.causalRevision as GroupStateCausalRevision;
  const expectedOutboxId = [
    String(receipt.commandId),
    'rtc-topology-recompute',
    'group-revision',
    `group=${causalRevision.groupRevision};presence=${causalRevision.presenceRevision}`,
  ].join(':');
  if (receipt.outboxId !== expectedOutboxId) {
    throw new TypeError('Topology config receipt outbox identity is invalid');
  }
}

function validateTopologyConfigReceiptTimestamps(
  receipt: GroupTopologyConfigMutationReceipt,
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
  'outboxId',
  'outboxIds',
];
const topologyConfigAcceptedCausalRevisionKeys = [
  'stateRevision',
  'causalRevision',
  'snapshotVersion',
  'metadataVersion',
  'rosterVersion',
  'presenceVersion',
];
const acceptedReceiptTimeFields = [
  ['acceptedCreatedAtEpochMs', 'Topology config accepted creation time'],
  ['acceptedUpdatedAtEpochMs', 'Topology config accepted update time'],
  ['acceptedExpiresAtEpochMs', 'Topology config accepted expiry'],
] as const;
const causalReceiptRevisionFields = [
  'stateRevision',
  'snapshotVersion',
  'metadataVersion',
  'rosterVersion',
  'presenceVersion',
] as const;
