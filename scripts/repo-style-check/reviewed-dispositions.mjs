import path from 'node:path';

import { findingMagnitude } from './finding-magnitude.mjs';

export const reviewedDispositions = Object.freeze([
    // erasableSyntaxOnly migration: converting parameter properties to explicit
    // fields duplicates each `unknown`-typed parameter annotation into a field
    // declaration (+1 textual occurrence per file, no new unknown values). These
    // four module-owner entries accept exactly that; remove them when the
    // affected classes gain precise persisted-value types or the boundary rule
    // moves to the metric-based checker.
    Object.freeze({
        path: 'packages/shared-web/browser/rallar-data.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/alm/ALInboundAdmissionStore.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/alm/ALOutboundAdmissionStore.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared/rallar-ai/rallar-ai-types.ts',
        rule: 'boundary.unknown',
        symbol: undefined
    }),
    Object.freeze({
        path: 'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
        rule: 'boundary.unknown',
        symbol: 'normalizeRtcBaselineJson'
    }),
    Object.freeze({
        path: 'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts',
        rule: 'layout.primary-export-name',
        symbol: 'parseRtcBaselineCommand'
    }),
    // These runtime capability modules intentionally use noun-based filenames:
    // each contains the cohesive helpers needed to construct that capability,
    // while the checker sees only the exported factory as the primary symbol.
    Object.freeze({
        path: 'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-acceptance.ts',
        rule: 'layout.primary-export-name',
        symbol: 'createRtcBaselineDenoAcceptance'
    }),
    Object.freeze({
        path: 'packages/shared-rtc-bench/baseline/runtime/rtc-baseline-repeat-initializer.ts',
        rule: 'layout.primary-export-name',
        symbol: 'createRtcBaselineRepeatInitializer'
    }),
    // AppInbox accepts raw JSON only at this exact decoder. It immediately
    // validates the complete persisted command as JsonWireValue before any
    // identity, routing, hashing, or domain decision consumes it.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeAppInboxEnqueue'
    }),
    // Client-state record decoding is the single raw-object boundary for the
    // operation-specific command, persisted-state, and result validators. It
    // immediately rejects non-plain objects and returns the narrowed record
    // vocabulary consumed by every downstream scalar validator.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/client-state/validation/' +
            'client-record-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'decodeClientValidationRecord'
    }),
    // Group mutation operation-input validation narrows raw request fields at
    // the HTTP/WS boundary. Both listed owners validate their unknown input
    // before any domain use, mirroring the persisted-JSON decoder entries below.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/' +
            'validate-group-mutation-operation-input.ts',
        rule: 'boundary.unknown',
        symbol: 'validateActivateGroupInput'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/' +
            'validate-group-mutation-operation-input.ts',
        rule: 'boundary.unknown',
        symbol: 'isUnitIntervalNumber'
    }),
    // RTC RTT persistence decoders own the untrusted persisted-JSON boundary.
    // Each listed owner validates or narrows its unknown input before domain use;
    // keep these exact symbols reviewed while the checker treats all unknown
    // annotations as propagation, regardless of that immediate normalization.
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation-primitives.ts',
        rule: 'boundary.unknown',
        symbol: 'readRtcRttPersistedRecord'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation-primitives.ts',
        rule: 'boundary.unknown',
        symbol: 'assertExactRtcRttPersistedKeys'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation-primitives.ts',
        rule: 'boundary.unknown',
        symbol: 'assertNonEmptyRtcRttString'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation-primitives.ts',
        rule: 'boundary.unknown',
        symbol: 'assertRtcRttSafeInteger'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation-primitives.ts',
        rule: 'boundary.unknown',
        symbol: 'validateRtcRttCommandHash'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'validateRtcRttMutationReceipt'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'validateRtcRttMeasurement'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'validateRtcRttEndpointAdmission'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'validateCanonicalGroupRef'
    }),
    Object.freeze({
        path: 'packages/shared-server/rallar-system/rtc-rtt/persistence/' +
            'rtc-rtt-persistence-validation.ts',
        rule: 'boundary.unknown',
        symbol: 'validateExpectedRevision'
    })
]);

export function readReviewedDispositionContext(repoRoot, candidateHead, dependencies = {}) {
    const index = dependencies.readGovernanceDecisionIndex?.(repoRoot) ?? {
        decisions: [],
        duplicateDecisionIds: new Set(),
        issues: []
    };
    const resolved = dependencies.resolveGovernanceExceptions?.(index, candidateHead) ?? [];
    const decisions = resolved.filter(isCodeStyleDecision);
    return {
        candidateHead,
        decisions,
        issues: [
            ...index.issues,
            ...(resolved.length === decisions.length
                ? []
                : ['governance exception resolver returned malformed repository code style evidence'])
        ]
    };
}

export function isReviewedDisposition(repoRoot, finding, context = {}) {
    const findingPath = path.relative(repoRoot, finding.file).split(path.sep).join('/');
    const staticallyReviewed = reviewedDispositions.some(
        (disposition) =>
            disposition.path === findingPath &&
            disposition.rule === finding.ruleId &&
            disposition.symbol === finding.symbol
    );
    if (staticallyReviewed) {
        return true;
    }
    if (!Array.isArray(context.decisions) || typeof context.candidateHead !== 'string') {
        return false;
    }
    return context.decisions.some(
        (decision) =>
            decision?.projection?.path === findingPath &&
            decision.projection.rule === finding.ruleId &&
            (decision.projection.symbol ?? undefined) === finding.symbol &&
            decision.projection.magnitude === findingMagnitude(finding) &&
            decision.projection.candidateHead === context.candidateHead
    );
}

function isCodeStyleDecision(decision) {
    const projection = decision?.projection;
    return (
        projection !== null &&
        typeof projection === 'object' &&
        !Array.isArray(projection) &&
        typeof projection.rule === 'string' &&
        typeof projection.path === 'string' &&
        (projection.symbol === null || typeof projection.symbol === 'string') &&
        Number.isSafeInteger(projection.magnitude) &&
        typeof projection.candidateHead === 'string'
    );
}
