import { test } from 'bun:test';
import assert from 'node:assert/strict';

import defaultsSource from '../../resources/configuration/defaults-config.json' with { type: 'json' };

import type { ApiV1Configuration } from '../../src/configuration/api-v1-configuration.ts';
import { computeApiReplicaLimitShare } from '../../src/configuration/compute-api-replica-limit-share.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { readApiV1ConfigurationEnvironment } from '../../src/configuration/read-api-v1-configuration-environment.ts';
import { validDecodeApiV1ConfigurationInput } from './api-v1-configuration-test-fixture.ts';

const HOST_LOGICAL_CORES = 8;

function decodeWithEnvironment(values: Record<string, string>): ApiV1Configuration {
    const environment = readApiV1ConfigurationEnvironment(values);
    return decodeApiV1Configuration({
        ...validDecodeApiV1ConfigurationInput(),
        defaultsSource,
        hardwareConcurrency: HOST_LOGICAL_CORES,
        environmentSource: { ...environment.environmentSource, group: { roomOwnedAppDataBindings: [] } }
    });
}

/** Every limit one process enforces on its own, which a fleet of replicas behind one balancer multiplies. */
function readProcessLocalLimits(configuration: ApiV1Configuration): Readonly<Record<string, number>> {
    const { authentication, stateApi, group, ice, friends, parties, matchmaking, tournaments } = configuration;
    return {
        loginIp: authentication.rateLimits.loginIp,
        loginUsername: authentication.rateLimits.loginUsername,
        registrationIp: authentication.rateLimits.registrationIp,
        registrationUsername: authentication.rateLimits.registrationUsername,
        webSocketTicket: authentication.rateLimits.webSocketTicket,
        passwordDerivations: authentication.maxConcurrentPasswordDerivations,
        stateRequest: stateApi.rateLimits.request,
        stateEventList: stateApi.rateLimits.eventList,
        joinPrincipal: group.admission.joinPrincipal,
        joinGroup: group.admission.joinGroup,
        presencePrincipal: group.admission.presencePrincipal,
        presenceGroup: group.admission.presenceGroup,
        iceRequests: ice.rateLimit.requests,
        friendsRequests: friends.rateLimit.requests,
        partiesRequests: parties.rateLimit.requests,
        matchmakingRequests: matchmaking.rateLimit.requests,
        tournamentsRequests: tournaments.rateLimit.requests
    };
}

test('a replica enforces its share of a fleet limit, rounded up and never below one', () => {
    assert.equal(computeApiReplicaLimitShare(100, 3), 34);
    assert.equal(computeApiReplicaLimitShare(6, 3), 2);
    assert.equal(computeApiReplicaLimitShare(2, 3), 1);
    assert.equal(computeApiReplicaLimitShare(1, 3), 1);
    assert.equal(computeApiReplicaLimitShare(5, 1), 5);
});

test('a single process enforces every configured limit whole when no replica count is named', () => {
    const configuration = decodeWithEnvironment({});

    assert.equal(configuration.http.replicaCount, 1);
    assert.equal(configuration.authentication.maxConcurrentPasswordDerivations, HOST_LOGICAL_CORES - 1);
    assert.equal(configuration.authentication.rateLimits.loginIp, defaultsSource.authentication.rateLimits.loginIp);
});

test('RALLAR_API_REPLICA_COUNT gives each replica its share of every process-local limit and leaves windows whole', () => {
    const fleet = decodeWithEnvironment({});
    const replica = decodeWithEnvironment({ RALLAR_API_REPLICA_COUNT: '3' });

    assert.equal(replica.http.replicaCount, 3);
    const fleetLimits = readProcessLocalLimits(fleet);
    const replicaLimits = readProcessLocalLimits(replica);
    for (const [name, fleetLimit] of Object.entries(fleetLimits)) {
        assert.equal(replicaLimits[name], Math.max(1, Math.ceil(fleetLimit / 3)), name);
    }
    assert.equal(replica.authentication.rateLimits.windowMs, fleet.authentication.rateLimits.windowMs);
    assert.equal(replica.group.admission.windowMs, fleet.group.admission.windowMs);
});
