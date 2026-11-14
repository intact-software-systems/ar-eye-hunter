import { GROUP_LAYOUT_IDENTITY_KEYS } from '@shared/api/group-lifecycle/group-layout-identity.ts';

import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { CONNECT_READINESS_TIMEOUT_MS, MESSAGE_CONTROL_TIMEOUT_MS } from '../alm-conformance-budgets.ts';
import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
import { toReadPollCommand, type PollFact, type PollField } from '../poll/alm-conformance-poll-commands.ts';
import { toAlmCellGroupRead } from './to-alm-cell-group-read.ts';
import { toAppliedHeadWaitCommands } from './to-applied-head-wait-commands.ts';

/**
 * What a settle role runs between its cell's barriers before its arming run. The receiver, which creates the room and
 * owns it, polls until the server holds the room settled; then every page reads the room's head itself and waits until
 * it applied that head, so no role's first send meets a page that would refuse it as not yet in sync.
 */
export interface AlmCellSettle {
    /** Before `formation-settled`: the receiver's formation poll, and nothing for any other role. */
    readonly formation: readonly RallarBlackBoxTestCommand[];
    /** After `formation-settled`: the page's head read, then its wait for the page to have applied that head. */
    readonly head: readonly RallarBlackBoxTestCommand[];
}

const CAUSAL_REVISION_KEYS = ['groupRevision', 'presenceRevision'] as const;

export function toAlmCellSettle(step: AlmConformanceStepInput): AlmCellSettle {
    return {
        formation: step.role === 'receiver' ? [toFormationPollCommand(step)] : [],
        head: toAppliedHeadWaitCommands({
            step,
            name: 'head',
            purpose: 'Read the room head this page must apply before its cell starts.',
            history: 'page'
        })
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
