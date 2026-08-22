import type { DistributedRunAnalysis } from './distributed-artifact-analysis.ts';
import {
    cadenceHint,
    isolatedAgentHint,
    readinessEvidence,
    thresholdHints,
    timeoutHint
} from './distributed-run-tuning-decision-rules.ts';
import type {
    DistributedRunTuningDecisionIssue,
    DistributedRunTuningDecisionIssueCode,
    DistributedRunTuningDecisionResult,
    DistributedRunTuningHint
} from './distributed-run-tuning-decision-types.ts';
import {
    tuningDecisionIssue as decisionIssue,
    tuningInventoryIssues as inventoryIssues
} from './distributed-run-tuning-decision-types.ts';
import type { DistributedRunTuningInventory } from './distributed-run-tuning.ts';

export type {
    DistributedRunTuningDecisionIssue,
    DistributedRunTuningDecisionIssueCode,
    DistributedRunTuningDecisionResult,
    DistributedRunTuningHint,
    DistributedRunTuningHintKind
} from './distributed-run-tuning-decision-types.ts';
export {
    compareDistributedRunTuningPerformance,
    type DistributedRunTuningNumericDelta,
    type DistributedRunTuningPerformanceComparison,
    type DistributedRunTuningTimingMetric
} from './distributed-run-tuning-performance-comparison.ts';

export function deriveDistributedRunTuningDecisions(
    input: Readonly<{
        analysis?: DistributedRunAnalysis;
        inventory: DistributedRunTuningInventory;
        completeness?: 'complete' | 'partial';
    }>
): DistributedRunTuningDecisionResult {
    const analysis = input.analysis;
    const readiness = analysis ? readinessEvidence(analysis) : [];
    if (readiness.length > 0) {
        return {
            state: 'blocked',
            issues: [],
            hints: [{
                id: 'readiness',
                kind: 'fix-target-readiness',
                priority: 0,
                category: 'target-readiness',
                title: 'Fix target readiness before tuning timing.',
                rationale: 'Missing or incompatible targets invalidate timeout and stream-threshold conclusions.',
                nextAction: 'Resolve every target blocker and rerun the recipe.',
                evidence: readiness
            }]
        };
    }
    if (input.completeness === 'partial') {
        return insufficient(
            'partial-evidence',
            'The loaded timing evidence is partial; load a complete artifact before producing a recipe change.'
        );
    }
    if (!analysis?.performance || !hasTuningPerformanceEvidence(analysis.performance)) {
        return insufficient('no-performance-evidence', 'No command or RTC stream performance evidence is available.');
    }

    const issues = inventoryIssues(input.inventory);
    const hints: DistributedRunTuningHint[] = [];
    const timeout = timeoutHint(analysis, input.inventory, issues);
    const cadence = cadenceHint(analysis.performance, input.inventory, issues);
    if (timeout) {
        hints.push(timeout);
    }
    if (cadence) {
        hints.push(cadence);
    }
    hints.push(...thresholdHints(analysis.performance, input.inventory, issues));
    if (!timeout && !analysis.ok && !issues.some((row) => row.code === 'blocked-knob')) {
        const agent = isolatedAgentHint(
            analysis.performance,
            input.inventory,
            issues,
            analysis.failure?.category
        );
        if (agent) {
            hints.push(agent);
        }
    }
    hints.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));

    if (hints.length === 0 && analysis.ok) {
        return { state: 'clean', hints, issues };
    }
    if (hints.length === 0) {
        issues.push(
            decisionIssue(
                'unclassified-evidence',
                'The run did not pass, but its evidence does not support a deterministic tuning decision.'
            )
        );
        return insufficientFrom(issues);
    }
    return {
        state: issues.length > 0 ? 'ambiguous' : 'ready',
        hints,
        issues: uniqueIssues(issues)
    };
}

function hasTuningPerformanceEvidence(
    performance: NonNullable<DistributedRunAnalysis['performance']>
): boolean {
    return performance.commandTiming.count > 0 ||
        (performance.streamTiming?.streamCount ?? 0) > 0;
}

function insufficient(
    code: DistributedRunTuningDecisionIssueCode,
    message: string
): DistributedRunTuningDecisionResult {
    return insufficientFrom([decisionIssue(code, message)]);
}

function insufficientFrom(
    issues: readonly DistributedRunTuningDecisionIssue[]
): DistributedRunTuningDecisionResult {
    return {
        state: 'insufficient',
        issues,
        hints: [{
            id: 'insufficient',
            kind: 'insufficient-evidence',
            priority: 90,
            category: 'evidence-quality',
            title: 'More evidence is required for a tuning decision.',
            rationale: issues[0]?.message ?? '',
            nextAction: 'Load a complete supported artifact and rerun the analysis.',
            evidence: []
        }]
    };
}

function uniqueIssues(
    issues: readonly DistributedRunTuningDecisionIssue[]
): DistributedRunTuningDecisionIssue[] {
    const seen = new Set<string>();
    return issues.filter((row) => {
        const key = `${row.code}:${row.pointers?.join(',') ?? ''}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
