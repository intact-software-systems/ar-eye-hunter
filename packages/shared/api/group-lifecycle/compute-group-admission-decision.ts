import type { GroupPolicyDenied } from '../group-policy-types.ts';
import type {
    GroupAdmissionPolicy,
    GroupLifecycleState,
} from './group-lifecycle-policy.ts';

export interface ComputeGroupAdmissionDecisionInput {
    readonly admission: GroupAdmissionPolicy;
    readonly lifecycleState: GroupLifecycleState;
    readonly activeMemberCount: number;
    /**
     * Whether the joining principal holds an unexpired invite. An invite is
     * the group's consent, so it bypasses `manager-approval` parking — but
     * never the `closed` mode or the window constraints, which are timing and
     * capacity facts independent of consent (plan decision 5.1).
     */
    readonly invited: boolean;
    readonly nowEpochMs: number;
}

export type GroupAdmissionDecision =
    | Readonly<{ kind: 'admit' }>
    | Readonly<{ kind: 'park' }>
    | Readonly<{ kind: 'deny'; denial: GroupPolicyDenied }>;

/**
 * The admission decision, binding per mode as plan decision 5.2 fixes
 * correction 5: the window constraints and `manager-approval` bind in every
 * lifecycle state from creation, while `closed` binds outside FORMING — the
 * roster freezes when establishment begins, and a below-floor return to
 * FORMING re-opens the lobby. The windows degrade any mode to closed once
 * they pass, so they are decided first.
 */
export function computeGroupAdmissionDecision(
    input: ComputeGroupAdmissionDecisionInput,
): GroupAdmissionDecision {
    const { admission } = input;

    if (admission.untilEpochMs !== null && input.nowEpochMs >= admission.untilEpochMs) {
        return deny(
            'group-admission-deadline-passed',
            'Group admission closed at its deadline.',
        );
    }

    if (
        admission.untilMemberCount !== null &&
        input.activeMemberCount >= admission.untilMemberCount
    ) {
        return deny(
            'group-admission-capacity-reached',
            'Group admission closed at its member-count limit.',
        );
    }

    switch (admission.mode) {
        case 'open':
            return { kind: 'admit' };
        case 'closed':
            return input.lifecycleState === 'forming'
                ? { kind: 'admit' }
                : deny('group-admission-closed', 'Group admission is closed outside formation.');
        case 'manager-approval':
            return input.invited ? { kind: 'admit' } : { kind: 'park' };
    }
}

function deny(
    code: GroupPolicyDenied['code'],
    message: string,
): GroupAdmissionDecision {
    return { kind: 'deny', denial: { allowed: false, code, message } };
}
