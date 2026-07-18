import * as api from '@shared-web/browser/api-integration.ts';
import type { StateGroupWorkflowValue } from '@shared-web/browser/api-workflows.ts';
import * as apiWorkflows from '@shared-web/browser/api-workflows.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type {
    RallarRefreshOptions,
    RallarScopedOperationOptions,
} from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarRoomMessageChannelDefinition,
    RallarMessagesFacade,
} from '@shared-web/browser/rallar-messages-facade.ts';
import {
    type RallarOperationOptions,
    toRallarOperationOptions,
    toRallarWorkflowPolicies,
} from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarRealtimeFacade } from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
    CreateRallarRoomsFacadeOptions,
    RallarCreateRoomInput,
    RallarJoinRoomInput,
    RallarJoinRoomOptions,
    RallarLeaveRoomOptions,
    RallarRoomGovernanceOptions,
    RallarRoomInviteOptions,
    RallarRoomLifecycleOptions,
    RallarRoomPresenceWaitOptions,
    RallarRoomPresenceWaitResult,
    RallarRoomSession,
    RallarRoomSessionMessageDefinition,
    RallarRoomSessionRealtimeInput,
    RallarRoomState,
    RallarRoomSummary,
    RallarRoomSwitchPartialFailureError,
    RallarRoomTargetInput,
    RallarUpdateRoomInput,
} from '@shared-web/browser/rallar-rooms-facade.ts';
import type {
    RallarStateEventsPort,
    RallarStatePort,
} from '@shared-web/browser/rallar-runtime/contracts.ts';
import {
    pushOptionalGroupRefIssue,
    pushOptionalRouteIdIssue,
    throwIfRallarValidationIssues,
    throwRallarValidationIssue,
} from '@shared-web/browser/rallar-runtime/validation.ts';
import { normalizeWaitTimeoutMs } from '@shared-web/browser/rallar-runtime/wait.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import {
    evaluateRallarReadinessExpectation,
    normalizeRallarReadinessExpectation,
    type RallarReadinessStatus,
} from '@shared-web/browser/readiness.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef, toStateScope } from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { isGroupActive } from '@shared/api/group-client-views.ts';
import type {
    GroupRef,
    GroupRole,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { type RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import type {
    StateScope,
    UpdateGroupRequest,
} from '@shared/api/state-types.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

export type CreateRallarRoomsControllerOptions = Readonly<{
    stateStore: RallarStatePort;
    stateEvents: RallarStateEventsPort;
    messages: RallarMessagesFacade;
    realtime: RallarRealtimeFacade;
    connect(options?: RallarOperationOptions): Promise<ApiMiddleware>;
    requireSession(): AuthSession;
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T,
    ): T & RallarOperationOptions;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
    resolveDefaultRoom(): string | GroupRef | undefined;
    resolveDefaultRoomRef(): GroupRef | undefined;
    runAuthAwareOperation<T>(operation: () => Promise<T>): Promise<T>;
    acceptSnapshots(
        ctx: ApiMiddleware,
        clients: readonly ClientSnapshot[],
        groups: readonly GroupSnapshot[],
        scope?: StateScope,
    ): Promise<void>;
}>;

export type RallarRoomsController = Readonly<{
    operations: CreateRallarRoomsFacadeOptions;
}>;

export function createRallarRoomsController(
    options: CreateRallarRoomsControllerOptions,
): RallarRoomsController {
    return new BrowserRallarRoomsController(options);
}

class BrowserRallarRoomsController implements RallarRoomsController {
    readonly operations: CreateRallarRoomsFacadeOptions;

    constructor(
        private readonly options: CreateRallarRoomsControllerOptions,
    ) {
        this.operations = {
            state: () => this.options.stateStore.roomState(),
            list: () => this.options.stateStore.roomState().rooms,
            refresh: async (input) => await this.refresh(input),
            listEvents: async (input) =>
                await this.options.stateEvents.listRoomEvents(input),
            listEventPage: async (input) =>
                await this.options.stateEvents.listRoomEventPage(input),
            replayEvents: async (input, listener) =>
                await this.options.stateEvents.replayRoomEventsInput(
                    input,
                    listener,
                ),
            create: async (input) => await this.create(input),
            createAndSwitch: async (input) =>
                await this.createAndSwitch(input),
            join: async (room, joinOptions) =>
                await this.join(room, joinOptions),
            enter: async (room, joinOptions) =>
                await this.enter(room, joinOptions),
            session: (room) => this.createSessionForTarget(room),
            leave: async (input) => await this.leave(input),
            update: async (input) => await this.update(input),
            archive: async (room, lifecycleOptions) =>
                await this.changeLifecycle(room, 'archived', lifecycleOptions),
            delete: async (room, lifecycleOptions) =>
                await this.changeLifecycle(room, 'deleted', lifecycleOptions),
            invite: async (room, principalId, inviteOptions) =>
                await this.invite(room, principalId, inviteOptions),
            acceptInvite: async (room, acceptOptions) =>
                await this.acceptInvite(room, acceptOptions),
            removeMember: async (room, principalId, governanceOptions) =>
                await this.governMember(
                    room,
                    principalId,
                    'remove',
                    governanceOptions,
                ),
            banMember: async (room, principalId, governanceOptions) =>
                await this.governMember(
                    room,
                    principalId,
                    'ban',
                    governanceOptions,
                ),
            unbanMember: async (room, principalId, governanceOptions) =>
                await this.governMember(
                    room,
                    principalId,
                    'unban',
                    governanceOptions,
                ),
            setMemberRole: async (
                room,
                principalId,
                role,
                governanceOptions,
            ) => await this.setMemberRole(
                room,
                principalId,
                role,
                governanceOptions,
            ),
            transferOwnership: async (
                room,
                principalId,
                governanceOptions,
            ) => await this.transferOwnership(
                room,
                principalId,
                governanceOptions,
            ),
            updateMetadata: async (room, patch, mutationOptions) =>
                await this.updateMetadata(room, patch, mutationOptions),
            waitForPresence: async (room, waitOptions) =>
                await this.waitForPresence(room, waitOptions),
            current: () => this.options.stateStore.roomState().currentRoom,
            onChange: (listener, changeOptions) =>
                this.options.stateStore.onRoomChange(listener, changeOptions),
            onEvent: (listener, eventOptions = {}) =>
                this.options.stateEvents.onRoomEvent(listener, eventOptions),
        };
    }

    private async refresh(
        input?: StateScope | RallarRefreshOptions,
    ): Promise<RallarRoomState> {
        return await this.options.runAuthAwareOperation(async () => {
            const refreshOptions = toRallarRefreshOptions(input);
            const operationOptions = this.options.resolveOperationOptions(
                refreshOptions,
            );
            const ctx = await this.options.connect(operationOptions);
            const operationScope = this.options.resolveOperationScope(
                refreshOptions.scope,
            );
            const { clients, groups } = await apiWorkflows.refreshStateSnapshots(
                operationScope,
                toRallarWorkflowPolicies(operationOptions),
            );
            await this.options.acceptSnapshots(
                ctx,
                clients,
                groups,
                operationScope,
            );
            return this.options.stateStore.roomState();
        });
    }

    private async create(
        input: string | RallarCreateRoomInput,
    ): Promise<GroupSnapshot> {
        return await this.options.runAuthAwareOperation(async () => {
            const createInput = typeof input === 'string'
                ? { displayName: input }
                : input;
            const operationOptions = this.options.resolveOperationOptions(
                createInput,
            );
            const ctx = await this.options.connect(operationOptions);
            const session = this.options.requireSession();
            const operationScope = this.options.resolveOperationScope(
                createInput.scope,
            );
            const createOptions = toDefinedRecord({
                description: createInput.description,
                joinMode: createInput.joinMode,
                maxMembers: createInput.maxMembers,
                maxSessionsPerMember: createInput.maxSessionsPerMember,
                metadata: createInput.metadata,
                expiresAtEpochMs: createInput.expiresAtEpochMs,
                purgeAfterEpochMs: createInput.purgeAfterEpochMs,
            });
            const policies = toRallarWorkflowPolicies<StateGroupWorkflowValue>(
                operationOptions,
            );
            const snapshot = Object.keys(createOptions).length === 0
                ? await apiWorkflows.createAndJoinStateGroup(
                    createInput.displayName,
                    session.clientId,
                    session.sessionId,
                    ctx.middleware.heartbeat.generationId,
                    operationScope,
                    policies,
                    createInput.groupId,
                )
                : await apiWorkflows.createAndJoinStateGroup(
                    createInput.displayName,
                    session.clientId,
                    session.sessionId,
                    ctx.middleware.heartbeat.generationId,
                    operationScope,
                    policies,
                    createInput.groupId,
                    createOptions,
                );
            this.options.stateStore.setCurrentRoom(snapshot);
            await this.options.acceptSnapshots(ctx, [], [snapshot], operationScope);
            return snapshot;
        });
    }

    private async createAndSwitch(
        input: string | RallarCreateRoomInput,
    ): Promise<GroupSnapshot> {
        const createInput = typeof input === 'string'
            ? { displayName: input }
            : input;
        const previousRoomRef = this.options.stateStore.resolveCurrentRoomRef();
        const leaveOptions = toRallarOperationOptions(
            this.options.resolveOperationOptions(createInput),
        );
        const snapshot = await this.create(input);

        if (
            previousRoomRef &&
            !this.options.stateStore.isSameRoomRefOrId(
                previousRoomRef,
                snapshot.group,
            )
        ) {
            try {
                await this.leave({
                    ...leaveOptions,
                    roomId: previousRoomRef.groupId,
                    roomRef: previousRoomRef,
                    clearCurrent: false,
                    scope: toStateScope(previousRoomRef),
                });
            } catch (error) {
                throw createRoomSwitchPartialFailureError({
                    operation: 'create-and-switch',
                    joinedRoom: snapshot,
                    previousRoomRef,
                    leaveError: error,
                });
            }
        }
        return snapshot;
    }

    private async join(
        room: string | GroupRef | RallarJoinRoomInput,
        joinOptions: RallarJoinRoomOptions = {},
    ): Promise<GroupSnapshot> {
        return await this.options.runAuthAwareOperation(async () => {
            const joinInput = this.toJoinInput(room, joinOptions);
            this.assertValidJoinInput(joinInput);
            const operationOptions = this.options.resolveOperationOptions(
                joinInput.options,
            );
            const ctx = await this.options.connect(operationOptions);
            const session = this.options.requireSession();
            const currentRoomRef = this.options.stateStore.resolveCurrentRoomRef();
            const roomRef = joinInput.roomRef ??
                (joinInput.roomId
                    ? this.options.stateStore.resolveGroupRefFromRoomId(
                        joinInput.roomId,
                        joinInput.options.scope,
                    )
                    : undefined);
            const roomId = joinInput.roomId ?? roomRef?.groupId;
            const operationScope = joinInput.options.scope ??
                (roomRef
                    ? toStateScope(roomRef)
                    : this.options.resolveOperationScope(joinInput.options.scope));
            if (!roomId) {
                throwRallarValidationIssue(
                    '$.roomId',
                    'missing-room',
                    'Cannot join room: room is required.',
                );
            }

            const snapshot = await apiWorkflows.joinStateGroup(
                roomId,
                session.clientId,
                session.sessionId,
                ctx.middleware.heartbeat.generationId,
                operationScope,
                toRallarWorkflowPolicies(operationOptions),
                {
                    inviteToken: joinInput.options.inviteToken,
                    joinCode: joinInput.options.joinCode,
                },
            );
            this.options.stateStore.setCurrentRoom(snapshot);
            await this.options.acceptSnapshots(ctx, [], [snapshot], operationScope);

            if (
                (joinInput.options.leaveCurrent ?? true) && currentRoomRef &&
                !this.options.stateStore.isSameRoomRefOrId(
                    currentRoomRef,
                    roomRef ?? roomId,
                )
            ) {
                try {
                    await this.leave({
                        roomId: currentRoomRef.groupId,
                        roomRef: currentRoomRef,
                        clearCurrent: false,
                        scope: toStateScope(currentRoomRef),
                        signal: operationOptions.signal,
                        timeoutMs: operationOptions.timeoutMs,
                    });
                } catch (error) {
                    throw createRoomSwitchPartialFailureError({
                        operation: 'join',
                        joinedRoom: snapshot,
                        previousRoomRef: currentRoomRef,
                        leaveError: error,
                    });
                }
            }
            return snapshot;
        });
    }

    private async enter(
        room: string | GroupRef | RallarJoinRoomInput,
        joinOptions: RallarJoinRoomOptions = {},
    ): Promise<RallarRoomSession> {
        const snapshot = await this.join(room, joinOptions);
        return this.createSession(snapshot.group);
    }

    private createSessionForTarget(
        room?: string | GroupRef,
    ): RallarRoomSession {
        const target = room ?? this.options.resolveDefaultRoomRef() ??
            this.options.stateStore.resolveCurrentRoomRef() ??
            this.options.resolveDefaultRoom();
        const roomRef = typeof target === 'string'
            ? this.options.stateStore.resolveRoomRef(target)
            : target;
        if (!roomRef) {
            throwRallarValidationIssue(
                '$.roomRef',
                'missing-room-ref',
                'Cannot create room session: no scoped room reference.',
            );
        }
        return this.createSession(roomRef);
    }

    private createSession(roomRef: GroupRef): RallarRoomSession {
        const roomId = roomRef.groupId;
        return {
            roomId,
            roomRef,
            snapshot: () => this.options.stateStore.findGroupSnapshot(roomRef),
            summary: () => this.findSummary(roomRef),
            leave: async (leaveOptions = {}) => await this.leave({
                ...leaveOptions,
                roomId,
                roomRef,
                scope: leaveOptions.scope ?? toStateScope(roomRef),
            }),
            refresh: async (refreshOptions = {}) => {
                await this.refresh({
                    ...refreshOptions,
                    scope: refreshOptions.scope ?? toStateScope(roomRef),
                });
                return this.createSession(roomRef);
            },
            realtime: <T>(input?: RallarRoomSessionRealtimeInput) =>
                this.options.realtime.room<T>(
                    toRoomSessionRealtimeDefaults(input, roomRef),
                ),
            message: <T>(input: RallarRoomSessionMessageDefinition) =>
                this.options.messages.room<T>(
                    this.toRoomSessionMessageDefinition(input, roomRef),
                ),
        };
    }

    private findSummary(roomRef: GroupRef): RallarRoomSummary | undefined {
        return this.options.stateStore.roomState().rooms.find((room) =>
            isSameGroupRef(room.roomRef, roomRef)
        );
    }

    private toRoomSessionMessageDefinition(
        input: RallarRoomSessionMessageDefinition,
        roomRef: GroupRef,
    ): RallarRoomMessageChannelDefinition {
        if (typeof input === 'string') {
            return {
                topicId: `room.${input}`,
                typeId: `room.${input}.v1`,
                roomRef,
            };
        }

        const issues: RallarValidationIssue[] = [];
        if (input.roomId && input.roomId !== roomRef.groupId) {
            issues.push({
                path: '$.roomId',
                code: 'room-id-mismatch',
                message: 'roomId must match the bound room session.',
            });
        }
        if (input.roomRef && !isSameGroupRef(input.roomRef, roomRef)) {
            issues.push({
                path: '$.roomRef',
                code: 'room-ref-mismatch',
                message: 'roomRef must match the bound room session.',
            });
        }
        throwIfRallarValidationIssues(issues);
        return { topicId: input.topicId, typeId: input.typeId, roomRef };
    }

    private toJoinInput(
        room: string | GroupRef | RallarJoinRoomInput,
        options: RallarJoinRoomOptions,
    ): Readonly<{
        roomId?: string;
        roomRef?: GroupRef;
        options: RallarJoinRoomOptions;
    }> {
        if (typeof room === 'string') {
            return { roomId: room, roomRef: options.roomRef, options };
        }
        if (isGroupRefInput(room)) {
            return { roomId: room.groupId, roomRef: room, options };
        }
        return {
            roomId: room.roomId ?? room.roomRef?.groupId,
            roomRef: room.roomRef,
            options: room,
        };
    }

    private assertValidJoinInput(
        input: Readonly<{ roomId?: string; roomRef?: GroupRef }>,
    ): void {
        const issues: RallarValidationIssue[] = [];
        pushOptionalRouteIdIssue(input.roomId, '$.roomId', 'Room ID', issues);
        pushOptionalGroupRefIssue(input.roomRef, '$.roomRef', issues);
        if (!input.roomId && !input.roomRef) {
            issues.push({
                path: '$.roomId',
                code: 'missing-room',
                message: 'Cannot join room: room is required.',
            });
        }
        if (
            input.roomId && input.roomRef &&
            input.roomId !== input.roomRef.groupId
        ) {
            issues.push({
                path: '$.roomRef.groupId',
                code: 'room-id-mismatch',
                message: 'roomId must match roomRef.groupId.',
            });
        }
        throwIfRallarValidationIssues(issues);
    }

    private toRoomTarget(
        room: string | GroupRef | RallarRoomTargetInput,
        options: RallarScopedOperationOptions,
    ): Readonly<{
        roomId: string;
        roomRef?: GroupRef;
        options: RallarScopedOperationOptions;
    }> {
        const target = typeof room === 'string'
            ? { roomId: room, roomRef: undefined, options }
            : isGroupRefInput(room)
                ? { roomId: room.groupId, roomRef: room, options }
                : {
                    roomId: room.roomId ?? room.roomRef?.groupId,
                    roomRef: room.roomRef,
                    options: { ...room, ...options },
                };
        this.assertValidJoinInput(target);
        if (!target.roomId) {
            throwRallarValidationIssue(
                '$.roomId',
                'missing-room',
                'Cannot operate on room: room is required.',
            );
        }
        return {
            roomId: target.roomId,
            roomRef: target.roomRef,
            options: target.options,
        };
    }

    private async leave(
        input?: string | RallarLeaveRoomOptions,
    ): Promise<GroupSnapshot | undefined> {
        return await this.options.runAuthAwareOperation(async () => {
            const leaveOptions = typeof input === 'string'
                ? { roomId: input }
                : input ?? {};
            const operationOptions = this.options.resolveOperationOptions(
                leaveOptions,
            );
            const ctx = await this.options.connect(operationOptions);
            const session = this.options.requireSession();
            const explicitScope = this.options.resolveOperationScope(
                leaveOptions.scope,
            );
            const roomRef = leaveOptions.roomRef ??
                (leaveOptions.roomId
                    ? this.options.stateStore.resolveGroupRefFromRoomId(
                        leaveOptions.roomId,
                        leaveOptions.scope,
                    )
                    : this.options.resolveDefaultRoomRef() ??
                        this.options.stateStore.resolveCurrentRoomRef());
            const roomId = leaveOptions.roomId ?? roomRef?.groupId;
            const operationScope = leaveOptions.scope ??
                (roomRef ? toStateScope(roomRef) : explicitScope);
            if (!roomId) {
                return undefined;
            }
            const snapshot = await apiWorkflows.leaveStateGroup(
                roomId,
                session.clientId,
                session.sessionId,
                ctx.middleware.heartbeat.generationId,
                operationScope,
                toRallarWorkflowPolicies(operationOptions),
            );
            this.options.stateStore.clearCurrentRoomIfMatches(
                roomRef ?? roomId,
                leaveOptions.clearCurrent ?? true,
            );
            await this.options.acceptSnapshots(ctx, [], [snapshot], operationScope);
            return snapshot;
        });
    }

    private async update(input: RallarUpdateRoomInput): Promise<GroupSnapshot> {
        const request = toDefinedRecord<UpdateGroupRequest>({
            slug: input.slug,
            displayName: input.displayName,
            description: input.description,
            kind: input.kind,
            joinMode: input.joinMode,
            maxMembers: input.maxMembers,
            maxSessionsPerMember: input.maxSessionsPerMember,
            metadata: input.metadata,
            expiresAtEpochMs: input.expiresAtEpochMs,
            purgeAfterEpochMs: input.purgeAfterEpochMs,
        });
        return await this.runTargetMutation(input, input, async (
            roomId,
            session,
            scope,
            policies,
        ) => await apiWorkflows.updateStateGroupDetails(
            roomId,
            request,
            session.clientId,
            session.sessionId,
            scope,
            policies,
        ));
    }

    private async changeLifecycle(
        room: string | GroupRef | RallarRoomTargetInput,
        status: 'archived' | 'deleted',
        lifecycleOptions: RallarRoomLifecycleOptions = {},
    ): Promise<GroupSnapshot> {
        return await this.runTargetMutation(
            room,
            lifecycleOptions,
            async (roomId, session, scope, policies) => {
                const request = toDefinedRecord<Omit<UpdateGroupRequest, 'status'>>({
                    reason: lifecycleOptions.reason,
                });
                return status === 'archived'
                    ? await apiWorkflows.archiveStateGroup(
                        roomId,
                        request,
                        session.clientId,
                        session.sessionId,
                        scope,
                        policies,
                    )
                    : await apiWorkflows.deleteStateGroup(
                        roomId,
                        request,
                        session.clientId,
                        session.sessionId,
                        scope,
                        policies,
                    );
            },
        );
    }

    private async invite(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        inviteOptions: RallarRoomInviteOptions = {},
    ): Promise<GroupSnapshot> {
        return await this.runTargetMutation(
            room,
            inviteOptions,
            async (roomId, session, scope, policies) =>
                await apiWorkflows.createStateGroupInvite(
                    roomId,
                    principalId,
                    toDefinedRecord({
                        invitationExpiresAtEpochMs:
                            inviteOptions.invitationExpiresAtEpochMs,
                        reason: inviteOptions.reason,
                    }),
                    session.clientId,
                    session.sessionId,
                    scope,
                    policies,
                ),
        );
    }

    private async acceptInvite(
        room: string | GroupRef | RallarRoomTargetInput,
        acceptOptions: RallarScopedOperationOptions = {},
    ): Promise<GroupSnapshot> {
        return await this.runTargetMutation(
            room,
            acceptOptions,
            async (roomId, session, scope, policies, generationId) =>
                await apiWorkflows.acceptStateGroupInvite(
                    roomId,
                    session.clientId,
                    session.sessionId,
                    generationId,
                    scope,
                    policies,
                ),
        );
    }

    private async governMember(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        action: 'remove' | 'ban' | 'unban',
        governanceOptions: RallarRoomGovernanceOptions = {},
    ): Promise<GroupSnapshot> {
        return await this.runTargetMutation(
            room,
            governanceOptions,
            async (roomId, session, scope, policies) => {
                const request = toDefinedRecord({
                    reason: governanceOptions.reason,
                });
                switch (action) {
                    case 'remove':
                        return await apiWorkflows.removeStateGroupMember(
                            roomId,
                            principalId,
                            request,
                            session.clientId,
                            session.sessionId,
                            scope,
                            policies,
                        );
                    case 'ban':
                        return await apiWorkflows.banStateGroupMember(
                            roomId,
                            principalId,
                            request,
                            session.clientId,
                            session.sessionId,
                            scope,
                            policies,
                        );
                    case 'unban':
                        return await apiWorkflows.unbanStateGroupMember(
                            roomId,
                            principalId,
                            request,
                            session.clientId,
                            session.sessionId,
                            scope,
                            policies,
                        );
                }
            },
        );
    }

    private async setMemberRole(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        role: GroupRole,
        governanceOptions: RallarRoomGovernanceOptions = {},
    ): Promise<GroupSnapshot> {
        return await this.runTargetMutation(
            room,
            governanceOptions,
            async (roomId, session, scope, policies) =>
                await apiWorkflows.setStateGroupMemberRole(
                    roomId,
                    principalId,
                    toDefinedRecord({ role, reason: governanceOptions.reason }),
                    session.clientId,
                    session.sessionId,
                    scope,
                    policies,
                ),
        );
    }

    private async transferOwnership(
        room: string | GroupRef | RallarRoomTargetInput,
        principalId: string,
        governanceOptions: RallarRoomGovernanceOptions = {},
    ): Promise<GroupSnapshot> {
        return await this.runTargetMutation(
            room,
            governanceOptions,
            async (roomId, session, scope, policies) =>
                await apiWorkflows.transferStateGroupOwnership(
                    roomId,
                    toDefinedRecord({
                        newOwnerPrincipalId: principalId,
                        reason: governanceOptions.reason,
                    }),
                    session.clientId,
                    session.sessionId,
                    scope,
                    policies,
                ),
        );
    }

    private async runTargetMutation(
        room: string | GroupRef | RallarRoomTargetInput,
        targetOptions: RallarScopedOperationOptions,
        execute: (
            roomId: string,
            session: AuthSession,
            scope: StateScope,
            policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue>,
            generationId: string,
        ) => Promise<GroupSnapshot>,
    ): Promise<GroupSnapshot> {
        return await this.options.runAuthAwareOperation(async () => {
            const target = this.toRoomTarget(room, targetOptions);
            const operationOptions = this.options.resolveOperationOptions(
                target.options,
            );
            const ctx = await this.options.connect(operationOptions);
            const session = this.options.requireSession();
            const scope = target.options.scope ??
                (target.roomRef
                    ? toStateScope(target.roomRef)
                    : this.options.resolveOperationScope(target.options.scope) ??
                        api.defaultStateScope());
            const snapshot = await execute(
                target.roomId,
                session,
                scope,
                toRallarWorkflowPolicies<StateGroupWorkflowValue>(
                    operationOptions,
                ),
                ctx.middleware.heartbeat.generationId,
            );
            await this.options.acceptSnapshots(ctx, [], [snapshot], scope);
            return snapshot;
        });
    }

    private async updateMetadata(
        room: string | GroupRef,
        patch: Readonly<Record<string, unknown>>,
        mutationOptions: RallarScopedOperationOptions = {},
    ): Promise<GroupSnapshot> {
        return await this.options.runAuthAwareOperation(async () => {
            const operationOptions = this.options.resolveOperationOptions(
                mutationOptions,
            );
            const ctx = await this.options.connect(operationOptions);
            const session = this.options.requireSession();
            const roomRef = this.options.stateStore.resolveRoomRef(room);
            const roomId = this.options.stateStore.toRoomId(room);
            const scope = mutationOptions.scope ??
                (roomRef
                    ? toStateScope(roomRef)
                    : this.options.resolveOperationScope());
            if (!roomId) {
                throw new Error(
                    'Cannot update room metadata: room is required.',
                );
            }
            const snapshot = await apiWorkflows.updateStateGroupMetadata(
                roomId,
                patch,
                session.clientId,
                session.sessionId,
                scope,
                toRallarWorkflowPolicies(operationOptions),
            );
            await this.options.acceptSnapshots(ctx, [], [snapshot], scope);
            return snapshot;
        });
    }

    private async waitForPresence(
        room: string | GroupRef,
        waitOptions: RallarRoomPresenceWaitOptions = {},
    ): Promise<RallarRoomPresenceWaitResult> {
        const operationOptions = this.options.resolveOperationOptions(waitOptions);
        const roomId = this.options.stateStore.toRoomId(room) ??
            (typeof room === 'string' ? room : room.groupId);
        const roomRef = typeof room === 'string'
            ? this.options.stateStore.resolveGroupRefFromRoomId(
                room,
                waitOptions.scope,
            ) ?? this.options.stateStore.resolveRoomRef(room)
            : room;
        const expectation = normalizeRallarReadinessExpectation(
            waitOptions.expect,
        );

        const readResult = (
            statusOverride?: RallarReadinessStatus,
        ): RallarRoomPresenceWaitResult => {
            const snapshot = this.options.stateStore.findGroupSnapshot(
                roomRef ?? room,
            );
            if (!snapshot || !isGroupActive(snapshot)) {
                const empty = evaluateRallarReadinessExpectation([], expectation);
                return {
                    ...empty,
                    status: statusOverride ?? 'not-found',
                    roomId,
                    roomRef: roomRef ?? undefined,
                    activeSessionIds: [],
                    timedOut: statusOverride === 'timeout',
                };
            }
            const activeSessionIds = uniquePeerIds(
                snapshot.activeSessions.map((session) => session.sessionId),
            );
            const evaluation = evaluateRallarReadinessExpectation(
                activeSessionIds,
                expectation,
            );
            return {
                ...evaluation,
                status: statusOverride ?? evaluation.status,
                roomId,
                roomRef: snapshot.group,
                activeSessionIds,
                timedOut: statusOverride === 'timeout',
            };
        };

        const current = readResult();
        if (isTerminalReadinessWaitResult(current)) {
            return current;
        }
        if (operationOptions.signal?.aborted) {
            return { ...current, status: 'aborted' };
        }
        const timeoutMs = normalizeWaitTimeoutMs(waitOptions.timeoutMs);
        if (timeoutMs <= 0) {
            return readResult('timeout');
        }

        return await new Promise<RallarRoomPresenceWaitResult>((resolve) => {
            let settled = false;
            // Assigned after subscription so synchronous callbacks can safely observe undefined.
            // deno-lint-ignore prefer-const
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let unsubscribe: RallarUnsubscribe = () => {};
            const finish = (result: RallarRoomPresenceWaitResult): void => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timeout !== undefined) {
                    clearTimeout(timeout);
                }
                operationOptions.signal?.removeEventListener('abort', onAbort);
                unsubscribe();
                resolve(result);
            };
            const onAbort = (): void => finish({
                ...readResult(),
                status: 'aborted',
            });
            unsubscribe = this.options.stateStore.onCacheChange(() => {
                const next = readResult();
                if (isTerminalReadinessWaitResult(next)) {
                    finish(next);
                }
            });
            operationOptions.signal?.addEventListener('abort', onAbort, {
                once: true,
            });
            const next = readResult();
            if (isTerminalReadinessWaitResult(next)) {
                finish(next);
                return;
            }
            if (operationOptions.signal?.aborted) {
                onAbort();
                return;
            }
            timeout = setTimeout(() => finish(readResult('timeout')), timeoutMs);
        });
    }
}

function toRallarRefreshOptions(
    input?: StateScope | RallarRefreshOptions,
): RallarRefreshOptions {
    if (!input) {
        return {};
    }
    return isStateScope(input) ? { scope: input } : input;
}

function isStateScope(
    input: StateScope | RallarRefreshOptions,
): input is StateScope {
    return typeof input === 'object' && input !== null &&
        !Array.isArray(input) &&
        typeof (input as { applicationId?: unknown }).applicationId === 'string';
}

function toDefinedRecord<T extends object>(input: T): T {
    return Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
    ) as T;
}

function isGroupRefInput(value: unknown): value is GroupRef {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return typeof (value as { applicationId?: unknown }).applicationId ===
            'string' &&
        typeof (value as { groupId?: unknown }).groupId === 'string' &&
        !Object.prototype.hasOwnProperty.call(value, 'roomId') &&
        !Object.prototype.hasOwnProperty.call(value, 'roomRef');
}

function toRoomSessionRealtimeDefaults(
    input: RallarRoomSessionRealtimeInput | undefined,
    roomRef: GroupRef,
) {
    if (input === undefined) {
        return { roomRef };
    }
    if (typeof input === 'string') {
        return { laneId: input, roomRef };
    }
    const { roomId: _roomId, roomRef: _roomRef, ...defaults } = input;
    return { ...defaults, roomRef };
}

function uniquePeerIds(peerIds: readonly string[]): readonly string[] {
    return [...new Set(peerIds)];
}

function isTerminalReadinessWaitResult(
    result: RallarRoomPresenceWaitResult,
): boolean {
    return result.status === 'ready' || result.status === 'not-found';
}

function createRoomSwitchPartialFailureError(
    input: Readonly<{
        operation: 'create-and-switch' | 'join';
        joinedRoom: GroupSnapshot;
        previousRoomRef: GroupRef;
        leaveError: unknown;
    }>,
): RallarRoomSwitchPartialFailureError {
    const message = input.leaveError instanceof Error
        ? input.leaveError.message
        : String(input.leaveError);
    return Object.assign(
        new Error(
            `Room switch joined ${input.joinedRoom.group.groupId}, but leaving ${input.previousRoomRef.groupId} failed: ${message}`,
        ),
        {
            name: 'RallarRoomSwitchPartialFailureError' as const,
            operation: input.operation,
            joinedRoom: input.joinedRoom,
            previousRoomRef: input.previousRoomRef,
            leaveError: input.leaveError,
        },
    );
}
