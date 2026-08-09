import type {
    RallarRtcCandidateDiagnostics,
    RallarRtcCandidatePairDiagnostics,
} from '@shared-web/browser/rtc-diagnostics/rallar-rtc-diagnostics-contracts.ts';

export async function readSelectedCandidatePairDiagnostics(
    pc: RTCPeerConnection | undefined,
): Promise<RallarRtcCandidatePairDiagnostics | undefined> {
    if (!pc || typeof pc.getStats !== 'function') {
        return undefined;
    }

    const report = await pc.getStats();
    const stats = toStatsArray(report);
    const byId = new Map(stats.map((stat) => [String(stat.id), stat]));
    const selectedPair = stats.find((stat) =>
        stat.type === 'candidate-pair' &&
        (stat.selected === true || stat.nominated === true ||
            stat.state === 'succeeded')
    );
    if (!selectedPair) {
        return undefined;
    }

    const local = selectedPair.localCandidateId
        ? toCandidateDiagnostics(byId.get(String(selectedPair.localCandidateId)))
        : undefined;
    const remote = selectedPair.remoteCandidateId
        ? toCandidateDiagnostics(byId.get(String(selectedPair.remoteCandidateId)))
        : undefined;

    return {
        id: toOptionalString(selectedPair.id),
        state: toOptionalString(selectedPair.state),
        nominated: toOptionalBoolean(selectedPair.nominated),
        selected: toOptionalBoolean(selectedPair.selected),
        currentRoundTripTime: toOptionalNumber(
            selectedPair.currentRoundTripTime,
        ),
        availableOutgoingBitrate: toOptionalNumber(
            selectedPair.availableOutgoingBitrate,
        ),
        bytesSent: toOptionalNumber(selectedPair.bytesSent),
        bytesReceived: toOptionalNumber(selectedPair.bytesReceived),
        local,
        remote,
        usesRelay: local?.candidateType === 'relay' ||
            remote?.candidateType === 'relay',
    };
}

function toStatsArray(report: RTCStatsReport): Array<Record<string, unknown>> {
    const values: Array<Record<string, unknown>> = [];
    report.forEach((stat) => {
        if (typeof stat === 'object' && stat !== null) {
            values.push(stat as Record<string, unknown>);
        }
    });
    return values;
}

function toCandidateDiagnostics(
    stat: Record<string, unknown> | undefined,
): RallarRtcCandidateDiagnostics | undefined {
    if (!stat) {
        return undefined;
    }

    return {
        id: toOptionalString(stat.id),
        candidateType: toOptionalString(stat.candidateType),
        protocol: toOptionalString(stat.protocol),
        address: toOptionalString(stat.address),
        ip: toOptionalString(stat.ip),
        port: toOptionalNumber(stat.port),
        relayProtocol: toOptionalString(stat.relayProtocol),
        networkType: toOptionalString(stat.networkType),
        url: toOptionalString(stat.url),
    };
}

function toOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}
