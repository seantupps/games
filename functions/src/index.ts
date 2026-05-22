import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onValueCreated } from "firebase-functions/v2/database";
import * as admin from "firebase-admin";
const Logic = require("./shared/logic");

admin.initializeApp();

export const createGame = onCall(async (request) => {
    const { gameType, mode } = request.data;
    const uid = request.auth?.uid;

    if (!uid) {
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const gameId = Math.random().toString(36).substring(2, 7).toUpperCase();
    const logic = Logic[gameType];

    if (!logic) {
        throw new HttpsError("invalid-argument", "Invalid game type.");
    }

    const initialState = logic.initialState(mode);

    const gameMeta = {
        host: uid,
        status: "waiting",
        game: gameType,
        mode: mode,
        createdAt: admin.database.ServerValue.TIMESTAMP,
        users: { [uid]: admin.database.ServerValue.TIMESTAMP }
    };

    const gameData = {
        initialState: initialState,
        events: {}
    };

    const updates: any = {};
    updates[`games/${gameId}`] = gameMeta;
    updates[`gameData/${gameId}`] = gameData;

    await admin.database().ref().update(updates);

    return { gameId };
});

async function processMoveEvent(gameId: string, eventData: { type?: string }) {
    if (eventData.type !== "move") return;

    const gameRef = admin.database().ref(`games/${gameId}`);
    const dataRef = admin.database().ref(`gameData/${gameId}`);
    const targetEventsRef = admin.database().ref(`games/${gameId}/events`);

    const [metaSnap, dataSnap, targetEventsSnap] = await Promise.all([
        gameRef.get(),
        dataRef.get(),
        targetEventsRef.get()
    ]);

    const meta = metaSnap.val();
    const data = dataSnap.val();
    if (!meta) return;

    const roomMeta = meta.meta || {};
    const globalMeta = meta.global || {};
    const gameType = roomMeta.game || globalMeta.game || meta.game;
    const mode = roomMeta.mode || globalMeta.mode || meta.mode;
    const board =
        meta.state?.board || globalMeta.board || data?.initialState;
    const firstPlayer =
        roomMeta.firstPlayer || globalMeta.firstPlayer || "P1";

    const legacyEvents = data?.events || {};
    const targetEvents = targetEventsSnap.val() || {};
    const events = Object.values(
        Object.keys(targetEvents).length ? targetEvents : legacyEvents
    );

    const state = Logic.computeState(gameType, events, {
        mode,
        board,
        firstPlayer
    });

    const updates: Record<string, unknown> = {};
    if (state) {
        updates["meta/turn"] = state.turn;
        updates["global/turn"] = state.turn;
        if (state.isOver) {
            updates["status"] = "finished";
            updates["winner"] = state.winner;
            updates["finishedAt"] = admin.database.ServerValue.TIMESTAMP;
        }
    }
    await gameRef.update(updates);
}

export const onEventCreated = onValueCreated(
    "/gameData/{gameId}/events/{eventId}",
    async (event) => {
        await processMoveEvent(event.params.gameId, event.data.val());
    }
);

export const onRoomEventCreated = onValueCreated(
    "/games/{gameId}/events/{eventId}",
    async (event) => {
        await processMoveEvent(event.params.gameId, event.data.val());
    }
);
