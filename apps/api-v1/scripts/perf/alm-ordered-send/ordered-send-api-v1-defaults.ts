import apiV1Defaults from '../../../resources/configuration/defaults-config.json' with { type: 'json' };
import type { ApiV1CircuitBreakerConfiguration } from '../../../src/configuration/api-v1-configuration.ts';

/** What the cell takes from the `defaults-config.json` the API starts from. */
export interface OrderedSendApiV1Defaults {
    /** The most connections the application pool of an API instance opens. */
    readonly applicationPoolMaxConnections: number;
    /** The circuit breaker of an API instance's queue reads. */
    readonly queueResilience: ApiV1CircuitBreakerConfiguration;
}

/** A deployment's profile or environment may override either; the cell reads the defaults alone. */
export const ORDERED_SEND_API_V1_DEFAULTS: OrderedSendApiV1Defaults = {
    applicationPoolMaxConnections: apiV1Defaults.database.applicationPool.maxConnections,
    queueResilience: apiV1Defaults.topology.queueResilience
};
