import { FULL_STACK_RTC_ICE_FIXTURE_POLICIES } from './full-stack-rtc-ice-fixture-policy.ts';

type FullStackEnvironment = Readonly<Record<string, string | undefined>>;

export interface ReadFullStackRtcIceFixtureRequestsInput {
    readonly environment: FullStackEnvironment;
    readonly admittedCaseId: 'default' | 'all-scenarios' | 'retention-100' | null;
}

const locatorEnvironmentNames = [
    'RALLAR_BLACK_BOX_RTC_BASELINE_ID',
    'RALLAR_BLACK_BOX_RTC_CASE_ID',
    'RALLAR_BLACK_BOX_RTC_INPUT_KEY',
    'RALLAR_BLACK_BOX_RTC_INTENDED_PHASE',
    'RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL'
] as const;

export function readFullStackRtcIceFixtureRequests(input: ReadFullStackRtcIceFixtureRequestsInput): number {
    const requests = resolveFullStackIceRequestBudget(input);
    const issues = validateFullStackIceFixturePolicy(input, requests);
    if (issues.length > 0) {
        throw new Error(`ICE fixture: ${issues.join(' ')}`);
    }
    return requests;
}

function resolveFullStackIceRequestBudget(input: ReadFullStackRtcIceFixtureRequestsInput): number {
    const environment = input.environment;
    if (input.admittedCaseId === 'retention-100') {
        return FULL_STACK_RTC_ICE_FIXTURE_POLICIES['retention-100'].requests;
    }
    if (
        input.admittedCaseId === null &&
        enabledFixtureFlag(environment.RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK)
    ) {
        return enabledFixtureFlag(environment.RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS)
            ? FULL_STACK_RTC_ICE_FIXTURE_POLICIES['combined-all-retention'].requests
            : FULL_STACK_RTC_ICE_FIXTURE_POLICIES['combined-default-retention'].requests;
    }
    return FULL_STACK_RTC_ICE_FIXTURE_POLICIES.default.requests;
}

function validateFullStackIceFixturePolicy(
    input: ReadFullStackRtcIceFixtureRequestsInput,
    requests: number
): readonly string[] {
    const environment = input.environment;
    const issues: string[] = [];
    const caseId = input.admittedCaseId;
    // Only the canonical evidence loader admits locators; this core never parses
    // a locator or reads a manifest. Unadmitted input cannot claim standalone policy.
    if (caseId === null && locatorEnvironmentNames.some((name) => environment[name] !== undefined)) {
        issues.push('Locator input requires canonical predeclared attempt admission.');
    }
    if (caseId !== null && environment.RALLAR_BLACK_BOX_RTC_CASE_ID !== caseId) {
        issues.push('Locator case contradicts the admitted attempt.');
    }
    const allScenarios = enabledFixtureFlag(environment.RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS);
    const retention = enabledFixtureFlag(environment.RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK);
    const cycles = environment.RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES;
    if (caseId !== null && !['default', 'all-scenarios', 'retention-100'].includes(caseId)) {
        issues.push('Unknown governed case.');
    }
    if ((retention && cycles !== '100') || (!retention && cycles !== undefined)) {
        issues.push('Retention requires exactly 100 cycles and its explicit selector.');
    }
    if (
        caseId !== null &&
        (allScenarios !== (caseId === 'all-scenarios') || retention !== (caseId === 'retention-100'))
    ) {
        issues.push('Selectors contradict the governed case.');
    }
    const explicitRequests = environment.RALLAR_ICE_RATE_LIMIT_REQUESTS;
    if (explicitRequests !== undefined && (caseId === null || explicitRequests !== String(requests))) {
        issues.push(
            'Operational request input must be the exact governed case budget; inherited overrides are refused.'
        );
    }
    for (const name of ['RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS', 'RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK']) {
        const value = environment[name];
        if (value !== undefined && !['0', '1', 'false', 'true'].includes(value)) {
            issues.push('Workload selectors must use canonical boolean values.');
        }
    }
    return issues;
}

function enabledFixtureFlag(value: string | undefined): boolean {
    return value === '1' || value === 'true';
}
