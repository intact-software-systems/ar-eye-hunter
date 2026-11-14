import { GROUP_LAYOUT_IDENTITY_KEYS } from '@shared/api/group-lifecycle/group-layout-identity.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../rallar-black-box-test-contracts.ts';

import { CONNECT_READINESS_TIMEOUT_MS, MESSAGE_CONTROL_TIMEOUT_MS } from '../alm-conformance-budgets.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';
import { toReadPollCommand, type PollFact, type PollField } from '../poll/alm-conformance-poll-commands.ts';
import { toAlmCellGroupRead } from './to-alm-cell-group-read.ts';
import { toAlmCellStartState } from './to-alm-cell-start-state.ts';

/**
 * What a settle role runs between its cell's barriers before its arming run. The receiver, which creates the room and
 * owns it, polls until the server holds the room settled; then every page reads the room's head itself and waits until
 * it applied that head, so no role's first send meets a page that would refuse it as not yet in sync.
 */
export interface AlmCellSettle {
    /**
     * Before `formation-settled`: the receiver's start state, which every role's membership lets it write, then its
     * formation poll, which therefore covers the writes' chains; nothing for any other role.
     */
    readonly formation: readonly RallarBlackBoxTestCommand[];
    /** After `formation-settled`: the page's head read, then its wait for the page to have applied that head. */
    readonly head: readonly RallarBlackBoxTestCommand[];
}

const CAUSAL_REVISION_KEYS = ['groupRevision', 'presenceRevision'] as const;

export function toAlmCellSettle(step: AlmConformanceStepInput): AlmCellSettle {
    return {
        formation: step.role === 'receiver' ? [...toAlmCellStartState(step), toFormationPollCommand(step)] : [],
        head: [
            toAlmCellGroupRead({
                step,
                name: 'head-read',
                resource: 'snapshot',
                purpose: 'Read the room head this page must apply before its cell starts.'
            }),
            toHeadAppliedWait(step)
        ]
    };
}

const toFormationField = (field: string): PollField => ({ read: 'formation', field: `body.${field}` });
const toGroupField = (field: string): PollField => ({ read: 'group', field: `body.${field}` });

/**
 * The room settled: no replan is queued, the accepted layout matches the planning inputs, both reads describe one
 * revision, and the stored status was observed in the current formation epoch on the accepted layout. A room with no
 * status or no accepted layout leaves a compared path missing, so it never settles. The view's `condition` is not read:
 * it falls back to a derived band when the stored status is not current.
 */
const FORMATION_SETTLED_FACTS: readonly PollFact[] = [
    { name: 'formation-not-pending', source: toFormationField('pending'), operator: 'equals', expected: null },
    { name: 'formation-layout-current', source: toFormationField('layoutStale'), operator: 'equals', expected: false },
    ...CAUSAL_REVISION_KEYS.map((key) => ({
        name: `formation-at-group-${key}`,
        source: toFormationField(`causalRevision.${key}`),
        equals: toGroupField(`causalRevision.${key}`)
    })),
    {
        name: 'status-of-formation-epoch',
        source: toGroupField('group.activationStatus.formationEpoch'),
        equals: toGroupField('group.formationEpoch')
    },
    ...GROUP_LAYOUT_IDENTITY_KEYS.map((key) => ({
        name: `status-on-accepted-${key}`,
        source: toGroupField(`group.activationStatus.coverageBasisLayoutIdentity.${key}`),
        equals: toGroupField(`group.acceptedLayoutIdentity.${key}`)
    }))
];

/** The receiver reads its room's formation view, then its snapshot, until the two describe a settled room. */
function toFormationPollCommand(owner: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toReadPollCommand({
        step: owner,
        name: 'formation-poll',
        phaseMs: CONNECT_READINESS_TIMEOUT_MS,
        commandTimeoutMs: MESSAGE_CONTROL_TIMEOUT_MS,
        reads: [
            {
                name: 'formation',
                read: (readName) =>
                    toAlmCellGroupRead({
                        step: owner,
                        name: readName,
                        resource: 'formation',
                        purpose: 'Read whether the room\'s formation settled.'
                    })
            },
            {
                name: 'group',
                read: (readName) =>
                    toAlmCellGroupRead({
                        step: owner,
                        name: readName,
                        resource: 'snapshot',
                        purpose: 'Read the room head.'
                    })
            }
        ],
        facts: FORMATION_SETTLED_FACTS
    });
}

/**
 * The page holds the head it read, or a later one. The wait reads the page's whole history: every settle role's connect
 * in this cell wrote presence before this read, so the head's `presenceRevision` floor is above any `held` event an
 * earlier cell left on the page, and only this cell's applications can meet both floors. A `removed` event, which the
 * page emits when its cache drops the group, is not matched. The bridged diagnostic names no connection, so the match
 * names none.
 */
function toHeadAppliedWait(step: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    const group = step.input.group;
    const head = `resultCache.${toCommandId(step, 'head-read')}.value.body.causalRevision`;
    return {
        kind: 'wait',
        commandId: toCommandId(step, 'head-applied'),
        match: {
            kind: 'diagnostic',
            topic: 'rallar.browser.group_state.applied',
            payloadFields: {
                'data.change': 'held',
                'data.groupRef.applicationId': group.applicationId,
                'data.groupRef.workspaceId': group.workspaceId,
                'data.groupRef.groupId': group.groupId
            },
            payloadMinimums: Object.fromEntries(
                CAUSAL_REVISION_KEYS.map((key) => [`data.${key}`, `{${head}.${key}}`])
            )
        },
        timeoutMs: CONNECT_READINESS_TIMEOUT_MS,
        metadata: { historyFrom: 'page' }
    };
}
