import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import { readRttMutation, writeRttMutation } from '../../services/rtc-rtt-mutation-service.ts';
import { computeRttMutation, validateRttMutation } from '../../services/rtc-topology-mutations.ts';
import {
  type RtcRttAppInboxResult,
  toRtcRttAppInboxResult,
} from '../../services/rtc-rtt-app-inbox-result.ts';
import type { AppInboxMessageContext } from '../../services/AppInboxService.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import {
  createRtcRttDurableEnqueue,
  readRtcRttAppInboxAuthority,
  verifyRtcRttAppInboxAuthority,
} from './rtc-rtt-app-inbox-authority.ts';
import type {
  CreateRtcRttAppInboxEnqueueInput,
  RtcRttAppInboxCommand,
  RtcRttAppInboxDependencies,
} from './rtc-rtt-app-inbox-contracts.ts';
import type { AppInboxEnqueueInput } from '../../services/AppInboxService.ts';

export interface RtcRttAppInboxHandlerDependencies {
  readonly groupStateService: GroupStateService;
  readonly writeMutation: (
    context: AppInboxMessageContext,
    write: (transaction: PSqlTransactionSql) => Promise<RtcRttAppInboxResult>,
  ) => Promise<RtcRttAppInboxResult>;
  readonly nowEpochMs: () => number;
  readonly wakeQueue?: () => void;
}

export class RtcRttAppInboxHandler {
  private readonly dependencies: RtcRttAppInboxHandlerDependencies;

  constructor(dependencies: RtcRttAppInboxHandlerDependencies) {
    this.dependencies = dependencies;
  }

  async createEnqueue(
    input: CreateRtcRttAppInboxEnqueueInput,
  ): Promise<AppInboxEnqueueInput<RtcRttAppInboxCommand>> {
    return await createRtcRttDurableEnqueue({
      request: input,
      groupStateService: this.dependencies.groupStateService,
      nowEpochMs: this.dependencies.nowEpochMs,
    });
  }

  async processMutation(
    context: AppInboxMessageContext,
    rtcRttDependencies: RtcRttAppInboxDependencies,
  ): Promise<RtcRttAppInboxResult> {
    const authority = readRtcRttAppInboxAuthority(context.enqueue.authority);
    await verifyRtcRttAppInboxAuthority({
      authority,
      groupStateService: this.dependencies.groupStateService,
      nowEpochMs: this.dependencies.nowEpochMs,
    });
    const stableRequest = {
      rtt: authority.command.rtt,
      alSenderId: authority.command.actor.sessionId,
    };
    const read = await readRttMutation(rtcRttDependencies.repository, stableRequest);
    const attemptCount = context.entry.dequeueAudit.attempts;
    const command = read.receipt
      ? {
          ...stableRequest,
          candidateGroups: null,
          overlaySnapshotsByGroupKey: null,
          degreeLimit: null,
        }
      : {
          ...stableRequest,
          ...(await rtcRttDependencies.readPolicyInputs(authority.command)),
        };
    const lifecycleFacts = read.receipt
      ? { requestedAtEpochMs: null, purgeAfterEpochMs: null }
      : await rtcRttDependencies.repository.readMutationFacts();
    const facts = {
      ...lifecycleFacts,
      commandHash: authority.command.mutationCommandHash,
      attemptCount,
    };
    const computed = computeRttMutation({ command, read, facts });
    validateRttMutation({ command, read, facts, computed });
    const result = await this.commitMutation(context, authority.command, computed, facts);
    if (computed.outcome === 'write') {
      rtcRttDependencies.observeCommitted?.(computed.measurementGuard.value);
      this.dependencies.wakeQueue?.();
      try {
        rtcRttDependencies.formationMetrics?.({
          recomputeIntentCount: computed.recomputeIntents.length,
        });
      } catch {
        // Recording must never affect RTT mutation behavior.
      }
    }
    return result;
  }

  private async commitMutation(
    context: AppInboxMessageContext,
    command: RtcRttAppInboxCommand,
    computed: ReturnType<typeof computeRttMutation>,
    facts: Parameters<typeof computeRttMutation>[0]['facts'],
  ): Promise<RtcRttAppInboxResult> {
    return await this.dependencies.writeMutation(context, async (transaction) => {
      if (computed.outcome === 'write') {
        if (facts.requestedAtEpochMs === null || facts.purgeAfterEpochMs === null) {
          throw new TypeError('RTC RTT write lifecycle facts are missing');
        }
        await writeRttMutation(
          transaction,
          {
            ttlMs: facts.purgeAfterEpochMs - facts.requestedAtEpochMs,
            now: () => facts.requestedAtEpochMs,
          },
          computed,
        );
      }
      return toRtcRttAppInboxResult(computed, command.requestId);
    });
  }
}
