import { isStreamFailureText } from '../distributed-run-performance/to-stream-timing-samples.ts';

/** The failure evidence a fix area is chosen from; each value is undefined when the evidence does not name it. */
export interface MinimalFixAreaInput {
    readonly category: string | undefined;
    readonly transport: string | undefined;
    readonly text: string | undefined;
}

interface TextRule {
    readonly outcome: string;
    readonly fragments: readonly string[];
}

export const TERMINAL_FAILURE_STATES: ReadonlySet<string> = new Set(['failed', 'timed-out', 'cancelled']);

export const STREAM_FIX_AREA = 'RTC stream pacing/performance';
const LIVE_RTC_VERIFICATION = '`npm run test:e2e:rallar-black-box:full-stack:memory:live-rtc-3`';

const MINIMAL_FIX_AREA_RULES: readonly TextRule[] = [
    { outcome: 'group assertion contract or fleet evidence', fragments: ['group-assertion', 'group_assertion'] },
    { outcome: 'absence wait window or leaked traffic source', fragments: ['assertion-absence', 'absence'] },
    { outcome: 'convergence polling bounds or backend convergence', fragments: ['convergence-polling', 'until'] },
    { outcome: 'agent assertion capability rollout', fragments: ['capability-gating', 'assertion capabilities'] },
    { outcome: 'distributed targeting', fragments: ['target'] },
    { outcome: 'headless agent readiness', fragments: ['ack', 'readiness'] },
    { outcome: 'distributed barrier', fragments: ['barrier'] },
    { outcome: 'RTC/TURN', fragments: ['rtc', 'turn', 'peer', 'route'] },
    { outcome: 'API/CORS/auth', fragments: ['ws', 'cors', 'auth', 'login'] },
    { outcome: 'recipe assertion', fragments: ['recipe', 'assert'] }
];

const FAILURE_CATEGORY_RULES: readonly TextRule[] = [
    { outcome: 'group-assertion', fragments: ['group_assertion', 'group assertion'] },
    { outcome: 'assertion-absence', fragments: ['absence'] },
    { outcome: 'convergence-polling', fragments: ['until'] },
    { outcome: 'capability-gating', fragments: ['assertion-capability', 'assertion capabilities'] },
    { outcome: 'targeting', fragments: ['target'] },
    { outcome: 'readiness', fragments: ['ack'] },
    { outcome: 'barrier', fragments: ['barrier'] },
    { outcome: 'diagnostic', fragments: ['diagnostic'] },
    { outcome: 'runtime', fragments: ['runtime'] },
    { outcome: 'command', fragments: ['assert'] }
];

const VERIFICATION_COMMANDS: ReadonlyMap<string, string> = new Map([
    [STREAM_FIX_AREA, LIVE_RTC_VERIFICATION],
    [
        'group assertion contract or fleet evidence',
        '`npx vitest run packages/tests/shared-test/rallar-bb-test-group-assertion-conformance.test.ts`'
    ],
    ['RTC/TURN', LIVE_RTC_VERIFICATION],
    ['API/CORS/auth', '`./scripts/hetzner/controller/03-smoke-controller.sh` on the controller VM'],
    ['headless agent readiness', '`./scripts/hetzner/controller/12-status-headless-workers.sh` on the controller VM']
]);

export function toAffectedAgents(agentId: string | undefined): readonly string[] {
    return agentId ? [agentId] : [];
}

export function resolveMinimalFixArea(input: MinimalFixAreaInput): string {
    const text = `${input.category ?? ''} ${input.transport ?? ''} ${input.text ?? ''}`.toLowerCase();
    if (text.includes('rtc-stream-performance') || isStreamFailureText(text)) {
        return STREAM_FIX_AREA;
    }
    return resolveTextRule(MINIMAL_FIX_AREA_RULES, text) ?? 'control-server/runtime';
}

export function resolveFailureCategory(code: string | undefined, message: string): string {
    const text = `${code ?? ''} ${message}`.toLowerCase();
    if (isStreamFailureText(text)) {
        return 'rtc-stream-performance';
    }
    return resolveTextRule(FAILURE_CATEGORY_RULES, text) ?? (code || message ? 'command' : 'unknown');
}

export function resolveVerificationCommand(minimalFixArea: string): string {
    return VERIFICATION_COMMANDS.get(minimalFixArea) ??
        '`npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts`';
}

export function resolveEvidenceFileForAction(category: string): string {
    if (category === 'diagnostic') {
        return 'events.jsonl';
    }
    return category === 'command' ? 'results.jsonl' : 'distributed-run.json';
}

function resolveTextRule(rules: readonly TextRule[], text: string): string | undefined {
    return rules.find((rule) => rule.fragments.some((fragment) => text.includes(fragment)))?.outcome;
}
