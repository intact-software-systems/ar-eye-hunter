export const GROUP_FORMATION_OPERATION_KINDS = [
  'join',
  'presenceConnect',
  'heartbeat',
  'disconnect',
  'membership',
  'other',
] as const;

export type GroupFormationOperationKind = (typeof GROUP_FORMATION_OPERATION_KINDS)[number];

export const GROUP_FORMATION_MUTATION_OUTCOMES = ['write', 'noOp', 'rejected'] as const;

export type GroupFormationMutationOutcome = (typeof GROUP_FORMATION_MUTATION_OUTCOMES)[number];

export type GroupFormationMutationOutcomeCounts = Readonly<
  Record<GroupFormationMutationOutcome, number>
>;

export type RallarGroupFormationMetrics = Readonly<{
  groupMutationCount: Readonly<
    Record<GroupFormationOperationKind, GroupFormationMutationOutcomeCounts>
  >;
  presenceSummaryExpansionCount: number;
  presenceSummaryWsRowCount: Readonly<{
    event: number;
    snapshot: number;
    directory: number;
  }>;
  presenceSummaryTopologyEntryCount: number;
  topologyRecomputeTriggeredCount: number;
  wsOutboxSendCountByTopicId: Readonly<Record<string, number>>;
  wsOutboxRecipientCountByTopicId: Readonly<Record<string, number>>;
  wsOutboxNoLocalRecipientCount: number;
  rttAcceptedWriteCount: number;
  rttRecomputeIntentCount: number;
}>;
