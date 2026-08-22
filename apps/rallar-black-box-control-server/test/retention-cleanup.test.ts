import { ControlRetentionPlanLimitError, type ControlRetentionPlan } from '@shared-test/rallar-bb-test/control-retention.ts';
import { handleRetentionCleanup } from '../src/retention-cleanup.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEquals<T>(actual: T, expected: T): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `Expected ${JSON.stringify(expected, null, 2)}, got ${JSON.stringify(actual, null, 2)}`
        );
    }
}

Deno.test('retention cleanup authorizes before validating queries or reading plans', async () => {
    let serviceCalls = 0;
    const result = await handleRetentionCleanup({
        url: url('?dryRun=false&planToken=invalid'),
        maxRuns: 1,
        authorize: () => false,
        service: {
            createRetentionPlan: () => {
                serviceCalls += 1;
                return plan('unexpected');
            },
            applyRetentionPlan: () => {
                serviceCalls += 1;
                return [];
            },
            pruneRuns: () => {
                serviceCalls += 1;
                return [];
            },
            legacyRetainedRuns: () => {
                serviceCalls += 1;
                return 0;
            }
        },
        tokens: tokenAdapter(),
        persist: () => {
            serviceCalls += 1;
        }
    });

    assertEquals(result, {
        status: 401,
        body: { error: 'Admin token is required or invalid.' }
    });
    assertEquals(serviceCalls, 0);
});

Deno.test('retention preview whitelists safe consequence fields and never mutates', async () => {
    let applyCalls = 0;
    let persistCalls = 0;
    const result = await handleRetentionCleanup({
        url: url('?dryRun=true'),
        maxRuns: 1,
        authorize: () => true,
        service: {
            createRetentionPlan: () => plan('canonical-secret-sentinel'),
            applyRetentionPlan: () => {
                applyCalls += 1;
                return [];
            },
            pruneRuns: () => [],
            legacyRetainedRuns: () => 2
        },
        tokens: tokenAdapter('v1.abc.safe-token'),
        persist: () => {
            persistCalls += 1;
        }
    });

    assertEquals(result.status, 200);
    assertEquals(result.body, {
        deletedRunIds: [],
        retainedRuns: 2,
        maxRuns: 1,
        dryRun: true,
        wouldDeleteRuns: plan().candidates,
        wouldDeleteRunIds: ['run-old'],
        wouldDeleteDistributedRunIds: ['dist-old'],
        wouldDeleteFleetReportIds: ['dist-old'],
        projectedRetainedRuns: 1,
        preserves: {
            connectedAgentSockets: true,
            storedArtifactFiles: true
        },
        planToken: 'v1.abc.safe-token'
    });
    const serialized = JSON.stringify(result.body);
    assert(!serialized.includes('canonical-secret-sentinel'));
    assert(!serialized.includes('revision:'));
    assert(!serialized.includes('raw-token'));
    assertEquals(applyCalls, 0);
    assertEquals(persistCalls, 0);
});

Deno.test('retention confirmation rejects crypto-race drift without deletion', async () => {
    let current = plan('before-verify');
    let applyCalls = 0;
    let persistCalls = 0;
    const result = await handleRetentionCleanup({
        url: url('?planToken=v1.abc.safe-token'),
        maxRuns: 1,
        authorize: () => true,
        service: {
            createRetentionPlan: () => current,
            applyRetentionPlan: () => {
                applyCalls += 1;
                return [];
            },
            pruneRuns: () => [],
            legacyRetainedRuns: () => 2
        },
        tokens: {
            issue: async () => 'v1.abc.safe-token',
            verify: async () => {
                await Promise.resolve();
                current = plan('changed-during-verify');
                return true;
            }
        },
        persist: () => {
            persistCalls += 1;
        }
    });

    assertEquals(result, conflict());
    assertEquals(applyCalls, 0);
    assertEquals(persistCalls, 0);
});

Deno.test('retention confirmation replans compares and applies without an await gap', async () => {
    let planCalls = 0;
    let microtaskRan = false;
    let persistCalls = 0;
    const stable = plan('stable');
    const result = await handleRetentionCleanup({
        url: url('?planToken=v1.abc.safe-token'),
        maxRuns: 1,
        authorize: () => true,
        service: {
            createRetentionPlan: () => {
                planCalls += 1;
                if (planCalls === 2) {
                    queueMicrotask(() => (microtaskRan = true));
                }
                return stable;
            },
            applyRetentionPlan: (applied: ControlRetentionPlan) => {
                assertEquals(microtaskRan, false);
                assertEquals(applied, stable);
                return ['run-old'];
            },
            pruneRuns: () => [],
            legacyRetainedRuns: () => 2
        },
        tokens: tokenAdapter('v1.abc.safe-token', true),
        persist: () => {
            persistCalls += 1;
        }
    });

    assertEquals(result, {
        status: 200,
        body: { deletedRunIds: ['run-old'], retainedRuns: 1, maxRuns: 1 }
    });
    assertEquals(planCalls, 2);
    assertEquals(persistCalls, 1);
    await Promise.resolve();
    assertEquals(microtaskRan, true);
});

Deno.test('retention legacy mode preserves exact cleanup shape and sequence', async () => {
    const calls: string[] = [];
    const result = await handleRetentionCleanup({
        url: url('?unknown=value'),
        maxRuns: 1,
        authorize: () => true,
        service: {
            createRetentionPlan: () => plan(),
            applyRetentionPlan: () => [],
            pruneRuns: () => {
                calls.push('prune');
                return ['run-old'];
            },
            legacyRetainedRuns: () => {
                calls.push('count');
                return 1;
            }
        },
        tokens: tokenAdapter(),
        persist: () => calls.push('persist')
    });

    assertEquals(calls, ['prune', 'persist', 'count']);
    assertEquals(result, {
        status: 200,
        body: { deletedRunIds: ['run-old'], retainedRuns: 1, maxRuns: 1 }
    });
});

Deno.test('retention planning limits fail closed without changing legacy cleanup', async () => {
    const boundedService = {
        createRetentionPlan: () => {
            throw new ControlRetentionPlanLimitError('candidates', 1_000);
        },
        applyRetentionPlan: () => {
            throw new Error('bounded plans must not apply');
        },
        pruneRuns: () => ['legacy-old'],
        legacyRetainedRuns: () => 1
    };
    const common = {
        maxRuns: 1,
        authorize: () => true,
        service: boundedService,
        tokens: tokenAdapter('v1.abc.safe-token', true),
        persist: () => undefined
    };

    assertEquals(await handleRetentionCleanup({ ...common, url: url('?dryRun=true') }), {
        status: 413,
        body: { error: 'Retention preview exceeds bounded planning limits.' }
    });
    assertEquals(
        await handleRetentionCleanup({ ...common, url: url('?planToken=v1.abc.safe-token') }),
        conflict()
    );
    assertEquals(await handleRetentionCleanup({ ...common, url: url('?unknown=value') }), {
        status: 200,
        body: { deletedRunIds: ['legacy-old'], retainedRuns: 1, maxRuns: 1 }
    });
});

function plan(canonicalConsequence = 'canonical'): ControlRetentionPlan {
    return {
        maxRuns: 1,
        currentRuns: 2,
        projectedRetainedRuns: 1,
        candidates: [{
            runId: 'run-old',
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            connectedAgentCount: 1,
            issuedRunTokenCount: 1,
            distributedRuns: [{ distributedRunId: 'dist-old', state: 'running' }],
            fleetReportIds: ['dist-old']
        }],
        deletedRunIds: ['run-old'],
        distributedRunIds: ['dist-old'],
        fleetReportIds: ['dist-old'],
        canonicalConsequence
    };
}

function tokenAdapter(token = 'v1.abc.safe-token', verified = false) {
    return {
        issue: async () => token,
        verify: async () => verified
    };
}

function conflict() {
    return {
        status: 409,
        body: { error: 'Retention preview is stale, expired, or belongs to another server process.' }
    };
}

function url(query: string): URL {
    return new URL(`http://control.test/retention/cleanup${query}`);
}
