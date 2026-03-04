import {Hono} from "jsr:@hono/hono";
import {RoomCreate} from "@shared/api/api-config.ts";
import * as roomRepository from "./room-repository.ts";
import * as roomTransport from "../websocket/ws-rooms-transport.ts";

export function init(app: Hono) {
    app.post(
        "/api/rooms",
        async c => {
            const roomCreate = await c.req.json() as RoomCreate

            const roomDetails = await roomRepository.putRoomIfAbsent(roomCreate)

            await roomTransport.publishRoomDetails(roomDetails);

            return c.json(roomDetails)
        }
    )

    app.get(
        "/api/rooms/list",
        async c => {
            return c.json(await roomRepository.listRooms())
        }
    )

    app.get(
        "/api/rooms/:id",
        async c => {
            const roomDetails = await roomRepository.findRoom(c.req.param("id"))

            return roomDetails
                ? c.json(roomDetails)
                : c.json({}, 404)
        }
    )

    app.post(
        "/api/rooms/:roomName/join/:clientId",
        async c => {
            const roomName = c.req.param("roomName");
            const clientId = c.req.param("clientId");

            try {
                const roomDetails = await roomRepository.joinRoom(roomName, clientId);

                await roomTransport.publishRoomDetails(roomDetails);

                return c.json(roomDetails)
            } catch (e) {
                return c.json({error: e}, 404)
            }
        }
    )

    app.post(
        "/api/rooms/:roomName/leave/:clientId",
        async c => {
            const roomName = c.req.param("roomName");
            const clientId = c.req.param("clientId");

            try {
                const roomDetails = await roomRepository.leaveRoom(roomName, clientId);

                await roomTransport.publishRoomDetails(roomDetails);

                return c.json(roomDetails)
            } catch (e) {
                return c.json({error: e}, 404)
            }
        }
    )

}