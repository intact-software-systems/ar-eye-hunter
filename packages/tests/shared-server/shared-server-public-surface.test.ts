import { describe, expect, expectTypeOf, it } from 'vitest';

import * as sharedServer from '@shared-server/mod.ts';
import type {
    AppDataRepository,
    ClientStateService,
    GroupStateService,
    RallarServerAi,
    RallarServerRuntime,
    RallarServerWsRouterOptions
} from '@shared-server/mod.ts';

const expectedRuntimeExports = [
    'AppDataCorruptionError',
    'ClientMutationRejectedError',
    'DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS',
    'DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS',
    'GroupMutationIdempotencyConflictError',
    'GroupTopologyConfigRepository',
    'PSqlAppDataRepository',
    'RALLAR_CRDT_SERVER_DEFAULT_MAX_SYNC_BYTES',
    'RALLAR_CRDT_SERVER_DEFAULT_MAX_UPDATE_BYTES',
    'RallarRtcTopologyService',
    'RallarServerAppData',
    'RallarServerAppDataConflictError',
    'RallarServerAppDataStore',
    'RallarServerApplication',
    'RallarServerWsRouter',
    'RuntimeStateRetryExhaustedError',
    'RuntimeStateWriteConflictError',
    'authenticateAuthUser',
    'createAuthMutationService',
    'createClientStateService',
    'createGroupStateRuntime',
    'createGroupStateService',
    'createGroupTopologyRuntimeOwners',
    'createHmacAuthCredentialIssuer',
    'createRallarAiOllamaProvider',
    'createRallarMiddleware',
    'createRallarServerAi',
    'createRallarServerAiResultPersistence',
    'createRallarServerAiResultPublisher',
    'createRallarServerApplication',
    'createRallarServerValidatedMatchResult',
    'decodeAuthMutationResult',
    'defineAppDataStore',
    'hashAuthSecret',
    'installRallarCrdtWsTopics',
    'installRallarGameAuthorityServer',
    'installRallarServerAiHttpRoute',
    'installRallarServerAiWebSocketTopic',
    'isValidAuthCredentialSecret',
    'materializeAuthUserRegistration',
    'planRallarRtcTopologySnapshot',
    'prepareAuthUserRegistration',
    'prepareAuthUserRegistrationVerifier',
    'readRallarServerWsStatus',
    'requireConditionalWrite',
    'validateRallarCrdtServerLiveEnvelope',
    'verifyAuthUserPassword',
    'waitForRuntimeStateWriteRetry'
] as const;

describe('shared-server package surface', () => {
    it('publishes only intentional application, feature-entry, and shared-test owners', () => {
        expect(Object.keys(sharedServer).toSorted()).toEqual([...expectedRuntimeExports].toSorted());
    });

    it('publishes the contracts required to construct the current server runtime', () => {
        expectTypeOf<AppDataRepository>().toBeObject();
        expectTypeOf<ClientStateService>().toBeObject();
        expectTypeOf<GroupStateService>().toBeObject();
        expectTypeOf<RallarServerAi>().toBeObject();
        expectTypeOf<RallarServerRuntime>().toBeObject();
        expectTypeOf<RallarServerWsRouterOptions>().toBeObject();
    });
});
