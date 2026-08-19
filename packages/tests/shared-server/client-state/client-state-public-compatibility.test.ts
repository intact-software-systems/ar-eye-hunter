import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import * as sharedServer from '@shared-server/mod.ts';
import * as compatibilityInbox from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import * as compatibilityService from '@shared-server/rallar-system/services/client-state-service.ts';
import { ClientMutationIdempotencyConflictError } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';
import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/client-state-validation-primitives.ts';
import {
  toClientMutationIssuedSessionAuthority,
  toClientMutationSystemAuthority,
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import {
  toClientMutationCommand,
  toConnectCommandInput,
  toDisconnectCommandInput,
  toExpiryCommandInput,
  toHeartbeatCommandInput,
  toUpsertInstanceCommandInput,
  toUpsertPrincipalCommandInput,
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import {
  requiresClientWrite,
  toClientMutationReceipt,
  toClientStateWritten,
} from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import type * as PublicSharedServer from '@shared-server/mod.ts';
import type {
  ClientAuthorisedWsSessionConnectAppInboxPayload,
  ClientAuthorisedWsSessionDisconnectAppInboxPayload,
  ClientExpiredSessionsAppInboxPayload,
  ClientInstanceUpsertAppInboxPayload,
  ClientPrincipalUpsertAppInboxPayload,
  ClientSessionConnectAppInboxPayload,
  ClientSessionDisconnectAppInboxPayload,
  ClientSessionHeartbeatAppInboxPayload,
} from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import type { ClientMutationPersistedFacts } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import type { ClientMutationReceipt } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import type {
  ClientMutationWritten,
  ClientStateService,
  ClientStateServiceDependencies,
  ClientStateWritten,
  RegisterAuthorisedWsClientInput,
} from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';

describe('shared-server client-state public API contract', () => {
  it('keeps every predecessor runtime export as an identical canonical binding', assertPredecessorRuntimeExports);
  it('keeps public, canonical, and compatibility runtime exports identical', assertPublicCanonicalCompatibilityRuntimeIdentity);
  it('does not leak internal client-state construction or handler bindings', assertNoInternalLeaks);
  it('keeps predecessor public types equal to their canonical and compatibility contracts', assertPredecessorPublicTypeIdentity);
});

// @ts-expect-error Public callers must not receive the handler-only mutation capability.
type PublicClientStateMutationService = PublicSharedServer.ClientStateMutationService;
// @ts-expect-error Public callers must not receive the construction-only service factory type.
type PublicClientStateServiceFactory = PublicSharedServer.ClientStateServiceFactory;
// @ts-expect-error Public callers must not receive the timing factory type.
type PublicClientStateServiceTimingFactory = PublicSharedServer.ClientStateServiceTimingFactory;
type PublicClientStateInboxHandlerDependencies =
  // @ts-expect-error Public callers must not receive handler dependency wiring.
  PublicSharedServer.ClientStateInboxHandlerDependencies;
// @ts-expect-error Public callers must not receive handler private after-commit data.
type PublicClientStateInboxAfterCommitResult = PublicSharedServer.ClientStateInboxAfterCommitResult;

function assertPredecessorRuntimeExports(): void {
  expect(sharedServer.ClientMutationIdempotencyConflictError).toBe(ClientMutationIdempotencyConflictError);
  expect(sharedServer.ClientMutationRejectedError).toBe(ClientMutationRejectedError);
  expect(sharedServer.toClientMutationIssuedSessionAuthority).toBe(toClientMutationIssuedSessionAuthority);
  expect(sharedServer.toClientMutationSystemAuthority).toBe(toClientMutationSystemAuthority);
  expect(sharedServer.toClientMutationCommand).toBe(toClientMutationCommand);
  expect(sharedServer.toConnectCommandInput).toBe(toConnectCommandInput);
  expect(sharedServer.toDisconnectCommandInput).toBe(toDisconnectCommandInput);
  expect(sharedServer.toExpiryCommandInput).toBe(toExpiryCommandInput);
  expect(sharedServer.toHeartbeatCommandInput).toBe(toHeartbeatCommandInput);
  expect(sharedServer.toUpsertInstanceCommandInput).toBe(toUpsertInstanceCommandInput);
  expect(sharedServer.toUpsertPrincipalCommandInput).toBe(toUpsertPrincipalCommandInput);
  expect(sharedServer.createClientStateService).toBe(createClientStateService);
  expect(sharedServer.requiresClientWrite).toBe(requiresClientWrite);
  expect(sharedServer.toClientMutationReceipt).toBe(toClientMutationReceipt);
  expect(sharedServer.toClientStateWritten).toBe(toClientStateWritten);
  expect(sharedServer.AppClientInboxService).toBe(AppClientInboxService);
}

function assertPublicCanonicalCompatibilityRuntimeIdentity(): void {
  expect(sharedServer.createClientStateService).toBe(compatibilityService.createClientStateService);
  expect(sharedServer.AppClientInboxService).toBe(compatibilityInbox.AppClientInboxService);
  expect(sharedServer.ClientMutationRejectedError).toBe(compatibilityService.ClientMutationRejectedError);
  expect(sharedServer.ClientMutationIdempotencyConflictError).toBe(compatibilityService.ClientMutationIdempotencyConflictError);
  expect(sharedServer.toClientMutationCommand).toBe(compatibilityService.toClientMutationCommand);
  expect(sharedServer.toClientMutationIssuedSessionAuthority).toBe(compatibilityService.toClientMutationIssuedSessionAuthority);
}

function assertNoInternalLeaks(): void {
  for (const internalExport of ['CLIENT_STATE_INBOX_REGISTRATION_TYPES', 'createTimedClientStateService', 'ClientStateInboxHandler']) {
    expect(Object.hasOwn(sharedServer, internalExport), internalExport).toBe(false);
  }
}

function assertPredecessorPublicTypeIdentity(): void {
  expectTypeOf<PublicSharedServer.ClientMutationPersistedFacts>().toEqualTypeOf<ClientMutationPersistedFacts>();
  expectTypeOf<PublicSharedServer.ClientMutationReceipt>().toEqualTypeOf<ClientMutationReceipt>();
  expectTypeOf<PublicSharedServer.RegisterAuthorisedWsClientInput>().toEqualTypeOf<RegisterAuthorisedWsClientInput>();
  expectTypeOf<PublicSharedServer.ClientMutationWritten>().toEqualTypeOf<ClientMutationWritten>();
  expectTypeOf<PublicSharedServer.ClientStateWritten>().toEqualTypeOf<ClientStateWritten>();
  expectTypeOf<PublicSharedServer.ClientStateService>().toEqualTypeOf<ClientStateService>();
  expectTypeOf<PublicSharedServer.ClientStateServiceDependencies>().toEqualTypeOf<ClientStateServiceDependencies>();
  expectTypeOf<PublicSharedServer.ClientPrincipalUpsertAppInboxPayload>().toEqualTypeOf<ClientPrincipalUpsertAppInboxPayload>();
  expectTypeOf<PublicSharedServer.ClientInstanceUpsertAppInboxPayload>().toEqualTypeOf<ClientInstanceUpsertAppInboxPayload>();
  expectTypeOf<PublicSharedServer.ClientSessionConnectAppInboxPayload>().toEqualTypeOf<ClientSessionConnectAppInboxPayload>();
  expectTypeOf<PublicSharedServer.ClientSessionHeartbeatAppInboxPayload>().toEqualTypeOf<ClientSessionHeartbeatAppInboxPayload>();
  expectTypeOf<PublicSharedServer.ClientSessionDisconnectAppInboxPayload>().toEqualTypeOf<ClientSessionDisconnectAppInboxPayload>();
  // prettier-ignore
  expectTypeOf<PublicSharedServer.ClientAuthorisedWsSessionConnectAppInboxPayload>()
    .toEqualTypeOf<ClientAuthorisedWsSessionConnectAppInboxPayload>();
  // prettier-ignore
  expectTypeOf<PublicSharedServer.ClientAuthorisedWsSessionDisconnectAppInboxPayload>()
    .toEqualTypeOf<ClientAuthorisedWsSessionDisconnectAppInboxPayload>();
  expectTypeOf<PublicSharedServer.ClientExpiredSessionsAppInboxPayload>().toEqualTypeOf<ClientExpiredSessionsAppInboxPayload>();
}
