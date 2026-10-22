import assert from 'node:assert/strict';

import { AuthPasswordDerivationAdmission } from '@shared-server/rallar-system/auth/credentials/auth-password-derivation-admission.ts';
import type { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { ClientRestSnapshotReadSelector } from '@shared-server/rallar-system/client-state/snapshot/client-rest-snapshot-read-selector.ts';
import type { GroupRestSnapshotReadSelector } from '@shared-server/rallar-system/group-state/snapshot/group-rest-snapshot-read-selector.ts';
import type { GroupStateCurrentSnapshotCache } from '@shared-server/rallar-system/group-state/snapshot/group-state-current-snapshot-cache.ts';
import type { RallarMiddlewareRuntime } from '@shared-server/rallar-system/middleware/rallar-middleware-runtime.ts';
import {
    createRallarAlmReceiptDiagnosticsRecorder,
    RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY,
    type RallarAlmReceiptDiagnosticsRecorder
} from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import type { RallarGroupFormationMetricsRecorder } from '@shared-server/rallar-system/observability/formation-metrics.ts';

import type { ApiV1BackgroundTaskLifecycle } from '../../src/composition/api-v1-background-task-lifecycle.ts';
import { requireApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import type { ApiV1RelicServices } from '../../src/composition/create-api-v1-relic-services.ts';
import type { ApiV1TopologyServices } from '../../src/composition/create-api-v1-topology-services.ts';

Deno.test('requireApiV1Runtime preserves every complete API capability identity', () => {
    const runtime = createRuntimeCandidate();
    const additions = createRuntimeAdditions();

    const complete = requireApiV1Runtime({ runtime, ...additions });

    assert.equal(complete.clientStateService, runtime.clientStateService);
    assert.equal(complete.groupStateService, runtime.groupStateService);
    assert.equal(
        complete.rtcTopologyPublicationRepository,
        runtime.rtcTopologyPublicationRepository
    );
    assert.equal(
        complete.rtcTopologyExecutionRepository,
        runtime.rtcTopologyExecutionRepository
    );
    assert.equal(complete.rtcTopologyDelivery, runtime.rtcTopologyDelivery);
    assert.equal(complete.rtcTopologyReplay, runtime.rtcTopologyReplay);
    assert.equal(complete.appAuthInboxService, runtime.appAuthInboxService);
    assert.equal(complete.authSessionRepository, additions.authSessionRepository);
    assert.equal(
        complete.clientRestSnapshotReadSelector,
        additions.clientRestSnapshotReadSelector
    );
    assert.equal(
        complete.groupRestSnapshotReadSelector,
        additions.groupRestSnapshotReadSelector
    );
    assert.equal(complete.groupFormationMetrics, additions.groupFormationMetrics);
    assert.equal(complete.almReceiptDiagnostics, additions.almReceiptDiagnostics);
    assert.equal(complete.groupCurrentSnapshotCache, additions.groupCurrentSnapshotCache);
    assert.equal(complete.backgroundTasks, additions.backgroundTasks);
    assert.equal(complete.topologyServices, additions.topologyServices);
    assert.equal(complete.relicGameMutations, additions.relicGameMutations);
    assert.equal(complete.relicGameInboxService, additions.relicGameInboxService);
});

Deno.test('requireApiV1Runtime rejects every incomplete shared runtime capability', () => {
    const cases: readonly RuntimeFailureCase[] = [
        {
            name: 'cached client state service',
            overrides: { clientStateService: {} as RallarMiddlewareRuntime['clientStateService'] },
            message: /cached client state service/
        },
        {
            name: 'cached group state service',
            overrides: { groupStateService: {} as RallarMiddlewareRuntime['groupStateService'] },
            message: /cached group state service/
        },
        {
            name: 'RTC topology publication repository',
            overrides: { rtcTopologyPublicationRepository: undefined },
            message: /RTC topology publication repository/
        },
        {
            name: 'RTC topology execution repository',
            overrides: { rtcTopologyExecutionRepository: undefined },
            message: /RTC topology execution repository/
        },
        {
            name: 'RTC topology durable delivery',
            overrides: { rtcTopologyDelivery: undefined },
            message: /RTC topology durable delivery/
        },
        {
            name: 'RTC topology durable replay',
            overrides: { rtcTopologyReplay: undefined },
            message: /RTC topology durable replay/
        },
        {
            name: 'auth AppInbox service',
            overrides: { appAuthInboxService: undefined },
            message: /auth AppInbox service/
        }
    ];

    for (const failureCase of cases) {
        assert.throws(
            () =>
                requireApiV1Runtime({
                    runtime: createRuntimeCandidate(failureCase.overrides),
                    ...createRuntimeAdditions()
                }),
            failureCase.message,
            failureCase.name
        );
    }
});

interface RuntimeFailureCase {
    readonly name: string;
    readonly overrides: Partial<RallarMiddlewareRuntime>;
    readonly message: RegExp;
}

interface RuntimeAdditions extends ApiV1RelicServices {
    readonly authSessionRepository: AuthSessionRepository;
    readonly passwordDerivationAdmission: AuthPasswordDerivationAdmission;
    readonly clientRestSnapshotReadSelector: ClientRestSnapshotReadSelector;
    readonly groupRestSnapshotReadSelector: GroupRestSnapshotReadSelector;
    readonly groupFormationMetrics: RallarGroupFormationMetricsRecorder;
    readonly almReceiptDiagnostics: RallarAlmReceiptDiagnosticsRecorder;
    readonly groupCurrentSnapshotCache: GroupStateCurrentSnapshotCache;
    readonly backgroundTasks: ApiV1BackgroundTaskLifecycle;
    readonly topologyServices: ApiV1TopologyServices;
}

function createRuntimeCandidate(
    overrides: Partial<RallarMiddlewareRuntime> = {}
): RallarMiddlewareRuntime {
    return {
        clientStateService: { observeSnapshot: () => Promise.resolve() },
        groupStateService: {
            readCurrentSnapshot: () => Promise.resolve(undefined)
        },
        rtcTopologyPublicationRepository: {},
        rtcTopologyExecutionRepository: {},
        rtcTopologyDelivery: {},
        rtcTopologyReplay: {},
        appAuthInboxService: {},
        ...overrides
    } as RallarMiddlewareRuntime;
}

function createRuntimeAdditions(): RuntimeAdditions {
    return {
        relicGameMutations: {} as ApiV1RelicServices['relicGameMutations'],
        relicGameInboxService: {} as ApiV1RelicServices['relicGameInboxService'],
        authSessionRepository: {} as AuthSessionRepository,
        passwordDerivationAdmission: new AuthPasswordDerivationAdmission({ maxConcurrentDerivations: 1 }),
        clientRestSnapshotReadSelector: {} as ClientRestSnapshotReadSelector,
        groupRestSnapshotReadSelector: {} as GroupRestSnapshotReadSelector,
        groupFormationMetrics: {} as RallarGroupFormationMetricsRecorder,
        almReceiptDiagnostics: createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: Date.now,
            capacity: RALLAR_ALM_RECEIPT_DIAGNOSTICS_CAPACITY
        }),
        groupCurrentSnapshotCache: {} as GroupStateCurrentSnapshotCache,
        backgroundTasks: {} as ApiV1BackgroundTaskLifecycle,
        topologyServices: {} as ApiV1TopologyServices
    };
}
