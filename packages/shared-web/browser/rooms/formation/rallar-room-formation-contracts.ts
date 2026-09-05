import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupActivationCondition } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import type { GroupConnectRejectionCode } from '@shared/api/group-lifecycle/group-connect-rejection-codes.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type {
    GroupFormationOutcome,
    GroupLifecycleState,
    GroupMemberPolicy,
    GroupTopologyReconfigureLanding,
    GroupTransportState
} from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupDialLayoutRoles } from '@shared/api/group-lifecycle/resolve-dial-layout-roles.ts';
import type { GroupPolicyReasonCode } from '@shared/api/group-policy-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

export type RallarRoomLayoutRole = 'planned' | 'accepted';

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
    readonly lastFormationOutcome: GroupFormationOutcome | null;
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

export interface RallarRoomFormation {
    readonly roomRef: GroupRef;
    status(): RallarRoomFormationStatus | undefined;
    plan(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    connect(options?: RallarRoomConnectOptions): Promise<GroupSnapshot>;
    activate(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    reconfigure(options?: RallarRoomReconfigureOptions): Promise<GroupSnapshot>;
    pause(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    resume(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    reset(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
    start(options?: RallarRoomFormationCommandOptions): Promise<GroupSnapshot>;
}

export type RallarRoomFormationDenial =
    | Readonly<{ kind: 'policy'; code: GroupPolicyReasonCode; message: string; }>
    | Readonly<{ kind: 'layout'; code: GroupConnectRejectionCode; message: string; }>;
