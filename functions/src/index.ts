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

export const onEventCreated = onValueCreated("/gameData/{gameId}/events/{eventId}", async (event) => {
    const gameId = event.params.gameId;
    const eventData = event.data.val();

    if (eventData.type === "move") {
        const gameRef = admin.database().ref(`games/${gameId}`);
        const dataRef = admin.database().ref(`gameData/${gameId}`);

        const [metaSnap, dataSnap] = await Promise.all([
            gameRef.get(),
            dataRef.get()
        ]);

        const meta = metaSnap.val();
        const data = dataSnap.val();

        if (!meta || !data) return;

        const globalMeta = meta.global || {};
        const gameType = globalMeta.game || meta.game;
        const mode = globalMeta.mode || meta.mode;
        const events = Object.values(data.events || {});
        const state = Logic.computeState(gameType, events, {
            mode,
            board: globalMeta.board || data.initialState,
            firstPlayer: globalMeta.firstPlayer || "P1"
        });

        const updates: any = {};
        if (state) {
            updates['global/turn'] = state.turn;
            if (state.isOver) {
                updates['status'] = "finished";
                updates['winner'] = state.winner;
                updates['finishedAt'] = admin.database.ServerValue.TIMESTAMP;
            }
        }
        await gameRef.update(updates);
    }
});
