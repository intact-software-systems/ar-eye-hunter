export type FullStackQaArea =
    | 'auth'
    | 'rooms-clients'
    | 'websocket'
    | 'rest'
    | 'recipes-artifacts'
    | 'rtc'
    | 'control'
    | 'resilience';

export type FullStackQaCase = Readonly<{
    id: string;
    area: FullStackQaArea;
    intent: string;
    polarity: 'positive' | 'negative' | 'cross-check';
    testFile: string;
    skipGate: string;
    evidence: readonly string[];
    liveProvider: boolean;
}>;

export type FullStackQaCoverageSummary = Readonly<{
    total: number;
    covered: number;
    coveragePercent: number;
    missingIds: readonly string[];
    byArea: Readonly<Record<FullStackQaArea, Readonly<{
        total: number;
        covered: number;
        coveragePercent: number;
    }>>>;
}>;

const AREAS: readonly FullStackQaArea[] = [
    'auth',
    'rooms-clients',
    'websocket',
    'rest',
    'recipes-artifacts',
    'rtc',
    'control',
    'resilience',
];

export const FULL_STACK_QA_MATRIX: readonly FullStackQaCase[] = [
    {
        id: 'auth-login-rest-token',
        area: 'auth',
        intent: 'Login gates browser-rallar mode and protected REST calls attach bearer and client identity headers.',
        polarity: 'positive',
        testFile: 'full-stack-rest-workbench.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['login header', 'authorization header', 'x-client-id', 'redacted response'],
        liveProvider: true,
    },
    {
        id: 'auth-bad-credentials',
        area: 'auth',
        intent: 'Bad credentials stay on the login screen and surface a visible error.',
        polarity: 'negative',
        testFile: 'full-stack-command-center-qa-matrix.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['login error', 'no app shell'],
        liveProvider: true,
    },
    {
        id: 'auth-missing-token',
        area: 'auth',
        intent: 'Protected Rallar Server REST endpoints reject missing access tokens.',
        polarity: 'negative',
        testFile: 'full-stack-command-center-qa-matrix.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['401 or 403 response'],
        liveProvider: true,
    },
    {
        id: 'rooms-state-refresh',
        area: 'rooms-clients',
        intent: 'Groups/clients state can be read after group creation and presence changes.',
        polarity: 'positive',
        testFile: 'full-stack-browser-rallar-resilience.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['group snapshot', 'member status', 'state events'],
        liveProvider: true,
    },
    {
        id: 'rooms-replay-stale-session',
        area: 'rooms-clients',
        intent: 'Replay and stale-session cases preserve room/client event evidence.',
        polarity: 'cross-check',
        testFile: 'full-stack-browser-rallar-resilience.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['replay events', 'disconnect events', 'snapshot refresh'],
        liveProvider: true,
    },
    {
        id: 'websocket-ticket-open-send',
        area: 'websocket',
        intent: 'WebSocket command center creates an authenticated ticket, opens API WS, and records send evidence.',
        polarity: 'positive',
        testFile: 'full-stack-command-center-qa-matrix.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['ticket request', 'ws.open result', 'ws.send result'],
        liveProvider: true,
    },
    {
        id: 'websocket-missing-ticket',
        area: 'websocket',
        intent: 'Missing-ticket WebSocket open fails visibly and produces diagnostic evidence.',
        polarity: 'negative',
        testFile: 'full-stack-command-center-qa-matrix.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['negative open result', 'diagnostic event'],
        liveProvider: true,
    },
    {
        id: 'rest-collection-assert-extract',
        area: 'rest',
        intent: 'REST collections execute status/header/body assertions and variable extraction.',
        polarity: 'positive',
        testFile: 'full-stack-rest-workbench.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['collection row', 'assertions', 'extracted variables'],
        liveProvider: true,
    },
    {
        id: 'rest-group-login-join-existing',
        area: 'rest',
        intent: 'A logged-in browser can create-or-accept an existing group and join it through the Rallar Server tab with the authenticated client id.',
        polarity: 'positive',
        testFile: 'full-stack-rest-workbench.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['auth.session', 'PUT group member URL', 'x-client-id', 'status active body'],
        liveProvider: true,
    },
    {
        id: 'rest-group-join-live-errors',
        area: 'rest',
        intent: 'Malformed group-join requests and mismatched principal ids return visible live Rallar Server errors.',
        polarity: 'negative',
        testFile: 'full-stack-rest-workbench.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['400 missing join body', '403 principal mismatch', 'visible error message'],
        liveProvider: true,
    },
    {
        id: 'recipes-artifact-import',
        area: 'recipes-artifacts',
        intent: 'Shared Test catalog and artifact import remain visible in the full-stack shell.',
        polarity: 'positive',
        testFile: 'full-stack-command-center-qa-matrix.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['catalog entry', 'artifact validation'],
        liveProvider: false,
    },
    {
        id: 'control-artifact-cross-check',
        area: 'control',
        intent: 'Control-server run snapshots can be exported as redacted artifact bundles.',
        polarity: 'cross-check',
        testFile: 'full-stack-control-orchestration.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['control result', 'artifact bundle', 'events JSONL'],
        liveProvider: false,
    },
    {
        id: 'rtc-direct-realtime',
        area: 'rtc',
        intent: 'Two browsers exchange a direct realtime payload through Manual Rallar.',
        polarity: 'positive',
        testFile: 'full-stack-manual-rallar-realtime.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['received inbox', 'real-provider event stream'],
        liveProvider: true,
    },
    {
        id: 'rtc-three-browser-matrix',
        area: 'rtc',
        intent: 'Three browsers cover direct, multicast, broadcast, and NACK baselines for realtime and messages.rtc.',
        polarity: 'cross-check',
        testFile: 'full-stack-live-rtc-three-browser-matrix.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1 and RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1',
        evidence: ['three agents', 'delivery matrix', 'nack probes', 'artifact export'],
        liveProvider: true,
    },
    {
        id: 'resilience-server-reconnect',
        area: 'resilience',
        intent: 'Reconnect/replay paths survive missed events and lifecycle changes.',
        polarity: 'cross-check',
        testFile: 'full-stack-browser-rallar-resilience.spec.ts',
        skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1',
        evidence: ['ws lifecycle', 'rtc lifecycle', 'replay counts'],
        liveProvider: true,
    },
];

export function fullStackQaCoverageSummary(
    matrix: readonly FullStackQaCase[] = FULL_STACK_QA_MATRIX,
): FullStackQaCoverageSummary {
    const coveredCases = matrix.filter(entry => entry.testFile.length > 0 && entry.skipGate.length > 0);
    const byArea = Object.fromEntries(AREAS.map(area => {
        const entries = matrix.filter(entry => entry.area === area);
        const covered = entries.filter(entry => entry.testFile.length > 0 && entry.skipGate.length > 0).length;
        return [area, {
            total: entries.length,
            covered,
            coveragePercent: entries.length === 0 ? 100 : Math.round((covered / entries.length) * 100),
        }];
    })) as FullStackQaCoverageSummary['byArea'];

    return {
        total: matrix.length,
        covered: coveredCases.length,
        coveragePercent: matrix.length === 0 ? 100 : Math.round((coveredCases.length / matrix.length) * 100),
        missingIds: matrix
            .filter(entry => entry.testFile.length === 0 || entry.skipGate.length === 0)
            .map(entry => entry.id),
        byArea,
    };
}
