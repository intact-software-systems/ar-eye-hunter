import type { ControlDistributedRunSnapshot } from '../control-snapshots.ts';
import type { DistributedRunLowestReceiver, DistributedRunReceiverDelivery } from '../distributed-artifact-analysis.ts';
import type { DistributedRunResultEvidence } from '../distributed-artifact-analysis/decode-distributed-run-result-evidence.ts';
import {
    decodeReceiverDeliverySpecsByCommandId,
    type ReceiverDeliverySpec
} from '../distributed-artifact-analysis/decode-receiver-delivery-spec.ts';
import {
    computeNumberExtrema,
    computePercentile,
    toRoundedMetric
} from './compute-timing-summary.ts';

export interface ReceiverDeliverySources {
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly controlResults: readonly DistributedRunResultEvidence[];
    readonly jsonlResults: readonly DistributedRunResultEvidence[];
}

interface ReceiverDeliverySample extends ReceiverDeliverySpec {
    /** Absent when neither the stats result nor its enclosing result names the agent. */
    readonly agentId?: string;
    /** Absent when neither the stats nor the result names the command. */
    readonly commandId?: string;
    readonly receivedMessages: number;
}

const LOWEST_RECEIVER_LIMIT = 5;

/** Absent when no stats result carries a message count with a receiver delivery bound. */
export function computeReceiverDelivery(sources: ReceiverDeliverySources): DistributedRunReceiverDelivery | undefined {
    const samples = toReceiverDeliverySamples(sources);
    if (samples.length === 0) {
        return undefined;
    }
    const receivedMessages = samples.map((sample) => sample.receivedMessages);
    const deliveryRatios = samples.flatMap((sample) => toDeliveryRatio(sample) ?? []);
    const receivedMessageExtrema = computeNumberExtrema(receivedMessages);
    return {
        sampleCount: samples.length,
        expectedInboundMessages: toFirstFiniteNumber(samples.map((sample) => sample.expectedInboundMessages)),
        minExpectedInboundMessages: toFirstFiniteNumber(samples.map((sample) => sample.minExpectedInboundMessages)),
        minReceiveRatio: toFirstFiniteNumber(samples.map((sample) => sample.minReceiveRatio)),
        minReceivedMessages: receivedMessageExtrema?.min,
        medianReceivedMessages: computePercentile(receivedMessages, 0.5),
        p95ReceivedMessages: computePercentile(receivedMessages, 0.95),
        maxReceivedMessages: receivedMessageExtrema?.max,
        minDeliveryRatio: computeNumberExtrema(deliveryRatios)?.min,
        medianDeliveryRatio: computePercentile(deliveryRatios, 0.5),
        p95DeliveryRatio: computePercentile(deliveryRatios, 0.95),
        lowestAgents: toLowestReceivers(samples)
    };
}

function toLowestReceivers(samples: readonly ReceiverDeliverySample[]): readonly DistributedRunLowestReceiver[] {
    return samples
        .flatMap((sample) =>
            sample.agentId
                ? [{
                    agentId: sample.agentId,
                    receivedMessages: sample.receivedMessages,
                    expectedInboundMessages: sample.expectedInboundMessages,
                    deliveryRatio: toDeliveryRatio(sample)
                }]
                : []
        )
        .sort((left, right) =>
            left.receivedMessages - right.receivedMessages ||
            (left.deliveryRatio ?? Number.POSITIVE_INFINITY) - (right.deliveryRatio ?? Number.POSITIVE_INFINITY) ||
            left.agentId.localeCompare(right.agentId)
        )
        .slice(0, LOWEST_RECEIVER_LIMIT);
}

/** The last sample per agent and bound wins, so interim stats give way to the final ones. */
function toReceiverDeliverySamples(sources: ReceiverDeliverySources): readonly ReceiverDeliverySample[] {
    const specsByCommandId = decodeReceiverDeliverySpecsByCommandId(sources.distributedRun.manifest);
    const samples = new Map<string, ReceiverDeliverySample>();
    for (const result of [...sources.controlResults, ...sources.jsonlResults]) {
        for (const sample of toResultReceiverDeliverySamples(result, specsByCommandId, undefined)) {
            const key = [
                sample.agentId ?? 'unknown-agent',
                sample.expectedInboundMessages ?? 'unknown-expected',
                sample.minExpectedInboundMessages ?? 'unknown-minimum'
            ].join(':');
            samples.set(key, sample);
        }
    }
    return [...samples.values()];
}

function toResultReceiverDeliverySamples(
    result: DistributedRunResultEvidence,
    specsByCommandId: ReadonlyMap<string, ReceiverDeliverySpec>,
    inheritedAgentId: string | undefined
): readonly ReceiverDeliverySample[] {
    const agentId = result.agentId ?? inheritedAgentId;
    const commandId = result.stats?.commandId ?? result.payloadCommandId ?? result.commandId;
    const spec = result.receiverDeliverySpec ?? (commandId ? specsByCommandId.get(commandId) : undefined);
    const own = result.stats !== undefined && spec !== undefined
        ? [{ agentId, commandId, receivedMessages: result.stats.receivedMessages, ...spec }]
        : [];
    return [
        ...own,
        ...result.nestedResults.flatMap((nestedResult) =>
            toResultReceiverDeliverySamples(nestedResult, specsByCommandId, agentId)
        )
    ];
}

function toDeliveryRatio(sample: ReceiverDeliverySample): number | undefined {
    return sample.expectedInboundMessages && sample.expectedInboundMessages > 0
        ? toRoundedMetric(sample.receivedMessages / sample.expectedInboundMessages)
        : undefined;
}

function toFirstFiniteNumber(values: readonly (number | undefined)[]): number | undefined {
    return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}
