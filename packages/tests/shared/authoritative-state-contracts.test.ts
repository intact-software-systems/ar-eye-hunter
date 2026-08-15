import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AuditStamp as ClientAuditStamp,
  ClientEvent,
  ClientInstance,
  ClientPrincipal,
  ClientScope,
  ClientSession,
} from '@shared/api/client-types.ts';
import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type {
  AuditStamp as GroupAuditStamp,
  Group,
  GroupEvent,
  GroupMember,
  GroupPresenceSession,
  GroupScope,
  GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import type {
  GroupTopologyConfigPatch,
  GroupTopologyConfigView,
  GroupTopologyManagementView,
  PutGroupTopologyConfigRequest,
  SerializedGraphInfoSnapshot,
  StoredGroupTopologyConfig,
} from '@shared/api/graph-topology-management-types.ts';
import type { OverlayInfo, RegisterResponse } from '@shared/api/api-config.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { MutationActorInput } from '@shared/api/state-types.ts';
import type { ClientMutationReceipt } from '@shared-server/rallar-system/services/client-state-mutations.ts';
import type { AuthMutationResult } from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import type { GroupMutationReceipt } from '@shared-server/rallar-system/services/group-state-mutations.ts';
import type { RtcTopologyPublicationWorkClaim } from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import type { RtcRttAppInboxResult } from '@shared-server/rallar-system/rtc-topology/inbox/rtc-rtt-app-inbox-result.ts';

type EmptyObject = Record<never, never>;
type OptionalKeysOfObject<T> = {
  [K in keyof T]-?: EmptyObject extends Pick<T, K> ? K : never;
}[keyof T];
type OptionalKeys<T> = T extends unknown ? OptionalKeysOfObject<T> : never;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type VariantOptionalFixture =
  | Readonly<{ kind: 'complete'; required: string }>
  | Readonly<{ kind: 'broken'; required: string; variantOnly?: string }>;
type _FixtureOptionalKeysAreDistributive = Assert<
  Equal<OptionalKeys<VariantOptionalFixture>, 'variantOnly'>
>;
type _AuthResultHasNoOptionalVariantFields = Assert<Equal<OptionalKeys<AuthMutationResult>, never>>;
type _RtcResultHasNoOptionalFields = Assert<Equal<OptionalKeys<RtcRttAppInboxResult>, never>>;

/** Every entry names a reviewed semantic absence, never construction convenience. */
type AuthoritativeOptionalKeyAllowlist = Readonly<{
  SerializedGraphInfoSnapshot: 'measured';
}>;

describe('authoritative state contracts', () => {
  it('requires complete authoritative scopes, values, events, results, and receipts', () => {
    expectTypeOf<OptionalKeys<VariantOptionalFixture>>().toEqualTypeOf<'variantOnly'>();
    expectTypeOf<OptionalKeys<ClientScope>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<GroupScope>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<ClientAuditStamp>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<GroupAuditStamp>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<ClientPrincipal>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<ClientInstance>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<ClientSession>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<ClientEvent>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<Group>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<GroupMember>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<GroupPresenceSession>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<GroupEvent>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<ClientMutationReceipt>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<GroupMutationReceipt>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<AuthMutationResult>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<RtcRttAppInboxResult>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<RtcTopologyPublicationWorkClaim>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<GroupStateCausalRevision>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<RallarOverlayTopologySnapshot>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<OverlayInfo>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<RegisterResponse>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<StoredGroupTopologyConfig>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<GroupTopologyConfigView>>().toEqualTypeOf<never>();
    expectTypeOf<OptionalKeys<GroupTopologyManagementView>>().toEqualTypeOf<never>();
  });

  it('keeps only the named authoritative semantic-absence allowlist', () => {
    expectTypeOf<OptionalKeys<SerializedGraphInfoSnapshot>>().toEqualTypeOf<
      AuthoritativeOptionalKeyAllowlist['SerializedGraphInfoSnapshot']
    >();
  });

  it('keeps sparse inputs separate and omission-sensitive', () => {
    expectTypeOf<OptionalKeys<MutationActorInput>>().toEqualTypeOf<
      'actorPrincipalId' | 'actorSessionId' | 'reason' | 'traceId' | 'requestId'
    >();
    expectTypeOf<OptionalKeys<GroupTopologyConfigPatch>>().toEqualTypeOf<
      'topologyKind' | 'degreeLimit' | 'treeMinSize' | 'meshMinSize' | 'meshParamK'
    >();
    expectTypeOf<OptionalKeys<PutGroupTopologyConfigRequest>>().toEqualTypeOf<'requestId'>();

    const actor = {} satisfies MutationActorInput;
    const patch = {} satisfies GroupTopologyConfigPatch;
    const request = { config: {} } satisfies PutGroupTopologyConfigRequest;
    expect({ actor, patch, request }).toEqual({
      actor: {},
      patch: {},
      request: { config: {} },
    });
  });

  it('compares group and presence revisions as one componentwise causal tuple', () => {
    const base = { groupRevision: 2, presenceRevision: 3 };

    expect(compareGroupCausalRevision(base, base)).toBe('equal');
    expect(compareGroupCausalRevision({ groupRevision: 3, presenceRevision: 4 }, base)).toBe(
      'dominates',
    );
    expect(compareGroupCausalRevision({ groupRevision: 1, presenceRevision: 2 }, base)).toBe(
      'dominated',
    );
    expect(compareGroupCausalRevision({ groupRevision: 3, presenceRevision: 2 }, base)).toBe(
      'incomparable',
    );
  });

  it('makes non-terminal member lifecycle variants terminal-stamp free', () => {
    expectTypeOf<Extract<GroupMember, { status: 'invited' }>['joined']>().toEqualTypeOf<null>();
    expectTypeOf<
      Extract<GroupMember, { status: 'active' }>['joined']
    >().toEqualTypeOf<GroupAuditStamp>();
    expectTypeOf<
      Extract<GroupMember, { status: 'banned' }>['joined']
    >().toEqualTypeOf<GroupAuditStamp | null>();
    expectTypeOf<Extract<GroupMember, { status: 'invited' }>['left']>().toEqualTypeOf<null>();
    expectTypeOf<Extract<GroupMember, { status: 'invited' }>['removed']>().toEqualTypeOf<null>();
    expectTypeOf<Extract<GroupMember, { status: 'invited' }>['banned']>().toEqualTypeOf<null>();
    expectTypeOf<Extract<GroupMember, { status: 'active' }>['left']>().toEqualTypeOf<null>();
    expectTypeOf<Extract<GroupMember, { status: 'active' }>['removed']>().toEqualTypeOf<null>();
    expectTypeOf<Extract<GroupMember, { status: 'active' }>['banned']>().toEqualTypeOf<null>();
  });

  it('uses the group causal tuple as required topology source authority', () => {
    expectTypeOf<RallarOverlayTopologySnapshot>()
      .toHaveProperty('sourceGroupStateCausalRevision')
      .toEqualTypeOf<GroupStateCausalRevision>();
    expectTypeOf<OverlayInfo>()
      .toHaveProperty('sourceGroupStateCausalRevision')
      .toEqualTypeOf<GroupStateCausalRevision>();
  });

  it('keeps mutation receipts compact and references effects by identity', () => {
    expectTypeOf<ClientMutationReceipt>().toHaveProperty('requestId');
    expectTypeOf<ClientMutationReceipt>().toHaveProperty('aggregateRef');
    expectTypeOf<ClientMutationReceipt>().toHaveProperty('attemptCount').toEqualTypeOf<number>();
    expectTypeOf<ClientMutationReceipt>()
      .toHaveProperty('acceptedStorageRevision')
      .toEqualTypeOf<number | null>();
    expectTypeOf<ClientMutationReceipt>().toHaveProperty('eventId').toEqualTypeOf<string | null>();
    expectTypeOf<ClientMutationReceipt>()
      .toHaveProperty('outboxIds')
      .toEqualTypeOf<readonly string[]>();
    expectTypeOf<ClientMutationReceipt>().not.toHaveProperty('event');

    expectTypeOf<GroupMutationReceipt>().toHaveProperty('requestId');
    expectTypeOf<GroupMutationReceipt>().toHaveProperty('aggregateRef');
    expectTypeOf<GroupMutationReceipt>().toHaveProperty('attemptCount').toEqualTypeOf<number>();
    expectTypeOf<GroupMutationReceipt>()
      .toHaveProperty('acceptedStorageRevision')
      .toEqualTypeOf<number | null>();
    expectTypeOf<GroupMutationReceipt>().toHaveProperty('eventId').toEqualTypeOf<string | null>();
    expectTypeOf<GroupMutationReceipt>()
      .toHaveProperty('outboxIds')
      .toEqualTypeOf<readonly string[]>();
    expectTypeOf<GroupMutationReceipt>().not.toHaveProperty('event');
    expectTypeOf<RtcTopologyPublicationWorkClaim>()
      .toHaveProperty('acceptedCausalRevision')
      .toEqualTypeOf<GroupStateCausalRevision>();
    expectTypeOf<RtcTopologyPublicationWorkClaim>().toHaveProperty('eventId').toEqualTypeOf<null>();
    expectTypeOf<RtcTopologyPublicationWorkClaim>().not.toHaveProperty('snapshot');
  });
});
