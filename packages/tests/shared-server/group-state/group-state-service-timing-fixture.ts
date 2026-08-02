import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';

export const TIMED_ASYNC_OPERATIONS = [
  'prepareMutation',
  'prepareExpiredPresenceMutations',
  'prepareSessionCleanupMutations',
  'listSnapshots',
  'listSnapshotsPage',
  'readSnapshot',
  'readStateRevision',
  'readCausalRevision',
  'readIssuedAuthSession',
  'listEvents',
  'listRecentEvents',
  'listEventPage',
  'observeSnapshot',
  'read',
  'write',
] as const;

export type TimedAsyncOperation = (typeof TIMED_ASYNC_OPERATIONS)[number];

export interface GroupStateServiceTimingFake {
  readonly service: GroupStateService;
  readonly calls: readonly string[];
  readonly sentinels: Readonly<Record<TimedAsyncOperation | 'compute', unknown>>;
  readonly rejection: Error;
}

export function createGroupStateServiceTimingFake(
  rejectOperation?: TimedAsyncOperation,
): GroupStateServiceTimingFake {
  const calls: string[] = [];
  const rejection = new Error(`controlled ${rejectOperation ?? 'unused'} rejection`);
  const sentinels = Object.fromEntries(
    [...TIMED_ASYNC_OPERATIONS, 'compute'].map((operation) => [
      operation,
      Object.freeze({ operation, sentinel: true }),
    ]),
  ) as Readonly<Record<TimedAsyncOperation | 'compute', unknown>>;
  const record = async (operation: TimedAsyncOperation): Promise<unknown> => {
    calls.push(operation);
    if (operation === rejectOperation) throw rejection;
    return sentinels[operation];
  };
  const service: GroupStateService = {
    sessionGenerationLifecycle: Object.freeze({}) as never,
    ...createPreparationFake(record),
    ...createQueryFake(record),
    ...createMutationFake(record, calls, sentinels.compute),
  };
  return { service, calls, sentinels, rejection };
}

function createPreparationFake(
  record: (operation: TimedAsyncOperation) => Promise<unknown>,
): Pick<
  GroupStateService,
  'prepareMutation' | 'prepareExpiredPresenceMutations' | 'prepareSessionCleanupMutations'
> {
  return {
    prepareMutation: async () => (await record('prepareMutation')) as never,
    prepareExpiredPresenceMutations: async () =>
      (await record('prepareExpiredPresenceMutations')) as never,
    prepareSessionCleanupMutations: async () =>
      (await record('prepareSessionCleanupMutations')) as never,
  };
}

function createQueryFake(
  record: (operation: TimedAsyncOperation) => Promise<unknown>,
): Pick<
  GroupStateService,
  | 'listSnapshots'
  | 'listSnapshotsPage'
  | 'readSnapshot'
  | 'readStateRevision'
  | 'readCausalRevision'
  | 'readIssuedAuthSession'
  | 'listEvents'
  | 'listRecentEvents'
  | 'listEventPage'
  | 'observeSnapshot'
> {
  return {
    listSnapshots: async () => (await record('listSnapshots')) as never,
    listSnapshotsPage: async () => (await record('listSnapshotsPage')) as never,
    readSnapshot: async () => (await record('readSnapshot')) as never,
    readStateRevision: async () => (await record('readStateRevision')) as never,
    readCausalRevision: async () => (await record('readCausalRevision')) as never,
    readIssuedAuthSession: async () => (await record('readIssuedAuthSession')) as never,
    listEvents: async () => (await record('listEvents')) as never,
    listRecentEvents: async () => (await record('listRecentEvents')) as never,
    listEventPage: async () => (await record('listEventPage')) as never,
    observeSnapshot: async () => (await record('observeSnapshot')) as never,
  };
}

function createMutationFake(
  record: (operation: TimedAsyncOperation) => Promise<unknown>,
  calls: string[],
  computeSentinel: unknown,
): Pick<GroupStateService, 'read' | 'compute' | 'validate' | 'write'> {
  return {
    read: async () => (await record('read')) as never,
    compute: () => {
      calls.push('compute');
      return computeSentinel as never;
    },
    validate: () => {
      calls.push('validate');
    },
    write: async () => (await record('write')) as never,
  };
}

export async function invokeEveryTimedGroupStateOperation(
  service: GroupStateService,
): Promise<Readonly<Record<TimedAsyncOperation, unknown>>> {
  const scope = { applicationId: 'timing-app', workspaceId: 'timing-workspace' };
  const groupRef = { ...scope, groupId: 'timing-group' };
  const results = {
    prepareMutation: await service.prepareMutation(timingDescriptor(), {} as never),
    prepareExpiredPresenceMutations: await service.prepareExpiredPresenceMutations(1_000),
    prepareSessionCleanupMutations: await service.prepareSessionCleanupMutations({
      scope,
      authSession: {} as never,
      principalId: 'cleanup-principal',
      disconnectedAtEpochMs: 1_000,
    }),
    listSnapshots: await service.listSnapshots(scope),
    listSnapshotsPage: await service.listSnapshotsPage(scope, { limit: 1 }),
    readSnapshot: await service.readSnapshot(groupRef),
    readStateRevision: await service.readStateRevision(groupRef),
    readCausalRevision: await service.readCausalRevision(groupRef),
    readIssuedAuthSession: await service.readIssuedAuthSession('timing-session'),
    listEvents: await service.listEvents(groupRef),
    listRecentEvents: await service.listRecentEvents!(groupRef, { limit: 1 }),
    listEventPage: await service.listEventPage(groupRef, { limit: 1 }),
    observeSnapshot: await service.observeSnapshot({ marker: 'snapshot' } as never),
    read: await service.read(timingCommand()),
    write: await service.write((() => undefined) as never, {} as never),
  };
  return results;
}

export function invokeUntimedGroupStateOperations(service: GroupStateService): unknown {
  const command = timingCommand();
  const read = {} as never;
  const computed = service.compute(command, read);
  service.validate(command, read, computed);
  return computed;
}

function timingDescriptor() {
  return {
    operation: 'updateGroup' as const,
    scope: { applicationId: 'timing-app', workspaceId: 'timing-workspace' },
    groupId: 'timing-group',
    targetPrincipalId: null,
    sessionId: null,
    request: { requestId: 'timing-prepare-request' },
  } as never;
}

function timingCommand() {
  return {
    command: {
      requestId: 'timing-read-request',
      aggregateRef: {
        applicationId: 'timing-app',
        workspaceId: 'timing-workspace',
        groupId: 'timing-group',
      },
    },
  } as never;
}
