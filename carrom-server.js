/**
 * Carrom Royale WebSocket server
 *
 *   npm install
 *   npm start
 *
 * Env
 *   PORT=8080
 *   CORS_ORIGINS=https://example.com,https://www.example.com
 */

"use strict";

const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 8080;
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes("*")) return true;
  if (!origin) return false;
  return CORS_ORIGINS.includes(origin);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (CORS_ORIGINS.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const httpServer = http.createServer((req, res) => {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
});

const server = new WebSocket.Server({
  server: httpServer,
  verifyClient(info) {
    return isOriginAllowed(info.origin);
  }
});
const rooms = new Map();
let randomWaiting = null;

function send(socket, payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    const bytes = crypto.randomBytes(6);
    code = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
  } while (rooms.has(code));
  return code;
}

function makeRoom(code, isPrivate) {
  const room = {
    code,
    isPrivate,
    players: [],
    turn: 0,
    shotBy: null,
    createdAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function joinRoom(socket, room) {
  if (!room || room.players.length >= 2) {
    send(socket, { type: "error", message: "That room is full or unavailable." });
    return false;
  }

  room.players.push(socket);
  socket.roomCode = room.code;
  socket.playerIndex = room.players.length - 1;

  if (room.players.length === 2) {
    room.turn = 0;
    room.shotBy = null;
    room.players.forEach((player, playerIndex) => {
      send(player, {
        type: "match_found",
        roomCode: room.code,
        playerIndex
      });
    });
  }

  return true;
}

function broadcast(room, payload, except = null) {
  if (!room) return;
  room.players.forEach(player => {
    if (player !== except) send(player, payload);
  });
}

function leaveRoom(socket, notify = true) {
  if (randomWaiting === socket) randomWaiting = null;
  if (!socket.roomCode) return;

  const room = rooms.get(socket.roomCode);
  socket.roomCode = null;
  socket.playerIndex = null;
  if (!room) return;

  room.players = room.players.filter(player => player !== socket);
  if (notify) broadcast(room, { type: "opponent_left" });

  room.players.forEach(player => {
    player.roomCode = null;
    player.playerIndex = null;
  });
  rooms.delete(room.code);
}

function handleRandom(socket) {
  leaveRoom(socket, false);
  if (
    randomWaiting &&
    randomWaiting !== socket &&
    randomWaiting.readyState === WebSocket.OPEN &&
    !randomWaiting.roomCode
  ) {
    const opponent = randomWaiting;
    randomWaiting = null;
    const room = makeRoom(roomCode(), false);
    joinRoom(opponent, room);
    joinRoom(socket, room);
  } else {
    randomWaiting = socket;
    send(socket, { type: "waiting" });
  }
}

function handleCreateFriend(socket) {
  leaveRoom(socket, false);
  const room = makeRoom(roomCode(), true);
  joinRoom(socket, room);
  send(socket, { type: "room_created", roomCode: room.code });
}

function handleJoinFriend(socket, requestedCode) {
  leaveRoom(socket, false);
  const code = String(requestedCode || "").trim().toUpperCase();
  const room = rooms.get(code);

  if (!room || !room.isPrivate || room.players.length !== 1) {
    send(socket, { type: "error", message: "Room not found or already full." });
    return;
  }
  joinRoom(socket, room);
}

function validShot(message) {
  const power = Number(message.power);
  const strikerX = Number(message.strikerX);
  const x = Number(message.dir && message.dir.x);
  const y = Number(message.dir && message.dir.y);
  return (
    Number.isFinite(power) &&
    power >= 0 &&
    power <= 1 &&
    Number.isFinite(strikerX) &&
    strikerX >= -2.8 &&
    strikerX <= 2.8 &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x * x + y * y > 0.5 &&
    x * x + y * y < 1.5
  );
}

function handleShot(socket, message) {
  const room = rooms.get(socket.roomCode);
  if (!room || room.players.length !== 2) return;
  if (socket.playerIndex !== room.turn || room.shotBy !== null) {
    send(socket, { type: "error", message: "It is not your turn." });
    return;
  }
  if (!validShot(message)) {
    send(socket, { type: "error", message: "Invalid shot data." });
    return;
  }

  room.shotBy = socket.playerIndex;
  broadcast(
    room,
    {
      type: "shot",
      playerIndex: socket.playerIndex,
      strikerX: Number(message.strikerX),
      dir: { x: Number(message.dir.x), y: Number(message.dir.y) },
      power: Number(message.power)
    },
    socket
  );
}

function handleState(socket, message) {
  const room = rooms.get(socket.roomCode);
  if (!room || room.players.length !== 2) return;
  if (room.shotBy !== socket.playerIndex || !message.state) return;

  const nextTurn = message.state.turn === 1 ? 1 : 0;
  room.turn = nextTurn;
  room.shotBy = null;

  broadcast(
    room,
    {
      type: "state",
      playerIndex: socket.playerIndex,
      state: message.state
    },
    socket
  );
}

server.on("connection", socket => {
  socket.roomCode = null;
  socket.playerIndex = null;

  send(socket, { type: "connected" });

  socket.on("message", raw => {
    let message;
    try {
      if (raw.length > 100000) throw new Error("Message too large");
      message = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: "error", message: "Invalid message." });
      return;
    }

    switch (message.type) {
      case "join_random":
        handleRandom(socket);
        break;
      case "create_friend":
        handleCreateFriend(socket);
        break;
      case "join_friend":
        handleJoinFriend(socket, message.roomCode);
        break;
      case "shot":
        handleShot(socket, message);
        break;
      case "state":
        handleState(socket, message);
        break;
      case "leave":
        leaveRoom(socket);
        break;
      case "ping":
        send(socket, { type: "pong" });
        break;
      default:
        send(socket, { type: "error", message: "Unknown message type." });
    }
  });

  socket.on("close", () => leaveRoom(socket));
  socket.on("error", () => leaveRoom(socket));
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.players.length < 2 && now - room.createdAt > 30 * 60 * 1000) {
      room.players.forEach(player => {
        send(player, { type: "error", message: "Room expired." });
        player.roomCode = null;
        player.playerIndex = null;
      });
      rooms.delete(room.code);
    }
  }
  if (randomWaiting && randomWaiting.readyState !== WebSocket.OPEN) {
    randomWaiting = null;
  }
}, 30000);

httpServer.listen(PORT, () => {
  console.log(`Carrom Royale WebSocket server listening on ws://localhost:${PORT}`);
  if (CORS_ORIGINS.length === 0) {
    console.log("CORS_ORIGINS is unset; allowing all origins");
  } else {
    console.log(`CORS origins: ${CORS_ORIGINS.join(", ")}`);
  }
});
