import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { createAlmCohortBarrier } from '../cohort/create-alm-cohort-barrier.ts';
import {
    computeAlmCohortGroupRequestTimeoutMs,
    createAlmCohortSetupCommands,
    type AlmCohortSetupInput
} from '../cohort/create-alm-cohort-setup-commands.ts';
import type { AlmScaleRecipeInput } from './create-alm-scale-recipes.ts';

const SCOPE = 'alm-scale';
const DIRECTOR_TOPIC_ID = 'room.ar-eye-hunter.director';
const DIRECTOR_INTENT_TYPE_ID = 'room.ar-eye-hunter.director.intent.v1';
const DIRECTOR_EVENT_TYPE_ID = 'room.ar-eye-hunter.director.event.v1';

/** The cohort setup with the director's steps: its appointment before any player joins, and every role's wait for it. */
export function createAlmScaleSetupCommands(
    input: AlmScaleRecipeInput,
    role: 'director' | 'player'
): readonly RallarBlackBoxTestCommand[] {
    const prefix = `${SCOPE}-${role}`;
    const cohort = toAlmScaleCohort(input);
    const setup = createAlmCohortSetupCommands(cohort, role === 'director' ? 'owner' : 'member');
    return [
        ...setup.entry,
        ...(role === 'director' ? [createAppointCommand(input, prefix)] : []),
        ...setup.gathering,
        createAlmCohortBarrier({ scope: SCOPE, roleName: role, phase: 'appointed', timeoutMs: input.readyTimeoutMs }),
        createDirectorWait(input, prefix),
        {
            kind: 'director.status',
            commandId: `${prefix}-ready-status`,
            roomRef: { ...input.group },
            refresh: 'when-absent',
            timeoutMs: computeAlmCohortGroupRequestTimeoutMs(cohort)
        },
        ...setup.settling,
        { kind: 'storage.counters', commandId: `${prefix}-storage-reset`, reset: true },
        createAlmCohortBarrier({
            scope: SCOPE,
            roleName: role,
            phase: 'traffic-ready',
            timeoutMs: input.readyTimeoutMs
        })
    ];
}

/** The director owns the group; every page hears the director topic for the players' intents and its own events. */
function toAlmScaleCohort(input: AlmScaleRecipeInput): AlmCohortSetupInput {
    return {
        group: input.group,
        participantCount: input.participantCount,
        readyTimeoutMs: input.readyTimeoutMs,
        almDiagnostics: input.almDiagnostics,
        scope: SCOPE,
        roleNames: { owner: 'director', member: 'player' },
        channel: {
            typeId: DIRECTOR_INTENT_TYPE_ID,
            topicId: DIRECTOR_TOPIC_ID,
            messageSelector: { topicId: DIRECTOR_TOPIC_ID },
            messageTypeIds: [DIRECTOR_INTENT_TYPE_ID, DIRECTOR_EVENT_TYPE_ID]
        }
    };
}

/** The appointment needs only the director's own session, so the first layout with peers is already rooted at it. */
function createAppointCommand(input: AlmScaleRecipeInput, prefix: string): RallarBlackBoxTestCommand {
    return {
        kind: 'director.appoint',
        commandId: `${prefix}-appoint`,
        roomRef: { ...input.group },
        timeoutMs: 5_000
    };
}

function createDirectorWait(input: AlmScaleRecipeInput, prefix: string): RallarBlackBoxTestCommand {
    return {
        kind: 'loop',
        commandId: `${prefix}-director-ready`,
        count: Math.ceil(input.readyTimeoutMs / 200),
        intervalMs: 200,
        timeoutMs: input.readyTimeoutMs,
        until: 'first-success',
        commands: [
            {
                kind: 'director.status',
                commandId: `${prefix}-director-status`,
                roomRef: { ...input.group },
                refresh: 'when-absent',
                timeoutMs: 5_000
            },
            {
                kind: 'assert',
                commandId: `${prefix}-assert-director-active`,
                operator: 'equals',
                expected: true,
                source:
                    `resultCache.${prefix}-director-ready:i{loop.iteration}:c1:${prefix}-director-status.value.directorStatus.active`
            }
        ]
    };
}
