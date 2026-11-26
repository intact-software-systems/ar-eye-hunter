import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import type {
    RallarBlackBoxTestBarrierCommand,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestLoopCommand,
    RallarBlackBoxTestRecipe
} from '../../../rallar-black-box-test-contracts.ts';

import { RESPONSE_MARGIN_MS, STATS_TIMEOUT_MS } from '../alm-conformance-budgets.ts';
import { computeCommandsTimeoutMs } from '../cell/compute-commands-timeout-ms.ts';
import { createAlmCohortBarrier } from '../cohort/create-alm-cohort-barrier.ts';
import {
    createAlmCohortSetupCommands,
    type AlmCohortRole,
    type AlmCohortSetupInput
} from '../cohort/create-alm-cohort-setup-commands.ts';
import { toPauseWait } from '../to-pause-command.ts';
import { computePublicationWorkloadPlan, type PublicationWorkloadPlan } from './compute-publication-workload-plan.ts';
import {
    PUBLICATION_WORKLOAD_SENT_AT_FIELD,
    toPublicationWorkloadPayload
} from './to-publication-workload-payload.ts';
import {
    validatePublicationWorkloadParameters,
    type PublicationWorkloadParameters
} from './validate-publication-workload-parameters.ts';

/** One role's recipe and how many agents of the point's cohort run it. */
export interface PublicationWorkloadRoleRecipe {
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly agentCount: number;
}

/** The first agent of a run publishes; every other agent subscribes. */
export interface PublicationWorkloadRecipes {
    readonly publisher: PublicationWorkloadRoleRecipe;
    readonly subscriber: PublicationWorkloadRoleRecipe;
}

const SCOPE = 'publication-workload';
const ROLE_NAMES = { owner: 'publisher', member: 'subscriber' } as const;
const TOPIC_ID = 'room.publication-workload';
/** No other command of a run sends this type: a subscriber counts every copy of it on its page's inbound log. */
const FRAME_TYPE_ID = 'room.publication-workload.frame.v1';
/** A live send names its stream; the one publisher of a point publishes one. */
const STREAM_RESOURCE_ID = 'publication-workload';
/** The publisher's loop of sends: its result's `passed` is what the assert on the accepted sends reads. */
const PUBLISH_LOOP_COMMAND_ID = `${SCOPE}-${ROLE_NAMES.owner}-frames`;
/**
 * A page's ALM diagnostics put an event per send and per arrival on the page whose load a point measures, so the
 * family's pages connect without them.
 */
const ALM_DIAGNOSTICS = false;
/**
 * A loop pauses one interval after each send returns, so the sends' own durations stretch its window. A loop still
 * running at twice its window has sent at under half the configured rate, and ends there instead of holding the cohort.
 */
const LOOP_TIMEOUT_WINDOWS = 2;

/** The left holds every issue of `validatePublicationWorkloadParameters`; a point with one has no plan and no payload. */
export function createPublicationWorkloadRecipes(
    parameters: PublicationWorkloadParameters
): Either<readonly RallarValidationIssue[], PublicationWorkloadRecipes> {
    const issues = validatePublicationWorkloadParameters(parameters);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const plan = computePublicationWorkloadPlan(parameters);
    const window = createPublisherWindowCommands(parameters, plan);
    // A subscriber waits at the complete barrier through the publisher's whole window.
    const completeTimeoutMs = computeCommandsTimeoutMs(window, 'the complete barrier');
    return Either.ofRight({
        publisher: {
            agentCount: 1,
            recipe: {
                ...toRecipeIdentity('owner'),
                // The gate on the accepted sends comes last: a publisher that fails it has already met the
                // subscribers at the complete barrier, so they still count what did arrive.
                commands: [
                    ...createSetupCommands(parameters, 'owner'),
                    ...window,
                    createBarrier('owner', 'complete', completeTimeoutMs),
                    createAcceptedSendsAssert(plan)
                ]
            }
        },
        subscriber: {
            agentCount: plan.subscriberCount,
            recipe: {
                ...toRecipeIdentity('member'),
                // The count reads the page's whole inbound log, so the page keeps all of it.
                eventHistory: { mode: 'full' },
                commands: [
                    ...createSetupCommands(parameters, 'member'),
                    createBarrier('member', 'complete', completeTimeoutMs),
                    ...createSubscriberCountCommands(parameters, plan)
                ]
            }
        }
    });
}

function toRecipeIdentity(
    role: AlmCohortRole
): Pick<RallarBlackBoxTestRecipe, 'schemaVersion' | 'recipeId' | 'name' | 'continueOnFailure'> {
    return {
        schemaVersion: 1,
        recipeId: toCommandPrefix(role),
        name: `Publication workload ${ROLE_NAMES[role]}`,
        continueOnFailure: false
    };
}

function toCommandPrefix(role: AlmCohortRole): string {
    return `${SCOPE}-${ROLE_NAMES[role]}`;
}

function createBarrier(role: AlmCohortRole, phase: string, timeoutMs: number): RallarBlackBoxTestBarrierCommand {
    return createAlmCohortBarrier({ scope: SCOPE, roleName: ROLE_NAMES[role], phase, timeoutMs });
}

/**
 * The cohort settles on one layout whatever the carrier, and its setup-complete barrier is the one gate before the
 * window: the publisher's first send and a subscriber's wait both follow it directly.
 */
function createSetupCommands(
    parameters: PublicationWorkloadParameters,
    role: AlmCohortRole
): readonly RallarBlackBoxTestCommand[] {
    const cohort: AlmCohortSetupInput = {
        group: parameters.group,
        participantCount: parameters.participantCount,
        readyTimeoutMs: parameters.readyTimeoutMs,
        almDiagnostics: ALM_DIAGNOSTICS,
        scope: SCOPE,
        roleNames: ROLE_NAMES,
        channel: { typeId: FRAME_TYPE_ID, topicId: TOPIC_ID }
    };
    const setup = createAlmCohortSetupCommands(cohort, role);
    return [...setup.entry, ...setup.gathering, ...setup.settling];
}

/**
 * The sends, and the stats once the stage holds nothing of the window. A staged value leaves the stage at an
 * opportunity, admitted or, past its lifetime, expired, and the next opportunity is at most one cadence away: one
 * lifetime and one cadence after the last send, the stage's counters are final.
 */
function createPublisherWindowCommands(
    parameters: PublicationWorkloadParameters,
    plan: PublicationWorkloadPlan
): readonly RallarBlackBoxTestCommand[] {
    const prefix = toCommandPrefix('owner');
    return [
        createPublishLoop(parameters, plan),
        toPauseWait(`${prefix}-drain`, parameters.publication.cadenceMs + parameters.ttlMs),
        { kind: 'stats', commandId: `${prefix}-stats`, timeoutMs: STATS_TIMEOUT_MS }
    ];
}

/** A loop's thresholds read `rtc.send` and `ws.send` alone, so the accepted sends are judged by an assert of their own. */
function createAcceptedSendsAssert(plan: PublicationWorkloadPlan): RallarBlackBoxTestCommand {
    return {
        kind: 'assert',
        commandId: `${toCommandPrefix('owner')}-assert-accepted-sends`,
        source: `resultCache.${PUBLISH_LOOP_COMMAND_ID}.value.passed`,
        operator: 'gte',
        expected: plan.minAcceptedSends
    };
}

/**
 * One child, so each iteration is one frame and the loop's `passed` counts accepted sends. The loop stays at the top
 * level of its recipe: inside another loop, that loop would resolve the payload's placeholders with its own position.
 * A send is bounded by its own lifetime, as an expiring send of the conformance lane is.
 */
function createPublishLoop(
    parameters: PublicationWorkloadParameters,
    plan: PublicationWorkloadPlan
): RallarBlackBoxTestLoopCommand {
    const prefix = toCommandPrefix('owner');
    return {
        kind: 'loop',
        commandId: PUBLISH_LOOP_COMMAND_ID,
        count: plan.frameCount,
        intervalMs: parameters.publishIntervalMs,
        continueOnFailure: true,
        timeoutMs: LOOP_TIMEOUT_WINDOWS * parameters.windowMs,
        commands: [{
            kind: 'messages.send',
            commandId: `${prefix}-send`,
            connection: prefix,
            carrier: parameters.carrier,
            roomRef: { ...parameters.group },
            topicId: TOPIC_ID,
            typeId: FRAME_TYPE_ID,
            purpose: 'live',
            publication: parameters.publication,
            resourceId: STREAM_RESOURCE_ID,
            ttlMs: parameters.ttlMs,
            payload: toPublicationWorkloadPayload(parameters),
            timeoutMs: parameters.ttlMs
        }]
    };
}

/**
 * The count starts once the publisher has drained and settles at once when enough copies are on the log; short of
 * them it waits one more lifetime, the longest a copy still on its way is worth waiting for. Its two guards need no
 * arithmetic: no copy without an age, and as many ages as copies.
 */
function createSubscriberCountCommands(
    parameters: PublicationWorkloadParameters,
    plan: PublicationWorkloadPlan
): readonly RallarBlackBoxTestCommand[] {
    const prefix = toCommandPrefix('member');
    const received = `resultCache.${prefix}-received.value`;
    return [
        {
            kind: 'messages.received',
            commandId: `${prefix}-received`,
            connection: prefix,
            typeId: FRAME_TYPE_ID,
            count: plan.minExpectedInboundMessages,
            ageFrom: PUBLICATION_WORKLOAD_SENT_AT_FIELD,
            windowMs: parameters.ttlMs,
            timeoutMs: parameters.ttlMs + RESPONSE_MARGIN_MS
        },
        {
            kind: 'assert',
            commandId: `${prefix}-assert-every-copy-aged`,
            source: `${received}.sampleAge.unrecordedSamples`,
            operator: 'equals',
            expected: 0
        },
        {
            kind: 'assert',
            commandId: `${prefix}-assert-ages-cover-copies`,
            source: `${received}.sampleAge.ageMs.count`,
            operator: 'equals',
            comparisonSource: `${received}.observed`
        },
        { kind: 'stats', commandId: `${prefix}-stats`, timeoutMs: STATS_TIMEOUT_MS }
    ];
}
