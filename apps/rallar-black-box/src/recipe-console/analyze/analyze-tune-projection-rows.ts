import type {
    DistributedRunTuningInventoryLimitation,
    DistributedRunTuningKnob
} from '@shared-test/rallar-bb-test/mod.ts';
import type { AnalyzeArtifactModel } from './analyze-artifact-model.ts';
import {
    boundedClone,
    boundedText,
    finiteNumber,
    MAX_METADATA_BYTES,
    MAX_SUMMARY_BYTES,
    MAX_TUNE_ROWS,
    projectOpaqueIdentifier
} from './analyze-projection-bounds.ts';
import type { AnalyzeTuneArtifactFacade, AnalyzeWorkerRequest } from './analyze-worker-contract.ts';

export function projectTuningKnob(
    knob: DistributedRunTuningKnob
): DistributedRunTuningKnob {
    return {
        name: knob.name,
        pointer: boundedText(knob.pointer, MAX_METADATA_BYTES),
        scope: knob.scope,
        ...(knob.currentValue !== undefined
            ? { currentValue: finiteNumber(knob.currentValue) }
            : {}),
        availability: knob.availability,
        effective: knob.effective,
        constraint: { ...knob.constraint },
        ...(knob.recipeIndex !== undefined
            ? { recipeIndex: finiteNumber(knob.recipeIndex) }
            : {}),
        ...(knob.recipeId
            ? { recipeId: projectOpaqueIdentifier(knob.recipeId) }
            : {}),
        ...(knob.commandId
            ? { commandId: projectOpaqueIdentifier(knob.commandId) }
            : {}),
        ...(knob.commandKind ? { commandKind: knob.commandKind } : {}),
        ...(knob.reason ? { reason: boundedText(knob.reason, MAX_SUMMARY_BYTES) } : {})
    };
}

export function projectTuningLimitation(
    limitation: DistributedRunTuningInventoryLimitation
): DistributedRunTuningInventoryLimitation {
    return {
        code: limitation.code,
        message: boundedText(limitation.message, MAX_SUMMARY_BYTES),
        ...(limitation.recipeIndex !== undefined
            ? { recipeIndex: finiteNumber(limitation.recipeIndex) }
            : {}),
        ...(limitation.recipeId
            ? { recipeId: projectOpaqueIdentifier(limitation.recipeId) }
            : {})
    };
}

export function projectTuneRollup(value: unknown): unknown {
    return boundedClone(value, {
        arrayLimit: MAX_TUNE_ROWS,
        textLimit: MAX_SUMMARY_BYTES
    });
}

export function receivedMessageDeltas(
    model: AnalyzeArtifactModel
): AnalyzeTuneArtifactFacade['receivedMessageDeltas'] {
    const latestByAgent = new Map<string, number>();
    for (const row of model.snapshots.controlRun.stats) {
        const receivedMessages = finiteNumberAtPath(
            row.payload,
            ['counters', 'messages']
        );
        if (receivedMessages !== undefined) {
            latestByAgent.set(row.agentId, receivedMessages);
        }
    }
    const expectedByAgent = new Map<string, number>();
    for (const row of model.analysis.performance?.receiverDelivery?.lowestAgents ?? []) {
        if (
            row.expectedInboundMessages !== undefined &&
            Number.isFinite(row.expectedInboundMessages)
        ) {
            expectedByAgent.set(row.agentId, row.expectedInboundMessages);
        }
    }
    const entries = [...latestByAgent]
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, MAX_TUNE_ROWS)
        .map(([agentId, receivedMessages]) => {
            const expectedMessages = expectedByAgent.get(agentId);
            const delta = expectedMessages === undefined
                ? undefined
                : receivedMessages - expectedMessages;
            return {
                agentId: projectOpaqueIdentifier(agentId),
                receivedMessages,
                ...(expectedMessages !== undefined ? { expectedMessages } : {}),
                ...(delta !== undefined && Number.isFinite(delta) ? { delta } : {})
            };
        });
    return {
        entries,
        total: latestByAgent.size,
        omitted: Math.max(0, latestByAgent.size - entries.length)
    };
}

export function tuneArtifactRole(
    distributedRunId: string,
    selection: Pick<Extract<AnalyzeWorkerRequest, { type: 'tune'; }>, 'focusRunId' | 'compareLeft' | 'compareRight'>
): AnalyzeTuneArtifactFacade['selection']['artifactRole'] {
    if (selection.focusRunId === distributedRunId) {
        return 'focus';
    }
    if (selection.compareLeft === distributedRunId) {
        return 'compare-left';
    }
    if (selection.compareRight === distributedRunId) {
        return 'compare-right';
    }
    return 'unrelated';
}

function finiteNumberAtPath(
    value: unknown,
    path: readonly string[]
): number | undefined {
    let current = value;
    for (const key of path) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return undefined;
        }
        current = (current as Record<string, unknown>)[key];
    }
    return typeof current === 'number' && Number.isFinite(current)
        ? current
        : undefined;
}
