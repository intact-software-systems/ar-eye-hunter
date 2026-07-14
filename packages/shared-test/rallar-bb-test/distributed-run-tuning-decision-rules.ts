import type { DistributedRunAnalysis, DistributedRunPerformanceAnalysis } from
    './distributed-artifact-analysis.ts';
import type {
    DistributedRunTuningInventory,
    DistributedRunTuningKnob,
    DistributedRunTuningKnobName,
} from './distributed-run-tuning.ts';
import type {
    DistributedRunTuningDecisionIssue, DistributedRunTuningHint, DistributedRunTuningHintKind,
} from './distributed-run-tuning-decision-types.ts';
import { tuningDecisionIssue as decisionIssue } from './distributed-run-tuning-decision-types.ts';

export function readinessEvidence(analysis: DistributedRunAnalysis): string[] {
    const target = analysis.targetResolution;
    const evidence: string[] = [];
    if (!target) evidence.push('Target resolution evidence is unavailable.');
    if (target?.missingExpectedParticipants) evidence.push(`${target.missingExpectedParticipants} expected participants missing`);
    if (target?.staleAgents) evidence.push(`${target.staleAgents} stale agents`);
    if (target?.offlineAgents) evidence.push(`${target.offlineAgents} offline agents`);
    if (target?.wrongGroupAgents) evidence.push(`${target.wrongGroupAgents} wrong-group agents`);
    if (target?.agentsWithoutIdentity) evidence.push(`${target.agentsWithoutIdentity} agents without identity`);
    if (target?.blockers && evidence.length === 0) evidence.push(`${target.blockers} unresolved target blockers`);
    const failure = analysis.failure;
    const ackTimeout = failure?.category === 'readiness' && isAckTimeout(failureText(analysis));
    if (failure?.category === 'targeting' || failure?.category === 'readiness' && !ackTimeout) {
        evidence.push(`${failure.category}: ${failure.title}`);
    }
    return evidence;
}

export function timeoutHint(
    analysis: DistributedRunAnalysis,
    inventory: DistributedRunTuningInventory,
    issues: DistributedRunTuningDecisionIssue[],
): DistributedRunTuningHint | undefined {
    const failure = analysis.failure;
    if (!failure) return undefined;
    const text = failureText(analysis);
    const barrier = failure.category === 'barrier' && /barrier.+tim(?:e|ed)\s*out/i.test(text);
    const ack = failure.category === 'readiness' && isAckTimeout(text);
    if (!barrier && !ack) return undefined;
    const name: DistributedRunTuningKnobName = barrier ? 'barrier.timeoutMs' : 'ackTimeoutMs';
    const knob = inventory.knobs.find(row => row.name === name);
    if (knob && (!knob.effective || knob.availability === 'blocked')) {
        issues.push(decisionIssue('blocked-knob', knob.reason ?? `${name} is not editable.`, [knob.pointer]));
        return undefined;
    }
    return createHint({
        id: barrier ? 'barrier-timeout' : 'ack-timeout',
        kind: barrier ? 'raise-barrier-timeout' : 'raise-ack-timeout',
        priority: 10,
        category: failure.category,
        title: barrier ? 'Review the distributed barrier timeout.' : 'Review the staging ACK timeout.',
        rationale: failure.title,
        nextAction: `Enter and validate a deliberate ${name} candidate only after target readiness is clean.`,
        evidence: [`${failure.category}: ${failure.title}`],
        knob: editableKnob(knob),
        candidatePointers: knob ? [knob.pointer] : undefined,
    });
}

export function cadenceHint(
    performance: DistributedRunPerformanceAnalysis,
    inventory: DistributedRunTuningInventory,
    issues: DistributedRunTuningDecisionIssue[],
): DistributedRunTuningHint | undefined {
    const stream = performance.streamTiming;
    if (!stream) return undefined;
    const evidence = cadenceEvidence(stream);
    if (evidence.length === 0) return undefined;
    const candidates = cadenceKnobs(inventory);
    return createHint({
        id: 'cadence',
        kind: 'lower-cadence',
        priority: 20,
        category: 'rtc-stream-performance',
        title: 'Lower stream cadence or increase its effective interval.',
        rationale: 'Drops, backpressure, or material cadence/drift degradation show that the current load is not sustained.',
        nextAction: 'Edit one effective cadence knob, rerun, and compare frame disposition before considering maxInFlight.',
        evidence,
        knob: exactKnob(candidates, inventory, issues),
        candidatePointers: inventory.limitations.length === 0
            ? candidates.map(row => row.pointer)
            : undefined,
    });
}

export function thresholdHints(
    performance: DistributedRunPerformanceAnalysis,
    inventory: DistributedRunTuningInventory,
    issues: DistributedRunTuningDecisionIssue[],
): DistributedRunTuningHint[] {
    const stream = performance.streamTiming;
    if (!stream) return [];
    const thresholdKnobs = inventory.knobs.filter(row =>
        row.scope === 'stream-threshold' && row.currentValue !== undefined
    );
    if (thresholdKnobs.length === 0) return [];
    const streams = inventory.knobs.filter(row =>
        row.commandKind === 'rtc.stream' && row.name === 'durationMs'
    );
    if (stream.streamCount !== 1) {
        issues.push(decisionIssue(
            'aggregate-threshold-evidence',
            `${stream.streamCount} stream executions are aggregated; per-execution threshold breaches are unavailable.`,
        ));
        addStreamAmbiguityIssues(streams, thresholdKnobs, issues);
        return [];
    }
    if (streams.length !== 1 || inventory.limitations.length > 0) {
        addStreamAmbiguityIssues(streams, thresholdKnobs, issues);
        return [];
    }
    const groups = new Map<string, DistributedRunTuningKnob[]>();
    for (const knob of thresholdKnobs) {
        groups.set(knob.name, [...(groups.get(knob.name) ?? []), knob]);
    }
    const hints: DistributedRunTuningHint[] = [];
    for (const [name, knobs] of groups) {
        const actual = thresholdActual(name, stream);
        const configured = knobs[0]?.currentValue;
        const breached = actual !== undefined && configured !== undefined &&
            (name === 'thresholds.minSendSuccessRatio' ? actual < configured : actual > configured);
        if (!breached) continue;
        hints.push(createHint({
            id: `threshold:${name}`,
            kind: 'adjust-stream-threshold',
            priority: 30,
            category: 'rtc-stream-threshold',
            title: `Review ${name}.`,
            rationale: 'Observed RTC stream evidence crossed the configured threshold.',
            nextAction: 'Choose an exact threshold candidate deliberately; do not silently loosen it.',
            evidence: [`${numberText(actual)}${thresholdUnit(name)} observed vs ${numberText(configured)}${thresholdUnit(name)} configured`],
            knob: exactKnob(knobs, inventory, issues),
            candidatePointers: inventory.limitations.length === 0
                ? knobs.map(row => row.pointer)
                : undefined,
        }));
    }
    return hints;
}

export function isolatedAgentHint(
    performance: DistributedRunPerformanceAnalysis,
    inventory: DistributedRunTuningInventory,
    issues: DistributedRunTuningDecisionIssue[],
    failureCategory?: string,
): DistributedRunTuningHint | undefined {
    const slowestAgents = failureCategory?.startsWith('rtc-stream')
        ? performance.streamTiming?.slowestAgents ?? []
        : performance.slowestAgents;
    const ranked = [...slowestAgents]
        .filter(row => row.maxMs !== undefined)
        .sort((left, right) => (right.maxMs ?? 0) - (left.maxMs ?? 0) || left.agentId.localeCompare(right.agentId));
    if (ranked.length < 2) return undefined;
    const [first, second] = ranked;
    if (first.maxMs === second.maxMs) {
        issues.push(decisionIssue('equal-slow-agents', 'Multiple agents share the slowest timing value.'));
        return undefined;
    }
    if ((first.maxMs ?? 0) < (second.maxMs ?? 0) * 1.5) return undefined;
    const context = exactKnob(cadenceKnobs(inventory), inventory, issues);
    return {
        ...createHint({
            id: 'agent-outlier',
            kind: 'investigate-agent',
            priority: 40,
            category: 'agent-outlier',
            title: `Investigate ${first.agentId} before changing a global threshold.`,
            rationale: 'One agent is materially slower than the next-slowest participant.',
            nextAction: 'Inspect that agent\'s region, browser, network, and transport evidence.',
            evidence: [`${first.agentId} max ${numberText(first.maxMs)}ms vs ${numberText(second.maxMs)}ms`],
        }),
        agentId: first.agentId,
        evidencePointer: context?.pointer,
    };
}

function cadenceEvidence(
    stream: NonNullable<DistributedRunPerformanceAnalysis['streamTiming']>,
): string[] {
    const evidence: string[] = [];
    if (stream.droppedFrames > 0) evidence.push(`${stream.droppedFrames} dropped frames`);
    if (stream.inFlightLimitDropCount > 0) evidence.push(`${stream.inFlightLimitDropCount} in-flight-limit drops`);
    if (stream.backpressureCount > 0) evidence.push(`${stream.backpressureCount} backpressure events`);
    if (stream.requestedRateHz && stream.achievedCompletionHz !== undefined &&
        stream.achievedCompletionHz < stream.requestedRateHz * 0.9) {
        evidence.push(`${numberText(stream.achievedCompletionHz)}Hz achieved vs ${numberText(stream.requestedRateHz)}Hz requested`);
    }
    if ((stream.maxStartDriftMs ?? 0) >= 1_000) evidence.push(`${numberText(stream.maxStartDriftMs)}ms max start drift`);
    if (stream.plannedFrames > 0 && stream.lateFrameCount / stream.plannedFrames >= 0.05) {
        evidence.push(`${stream.lateFrameCount} late frames`);
    }
    return evidence;
}

function cadenceKnobs(inventory: DistributedRunTuningInventory): DistributedRunTuningKnob[] {
    const groups = new Map<string, DistributedRunTuningKnob[]>();
    for (const row of inventory.knobs.filter(candidate =>
        candidate.commandKind === 'rtc.stream' && candidate.effective &&
        (candidate.name === 'intervalMs' || candidate.name === 'rateHz')
    )) {
        const base = row.pointer.replace(/\/(?:intervalMs|rateHz)$/, '');
        groups.set(base, [...(groups.get(base) ?? []), row]);
    }
    return [...groups.values()].flatMap(rows => {
        const interval = rows.find(row =>
            row.name === 'intervalMs' && row.availability === 'configured'
        );
        const rate = rows.find(row =>
            row.name === 'rateHz' && row.availability === 'configured'
        );
        return interval ? [interval] : rate ? [rate] : rows;
    });
}

function exactKnob(
    candidates: readonly DistributedRunTuningKnob[],
    inventory: DistributedRunTuningInventory,
    issues: DistributedRunTuningDecisionIssue[],
): DistributedRunTuningHint['knob'] {
    const streams = inventory.knobs.filter(row =>
        row.commandKind === 'rtc.stream' && row.name === 'durationMs'
    );
    addStreamAmbiguityIssues(streams, candidates, issues);
    return inventory.limitations.length === 0 && streams.length === 1 && candidates.length === 1
        ? editableKnob(candidates[0])
        : undefined;
}

function addStreamAmbiguityIssues(
    streams: readonly DistributedRunTuningKnob[],
    candidates: readonly DistributedRunTuningKnob[],
    issues: DistributedRunTuningDecisionIssue[],
): void {
    if (streams.length > 1 && !hasIssue(issues, 'multiple-streams')) {
        issues.push(decisionIssue('multiple-streams', `${streams.length} RTC stream command paths contribute aggregate evidence.`));
    }
    const ids = streams.map(row => row.commandId).filter((id): id is string => Boolean(id));
    if (new Set(ids).size < ids.length && !hasIssue(issues, 'duplicate-command-id')) {
        issues.push(decisionIssue('duplicate-command-id', 'Duplicate RTC stream command IDs prevent identity-based pointer selection.'));
    }
    if (candidates.length > 1 && !hasIssue(issues, 'pointer-ambiguity')) {
        issues.push(decisionIssue('pointer-ambiguity',
            'Aggregate evidence maps to multiple candidate knob paths.',
            candidates.map(row => row.pointer)));
    }
}

function editableKnob(knob: DistributedRunTuningKnob | undefined): DistributedRunTuningHint['knob'] {
    return knob?.effective && knob.availability !== 'blocked'
        ? { name: knob.name, pointer: knob.pointer, currentValue: knob.currentValue }
        : undefined;
}

function thresholdActual(
    name: string,
    stream: NonNullable<DistributedRunPerformanceAnalysis['streamTiming']>,
): number | undefined {
    return ({
        'thresholds.minSendSuccessRatio': stream.sendSuccessRatio,
        'thresholds.maxDroppedFrames': stream.droppedFrames,
        'thresholds.maxBackpressureCount': stream.backpressureCount,
        'thresholds.maxP95SendDurationMs': stream.duration.p95Ms,
        'thresholds.maxP99SendDurationMs': stream.duration.p99Ms,
        'thresholds.maxStartDriftMs': stream.maxStartDriftMs,
    } as Readonly<Record<string, number | undefined>>)[name];
}

function createHint(input: DistributedRunTuningHint): DistributedRunTuningHint {
    return input;
}

function failureText(analysis: DistributedRunAnalysis): string {
    const row = analysis.failure;
    return row ? `${row.title} ${row.likelyCause} ${row.nextAction}` : '';
}

function isAckTimeout(text: string): boolean {
    return /\back\b|acktimeout|stage.+tim(?:e|ed)\s*out/i.test(text);
}

function thresholdUnit(name: string): string {
    return name.includes('Duration') || name.includes('Drift') || name.includes('Jitter')
        ? 'ms'
        : '';
}

function hasIssue(
    issues: readonly DistributedRunTuningDecisionIssue[],
    code: DistributedRunTuningDecisionIssue['code'],
): boolean {
    return issues.some(row => row.code === code);
}

function numberText(value: number | undefined): string {
    return value === undefined
        ? 'unavailable'
        : String(Math.round(value * 1_000_000) / 1_000_000);
}
