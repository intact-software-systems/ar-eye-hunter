import { ControlRetentionPlanLimitError, type ControlRetentionPlan } from '@shared-test/rallar-bb-test/control-retention.ts';
import { assert } from '@std/assert';

import { applyRetentionCleanup } from '../src/retention-cleanup.ts';
import type { RetentionPlanTokenAdapter } from '../src/retention-plan-token.ts';
import { assertJsonEquals } from './support/control-service-test-fixtures.ts';

Deno.test('retention cleanup authorizes before validating queries or reading plans', async () => {
    let serviceCalls = 0;
    const result = await applyRetentionCleanup({
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
            applyRunRetention: () => {
                serviceCalls += 1;
                return [];
            },
            readRetainedRunCount: () => {
                serviceCalls += 1;
                return 0;
            }
        },
        tokens: tokenAdapter(),
        persist: () => {
            serviceCalls += 1;
        }
    });

    assertJsonEquals(result, {
        status: 401,
        body: { error: 'Admin token is required or invalid.' }
    });
    assertJsonEquals(serviceCalls, 0);
});

Deno.test('retention preview whitelists safe consequence fields and never mutates', async () => {
    let applyCalls = 0;
    let persistCalls = 0;
    const result = await applyRetentionCleanup({
        url: url('?dryRun=true'),
        maxRuns: 1,
        authorize: () => true,
        service: {
            createRetentionPlan: () => plan('canonical-secret-sentinel'),
            applyRetentionPlan: () => {
                applyCalls += 1;
                return [];
            },
            applyRunRetention: () => [],
            readRetainedRunCount: () => 2
        },
        tokens: tokenAdapter('v1.abc.safe-token'),
        persist: () => {
            persistCalls += 1;
        }
    });

    assertJsonEquals(result.status, 200);
    assertJsonEquals(result.body, {
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
    assertJsonEquals(applyCalls, 0);
    assertJsonEquals(persistCalls, 0);
});

Deno.test('retention confirmation rejects crypto-race drift without deletion', async () => {
    let current = plan('before-verify');
    let applyCalls = 0;
    let persistCalls = 0;
    const result = await applyRetentionCleanup({
        url: url('?planToken=v1.abc.safe-token'),
        maxRuns: 1,
        authorize: () => true,
        service: {
            createRetentionPlan: () => current,
            applyRetentionPlan: () => {
                applyCalls += 1;
                return [];
            },
            applyRunRetention: () => [],
            readRetainedRunCount: () => 2
        },
        tokens: {
            issue: () => Promise.resolve('v1.abc.safe-token'),
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

    assertJsonEquals(result, conflict());
    assertJsonEquals(applyCalls, 0);
    assertJsonEquals(persistCalls, 0);
});

Deno.test('retention confirmation replans compares and applies without an await gap', async () => {
    let planCalls = 0;
    let microtaskRan = false;
    let persistCalls = 0;
    const stable = plan('stable');
    const result = await applyRetentionCleanup({
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
                assertJsonEquals(microtaskRan, false);
                assertJsonEquals(applied, stable);
                return ['run-old'];
            },
            applyRunRetention: () => [],
            readRetainedRunCount: () => 2
        },
        tokens: tokenAdapter('v1.abc.safe-token', true),
        persist: () => {
            persistCalls += 1;
        }
    });

    assertJsonEquals(result, {
        status: 200,
        body: { deletedRunIds: ['run-old'], retainedRuns: 1, maxRuns: 1 }
    });
    assertJsonEquals(planCalls, 2);
    assertJsonEquals(persistCalls, 1);
    await Promise.resolve();
    assertJsonEquals(microtaskRan, true);
});

Deno.test('retention immediate mode preserves exact cleanup shape and sequence', async () => {
    const calls: string[] = [];
    const result = await applyRetentionCleanup({
        url: url('?unknown=value'),
        maxRuns: 1,
        authorize: () => true,
        service: {
            createRetentionPlan: () => plan(),
            applyRetentionPlan: () => [],
            applyRunRetention: () => {
                calls.push('prune');
                return ['run-old'];
            },
            readRetainedRunCount: () => {
                calls.push('count');
                return 1;
            }
        },
        tokens: tokenAdapter(),
        persist: () => calls.push('persist')
    });

    assertJsonEquals(calls, ['prune', 'persist', 'count']);
    assertJsonEquals(result, {
        status: 200,
        body: { deletedRunIds: ['run-old'], retainedRuns: 1, maxRuns: 1 }
    });
});

Deno.test('retention planning limits fail closed without changing immediate cleanup', async () => {
    const boundedService = {
        createRetentionPlan: () => {
            throw new ControlRetentionPlanLimitError('candidates', 1_000);
        },
        applyRetentionPlan: () => {
            throw new Error('bounded plans must not apply');
        },
        applyRunRetention: () => ['immediate-old'],
        readRetainedRunCount: () => 1
    };
    const common = {
        maxRuns: 1,
        authorize: () => true,
        service: boundedService,
        tokens: tokenAdapter('v1.abc.safe-token', true),
        persist: () => undefined
    };

    assertJsonEquals(await applyRetentionCleanup({ ...common, url: url('?dryRun=true') }), {
        status: 413,
        body: { error: 'Retention preview exceeds bounded planning limits.' }
    });
    assertJsonEquals(
        await applyRetentionCleanup({ ...common, url: url('?planToken=v1.abc.safe-token') }),
        conflict()
    );
    assertJsonEquals(await applyRetentionCleanup({ ...common, url: url('?unknown=value') }), {
        status: 200,
        body: { deletedRunIds: ['immediate-old'], retainedRuns: 1, maxRuns: 1 }
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

function tokenAdapter(token = 'v1.abc.safe-token', verified = false): RetentionPlanTokenAdapter {
    return {
        issue: () => Promise.resolve(token),
        verify: () => Promise.resolve(verified)
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
