export type LiveRtcThreeBrowserCoverageArea =
    | 'environment'
    | 'membership'
    | 'websocket'
    | 'delivery'
    | 'negative'
    | 'evidence';

export type LiveRtcThreeBrowserCoverageCase = Readonly<{
    id: string;
    area: LiveRtcThreeBrowserCoverageArea;
    intent: string;
    required: boolean;
    testFile?: string;
    evidence: readonly string[];
}>;

export type LiveRtcThreeBrowserCoverageSummary = Readonly<{
    total: number;
    required: number;
    covered: number;
    requiredCovered: number;
    coveragePercent: number;
    requiredCoveragePercent: number;
    missingRequiredIds: readonly string[];
    missingOptionalIds: readonly string[];
}>;

export const LIVE_RTC_THREE_BROWSER_COVERAGE: readonly LiveRtcThreeBrowserCoverageCase[] = [
    {
        id: 'provision-three-browser-agents',
        area: 'environment',
        intent: 'Launch three isolated browser contexts with explicit live-matrix skip gates and real Rallar auth.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['three contexts', 'control registration', 'login or restored session'],
    },
    {
        id: 'unique-group-create-join',
        area: 'membership',
        intent: 'Create a unique group and join all three authenticated clients before RTC delivery.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['group create command', 'three join commands'],
    },
    {
        id: 'group-state-readback',
        area: 'membership',
        intent: 'Read back the live group and group event page after all three clients join.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['group GET', 'group events page', '200 response'],
    },
    {
        id: 'websocket-three-agent-open-send-close',
        area: 'websocket',
        intent: 'Open authenticated API WebSockets, send JSON, and close from all three live browser agents.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['ws.open', 'ws.send', 'ws.close', 'three agents'],
    },
    {
        id: 'realtime-direct',
        area: 'delivery',
        intent: 'Send a realtime direct payload from agent A to agent B.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['control event', 'receiver inbox', 'unique matrix id'],
    },
    {
        id: 'realtime-multicast',
        area: 'delivery',
        intent: 'Send a realtime multicast payload from agent A to agents B and C.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['two receiver events', 'ready peer health'],
    },
    {
        id: 'realtime-broadcast',
        area: 'delivery',
        intent: 'Send a realtime broadcast payload from agent A and observe both other agents.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['broadcast matrix id', 'B receiver event', 'C receiver event'],
    },
    {
        id: 'messages-rtc-direct',
        area: 'delivery',
        intent: 'Send a messages.rtc direct payload from agent A to agent B with next-hop addressing.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['nextHopPeerIds', 'receiver event', 'receiver inbox'],
    },
    {
        id: 'messages-rtc-multicast',
        area: 'delivery',
        intent: 'Send a messages.rtc multicast payload from agent A to agents B and C.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['nextHopPeerIds', 'two receiver events'],
    },
    {
        id: 'messages-rtc-broadcast',
        area: 'delivery',
        intent: 'Send a messages.rtc broadcast payload from agent A and observe both other agents.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['broadcast matrix id', 'B receiver event', 'C receiver event'],
    },
    {
        id: 'realtime-all-sender-receiver-permutations',
        area: 'delivery',
        intent: 'Run every three-browser realtime sender/receiver direct pair plus every sender multicast and broadcast.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['six direct pairs', 'three multicasts', 'three broadcasts'],
    },
    {
        id: 'messages-rtc-all-sender-receiver-permutations',
        area: 'delivery',
        intent: 'Run every three-browser messages.rtc sender/receiver direct pair plus every sender multicast and broadcast.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['six direct pairs', 'three multicasts', 'three broadcasts'],
    },
    {
        id: 'unexpected-delivery-guard',
        area: 'delivery',
        intent: 'Check direct and multicast matrix IDs do not appear on unintended live receiver agents.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['scenario map', 'unexpected delivery scan'],
    },
    {
        id: 'not-yet-in-sync-probe',
        area: 'negative',
        intent: 'Probe not-yet-in-sync/NACK behavior with a high minSnapshotVersion and retain server/runtime evidence.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['minSnapshotVersion', 'NACK or min-snapshot diagnostic evidence'],
    },
    {
        id: 'closed-transport-send-failure',
        area: 'negative',
        intent: 'Close one agent and prove a stale RTC send fails visibly instead of reporting green delivery.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['close command', 'failed stale-send result'],
    },
    {
        id: 'reconnect-after-stale-agent',
        area: 'negative',
        intent: 'Reconnect a closed live browser agent and prove a fresh messages.rtc direct payload reaches it.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['reconnect command', 'post-reconnect direct delivery'],
    },
    {
        id: 'no-simulated-provider-evidence',
        area: 'evidence',
        intent: 'Reject fake provider topics in the live run snapshot.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['zero rallar.bb.fake topics'],
    },
    {
        id: 'control-artifact-export',
        area: 'evidence',
        intent: 'Export a control-server artifact bundle containing command results and browser Rallar events.',
        required: true,
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        evidence: ['report.json', 'events.jsonl'],
    },
    {
        id: 'permission-denied-negative',
        area: 'negative',
        intent: 'Exercise explicit denied group/room operations once the provisioned environment exposes stable permission fixtures.',
        required: false,
        evidence: ['forbidden group operation', 'redacted denial evidence'],
    },
];

export function liveRtcThreeBrowserCoverageSummary(
    matrix: readonly LiveRtcThreeBrowserCoverageCase[] = LIVE_RTC_THREE_BROWSER_COVERAGE,
): LiveRtcThreeBrowserCoverageSummary {
    const covered = matrix.filter(isCovered);
    const required = matrix.filter(entry => entry.required);
    const requiredCovered = required.filter(isCovered);

    return {
        total: matrix.length,
        required: required.length,
        covered: covered.length,
        requiredCovered: requiredCovered.length,
        coveragePercent: percent(covered.length, matrix.length),
        requiredCoveragePercent: percent(requiredCovered.length, required.length),
        missingRequiredIds: required.filter(entry => !isCovered(entry)).map(entry => entry.id),
        missingOptionalIds: matrix
            .filter(entry => !entry.required && !isCovered(entry))
            .map(entry => entry.id),
    };
}

function isCovered(entry: LiveRtcThreeBrowserCoverageCase): boolean {
    return Boolean(entry.testFile && entry.testFile.length > 0 && entry.evidence.length > 0);
}

function percent(value: number, total: number): number {
    return total === 0 ? 100 : Math.round((value / total) * 100);
}
