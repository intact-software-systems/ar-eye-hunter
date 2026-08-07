import type { AppAuthInboxService } from '@shared-server/rallar-system/services/AppAuthInboxService.ts';
import type { CachedClientStateService } from '@shared-server/rallar-system/services/cached-client-state-service.ts';
import type { CachedGroupStateService } from '@shared-server/rallar-system/services/cached-group-state-service.ts';
import type { RallarMiddlewareRuntime } from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import type { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import type { RtcTopologyPublicationRepository } from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import type { RtcTopologyPublicationFanout } from '@shared-server/rallar-system/pubsub/RtcTopologyClusterTransport.ts';
import type {
  ClientRestSnapshotReadSelector,
} from '@shared-server/rallar-system/client-state/snapshot/client-rest-snapshot-read-selector.ts';
import type {
  GroupRestSnapshotReadSelector,
} from '@shared-server/rallar-system/group-state/snapshot/group-rest-snapshot-read-selector.ts';

export type Middleware =
  & Omit<
    RallarMiddlewareRuntime,
    | 'clientStateService'
    | 'groupStateService'
    | 'rtcTopologyPublicationRepository'
    | 'rtcTopologyExecutionRepository'
    | 'rtcTopologyPublicationFanout'
    | 'appAuthInboxService'
  >
  & Readonly<{
    clientStateService: CachedClientStateService;
    groupStateService: CachedGroupStateService;
    rtcTopologyPublicationRepository: RtcTopologyPublicationRepository;
    rtcTopologyExecutionRepository: RtcTopologyExecutionRepository;
    rtcTopologyPublicationFanout: RtcTopologyPublicationFanout;
    appAuthInboxService: AppAuthInboxService;
    clientRestSnapshotReadSelector: ClientRestSnapshotReadSelector;
    groupRestSnapshotReadSelector: GroupRestSnapshotReadSelector;
  }>;

export function requireApiMiddleware(
  runtime: RallarMiddlewareRuntime,
  selectors: Readonly<{
    clientRestSnapshotReadSelector: ClientRestSnapshotReadSelector;
    groupRestSnapshotReadSelector: GroupRestSnapshotReadSelector;
  }>,
): Middleware {
  if (!isCachedClientStateService(runtime.clientStateService)) {
    throw new Error('API middleware requires the cached client state service');
  }
  if (!isCachedGroupStateService(runtime.groupStateService)) {
    throw new Error('API middleware requires the cached group state service');
  }
  if (!runtime.rtcTopologyPublicationRepository) {
    throw new Error('API middleware requires the RTC topology publication repository');
  }
  if (!runtime.rtcTopologyExecutionRepository) {
    throw new Error('API middleware requires the RTC topology execution repository');
  }
  if (!runtime.rtcTopologyPublicationFanout) {
    throw new Error('API middleware requires the RTC topology publication fanout');
  }
  if (!runtime.appAuthInboxService) {
    throw new Error('API middleware requires the auth AppInbox service');
  }
  return {
    ...runtime,
    clientStateService: runtime.clientStateService,
    groupStateService: runtime.groupStateService,
    rtcTopologyPublicationRepository: runtime.rtcTopologyPublicationRepository,
    rtcTopologyExecutionRepository: runtime.rtcTopologyExecutionRepository,
    rtcTopologyPublicationFanout: runtime.rtcTopologyPublicationFanout,
    appAuthInboxService: runtime.appAuthInboxService,
    ...selectors,
  };
}

function isCachedClientStateService(
  service: RallarMiddlewareRuntime['clientStateService'],
): service is CachedClientStateService {
  return 'observeSnapshot' in service;
}

function isCachedGroupStateService(
  service: RallarMiddlewareRuntime['groupStateService'],
): service is CachedGroupStateService {
  return 'readCurrentSnapshot' in service;
}
