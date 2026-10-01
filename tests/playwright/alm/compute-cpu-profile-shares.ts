import type { BundledModule } from './bundle-durable-send-harness.ts';

export interface CpuProfile {
    readonly nodes: readonly CpuProfileNode[];
    readonly samples?: readonly number[];
    readonly timeDeltas?: readonly number[];
}

export interface CpuProfileNode {
    readonly id: number;
    readonly callFrame: {
        readonly functionName: string;
        readonly url: string;
        readonly lineNumber: number;
    };
    readonly children?: readonly number[];
}

export interface CpuProfileSharesInput {
    readonly profile: CpuProfile;
    readonly bundleUrl: string;
    readonly modules: readonly BundledModule[];
}

export const TEMPORAL_POLYFILL_SOURCE = '@js-temporal/polyfill/';
export const JSBI_SOURCE = '/jsbi/';
export const CODEC_SOURCE_SUFFIX = 'queuebox/indexed-db-queue-box-entry-codec.ts';

/** Self-time shares of busy CPU (every sample but `(idle)`), each rounded to 0.1 %. */
export interface CpuProfileShares {
    readonly busyMs: number;
    readonly temporalPolyfillPercent: number;
    readonly jsbiPercent: number;
    readonly temporalPercent: number;
    readonly codecSelfPercent: number;
    readonly codecInclusivePercent: number;
    /** Of the polyfill and JSBI time, the part with a codec frame on the stack. */
    readonly temporalUnderCodecPercent: number;
    /** Busy time no named owner accounts for; 100 means the attribution found nothing. */
    readonly otherPercent: number;
}

type FrameOwner = 'temporal-polyfill' | 'jsbi' | 'codec' | 'other' | 'idle';

interface SampleTotals {
    busyUs: number;
    readonly selfUs: Record<FrameOwner, number>;
    codecOnStackUs: number;
    temporalUnderCodecUs: number;
}

export function computeCpuProfileShares(input: CpuProfileSharesInput): CpuProfileShares {
    const totals = computeSampleTotals(input);
    const temporalUs = totals.selfUs['temporal-polyfill'] + totals.selfUs.jsbi;
    return {
        busyMs: Math.round(totals.busyUs / 100) / 10,
        temporalPolyfillPercent: toPercent(totals.selfUs['temporal-polyfill'], totals.busyUs),
        jsbiPercent: toPercent(totals.selfUs.jsbi, totals.busyUs),
        temporalPercent: toPercent(temporalUs, totals.busyUs),
        codecSelfPercent: toPercent(totals.selfUs.codec, totals.busyUs),
        codecInclusivePercent: toPercent(totals.codecOnStackUs, totals.busyUs),
        temporalUnderCodecPercent: toPercent(totals.temporalUnderCodecUs, temporalUs),
        otherPercent: toPercent(totals.selfUs.other, totals.busyUs)
    };
}

function computeSampleTotals(input: CpuProfileSharesInput): SampleTotals {
    const attributions = toNodeAttributions(input);
    const totals: SampleTotals = {
        busyUs: 0,
        selfUs: { 'temporal-polyfill': 0, jsbi: 0, codec: 0, other: 0, idle: 0 },
        codecOnStackUs: 0,
        temporalUnderCodecUs: 0
    };
    const deltas = input.profile.timeDeltas ?? [];
    (input.profile.samples ?? []).forEach((nodeId, index) => {
        const { owner, codecOnStack } = attributions.get(nodeId) ??
            { owner: 'other', codecOnStack: false };
        const durationUs = deltas[index + 1] ?? 0;
        totals.selfUs[owner] += durationUs;
        if (owner === 'idle') {
            return;
        }
        totals.busyUs += durationUs;
        totals.codecOnStackUs += codecOnStack ? durationUs : 0;
        const temporal = owner === 'temporal-polyfill' || owner === 'jsbi';
        totals.temporalUnderCodecUs += temporal && codecOnStack ? durationUs : 0;
    });
    return totals;
}

interface NodeAttribution {
    readonly owner: FrameOwner;
    readonly codecOnStack: boolean;
}

function toNodeAttributions(input: CpuProfileSharesInput): ReadonlyMap<number, NodeAttribution> {
    const nodes = new Map(input.profile.nodes.map((node) => [node.id, node]));
    const attributions = new Map<number, NodeAttribution>();
    const root = input.profile.nodes[0];
    const pending: [CpuProfileNode, boolean][] = root === undefined ? [] : [[root, false]];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        const [node, codecAbove] = next;
        const owner = resolveFrameOwner(node, input);
        const codecOnStack = codecAbove || owner === 'codec';
        attributions.set(node.id, { owner, codecOnStack });
        for (const child of node.children ?? []) {
            const childNode = nodes.get(child);
            if (childNode !== undefined) {
                pending.push([childNode, codecOnStack]);
            }
        }
    }
    return attributions;
}

function resolveFrameOwner(node: CpuProfileNode, input: CpuProfileSharesInput): FrameOwner {
    if (node.callFrame.functionName === '(idle)') {
        return 'idle';
    }
    if (node.callFrame.url !== input.bundleUrl) {
        return 'other';
    }
    const source = resolveBundledSource(input.modules, node.callFrame.lineNumber);
    if (source.includes(TEMPORAL_POLYFILL_SOURCE)) {
        return 'temporal-polyfill';
    }
    if (source.includes(JSBI_SOURCE)) {
        return 'jsbi';
    }
    return source.endsWith(CODEC_SOURCE_SUFFIX) ? 'codec' : 'other';
}

function resolveBundledSource(modules: readonly BundledModule[], lineNumber: number): string {
    let source = '';
    for (const module of modules) {
        if (module.startLine > lineNumber) {
            break;
        }
        source = module.source;
    }
    return source;
}

function toPercent(partUs: number, wholeUs: number): number {
    return wholeUs === 0 ? 0 : Math.round((partUs / wholeUs) * 1000) / 10;
}
