import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { assertValidRallarWsUserTopicId } from '@shared/api/rallar-validation.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsHandler,
    RallarServerWsMessage,
    RallarServerWsMessageContext,
    RallarServerWsPayload,
    RallarServerWsProxyRule,
    RallarServerWsPublishResult,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition
} from './rallar-server-ws-router-contracts.ts';

interface RegisteredHandler {
    readonly selector: RallarServerWsSelector;
    readonly handler: RallarServerWsHandler<JsonWireValue>;
}

export interface DispatchRallarServerWsProxyRulesInput {
    readonly message: RallarServerWsMessage<JsonWireValue>;
    readonly context: RallarServerWsMessageContext;
    readonly defaultFanout: RallarServerWsFanout;
    readonly publish: (
        message: ALMessage,
        fanout: RallarServerWsFanout
    ) => Promise<RallarServerWsPublishResult>;
}

export class RallarServerWsTopicRegistry {
    private readonly definitions: RallarServerWsTopicDefinition<JsonWireValue>[] = [];
    private readonly handlers = new Map<string, RegisteredHandler>();
    private readonly proxyRules = new Map<string, RallarServerWsProxyRule<JsonWireValue>>();

    define<T extends RallarServerWsPayload>(
        definition: RallarServerWsTopicDefinition<T>
    ): void {
        assertValidRallarWsUserTopicId(definition.topicId, '$.topicId');
        const exists = this.definitions.some((registered) =>
            registered.topicId === definition.topicId &&
            registered.typeId === definition.typeId
        );
        if (exists) {
            throw new Error(`Rallar WS topic already defined: ${toSelectorKey(definition)}`);
        }
        const authorize = definition.authorize;
        this.definitions.push({
            ...definition,
            authorize: authorize
                ? (message, context) => authorize(toTypedMessage(message), context)
                : undefined
        });
    }

    remove(selector: RallarServerWsSelector): boolean {
        const index = this.definitions.findIndex((definition) =>
            matchesRallarServerWsSelector(selector, {
                route: { topicId: definition.topicId },
                payload: { typeId: definition.typeId ?? '' }
            })
        );
        if (index < 0) {
            return false;
        }
        this.definitions.splice(index, 1);
        return true;
    }

    subscribe<T extends RallarServerWsPayload>(
        selector: RallarServerWsSelector,
        handler: RallarServerWsHandler<T>
    ): () => boolean {
        assertSelector(selector);
        const id = `handler:${crypto.randomUUID()}`;
        this.handlers.set(id, {
            selector,
            handler: (message, context) => handler(toTypedMessage(message), context)
        });
        return () => this.handlers.delete(id);
    }

    addProxy<T extends RallarServerWsPayload>(rule: RallarServerWsProxyRule<T>): () => boolean {
        assertSelector(rule.from);
        const id = rule.id ?? `proxy:${crypto.randomUUID()}`;
        if (this.proxyRules.has(id)) {
            throw new Error(`Rallar WS proxy rule already exists: ${id}`);
        }
        const authorize = rule.authorize;
        const transform = rule.transform;
        const targets = rule.targets;
        this.proxyRules.set(id, {
            ...rule,
            authorize: authorize
                ? (message, context) => authorize(toTypedMessage(message), context)
                : undefined,
            transform: transform
                ? (message, context) => transform(toTypedMessage(message), context)
                : undefined,
            targets: targets
                ? (message, context) => targets(toTypedMessage(message), context)
                : undefined
        });
        return () => this.proxyRules.delete(id);
    }

    find(message: ALMessage): RallarServerWsTopicDefinition<JsonWireValue> | undefined {
        return this.definitions.find((definition) =>
            definition.topicId === message.route.topicId &&
            (definition.typeId === undefined || definition.typeId === message.payload.typeId)
        );
    }

    async dispatchHandlers(
        message: RallarServerWsMessage<JsonWireValue>,
        context: RallarServerWsMessageContext
    ): Promise<void> {
        for (const registered of this.handlers.values()) {
            if (!matchesRallarServerWsSelector(registered.selector, message.raw)) {
                continue;
            }
            try {
                await registered.handler(message, context);
            }
            catch (error) {
                console.error(
                    `Error in Rallar WS handler for ${toSelectorKey(registered.selector)}`,
                    error
                );
            }
        }
    }

    async dispatchProxyRules(
        input: DispatchRallarServerWsProxyRulesInput
    ): Promise<boolean> {
        let suppressDefaultFanout = false;
        for (const rule of this.proxyRules.values()) {
            if (!matchesRallarServerWsSelector(rule.from, input.message.raw)) {
                continue;
            }
            try {
                suppressDefaultFanout = await this.dispatchProxyRule(
                    rule,
                    input,
                    suppressDefaultFanout
                );
            }
            catch (error) {
                console.error(`Error in Rallar WS proxy for ${toSelectorKey(rule.from)}`, error);
            }
        }
        return suppressDefaultFanout;
    }

    private async dispatchProxyRule(
        rule: RallarServerWsProxyRule<JsonWireValue>,
        input: DispatchRallarServerWsProxyRulesInput,
        suppressDefaultFanout: boolean
    ): Promise<boolean> {
        if (rule.authorize && !await rule.authorize(input.message, input.context)) {
            return suppressDefaultFanout;
        }
        const transformed = rule.transform
            ? await rule.transform(input.message, input.context)
            : input.message.raw;
        const targets = rule.targets
            ? await rule.targets(input.message, input.context)
            : transformed.targets;
        if (!targets) {
            return suppressDefaultFanout;
        }
        await input.publish(
            { ...transformed, targets },
            rule.fanout ?? input.context.definition?.fanout ?? input.defaultFanout
        );
        return suppressDefaultFanout || (rule.suppressDefaultFanout ?? false);
    }
}

function toTypedMessage<T extends RallarServerWsPayload>(
    message: RallarServerWsMessage<JsonWireValue>
): RallarServerWsMessage<T> {
    return {
        ...message,
        payload: message.payload as T
    };
}

export function matchesRallarServerWsSelector(
    selector: RallarServerWsSelector,
    message: Readonly<{
        route: Pick<ALMessage['route'], 'topicId'>;
        payload: Pick<ALMessage['payload'], 'typeId'>;
    }>
): boolean {
    return (selector.topicId === undefined || selector.topicId === message.route.topicId) &&
        (selector.typeId === undefined || selector.typeId === message.payload.typeId);
}

function assertSelector(selector: RallarServerWsSelector): void {
    if (!selector.topicId && !selector.typeId) {
        throw new Error('Rallar WS selector requires topicId or typeId.');
    }
}

function toSelectorKey(selector: RallarServerWsSelector): string {
    return `${selector.topicId ?? '*'}/${selector.typeId ?? '*'}`;
}
