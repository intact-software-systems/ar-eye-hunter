import type {
  Group,
  GroupMember,
  GroupPresenceSession,
  GroupSnapshot,
} from '@shared/api/group-types.ts';
import type {
  GroupPolicyDenied,
  GroupPolicyReasonCode,
  GroupPolicyResult,
} from '@shared/api/group-policy-types.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import {
  resolveGroupLifecycleManagers,
  toGroupLifecycleElectionKey,
} from '@shared/api/group-lifecycle/resolve-group-lifecycle-managers.ts';
import type { GroupLifecycleTransition } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';
import { computeGroupLifecycleTransition } from '@shared/api/group-lifecycle/group-lifecycle-transitions.ts';

export type GroupPolicyActor = Readonly<{
  principalId?: string;
  sessionId?: string;
  serviceId?: string;
}>;

/**
 * Operational capacity defaults threaded from runtime configuration. The
 * config is absent when the runtime supplies no operational defaults;
 * `defaultMaxMembers: null` states explicitly that the default cap is
 * disabled. A stored `group.maxMembers` always wins over the default.
 */
export type GroupPolicyCapacityConfig = Readonly<{
  defaultMaxMembers: number | null;
}>;

export type CanJoinGroupInput = Readonly<{
  snapshot: GroupSnapshot;
  actor: GroupPolicyActor;
  nowEpochMs?: number;
  capacity?: GroupPolicyCapacityConfig;
  inviteToken?: string;
  expectedInviteToken?: string;
  joinCode?: string;
  expectedJoinCode?: string;
  joinCodeVerifier?: string;
  expectedJoinCodeVerifier?: string;
  joinCodeExpiresAtEpochMs?: number;
}>;

export type CanConnectGroupPresenceSessionInput = Readonly<{
  snapshot: GroupSnapshot;
  actor: GroupPolicyActor;
  sessionId: string;
  nowEpochMs?: number;
}>;

export type CanActivateGroupMemberInput = Readonly<{
  snapshot: GroupSnapshot;
  targetPrincipalId: string;
  nowEpochMs?: number;
  capacity?: GroupPolicyCapacityConfig;
}>;

export type CanMutateActiveGroupInput = Readonly<{
  group: Group;
  nowEpochMs?: number;
}>;

export type ShouldPlanGroupPurgeInput = Readonly<{
  group: Group;
  nowEpochMs: number;
}>;

export type CanReadGroupSnapshotInput = Readonly<{
  snapshot: GroupSnapshot;
  actor: GroupPolicyActor;
  nowEpochMs?: number;
}>;

export type CanUpdateGroupSnapshotInput = Readonly<{
  snapshot: GroupSnapshot;
  actor: GroupPolicyActor;
  nowEpochMs?: number;
}>;

export type GroupReadVisibility = 'full' | 'invite' | 'directory' | 'none';

export type CanChangeGroupLifecycleInput = Readonly<{
  snapshot: GroupSnapshot;
  actor: GroupPolicyActor;
  targetStatus: Group['status'];
}>;

export type CanCommandGroupLifecycleTransitionInput = Readonly<{
  snapshot: GroupSnapshot;
  actor: GroupPolicyActor;
  policy: GroupLifecyclePolicy;
  transition: GroupLifecycleTransition;
  /**
   * The full active roster at decision time. The policy snapshot on the
   * mutation path carries only the involved members, and manager
   * resolution's liveness filter needs every candidate, not just them.
   */
  activeMemberPrincipalIds: readonly string[];
}>;

export type GroupGovernanceAction =
  'invite' | 'remove' | 'ban' | 'unban' | 'promote' | 'demote' | 'transfer-ownership';

export type CanGovernGroupMemberInput = Readonly<{
  snapshot: GroupSnapshot;
  actor: GroupPolicyActor;
  targetPrincipalId: string;
  action: GroupGovernanceAction;
}>;

export type CanSendRoomMessageInput = Readonly<{
  snapshot: GroupSnapshot;
  actor: GroupPolicyActor;
  senderSessionId: string;
  minSnapshotVersion?: number;
  nowEpochMs?: number;
}>;

const ALLOWED: GroupPolicyResult = { allowed: true };

export class GroupPolicyDeniedError extends Error {
  public override readonly name = 'GroupPolicyDeniedError';
  public readonly status = 403;

  public readonly denial: GroupPolicyDenied;

  public constructor(denial: GroupPolicyDenied) {
    super(`Forbidden: ${denial.message}`);
    this.denial = denial;
  }
}

export function isGroupPolicyDeniedError(error: unknown): error is GroupPolicyDeniedError {
  return error instanceof GroupPolicyDeniedError;
}

export function canJoinGroup(input: CanJoinGroupInput): GroupPolicyResult {
  const lifecycleDenial = requireActiveGroup(input.snapshot.group, input.nowEpochMs);
  if (lifecycleDenial) {
    return lifecycleDenial;
  }

  const principalId = input.actor.principalId;
  if (!principalId) {
    return deny('group-policy-denied', 'A principal is required to join a group.');
  }

  const member = findMember(input.snapshot, principalId);
  const memberDenial = denyForBlockedMember(member);
  if (memberDenial) {
    return memberDenial;
  }

  if (wouldExceedMemberCap(input.snapshot, member, input.capacity)) {
    return deny('group-full', 'Group member capacity has been reached.');
  }

  switch (input.snapshot.group.joinMode) {
    case 'open':
      return ALLOWED;
    case 'invite-only':
      return canUseInvite(input, member);
    case 'code':
      return canUseJoinCode(input);
  }
}

export function canConnectGroupPresenceSession(
  input: CanConnectGroupPresenceSessionInput,
): GroupPolicyResult {
  const lifecycleDenial = requireActiveGroup(input.snapshot.group, input.nowEpochMs);
  if (lifecycleDenial) {
    return lifecycleDenial;
  }

  const principalId = input.actor.principalId;
  if (!principalId) {
    return deny('member-not-active', 'An active group member is required for presence.');
  }

  const member = findMember(input.snapshot, principalId);
  const memberDenial = denyForPresenceMember(member);
  if (memberDenial) {
    return memberDenial;
  }

  const cap = input.snapshot.group.maxSessionsPerMember;
  if (cap !== null) {
    const liveSessions = input.snapshot.activeSessions.filter(
      (session) => session.principalId === principalId && isLiveSession(session, input.nowEpochMs),
    );
    const alreadyConnected = liveSessions.some((session) => session.sessionId === input.sessionId);
    if (!alreadyConnected && liveSessions.length >= cap) {
      return deny(
        'member-session-limit-reached',
        'Group member session capacity has been reached.',
      );
    }
  }

  return ALLOWED;
}

export function canActivateGroupMember(input: CanActivateGroupMemberInput): GroupPolicyResult {
  const lifecycleDenial = requireActiveGroup(input.snapshot.group, input.nowEpochMs);
  if (lifecycleDenial) {
    return lifecycleDenial;
  }

  const member = findMember(input.snapshot, input.targetPrincipalId);
  if (wouldExceedMemberCap(input.snapshot, member, input.capacity)) {
    return deny('group-full', 'Group member capacity has been reached.');
  }

  return ALLOWED;
}

export function canMutateActiveGroup(input: CanMutateActiveGroupInput): GroupPolicyResult {
  return requireActiveGroup(input.group, input.nowEpochMs) ?? ALLOWED;
}

export function shouldPlanGroupPurge(input: ShouldPlanGroupPurgeInput): boolean {
  return (
    input.group.purgeAfterEpochMs !== null && input.group.purgeAfterEpochMs <= input.nowEpochMs
  );
}

export function canReadGroupSnapshot(input: CanReadGroupSnapshotInput): GroupPolicyResult {
  if (input.snapshot.group.status === 'deleted') {
    return deny('group-deleted', 'Deleted groups are not readable.');
  }

  const principalId = input.actor.principalId;
  if (!principalId) {
    return deny('group-policy-denied', 'A principal is required to read group state.');
  }

  const member = findMember(input.snapshot, principalId);
  const blockedDenial = denyForBlockedMember(member);
  if (blockedDenial) {
    return blockedDenial;
  }

  const visibility = readGroupVisibility(input);
  if (visibility === 'full') {
    return ALLOWED;
  }

  return deny('group-policy-denied', 'Only active group members can read full group state.', {
    visibility,
  });
}

export function canUpdateGroupSnapshot(input: CanUpdateGroupSnapshotInput): GroupPolicyResult {
  const lifecycleDenial = requireActiveGroup(input.snapshot.group, input.nowEpochMs);
  if (lifecycleDenial) {
    return lifecycleDenial;
  }

  const actorMember = findActorMember(input.snapshot, input.actor);
  if (!actorMember) {
    return deny('member-not-active', 'An active group member is required for this operation.');
  }

  const memberDenial = denyForPresenceMember(actorMember);
  if (memberDenial) {
    return memberDenial;
  }

  if (actorMember.role !== 'owner' && actorMember.role !== 'admin') {
    return deny('forbidden-role', 'Only active group owners/admins can update groups.');
  }

  return ALLOWED;
}

export function readGroupVisibility(input: CanReadGroupSnapshotInput): GroupReadVisibility {
  if (input.snapshot.group.status === 'deleted') {
    return 'none';
  }

  const principalId = input.actor.principalId;
  if (!principalId) {
    return readDirectoryVisibility(input.snapshot);
  }

  const member = findMember(input.snapshot, principalId);
  switch (member?.status) {
    case 'active':
      return 'full';
    case 'invited':
      return isInviteExpired(member, input.nowEpochMs)
        ? readDirectoryVisibility(input.snapshot)
        : 'invite';
    case 'pending':
      return 'invite';
    case 'left':
    case undefined:
      return readDirectoryVisibility(input.snapshot);
    case 'removed':
    case 'banned':
      return 'none';
  }
}

export function canChangeGroupLifecycle(input: CanChangeGroupLifecycleInput): GroupPolicyResult {
  const actorMember = findActorMember(input.snapshot, input.actor);
  if (!isActiveOwnerOrAdmin(actorMember)) {
    return deny('forbidden-role', 'Only active group owners/admins can change group lifecycle.');
  }

  return ALLOWED;
}

/**
 * Who may command a formation-intent transition, per the lifecycle policy.
 * Distinct from `canChangeGroupLifecycle`, which guards the business `status`
 * (archive/delete). Whether the transition is valid from the current state is
 * part of the same decision, so this predicate answers both.
 */
export function canCommandGroupLifecycleTransition(
  input: CanCommandGroupLifecycleTransitionInput,
): GroupPolicyResult {
  const actorMember = findActorMember(input.snapshot, input.actor);
  const blocked = denyForPresenceMember(actorMember);
  if (blocked) {
    return blocked;
  }
  const authority = denyForLifecycleInitiator(input);
  if (authority) {
    return authority;
  }
  const transition = computeGroupLifecycleTransition({
    transition: input.transition,
    lifecycleState: input.snapshot.group.lifecycleState,
    formationEpoch: input.snapshot.group.formationEpoch,
  });
  return transition.allowed ? ALLOWED : transition;
}

function denyForLifecycleInitiator(
  input: CanCommandGroupLifecycleTransitionInput,
): GroupPolicyDenied | undefined {
  switch (input.policy.establishment.initiator) {
    case 'any-member':
      return undefined;
    case 'server-auto':
      return deny(
        'forbidden-role',
        'Lifecycle transitions are server-initiated under this policy.',
      );
    case 'manager':
      return denyForNonManager(input);
  }
}

function denyForNonManager(
  input: CanCommandGroupLifecycleTransitionInput,
): GroupPolicyDenied | undefined {
  return denyForNonManagerPrincipal(
    input,
    'Only the group manager can command lifecycle transitions.',
  );
}

interface ManagerResolutionPolicyInput {
  readonly snapshot: GroupSnapshot;
  readonly actor: GroupPolicyActor;
  readonly policy: GroupLifecyclePolicy;
  readonly activeMemberPrincipalIds: readonly string[];
}

function denyForNonManagerPrincipal(
  input: ManagerResolutionPolicyInput,
  message: string,
): GroupPolicyDenied | undefined {
  const managers = resolveGroupLifecycleManagers({
    manager: input.policy.manager,
    ownerPrincipalId: input.snapshot.group.ownerPrincipalId,
    formationElectorate: input.snapshot.group.formationElectorate,
    formationEpoch: input.snapshot.group.formationEpoch,
    groupKey: toGroupLifecycleElectionKey(input.snapshot.group),
    activePrincipalIds: new Set(input.activeMemberPrincipalIds),
    // No rank source exists in v1 (plan decision 4.2).
    rankByPrincipalId: null,
  });
  if (managers.length === 0) {
    // The zero-manager fallback: only manager-assigned actions block.
    return deny('lifecycle-manager-unavailable', 'No group manager resolves under this policy.');
  }
  const principalId = input.actor.principalId;
  return principalId !== undefined && managers.includes(principalId)
    ? undefined
    : deny('forbidden-role', message);
}

export type CanDecideGroupAdmissionInput = Readonly<{
  snapshot: GroupSnapshot;
  actor: GroupPolicyActor;
  policy: GroupLifecyclePolicy;
  /** The full active roster at decision time; see the transition input note. */
  activeMemberPrincipalIds: readonly string[];
  nowEpochMs?: number;
}>;

/**
 * Who may grant or decline a pending admission: the lifecycle managers, and
 * only them (plan decision 5.3). Governance is not widened — an owner in a
 * zero-manager group recovers through its own consent channel, the invite.
 */
export function canDecideGroupAdmission(input: CanDecideGroupAdmissionInput): GroupPolicyResult {
  const lifecycleDenial = requireActiveGroup(input.snapshot.group, input.nowEpochMs);
  if (lifecycleDenial) {
    return lifecycleDenial;
  }
  const actorMember = findActorMember(input.snapshot, input.actor);
  const blocked = denyForPresenceMember(actorMember);
  if (blocked) {
    return blocked;
  }
  const denial = denyForNonManagerPrincipal(input, 'Only a group manager can decide admissions.');
  return denial ?? ALLOWED;
}

export function canGovernGroupMember(input: CanGovernGroupMemberInput): GroupPolicyResult {
  const actorMember = findActorMember(input.snapshot, input.actor);
  if (!isActiveOwnerOrAdmin(actorMember)) {
    return deny('forbidden-role', 'Only active group owners/admins can govern group members.');
  }

  if (input.action === 'transfer-ownership' && actorMember.role !== 'owner') {
    return deny('forbidden-role', 'Only active group owners can transfer group ownership.');
  }

  const targetMember = findMember(input.snapshot, input.targetPrincipalId);
  if (
    actorMember.role === 'admin' &&
    targetMember &&
    (targetMember.role === 'owner' || targetMember.role === 'admin')
  ) {
    return deny('forbidden-role', 'Group admins can only govern regular members.');
  }

  if (
    targetMember &&
    isLastActiveOwner(input.snapshot, targetMember) &&
    removesOwner(input.action)
  ) {
    return deny('last-owner', 'Cannot leave an active group without an owner.');
  }

  return ALLOWED;
}

export function canSendRoomMessage(input: CanSendRoomMessageInput): GroupPolicyResult {
  if (
    input.minSnapshotVersion !== undefined &&
    input.snapshot.group.snapshotVersion < input.minSnapshotVersion
  ) {
    return deny('group-policy-denied', 'Group snapshot is not fresh enough.');
  }

  const lifecycleDenial = requireActiveGroup(input.snapshot.group, input.nowEpochMs);
  if (lifecycleDenial) {
    return lifecycleDenial;
  }

  const liveSession = input.snapshot.activeSessions.find(
    (session) =>
      session.sessionId === input.senderSessionId && isLiveSession(session, input.nowEpochMs),
  );
  const principalId = input.actor.principalId ?? liveSession?.principalId;
  if (!liveSession || !principalId || liveSession.principalId !== principalId) {
    return deny(
      'member-not-active',
      'A live active group session is required to send room messages.',
    );
  }

  const member = findMember(input.snapshot, principalId);
  const memberDenial = denyForPresenceMember(member);
  if (memberDenial) {
    return memberDenial;
  }

  return ALLOWED;
}

function canUseInvite(
  input: CanJoinGroupInput,
  member: GroupMember | undefined,
): GroupPolicyResult {
  if (member?.status === 'active') {
    return ALLOWED;
  }

  if (
    input.inviteToken &&
    input.expectedInviteToken !== undefined &&
    input.inviteToken === input.expectedInviteToken
  ) {
    return ALLOWED;
  }

  if (member?.status !== 'invited') {
    return deny('group-invite-required', 'A valid invite is required to join.');
  }

  if (
    member.invitationExpiresAtEpochMs !== null &&
    input.nowEpochMs !== undefined &&
    member.invitationExpiresAtEpochMs <= input.nowEpochMs
  ) {
    return deny('group-invite-expired', 'Group invite has expired.');
  }

  return ALLOWED;
}

function canUseJoinCode(input: CanJoinGroupInput): GroupPolicyResult {
  if (!input.joinCode) {
    return deny('group-code-required', 'A join code is required to join.');
  }

  if (
    input.joinCodeExpiresAtEpochMs !== undefined &&
    input.nowEpochMs !== undefined &&
    input.joinCodeExpiresAtEpochMs <= input.nowEpochMs
  ) {
    return deny('group-code-invalid', 'Join code is invalid.');
  }

  if (input.expectedJoinCode !== undefined && input.joinCode !== input.expectedJoinCode) {
    return deny('group-code-invalid', 'Join code is invalid.');
  }

  if (
    input.expectedJoinCodeVerifier !== undefined &&
    input.joinCodeVerifier !== input.expectedJoinCodeVerifier
  ) {
    return deny('group-code-invalid', 'Join code is invalid.');
  }

  return ALLOWED;
}

function requireActiveGroup(
  group: Group,
  nowEpochMs: number | undefined,
): GroupPolicyDenied | undefined {
  if (group.status === 'archived') {
    return deny('group-archived', 'Group is archived.');
  }
  if (group.status === 'deleted') {
    return deny('group-deleted', 'Group is deleted.');
  }
  if (group.status !== 'active') {
    return deny('group-not-active', 'Group is not active.');
  }
  if (
    group.expiresAtEpochMs !== null &&
    nowEpochMs !== undefined &&
    group.expiresAtEpochMs <= nowEpochMs
  ) {
    return deny('group-not-active', 'Group has expired.');
  }

  return undefined;
}

function wouldExceedMemberCap(
  snapshot: GroupSnapshot,
  member: GroupMember | undefined,
  capacity: GroupPolicyCapacityConfig | undefined,
): boolean {
  const cap = snapshot.group.maxMembers ?? capacity?.defaultMaxMembers ?? null;
  if (cap === null || member?.status === 'active') {
    return false;
  }

  return snapshot.group.activeMemberCount >= cap;
}

function denyForBlockedMember(member: GroupMember | undefined): GroupPolicyDenied | undefined {
  if (member?.status === 'removed') {
    return deny('member-removed', 'Group member has been removed.');
  }
  if (member?.status === 'banned') {
    return deny('member-banned', 'Group member has been banned.');
  }

  return undefined;
}

function denyForPresenceMember(member: GroupMember | undefined): GroupPolicyDenied | undefined {
  const blocked = denyForBlockedMember(member);
  if (blocked) {
    return blocked;
  }
  if (!member || member.status !== 'active') {
    return deny('member-not-active', 'An active group member is required for this operation.');
  }

  return undefined;
}

function readDirectoryVisibility(snapshot: GroupSnapshot): GroupReadVisibility {
  return snapshot.group.status === 'active' && snapshot.group.joinMode === 'open'
    ? 'directory'
    : 'none';
}

function isInviteExpired(member: GroupMember, nowEpochMs: number | undefined): boolean {
  return (
    member.invitationExpiresAtEpochMs !== null &&
    nowEpochMs !== undefined &&
    member.invitationExpiresAtEpochMs <= nowEpochMs
  );
}

function findActorMember(
  snapshot: GroupSnapshot,
  actor: GroupPolicyActor,
): GroupMember | undefined {
  return actor.principalId ? findMember(snapshot, actor.principalId) : undefined;
}

function findMember(snapshot: GroupSnapshot, principalId: string): GroupMember | undefined {
  return snapshot.members.find((member) => member.principalId === principalId);
}

function isActiveOwnerOrAdmin(member: GroupMember | undefined): member is GroupMember {
  return member?.status === 'active' && (member.role === 'owner' || member.role === 'admin');
}

function isLastActiveOwner(snapshot: GroupSnapshot, member: GroupMember): boolean {
  if (member.role !== 'owner' || member.status !== 'active') {
    return false;
  }

  return snapshot.group.ownerPrincipalId === member.principalId;
}

function removesOwner(action: GroupGovernanceAction): boolean {
  return (
    action === 'remove' ||
    action === 'ban' ||
    action === 'demote' ||
    action === 'transfer-ownership'
  );
}

function isLiveSession(session: GroupPresenceSession, nowEpochMs: number | undefined): boolean {
  return (
    session.disconnectedAtEpochMs === null &&
    (nowEpochMs === undefined || session.expiresAtEpochMs > nowEpochMs)
  );
}

function deny(
  code: GroupPolicyReasonCode,
  message: string,
  details?: Record<string, unknown>,
): GroupPolicyDenied {
  return {
    allowed: false,
    code,
    message,
    details,
  };
}
