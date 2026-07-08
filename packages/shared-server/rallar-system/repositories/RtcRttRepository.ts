import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { pairKey } from '@shared/repository/rtt-repository.ts';
import type {
    RuntimeStateRepositoryLike,
    RuntimeStateTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import { isRuntimeStateTransactionalRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';

export const RTC_RTT_LATEST_NAMESPACE = 'rtc-rtt:latest';

const DEFAULT_RTC_RTT_TTL_MS = 60_000;

export type RtcRttRepositoryAcceptance<Result> = Readonly<{
    result: Result;
    updated: boolean;
}>;

export type RtcRttRepositoryOptions = Readonly<{
    ttlMs?: number;
    now?: () => number;
}>;

export class RtcRttRepository extends RuntimeStateJsonStore {
    constructor(
        repository: RuntimeStateRepositoryLike,
        private readonly options: RtcRttRepositoryOptions = {},
    ) {
        super(repository);
    }

    async putMeasurementIfNewer(
        measurement: RttMeasurementInfo,
        purgeAfterEpochMs: number = this.defaultPurgeAfterEpochMs(),
    ): Promise<boolean> {
        return await this.withMeasurementLock(measurement, async (repository) => {
            return await repository.putMeasurementIfNewerWithoutLock(
                measurement,
                purgeAfterEpochMs,
            );
        });
    }

    async putMeasurementIfNewerWithEndpointLocks<
        Result extends Readonly<{ accepted: boolean }>,
    >(
        measurement: RttMeasurementInfo,
        evaluate: (existingMeasurements: readonly RttMeasurementInfo[]) => Result,
        purgeAfterEpochMs: number = this.defaultPurgeAfterEpochMs(),
    ): Promise<RtcRttRepositoryAcceptance<Result>> {
        return await this.withEndpointPairLock(measurement, async (repository) => {
            const result = evaluate(await repository.listMeasurements());
            if (!result.accepted) {
                return { result, updated: false };
            }

            return {
                result,
                updated: await repository.putMeasurementIfNewerWithoutLock(
                    measurement,
                    purgeAfterEpochMs,
                ),
            };
        });
    }

    async findMeasurement(
        sessionIdA: string,
        sessionIdB: string,
    ): Promise<RttMeasurementInfo | undefined> {
        return await this.getValue<RttMeasurementInfo>(
            RTC_RTT_LATEST_NAMESPACE,
            this.measurementKey(sessionIdA, sessionIdB),
        );
    }

    async listMeasurements(): Promise<readonly RttMeasurementInfo[]> {
        return await this.listValues<RttMeasurementInfo>(
            RTC_RTT_LATEST_NAMESPACE,
        );
    }

    async listMeasurementsForSessionIds(
        sessionIds: readonly string[],
    ): Promise<readonly RttMeasurementInfo[]> {
        const sessionSet = new Set(sessionIds);
        const measurements = await this.listMeasurements();
        return measurements.filter(
            (measurement) =>
                sessionSet.has(measurement.sessionIdFrom) &&
                sessionSet.has(measurement.sessionIdTo),
        );
    }

    async removeMeasurement(
        sessionIdA: string,
        sessionIdB: string,
    ): Promise<void> {
        await this.deleteValue(
            RTC_RTT_LATEST_NAMESPACE,
            this.measurementKey(sessionIdA, sessionIdB),
        );
    }

    measurementKey(sessionIdA: string, sessionIdB: string): string {
        return this.idKey('pair', pairKey(sessionIdA, sessionIdB));
    }

    private async putMeasurement(
        measurement: RttMeasurementInfo,
        purgeAfterEpochMs: number,
    ): Promise<void> {
        await this.putValue(
            RTC_RTT_LATEST_NAMESPACE,
            this.measurementKey(
                measurement.sessionIdFrom,
                measurement.sessionIdTo,
            ),
            measurement,
            purgeAfterEpochMs,
        );
    }

    private async putMeasurementIfNewerWithoutLock(
        measurement: RttMeasurementInfo,
        purgeAfterEpochMs: number,
    ): Promise<boolean> {
        const current = await this.findMeasurement(
            measurement.sessionIdFrom,
            measurement.sessionIdTo,
        );

        if (current !== undefined && current.version >= measurement.version) {
            return false;
        }

        await this.putMeasurement(measurement, purgeAfterEpochMs);
        return true;
    }

    private async withMeasurementLock<T>(
        measurement: RttMeasurementInfo,
        fn: (repository: RtcRttRepository) => Promise<T>,
    ): Promise<T> {
        if (!isRuntimeStateTransactionalRepositoryLike(this.repository)) {
            return await fn(this);
        }

        return await this.repository.begin(async (repository) => {
            await repository.lockKey(
                RTC_RTT_LATEST_NAMESPACE,
                this.measurementKey(
                    measurement.sessionIdFrom,
                    measurement.sessionIdTo,
                ),
            );
            return await fn(this.withRepository(repository));
        });
    }

    private async withEndpointPairLock<T>(
        measurement: RttMeasurementInfo,
        fn: (repository: RtcRttRepository) => Promise<T>,
    ): Promise<T> {
        if (!isRuntimeStateTransactionalRepositoryLike(this.repository)) {
            return await fn(this);
        }

        return await this.repository.begin(async (repository) => {
            for (
                const sessionId of [...new Set([
                    measurement.sessionIdFrom,
                    measurement.sessionIdTo,
                ])].sort()
            ) {
                await repository.lockKey(
                    RTC_RTT_LATEST_NAMESPACE,
                    this.endpointLockKey(sessionId),
                );
            }
            await repository.lockKey(
                RTC_RTT_LATEST_NAMESPACE,
                this.measurementKey(
                    measurement.sessionIdFrom,
                    measurement.sessionIdTo,
                ),
            );
            return await fn(this.withRepository(repository));
        });
    }

    private withRepository(
        repository: RuntimeStateTransactionalRepositoryLike,
    ): RtcRttRepository {
        return new RtcRttRepository(repository, this.options);
    }

    private endpointLockKey(sessionId: string): string {
        return this.idKey('endpoint', sessionId);
    }

    private defaultPurgeAfterEpochMs(): number {
        return this.now() + (this.options.ttlMs ?? DEFAULT_RTC_RTT_TTL_MS);
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }
}
