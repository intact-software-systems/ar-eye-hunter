import type {
  AuthSessionRepository,
} from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type {
  AppAuthInboxService,
} from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import type {
  CachedClientStateService,
} from '@shared-server/rallar-system/client-state/snapshot/cached-client-state-service.ts';
import type {
  CachedGroupStateService,
} from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import type {
  RallarMiddlewareRuntime,
} from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import type {
  RtcTopologyExecutionRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import type {
  RtcTopologyPublicationRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import type {
  ClientRestSnapshotReadSelector,
} from '@shared-server/rallar-system/client-state/snapshot/client-rest-snapshot-read-selector.ts';
import type {
  GroupRestSnapshotReadSelector,
} from '@shared-server/rallar-system/group-state/snapshot/group-rest-snapshot-read-selector.ts';
import type {
  RallarGroupFormationMetricsRecorder,
} from '@shared-server/rallar-system/formation-metrics.ts';

import type { ApiV1BackgroundTaskLifecycle } from './api-v1-background-task-lifecycle.ts';

export interface ApiV1Runtime extends
  Omit<
    RallarMiddlewareRuntime,
    | 'clientStateService'
    | 'groupStateService'
    | 'rtcTopologyPublicationRepository'
    | 'rtcTopologyExecutionRepository'
    | 'rtcTopologyDelivery'
    | 'rtcTopologyReplay'
    | 'appAuthInboxService'
  > {
  readonly clientStateService: CachedClientStateService;
  readonly groupStateService: CachedGroupStateService;
  readonly rtcTopologyPublicationRepository: RtcTopologyPublicationRepository;
  readonly rtcTopologyExecutionRepository: RtcTopologyExecutionRepository;
  readonly rtcTopologyDelivery: NonNullable<RallarMiddlewareRuntime['rtcTopologyDelivery']>;
  readonly rtcTopologyReplay: NonNullable<RallarMiddlewareRuntime['rtcTopologyReplay']>;
  readonly appAuthInboxService: AppAuthInboxService;
  readonly authSessionRepository: AuthSessionRepository;
  readonly clientRestSnapshotReadSelector: ClientRestSnapshotReadSelector;
  readonly groupRestSnapshotReadSelector: GroupRestSnapshotReadSelector;
  readonly groupFormationMetrics: RallarGroupFormationMetricsRecorder;
  readonly backgroundTasks: ApiV1BackgroundTaskLifecycle;
}

export interface RequireApiV1RuntimeInput {
  readonly runtime: RallarMiddlewareRuntime;
  readonly authSessionRepository: AuthSessionRepository;
  readonly clientRestSnapshotReadSelector: ClientRestSnapshotReadSelector;
  readonly groupRestSnapshotReadSelector: GroupRestSnapshotReadSelector;
  readonly groupFormationMetrics: RallarGroupFormationMetricsRecorder;
  readonly backgroundTasks: ApiV1BackgroundTaskLifecycle;
}

export function requireApiV1Runtime(input: RequireApiV1RuntimeInput): ApiV1Runtime {
  const { runtime } = input;
  if (!isCachedClientStateService(runtime.clientStateService)) {
    throw new Error('API runtime requires the cached client state service');
  }
  if (!isCachedGroupStateService(runtime.groupStateService)) {
    throw new Error('API runtime requires the cached group state service');
  }
  if (!runtime.rtcTopologyPublicationRepository) {
    throw new Error('API runtime requires the RTC topology publication repository');
  }
  if (!runtime.rtcTopologyExecutionRepository) {
    throw new Error('API runtime requires the RTC topology execution repository');
  }
  if (!runtime.rtcTopologyDelivery) {
    throw new Error('API runtime requires RTC topology durable delivery');
  }
  if (!runtime.rtcTopologyReplay) {
    throw new Error('API runtime requires RTC topology durable replay');
  }
  if (!runtime.appAuthInboxService) {
    throw new Error('API runtime requires the auth AppInbox service');
  }

  return {
    ...runtime,
    clientStateService: runtime.clientStateService,
    groupStateService: runtime.groupStateService,
    rtcTopologyPublicationRepository: runtime.rtcTopologyPublicationRepository,
    rtcTopologyExecutionRepository: runtime.rtcTopologyExecutionRepository,
    rtcTopologyDelivery: runtime.rtcTopologyDelivery,
    rtcTopologyReplay: runtime.rtcTopologyReplay,
    appAuthInboxService: runtime.appAuthInboxService,
    authSessionRepository: input.authSessionRepository,
    clientRestSnapshotReadSelector: input.clientRestSnapshotReadSelector,
    groupRestSnapshotReadSelector: input.groupRestSnapshotReadSelector,
    groupFormationMetrics: input.groupFormationMetrics,
    backgroundTasks: input.backgroundTasks,
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
