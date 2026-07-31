export {
  normalizePersistedGroupEvent,
  validatePersistedGroupEvent,
} from '../persisted-group-event.ts';
export {
  computeGroupPresenceSummaryEntry,
  GROUP_PRESENCE_SUMMARY_TOPIC as APP_OUTBOX_GROUP_PRESENCE_SUMMARY_TOPIC,
  type GroupPresenceSummaryWorkData,
} from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
export type {
  GroupMutationCommand,
  GroupMutationComputed,
  GroupMutationComputedWrite,
  GroupMutationFacts,
  GroupMutationIdempotencyProbe,
  GroupMutationIdempotencyRecord,
  GroupMutationRead,
  GroupMutationReceipt,
} from '../group-state/mutation/group-mutation-contracts.ts';
export { GroupMutationRejectedError } from '../group-state/mutation/group-mutation-contracts.ts';
export { validateGroupMutationCommand } from '../group-state/mutation/group-mutation-command-validation.ts';
export {
  computeGroupMutation,
  probeGroupMutationIdempotency,
} from '../group-state/mutation/compute-group-mutation.ts';
export { validateGroupMutation } from '../group-state/mutation/validate-group-mutation.ts';
export {
  validateGroupMutationRequest,
  validateGroupPresenceMutationRequest,
} from '../group-state/mutation/group-mutation-request-validation.ts';
export {
  normalizePersistedGroup,
  normalizePersistedGroupMember,
  normalizePersistedGroupPresenceAdmission,
  normalizePersistedGroupPresenceSession,
  normalizePersistedGroupPresenceSummary,
} from '../group-state/persistence/group-state-persistence-codec.ts';
export {
  validatePersistedGroup,
  validatePersistedGroupMember,
} from '../group-state/persistence/validate-persisted-group.ts';
export {
  validatePersistedGroupPresenceAdmission,
  validatePersistedGroupPresenceSession,
  validatePersistedGroupPresenceSummary,
} from '../group-state/persistence/validate-persisted-group-presence.ts';
export { validateGroupMutationIdempotencyRecord } from '../group-state/mutation/group-mutation-result.ts';
export {
  compareGroupCausalRevision,
  computeGroupPresenceSummary,
  type GroupPresenceSummaryComputed,
  type GroupPresenceSummaryRead,
  validateGroupPresenceSummary,
} from '../group-state/presence/compute-group-presence-summary.ts';
