import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarOnChangeOptions,
    RallarStateListener,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupActivationCondition } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import type { GroupConnectRejectionCode } from '@shared/api/group-lifecycle/group-connect-rejection-codes.ts';
import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';
import type { GroupLayoutIdentity, GroupLayoutRole } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type {
    GroupFormationOutcome,
    GroupLifecycleState,
    GroupMemberPolicy,
    GroupTopologyReconfigureLanding,
    GroupTransportState
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupDialLayoutRoles } from '@shared/api/group-lifecycle/resolve-dial-layout-roles.ts';
import type { GroupPolicyReasonCode } from '@shared/api/group-policy-types.ts';

import type { GroupRef, GroupSnapshot, GroupStateCausalRevision } from '../room-group-state-translation.ts';

export type RallarRoomLayoutRole = Extract<GroupLayoutRole, 'planned' | 'accepted'>;

export interface RallarRoomLayout {
    readonly role: RallarRoomLayoutRole;
    readonly identity: GroupLayoutIdentity;
    readonly overlay: OverlayInfo;
}

export interface RallarRoomFormationStatus {
    readonly roomRef: GroupRef;
    readonly stage: GroupLifecycleState;
    readonly formationEpoch: number;
    readonly formationAttemptCount: number;
    readonly lastFormationOutcome: GroupFormationOutcome | undefined;
    readonly transportState: GroupTransportState;
    readonly dialing: GroupDialLayoutRoles;
    readonly memberPolicy: GroupMemberPolicy;
    readonly accepted: RallarRoomLayout | undefined;
    readonly planned: RallarRoomLayout | undefined;
    readonly condition: GroupActivationCondition | undefined;
    readonly coverageRate: number | undefined;
    readonly snapshot: GroupSnapshot;
}

export interface RallarRoomFormationCommandOptions extends RallarScopedOperationOptions {
    readonly reason?: string;
}

export interface RallarRoomConnectOptions extends RallarRoomFormationCommandOptions {
    /** The exact planned layout to dial; the room's current planned layout when omitted. */
    readonly layout?: GroupLayoutIdentity;
}

export interface RallarRoomReconfigureOptions extends RallarRoomFormationCommandOptions {
    /** Overrides the stored policy's `reconfigureLanding` for this call. */
    readonly landing?: GroupTopologyReconfigureLanding;
}

export type RallarRoomFormationWaitStatus = 'ready' | 'timeout' | 'aborted' | 'not-found';

export interface RallarRoomFormationWaitResult {
    readonly status: RallarRoomFormationWaitStatus;
    readonly roomRef: GroupRef;
    readonly formation: RallarRoomFormationStatus | undefined;
}

export interface RallarRoomLayoutWaitOptions extends RallarScopedOperationOptions {
    /** The slot to wait on; the planned slot when omitted. */
    readonly role?: RallarRoomLayoutRole;
    /** Accept only a layout published at or after this revision; any layout when omitted. */
    readonly after?: GroupStateCausalRevision;
}

export interface RallarRoomLayoutWaitResult {
    readonly status: RallarRoomFormationWaitStatus;
    readonly roomRef: GroupRef;
    readonly layout: RallarRoomLayout | undefined;
    readonly formation: RallarRoomFormationStatus | undefined;
}

export type RallarRoomLayoutEvent =
    | Readonly<{ kind: 'layoutPlanned'; roomRef: GroupRef; layout: RallarRoomLayout; }>
    | Readonly<{ kind: 'layoutAccepted'; roomRef: GroupRef; layout: RallarRoomLayout; }>
    | Readonly<{
        kind: 'layoutRemoved';
        roomRef: GroupRef;
        role: RallarRoomLayoutRole;
        previous: RallarRoomLayout | undefined;
    }>;

export type RallarRoomLayoutListener = (event: RallarRoomLayoutEvent) => void | Promise<void>;

export interface RallarRoomFormation {
    readonly roomRef: GroupRef;
    status(): RallarRoomFormationStatus | undefined;
    readView(options?: RallarScopedOperationOptions): Promise<GroupFormationView>;
    plan(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    connect(options?: RallarRoomConnectOptions): Promise<GroupSnapshot>;
    activate(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    reconfigure(options?: RallarRoomReconfigureOptions): Promise<GroupSnapshot>;
    pause(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    resume(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    reset(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    start(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    waitForStage(
        stage: GroupLifecycleState | readonly GroupLifecycleState[],
        options?: RallarScopedOperationOptions
    ): Promise<RallarRoomFormationWaitResult>;
    waitForCondition(
        condition: GroupActivationCondition | readonly GroupActivationCondition[],
        options?: RallarScopedOperationOptions
    ): Promise<RallarRoomFormationWaitResult>;
    waitForLayout(options?: RallarRoomLayoutWaitOptions): Promise<RallarRoomLayoutWaitResult>;
    onChange(
        listener: RallarStateListener<RallarRoomFormationStatus>,
        options?: RallarOnChangeOptions
    ): RallarUnsubscribe;
    onLayout(listener: RallarRoomLayoutListener): RallarUnsubscribe;
}

export type RallarRoomFormationDenial =
    | Readonly<{ kind: 'policy'; code: GroupPolicyReasonCode; message: string; }>
    | Readonly<{ kind: 'layout'; code: GroupConnectRejectionCode; message: string; }>;
