import type { DistributedRunFailureRow } from '../distributed-run-observation/distributed-run-row-contracts.ts';
import type {
    DistributedFailureExplanation,
    FirstDistributedRunPhaseForCommand
} from './distributed-failure-explanation-contracts.ts';
import { toCompactStrings } from './to-compact-strings.ts';

export function toDistributedFailureExplanation(
    failure: DistributedRunFailureRow,
    firstPhaseForCommand: FirstDistributedRunPhaseForCommand = () => undefined
): DistributedFailureExplanation {
    const code = failure.code ?? '';
    const text = `${code} ${failure.message}`.toLowerCase();
    const evidence = toCompactStrings([
        failure.key,
        failure.code,
        failure.agentId,
        failure.recipeId,
        failure.commandId
    ]);
    return toStagingFailureExplanation({ code, text, evidence }) ??
        toEvidenceFailureExplanation({ failure, code, text, evidence, firstPhaseForCommand }) ?? {
        category: toDistributedFailureCategory(failure),
        title: 'Distributed run failure',
        likelyCause: failure.message || 'The distributed rollup reported a blocking failure.',
        nextAction: 'Inspect the linked recipe, agent, and raw failure payload for the exact failing stage.',
        evidence
    };
}

interface FailureExplanationInput {
    readonly code: string;
    readonly text: string;
    readonly evidence: readonly string[];
}

/** Targeting, readiness, and barrier codes that fail before any command result exists. */
function toStagingFailureExplanation(
    input: FailureExplanationInput
): DistributedFailureExplanation | undefined {
    const { code, text, evidence } = input;
    if (code === 'RALLAR_BB_DISTRIBUTED_NO_TARGET_AGENTS' || text.includes('no target')) {
        return {
            category: 'targeting',
            title: 'No target agents resolved',
            likelyCause:
                'The selected control run has no connected agents matching the current application, workspace, and group.',
            nextAction:
                'Open or restart agents for this group, then refresh target resolution before launching the recipe again.',
            evidence
        };
    }
    if (code === 'RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH' || text.includes('target count')) {
        return {
            category: 'targeting',
            title: 'Target count mismatch',
            likelyCause: 'The recipe expected a fixed participant count, but the resolved agent count was different.',
            nextAction:
                'Adjust the expected participant count or connect exactly the intended number of agents before staging.',
            evidence
        };
    }
    if (code === 'RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT' || text.includes('ack') && text.includes('timeout')) {
        return {
            category: 'readiness',
            title: 'Agent did not ACK staging',
            likelyCause: 'An agent did not load or acknowledge the recipe before ackTimeoutMs expired.',
            nextAction:
                'Check that the agent tab is still connected, logged in, and not blocked by a recipe-load error.',
            evidence
        };
    }
    if (code === 'RALLAR_BB_DISTRIBUTED_BARRIER_TIMEOUT' || text.includes('barrier') && text.includes('timeout')) {
        return {
            category: 'barrier',
            title: 'Barrier timed out',
            likelyCause: 'One or more agents never reported barrier.ready after staging.',
            nextAction:
                'Inspect ACK readiness and per-agent execution; the missing agent usually failed before the synchronized start point.',
            evidence
        };
    }
    if (code === 'RALLAR_BB_DISTRIBUTED_BARRIER_DISCONNECTED' || text.includes('disconnected')) {
        return {
            category: 'barrier',
            title: 'Agent disconnected during barrier',
            likelyCause: 'An agent left the control run while the distributed run waited at the barrier.',
            nextAction:
                'Restart the disconnected agent with the same control run and a unique agent ID, then rerun the recipe.',
            evidence
        };
    }
    return undefined;
}

/** Failures that carry their own command, assertion, or stream evidence. */
function toEvidenceFailureExplanation(
    input:
        & FailureExplanationInput
        & Readonly<{
            failure: DistributedRunFailureRow;
            firstPhaseForCommand: FirstDistributedRunPhaseForCommand;
        }>
): DistributedFailureExplanation | undefined {
    const { failure, code, text, evidence, firstPhaseForCommand } = input;
    if (code.startsWith('RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_')) {
        return {
            category: 'group-assertion',
            title: code === 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING'
                ? 'Group assertion evidence missing'
                : code === 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_NO_PARTICIPANTS'
                ? 'Group assertion has no participants'
                : 'Group assertion failed',
            likelyCause: failure.message ||
                'The coordinator-evaluated group assertion did not hold over the frozen ' +
                    'participant set.',
            nextAction: 'Read the redacted per-agent value table in failures.json; it names ' +
                'missing and violating agents for the typed source address.',
            evidence
        };
    }
    if (isRtcStreamPerformanceFailureText(text)) {
        return {
            category: 'rtc-stream-performance',
            title: 'RTC stream pacing/backlog threshold failed',
            likelyCause: failure.message ||
                'The RTC stream command exceeded pacing, backlog, or frame-drop thresholds.',
            nextAction:
                'Inspect frame disposition, in-flight drops, max start drift, late frames, stream duration percentiles, and slowest stream agents before changing RTC routing or thresholds.',
            evidence
        };
    }
    if (failure.kind === 'command' || failure.commandId) {
        return {
            category: 'command',
            title: 'Distributed command failed',
            likelyCause: failure.message || 'The browser agent returned a failed command result.',
            nextAction: toCommandFailureNextAction(failure, firstPhaseForCommand),
            evidence
        };
    }
    return undefined;
}

function toCommandFailureNextAction(
    failure: DistributedRunFailureRow,
    firstPhaseForCommand: FirstDistributedRunPhaseForCommand
): string {
    const phase = firstPhaseForCommand(failure.commandId);
    if (phase === 'stage') {
        return 'Open the agent progress and recipe-load output; staging failures usually mean invalid recipe JSON, missing auth, or a blocked browser runtime.';
    }
    if (phase === 'barrier') {
        return 'Inspect barrier readiness for every target and confirm all agents stayed connected until the synchronized start.';
    }
    if (phase === 'start') {
        return 'Open the composite drilldown and runtime diagnostics for the failing agent, then compare expected vs observed payload evidence.';
    }
    return 'Inspect the command result, runtime diagnostics, and raw evidence for this command ID.';
}

export function isRtcStreamPerformanceFailureText(text: string): boolean {
    const normalized = text.toLowerCase();
    const hasRtcStreamContext = normalized.includes('rallar_black_box_rtc_stream') ||
        normalized.includes('rallar.bb.rtc.stream') ||
        normalized.includes('rtc.stream') ||
        normalized.includes('rtc stream') ||
        normalized.includes('stream pacing');
    const hasInFlightBacklogText = normalized.includes('in-flight') || normalized.includes('in flight');
    return normalized.includes('rallar_black_box_rtc_stream_threshold_failed') ||
        normalized.includes('rallar_black_box_rtc_stream_in_flight_limit') ||
        normalized.includes('rallar.bb.rtc.stream_failed') ||
        normalized.includes('maxdroppedframes') ||
        normalized.includes('minsend success ratio') ||
        normalized.includes('stream pacing') ||
        (hasRtcStreamContext && hasInFlightBacklogText);
}

export function toDistributedFailureCategory(
    failure: DistributedRunFailureRow
): DistributedFailureExplanation['category'] {
    const code = failure.code ?? '';
    const text = `${code} ${failure.message}`.toLowerCase();
    if (isRtcStreamPerformanceFailureText(text)) {
        return 'rtc-stream-performance';
    }
    if (text.includes('target')) {
        return 'targeting';
    }
    if (text.includes('ack')) {
        return 'readiness';
    }
    if (text.includes('barrier')) {
        return 'barrier';
    }
    if (failure.kind === 'command' || failure.commandId) {
        return 'command';
    }
    return 'unknown';
}
