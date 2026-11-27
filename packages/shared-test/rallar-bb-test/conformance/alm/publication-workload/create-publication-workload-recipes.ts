import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxDistributedGroupRef } from '../../../distributed-run.ts';
import type {
    RallarBlackBoxTestBarrierCommand,
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestLoopCommand,
    RallarBlackBoxTestRecipe
} from '../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, RESPONSE_MARGIN_MS, STATS_TIMEOUT_MS } from '../alm-conformance-budgets.ts';
import { computeCommandsTimeoutMs } from '../cell/compute-commands-timeout-ms.ts';
import { createAlmCohortBarrier } from '../cohort/create-alm-cohort-barrier.ts';
import {
    createAlmCohortSetupCommands,
    type AlmCohortRole,
    type AlmCohortSetupInput
} from '../cohort/create-alm-cohort-setup-commands.ts';
import { toAlmCohortCommandPrefix } from '../cohort/to-alm-cohort-command-prefix.ts';
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

export interface PublicationWorkloadRecipes {
    /** One entry per room of the point. */
    readonly rooms: readonly PublicationWorkloadRoomRecipes[];
}

/**
 * A room's roles in the order a caller hands its agents out: the publisher that writes the group, the publishers that
 * join it where the point has more than one, the subscribers.
 */
export interface PublicationWorkloadRoomRecipes {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly roles: readonly PublicationWorkloadRoleRecipe[];
}

/** One role's recipe and how many agents of the room run it. */
export interface PublicationWorkloadRoleRecipe {
    readonly kind: PublicationWorkloadRoleKind;
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly agentCount: number;
}

/** What a role does in the window. Its commands and its connection are named by it, whichever recipe holds them. */
export type PublicationWorkloadRoleKind = 'publisher' | 'subscriber';

/** A recipe of a room: one of the two kinds, and for a publisher whether it writes the group or joins it. */
type PublicationWorkloadRecipeRole = 'publisher' | 'joining-publisher' | 'subscriber';

interface PublicationWorkloadRecipeRoleShape {
    readonly kind: PublicationWorkloadRoleKind;
    /** The owner writes the group and connects before any peer exists; a member joins it once a peer does. */
    readonly cohortRole: AlmCohortRole;
    readonly title: string;
}

/** What a role runs after the cohort's setup, and how many agents of the room run it. */
interface PublicationWorkloadRoleRecipeInput {
    readonly role: PublicationWorkloadRecipeRole;
    readonly agentCount: number;
    readonly windowCommands: readonly RallarBlackBoxTestCommand[];
}

const SCOPE = 'publication-workload';
const RECIPE_ROLES: Readonly<Record<PublicationWorkloadRecipeRole, PublicationWorkloadRecipeRoleShape>> = {
    publisher: { kind: 'publisher', cohortRole: 'owner', title: 'publisher' },
    'joining-publisher': { kind: 'publisher', cohortRole: 'member', title: 'joining publisher' },
    subscriber: { kind: 'subscriber', cohortRole: 'member', title: 'subscriber' }
};
/** A subscriber's count reads its page's whole inbound log, so the page keeps all of it. */
const SUBSCRIBER_EVENT_HISTORY = { mode: 'full' } as const;
const TOPIC_ID = 'room.publication-workload';
/** No other command of a run sends this type: a subscriber counts every message of it on its page's inbound log. */
const FRAME_TYPE_ID = 'room.publication-workload.frame.v1';
/** A live send names its stream. Every publisher names this one: a stream's key holds its sender, so each has its own. */
const STREAM_RESOURCE_ID = 'publication-workload';
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
    return Either.ofRight({ rooms: [{ group: parameters.group, roles: createRoomRoles(parameters) }] });
}

/**
 * Every publisher runs the same window, meets the subscribers at the complete barrier and then answers its own gate; a
 * subscriber waits at that barrier through a publisher's whole window and then counts.
 */
function createRoomRoles(parameters: PublicationWorkloadParameters): readonly PublicationWorkloadRoleRecipe[] {
    const plan = computePublicationWorkloadPlan(parameters);
    const window = createPublisherWindowCommands(parameters, plan);
    const completeTimeoutMs = computeCommandsTimeoutMs(window, 'the complete barrier');
    const publisherCommands = [
        ...window,
        createBarrier('publisher', 'complete', completeTimeoutMs),
        createAcceptedSendsAssert(plan)
    ];
    const subscriberCommands = [
        createBarrier('subscriber', 'complete', completeTimeoutMs),
        ...createSubscriberCountCommands(parameters, plan)
    ];
    const joiningPublisherCount = parameters.publisherCount - 1;
    return [
        createRoleRecipe(parameters, { role: 'publisher', agentCount: 1, windowCommands: publisherCommands }),
        ...(joiningPublisherCount > 0
            ? [createRoleRecipe(parameters, {
                role: 'joining-publisher',
                agentCount: joiningPublisherCount,
                windowCommands: publisherCommands
            })]
            : []),
        createRoleRecipe(parameters, {
            role: 'subscriber',
            agentCount: plan.subscriberCount,
            windowCommands: subscriberCommands
        })
    ];
}

function createRoleRecipe(
    parameters: PublicationWorkloadParameters,
    input: PublicationWorkloadRoleRecipeInput
): PublicationWorkloadRoleRecipe {
    const { kind, title } = RECIPE_ROLES[input.role];
    return {
        kind,
        agentCount: input.agentCount,
        recipe: {
            schemaVersion: 1,
            recipeId: `${SCOPE}-${input.role}`,
            name: `Publication workload ${title}`,
            continueOnFailure: false,
            ...(kind === 'subscriber' ? { eventHistory: SUBSCRIBER_EVENT_HISTORY } : {}),
            commands: [...createSetupCommands(parameters, input.role), ...input.windowCommands]
        }
    };
}

/** A kind's commands and its connection carry the prefix the cohort's setup gives a role of that name. */
function toCommandPrefix(kind: PublicationWorkloadRoleKind): string {
    return toAlmCohortCommandPrefix(SCOPE, kind);
}

function createBarrier(
    kind: PublicationWorkloadRoleKind,
    phase: string,
    timeoutMs: number
): RallarBlackBoxTestBarrierCommand {
    return createAlmCohortBarrier({ scope: SCOPE, roleName: kind, phase, timeoutMs });
}

/**
 * The cohort settles on one layout whatever the carrier, and its setup-complete barrier is the one gate before the
 * window: a publisher's first send and a subscriber's wait both follow it directly. Each role's connect opens the one
 * typed channel of the frame, under the connection its send or its count names. The cohort names only a role's own
 * commands, a member's by its kind: a joining publisher's commands and its connection are a publisher's.
 */
function createSetupCommands(
    parameters: PublicationWorkloadParameters,
    role: PublicationWorkloadRecipeRole
): readonly RallarBlackBoxTestCommand[] {
    const { kind, cohortRole } = RECIPE_ROLES[role];
    const cohort: AlmCohortSetupInput = {
        group: parameters.group,
        participantCount: parameters.participantCount,
        readyTimeoutMs: parameters.readyTimeoutMs,
        almDiagnostics: ALM_DIAGNOSTICS,
        scope: SCOPE,
        roleNames: { owner: 'publisher', member: kind },
        channel: { typeId: FRAME_TYPE_ID, topicId: TOPIC_ID }
    };
    const setup = createAlmCohortSetupCommands(cohort, cohortRole);
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
    const prefix = toCommandPrefix('publisher');
    return [
        createPublishLoop(parameters, plan),
        toPauseWait(`${prefix}-drain`, parameters.publication.cadenceMs + parameters.ttlMs),
        { kind: 'stats', commandId: `${prefix}-stats`, timeoutMs: STATS_TIMEOUT_MS }
    ];
}

/**
 * The gate on a publisher: its stage's `admitted`, the values its opportunities handed to a carrier, counted over
 * the connect, which sends nothing but the window's frames. The loop's `passed` is no such count: a live send returns
 * as soon as its value is staged or refused, so a frame the stage refused, displaced or let expire still passed. The
 * gate comes after the complete barrier: a publisher that fails it has already met the subscribers there, so they
 * still count what did arrive.
 */
function createAcceptedSendsAssert(plan: PublicationWorkloadPlan): RallarBlackBoxTestCommand {
    const prefix = toCommandPrefix('publisher');
    return {
        kind: 'assert',
        commandId: `${prefix}-assert-accepted-sends`,
        source: `resultCache.${prefix}-stats.value.rallar.alm.publication.counters.admitted`,
        operator: 'gte',
        expected: plan.minAcceptedSends
    };
}

/**
 * One child, so each iteration is one frame. The loop stays at the top level of its recipe: inside another loop, that
 * loop would resolve the payload's placeholders with its own position. A send's budget is the harness's own, as a live
 * send of the conformance lane has: the command returns once its value is staged, and a budget of the frame's lifetime
 * would have the harness abort, under a short lifetime, sends the product still publishes.
 */
function createPublishLoop(
    parameters: PublicationWorkloadParameters,
    plan: PublicationWorkloadPlan
): RallarBlackBoxTestLoopCommand {
    const prefix = toCommandPrefix('publisher');
    return {
        kind: 'loop',
        commandId: `${prefix}-frames`,
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
            timeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
        }]
    };
}

/**
 * The count starts once the publishers have drained and settles at once when enough messages are on the log; short of
 * them it waits one more lifetime, the longest a message still on its way is worth waiting for.
 */
function createSubscriberCountCommands(
    parameters: PublicationWorkloadParameters,
    plan: PublicationWorkloadPlan
): readonly RallarBlackBoxTestCommand[] {
    const prefix = toCommandPrefix('subscriber');
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
        ...createSubscriberCountGuards(plan.frameCount * parameters.publisherCount),
        { kind: 'stats', commandId: `${prefix}-stats`, timeoutMs: STATS_TIMEOUT_MS }
    ];
}

/**
 * The count's three guards need no arithmetic: no message without an age, as many ages as messages, and no more
 * messages than `publishedFrames`, the frames of the room's publishers together. A page's one inbound store delivers a
 * message once whichever carriers brought it, so a count above them holds another sender's messages or another run's.
 */
function createSubscriberCountGuards(publishedFrames: number): readonly RallarBlackBoxTestCommand[] {
    const prefix = toCommandPrefix('subscriber');
    const received = `resultCache.${prefix}-received.value`;
    return [
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
        {
            kind: 'assert',
            commandId: `${prefix}-assert-copies-within-frames`,
            source: `${received}.observed`,
            operator: 'lte',
            expected: publishedFrames
        }
    ];
}
