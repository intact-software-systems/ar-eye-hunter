import {assertEquals} from "https://deno.land";
import type {ALRouting} from "@shared/al-contracts/al-contract.ts";

const mockRouting = (overrides: Partial<ALRouting> = {}): ALRouting => {
    const base: ALRouting = {
        id: {
            v: 1,
            msgId: "00000000-0000-0000-0000-000000000001",
            ts: 1700000000000,
            sender: "client-a",
            sessionId: "session-1",
            traceId: "trace-1",
        },
        key: {
            topicId: "topic-1",
            resourceId: "resource-1",
            contextId: "ctx-1",
        },

        targets: {mode: "unicast", to: "client-b"},
        constraints: {ttlHops: 3},
        ordering: {groupId: "group-1", epoch: 1, seq: 42},

        qos: {
            ownership: "shared",
            reliability: "best-effort",
            ack: "receiver",
            ttlMs: 10_000,
        },

        actions: {corrId: "corr-1", replyTo: "00000000-0000-0000-0000-000000000000"},

        payload: {
            typeId: "type.test.message",
            contentType: "application/json",
            resource: JSON.stringify({hello: "world"}),
        },

        audit: {
            createdBy: "test",
            createdTs: 1700000000000,
        },

        history: {
            visited: ["client-a"],
        },
    };

    return {...base, ...overrides};
};

Deno.test("ALRouting can be instantiated with mock data", () => {
    const routing = mockRouting();

    assertEquals(routing.id.v, 1);
    assertEquals(routing.targets.mode, "unicast");
    assertEquals(routing.qos.ack, "receiver");
    assertEquals(routing.payload.typeId, "type.test.message");
});

Deno.test("ALRouting mock supports overrides", () => {
    const routing = mockRouting({
        targets: {mode: "broadcast", scope: "room", except: ["client-a"]},
        qos: {ownership: "exclusive", reliability: "at-least-once", ack: "all"},
    });

    assertEquals(routing.targets.mode, "broadcast");
    assertEquals(routing.qos.ownership, "exclusive");
    assertEquals(routing.qos.ack, "all");
});