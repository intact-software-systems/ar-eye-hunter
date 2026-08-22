import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import type { GroupRef } from '@shared/api/group-types.ts';
import { toGroupStateErrorResponse } from '../../src/group-state/group-state-route-errors.ts';
import {
    createGroupAdmissionQuota,
    GroupAdmissionRateLimitedError,
    readGroupAdmissionRateLimitDecision,
    toGroupAdmissionRateLimitConfig,
    type GroupAdmissionRateLimitConfig
} from '../../src/services/group-admission-rate-limit.ts';

Deno.test('group admission rate limit config maps every resolved policy field', () => {
    const config = toGroupAdmissionRateLimitConfig(defaultConfiguration());
    assert.equal(config.joinAdmission.principal.maxNumberToAllow, 60);
    assert.equal(config.joinAdmission.group.maxNumberToAllow, 600);
    assert.equal(config.presenceConnect.principal.maxNumberToAllow, 120);
    assert.equal(config.presenceConnect.group.maxNumberToAllow, 1200);
    for (const policy of allPolicies(config)) {
        assert.equal(policy.timebasedFilterMs, 60_000);
    }
});

Deno.test('group admission rate limit config preserves non-default resolved limits', () => {
    const config = toGroupAdmissionRateLimitConfig({
        windowMs: 12_500,
        joinPrincipal: 7,
        joinGroup: 70,
        presencePrincipal: 9,
        presenceGroup: 90
    });
    assert.equal(config.joinAdmission.principal.maxNumberToAllow, 7);
    assert.equal(config.joinAdmission.group.maxNumberToAllow, 70);
    assert.equal(config.presenceConnect.principal.maxNumberToAllow, 9);
    assert.equal(config.presenceConnect.group.maxNumberToAllow, 90);
    for (const policy of allPolicies(config)) {
        assert.equal(policy.timebasedFilterMs, 12_500);
    }
});

Deno.test('join-admission per-principal window exhausts exactly at the 61st request', () => {
    const config = toGroupAdmissionRateLimitConfig(defaultConfiguration());
    const groupRef = uniqueGroupRef('principal-exhaustion');
    for (let attempt = 1; attempt <= 60; attempt++) {
        assert.equal(
            readGroupAdmissionRateLimitDecision({
                family: 'join-admission',
                groupRef,
                principalId: 'storm-probe',
                config
            }),
            'allowed',
            `attempt ${attempt}`
        );
    }
    assert.equal(
        readGroupAdmissionRateLimitDecision({
            family: 'join-admission',
            groupRef,
            principalId: 'storm-probe',
            config
        }),
        'over-limit'
    );
});

Deno.test('per-principal windows are independent per group and per principal', () => {
    const config = toGroupAdmissionRateLimitConfig(defaultConfiguration());
    const stormedGroup = uniqueGroupRef('independence-stormed');
    for (let attempt = 1; attempt <= 60; attempt++) {
        readGroupAdmissionRateLimitDecision({
            family: 'join-admission',
            groupRef: stormedGroup,
            principalId: 'storm-probe',
            config
        });
    }

    assert.equal(
        readGroupAdmissionRateLimitDecision({
            family: 'join-admission',
            groupRef: stormedGroup,
            principalId: 'storm-probe',
            config
        }),
        'over-limit'
    );
    assert.equal(
        readGroupAdmissionRateLimitDecision({
            family: 'join-admission',
            groupRef: uniqueGroupRef('independence-other-group'),
            principalId: 'storm-probe',
            config
        }),
        'allowed',
        'same principal keeps its allowance on another group'
    );
    assert.equal(
        readGroupAdmissionRateLimitDecision({
            family: 'join-admission',
            groupRef: stormedGroup,
            principalId: 'calm-founder',
            config
        }),
        'allowed',
        'another principal keeps its allowance on the stormed group'
    );
});

Deno.test('the per-group window sheds every principal once the group budget is spent', () => {
    const config = toTinyConfig({ joinPrincipal: 100, joinGroup: 2 });
    const groupRef = uniqueGroupRef('group-budget');
    assert.equal(decideJoin(groupRef, 'first-principal', config), 'allowed');
    assert.equal(decideJoin(groupRef, 'second-principal', config), 'allowed');
    assert.equal(decideJoin(groupRef, 'third-principal', config), 'over-limit');
});

Deno.test('join-admission and presence-connect windows are separate families', () => {
    const config = toTinyConfig({ joinPrincipal: 1, joinGroup: 100 });
    const groupRef = uniqueGroupRef('family-separation');
    assert.equal(decideJoin(groupRef, 'probe', config), 'allowed');
    assert.equal(decideJoin(groupRef, 'probe', config), 'over-limit');
    assert.equal(
        readGroupAdmissionRateLimitDecision({
            family: 'presence-connect',
            groupRef,
            principalId: 'probe',
            config
        }),
        'allowed',
        'exhausting join-admission leaves presence-connect untouched'
    );
});

Deno.test('over-limit requests do not consume the remaining group budget', () => {
    const config = toTinyConfig({ joinPrincipal: 1, joinGroup: 2 });
    const groupRef = uniqueGroupRef('no-denied-consumption');
    assert.equal(decideJoin(groupRef, 'probe', config), 'allowed');
    assert.equal(decideJoin(groupRef, 'probe', config), 'over-limit');
    assert.equal(
        decideJoin(groupRef, 'founder', config),
        'allowed',
        'the denied probe request left the group budget intact'
    );
});

Deno.test('the route guard answers over-limit with 429, Retry-After: 60, and a coded body', async () => {
    const groupRef = uniqueGroupRef('route-shape');
    const quota = createGroupAdmissionQuota({
        ...defaultConfiguration(),
        joinPrincipal: 2
    });
    const app = new Hono();
    app.post('/api/state/join-guarded', (context) => {
        try {
            quota.require({
                family: 'join-admission',
                groupRef,
                principalId: 'route-probe'
            });
            return context.json({ ok: true });
        }
        catch (error) {
            return toGroupStateErrorResponse(context, error);
        }
    });

    let overLimit: Response | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const response = await app.request('/api/state/join-guarded', { method: 'POST' });
        if (attempt <= 2) {
            assert.equal(response.status, 200, `attempt ${attempt}`);
            continue;
        }
        overLimit = response;
    }

    assert.equal(overLimit?.status, 429);
    assert.equal(overLimit?.headers.get('retry-after'), '60');
    assert.deepEqual(await overLimit?.json(), {
        error: 'Too many group join-admission requests',
        code: 'group-admission-rate-limited'
    });
});

Deno.test('the typed rate-limited error carries the 429 contract values', () => {
    const error = new GroupAdmissionRateLimitedError('presence-connect', 13);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'group-admission-rate-limited');
    assert.equal(error.retryAfterSeconds, 13);
    assert.equal(error.message, 'Too many group presence-connect requests');
});

function decideJoin(
    groupRef: GroupRef,
    principalId: string,
    config: GroupAdmissionRateLimitConfig
) {
    return readGroupAdmissionRateLimitDecision({
        family: 'join-admission',
        groupRef,
        principalId,
        config
    });
}

function toTinyConfig(
    limits: Readonly<{ joinPrincipal: number; joinGroup: number; }>
): GroupAdmissionRateLimitConfig {
    return toGroupAdmissionRateLimitConfig({
        ...defaultConfiguration(),
        joinPrincipal: limits.joinPrincipal,
        joinGroup: limits.joinGroup
    });
}

function uniqueGroupRef(label: string): GroupRef {
    return {
        applicationId: `admission-app-${label}`,
        workspaceId: 'workspace-1',
        groupId: `group-${label}-${crypto.randomUUID()}`
    };
}

function allPolicies(config: GroupAdmissionRateLimitConfig) {
    return [
        config.joinAdmission.principal,
        config.joinAdmission.group,
        config.presenceConnect.principal,
        config.presenceConnect.group
    ];
}

function defaultConfiguration() {
    return {
        windowMs: 60_000,
        joinPrincipal: 60,
        joinGroup: 600,
        presencePrincipal: 120,
        presenceGroup: 1_200
    } as const;
}
