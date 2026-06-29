import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

// ==============================================================
// osu!droid+ Multiplayer Server
// Minimal implementation compatible with the osu!droid+ client.
// ==============================================================

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// ----- State -----

const rooms = new Map();
let nextRoomId = 1;

// ==============================================================
// REST API
// ==============================================================

/**
 * GET /getrooms
 * Returns an empty list (no persistent rooms in this minimal server).
 * Query params are accepted for compatibility but ignored.
 */
app.get("/getrooms", (req, res) => {
  console.log("[REST] GET /getrooms", req.query);
  res.json([]);
});

/**
 * POST /createroom
 * Creates a mock room and returns its data.
 * The actual room is created lazily on the first Socket.IO connection.
 */
app.post("/createroom", (req, res) => {
  const roomId = String(nextRoomId++);
  console.log("[REST] POST /createroom -> room", roomId, req.body);

  res.json({
    id: roomId,
    name: req.body.name || "New Room",
    isLocked: false,
    maxPlayers: req.body.maxPlayers || 8,
    mods: [],
    gameplaySettings: {
      isFreeMod: false,
      isRemoveSliderLock: false,
    },
    teamMode: 0,
    winCondition: 0,
    playerCount: 0,
    playerNames: "",
    status: 0,
  });
});

// ==============================================================
// Socket.IO — Room Namespaces
//
// The client connects to "http://<host>/<roomId>", which Socket.IO
// treats as a namespace.  We match every numeric namespace.
// ==============================================================

io.of(/^\/\d+$/).on("connection", (socket) => {
  const roomId = socket.nsp.name.slice(1); // strip leading "/"
  const auth = socket.handshake.auth || {};
  const uid = auth.uid || "0";
  const gameSessionId = auth.gameSessionID || "";
  const version = parseInt(auth.version || "0");
  const password = auth.password || "";
  const username = auth.username || `Player${uid}`;

  console.log(`[Room ${roomId}] 🔌 Connection: uid=${uid}, version=${version}`);

  // ----- Ensure room state exists -----
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      name: `Room ${roomId}`,
      isLocked: false,
      maxPlayers: 8,
      mods: [],
      gameplaySettings: { isFreeMod: false, isRemoveSliderLock: false },
      teamMode: 0,
      winCondition: 0,
      playerCount: 0,
      playerNames: "",
      status: 0,
      host: { id: uid },
      beatmap: null,
      sessionId: gameSessionId,
      hostUid: uid,
      password: null,
      gameStarted: false,
      players: new Map(),
      loadedPlayers: new Set(),
      skipPlayers: new Set(),
      failedPlayers: new Set(),
      scores: [],
    });
  }

  const room = rooms.get(roomId);

  // First player becomes host
  if (room.players.size === 0) {
    room.hostUid = uid;
    room.host = { id: uid };
  }

  // ----- Player object -----
  const player = {
    id: uid,
    socketId: socket.id,
    name: username,
    status: 0,
    mods: [],
    team: null,
    isHost: uid === room.hostUid,
    loaded: false,
    skipped: false,
    failed: false,
  };

  room.players.set(socket.id, player);
  updateRoomMetadata(room);

  // ----- initialConnection (server → client) -----
  const initialData = {
    id: roomId,
    name: room.name,
    isLocked: !!room.password,
    maxPlayers: room.maxPlayers,
    mods: room.mods,
    gameplaySettings: room.gameplaySettings,
    teamMode: room.teamMode,
    winCondition: room.winCondition,
    playerCount: room.players.size,
    playerNames: room.playerNames,
    sessionId: room.sessionId,
    host: { id: room.hostUid },
    beatmap: room.beatmap,
    status: room.gameStarted ? 2 : 0,
    players: Array.from(room.players.values()).map((p) => ({
      id: parseInt(p.id),
      username: p.name,
      status: p.status,
      mods: p.mods,
      team: p.team,
      isHost: p.isHost,
    })),
  };

  socket.emit("initialConnection", initialData);

  // ----- Broadcast join -----
  const joinPayload = {
    id: parseInt(uid),
    username: player.name,
    status: player.status,
    mods: player.mods,
    team: player.team,
    isHost: player.isHost,
  };
  socket.nsp.emit("playerJoined", joinPayload);
  socket.nsp.emit("onRoomPlayerJoin", joinPayload);

  console.log(
    `[Room ${roomId}] 👤 Player ${uid} (${player.name}) joined. Total: ${room.players.size}`,
  );

  // ============================================================
  //  Client → Server  event handlers
  // ============================================================

  // ---------- beatmapChanged ----------
  const onBeatmapChanged = (data) => {
    const beatmap = typeof data === "string" ? JSON.parse(data) : data;
    room.beatmap = beatmap;
    console.log(`[Room ${roomId}] 📋 beatmapChanged by ${uid}`);
    broadcastRoom("beatmapChanged", beatmap);
    broadcastRoom("onRoomBeatmapChange", beatmap);
  };

  // ---------- playerKicked ----------
  const onPlayerKicked = (targetUidStr) => {
    const targetUid =
      typeof targetUidStr === "string" ? targetUidStr : String(targetUidStr);
    console.log(`[Room ${roomId}] 👢 kick ${targetUid} by ${uid}`);
    broadcastRoom("playerKicked", targetUid);

    for (const [sid, p] of room.players) {
      if (p.id === targetUid) {
        const sock = io.of(socket.nsp.name).sockets.get(sid);
        if (sock) sock.disconnect(true);
        room.players.delete(sid);
        break;
      }
    }
  };

  // ---------- playBeatmap (start game) ----------
  const onPlayBeatmap = () => {
    console.log(`[Room ${roomId}] 🎮 playBeatmap by ${uid}`);
    room.gameStarted = true;
    room.loadedPlayers.clear();
    room.skipPlayers.clear();
    room.failedPlayers.clear();
    room.scores = [];
    broadcastRoom("playBeatmap");
    broadcastRoom("onGameStart");
  };

  // ---------- hostChanged ----------
  const onHostChanged = (newUidStr) => {
    const newUid =
      typeof newUidStr === "string" ? newUidStr : String(newUidStr);
    room.hostUid = newUid;
    room.host = { id: newUid };
    for (const p of room.players.values()) p.isHost = p.id === newUid;
    console.log(`[Room ${roomId}] 👑 host → ${newUid} by ${uid}`);
    broadcastRoom("hostChanged", newUid);
    broadcastRoom("onRoomHostChange", parseInt(newUid));
  };

  // ---------- room settings ----------
  const onRoomModsChanged = (mods) => {
    room.mods = mods;
    console.log(`[Room ${roomId}] 🔧 roomModsChanged by ${uid}`);
    broadcastRoom("roomModsChanged", mods);
    broadcastRoom("onRoomSettingsChange", { type: "mods", mods });
  };

  const onRoomGameplaySettingsChanged = (settings) => {
    Object.assign(room.gameplaySettings, settings);
    console.log(`[Room ${roomId}] ⚙️ gameplaySettings by ${uid}`);
    broadcastRoom("roomGameplaySettingsChanged", settings);
    broadcastRoom("onRoomSettingsChange", {
      type: "gameplaySettings",
      settings,
    });
  };

  const onTeamModeChanged = (mode) => {
    room.teamMode = mode;
    console.log(`[Room ${roomId}] 🏳️ teamMode → ${mode} by ${uid}`);
    broadcastRoom("teamModeChanged", mode);
    broadcastRoom("onRoomSettingsChange", { type: "teamMode", mode });
  };

  const onWinConditionChanged = (cond) => {
    room.winCondition = cond;
    console.log(`[Room ${roomId}] 🏆 winCondition → ${cond} by ${uid}`);
    broadcastRoom("winConditionChanged", cond);
    broadcastRoom("onRoomSettingsChange", {
      type: "winCondition",
      condition: cond,
    });
  };

  const onRoomNameChanged = (name) => {
    room.name = name;
    updateRoomMetadata(room);
    console.log(`[Room ${roomId}] 📝 name → "${name}" by ${uid}`);
    broadcastRoom("roomNameChanged", name);
    broadcastRoom("onRoomSettingsChange", { type: "name", name });
  };

  const onMaxPlayersChanged = (max) => {
    room.maxPlayers = parseInt(max);
    console.log(`[Room ${roomId}] 👥 maxPlayers → ${max} by ${uid}`);
    broadcastRoom("maxPlayersChanged", max);
    broadcastRoom("onRoomSettingsChange", {
      type: "maxPlayers",
      maxPlayers: room.maxPlayers,
    });
  };

  const onRoomPasswordChanged = (pw) => {
    room.password = pw;
    room.isLocked = !!pw;
    console.log(
      `[Room ${roomId}] 🔒 password ${pw ? "set" : "removed"} by ${uid}`,
    );
  };

  // ---------- score ----------
  const onScoreSubmission = (data) => {
    room.scores.push({ uid, ...data });
    console.log(
      `[Room ${roomId}] 📊 score by ${uid} (${room.scores.length}/${room.players.size})`,
    );

    if (room.scores.length >= room.players.size) {
      const results = room.scores.map((s) => ({ ...s }));
      broadcastRoom("allPlayersScoreSubmitted", results);
      broadcastRoom("onGameFinish", results);
      room.gameStarted = false;
      console.log(`[Room ${roomId}] 🏁 Game finished!`);
    }
  };

  const onLiveScoreData = (data) => {
    broadcastRoom("liveScoreData", data);
    broadcastRoom("onScoreUpdate", data);
  };

  // ---------- loading / skip / fail ----------
  const onBeatmapLoadComplete = () => {
    room.loadedPlayers.add(uid);
    console.log(
      `[Room ${roomId}] ✅ loaded by ${uid} (${room.loadedPlayers.size}/${room.players.size})`,
    );
    broadcastRoom("onPlayerLoaded", parseInt(uid));

    if (room.loadedPlayers.size >= room.players.size) {
      broadcastRoom("allPlayersBeatmapLoadComplete");
      broadcastRoom("onGameAllLoaded");
      console.log(`[Room ${roomId}] 🎯 All players loaded!`);
    }
  };

  const onSkipRequested = () => {
    room.skipPlayers.add(uid);
    console.log(
      `[Room ${roomId}] ⏭️ skip by ${uid} (${room.skipPlayers.size}/${room.players.size})`,
    );
    broadcastRoom("onPlayerSkip", parseInt(uid));

    if (room.skipPlayers.size >= room.players.size) {
      broadcastRoom("allPlayersSkipRequested");
      broadcastRoom("onGameAllSkip");
      console.log(`[Room ${roomId}] ⏩ All players skipped!`);
    }
  };

  const onPlayerFailed = () => {
    room.failedPlayers.add(uid);
    console.log(`[Room ${roomId}] 💀 failed by ${uid}`);
    broadcastRoom("onPlayerFailed", parseInt(uid));
  };

  // ---------- chat ----------
  const onChatMessage = (message) => {
    console.log(`[Room ${roomId}] 💬 ${uid}: ${message}`);
    broadcastRoom("chatMessage", uid, message);
    broadcastRoom("onRoomChatMessage", parseInt(uid), message);
  };

  // ---------- player state ----------
  const onPlayerStatusChanged = (status) => {
    player.status = status;
    broadcastRoom("playerStatusChanged", uid, status);
    broadcastRoom("onRoomSettingsChange", {
      type: "playerStatus",
      id: parseInt(uid),
      status,
    });
  };

  const onPlayerModsChanged = (mods) => {
    player.mods = mods;
    broadcastRoom("playerModsChanged", uid, mods);
    broadcastRoom("onRoomSettingsChange", {
      type: "playerMods",
      id: parseInt(uid),
      mods,
    });
  };

  const onTeamChanged = (team) => {
    player.team = team;
    console.log(`[Room ${roomId}] 🔄 team → ${team} by ${uid}`);
    broadcastRoom("teamChanged", uid, team);
    broadcastRoom("onRoomPlayerTeam", parseInt(uid), team);
  };

  // ---------- user-defined aliases ----------
  const onJoinRoom = () => {
    console.log(`[Room ${roomId}] joinRoom by ${uid} (already in room)`);
  };

  const onLeaveRoom = () => {
    console.log(`[Room ${roomId}] leaveRoom by ${uid}`);
    socket.disconnect(true);
  };

  const onPlayerSettings = (settings) => {
    console.log(`[Room ${roomId}] playerSettings by ${uid}:`, settings);
    if (settings.status !== undefined) player.status = settings.status;
    if (settings.mods !== undefined) player.mods = settings.mods;
    if (settings.team !== undefined) player.team = settings.team;
    broadcastRoom("onRoomSettingsChange", {
      type: "playerSettings",
      id: parseInt(uid),
      ...settings,
    });
  };

  // ---------- Register all listeners ----------

  // Actual client events
  socket.on("beatmapChanged", onBeatmapChanged);
  socket.on("playerKicked", onPlayerKicked);
  socket.on("playBeatmap", onPlayBeatmap);
  socket.on("hostChanged", onHostChanged);
  socket.on("roomModsChanged", onRoomModsChanged);
  socket.on("roomGameplaySettingsChanged", onRoomGameplaySettingsChanged);
  socket.on("teamModeChanged", onTeamModeChanged);
  socket.on("winConditionChanged", onWinConditionChanged);
  socket.on("roomNameChanged", onRoomNameChanged);
  socket.on("maxPlayersChanged", onMaxPlayersChanged);
  socket.on("roomPasswordChanged", onRoomPasswordChanged);
  socket.on("scoreSubmission", onScoreSubmission);
  socket.on("liveScoreData", onLiveScoreData);
  socket.on("beatmapLoadComplete", onBeatmapLoadComplete);
  socket.on("skipRequested", onSkipRequested);
  socket.on("playerFailed", onPlayerFailed);
  socket.on("chatMessage", onChatMessage);
  socket.on("playerStatusChanged", onPlayerStatusChanged);
  socket.on("playerModsChanged", onPlayerModsChanged);
  socket.on("teamChanged", onTeamChanged);

  // User-defined / future event aliases
  socket.on("joinRoom", onJoinRoom);
  socket.on("leaveRoom", onLeaveRoom);
  socket.on("startGame", onPlayBeatmap);
  socket.on("finishGame", onScoreSubmission);
  socket.on("updateBeatmap", onBeatmapChanged);
  socket.on("updateMods", onPlayerModsChanged);
  socket.on("updateTeam", onTeamChanged);
  socket.on("playerSettings", onPlayerSettings);
  socket.on("playerSkip", onSkipRequested);
  socket.on("playerLoaded", onBeatmapLoadComplete);

  // ---------- disconnect ----------
  socket.on("disconnect", (reason) => {
    console.log(`[Room ${roomId}] ⬅️ Player ${uid} disconnected: ${reason}`);

    room.players.delete(socket.id);
    room.loadedPlayers.delete(uid);
    room.skipPlayers.delete(uid);
    room.failedPlayers.delete(uid);

    if (room.players.size === 0) {
      rooms.delete(roomId);
      console.log(`[Room ${roomId}] 🗑️ Room deleted (empty)`);
    } else {
      updateRoomMetadata(room);
      broadcastRoom("playerLeft", uid);
      broadcastRoom("onRoomPlayerLeave", parseInt(uid));

      // Transfer host if the host left
      if (room.hostUid === uid) {
        const next = room.players.values().next().value;
        if (next) {
          room.hostUid = next.id;
          room.host = { id: next.id };
          next.isHost = true;
          broadcastRoom("hostChanged", next.id);
          broadcastRoom("onRoomHostChange", parseInt(next.id));
          console.log(`[Room ${roomId}] 👑 Host transferred to ${next.id}`);
        }
      }
    }
  });

  // ---------- helper ----------
  function broadcastRoom(event, ...args) {
    socket.nsp.emit(event, ...args);
  }
});

// ----- Utilities -----

function updateRoomMetadata(room) {
  room.playerNames = Array.from(room.players.values())
    .map((p) => p.name)
    .join(", ");
  room.playerCount = room.players.size;
}

// ==============================================================
// Start
// ==============================================================

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║     osu!droid+ Multiplayer Server        ║
║──────────────────────────────────────────║
║  REST API  : http://localhost:${PORT}        ║
║  Socket.IO : http://localhost:${PORT}/:id    ║
╚══════════════════════════════════════════╝
  `);
});
