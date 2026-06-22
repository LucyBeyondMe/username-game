// server.js
const { WebSocketServer } = require('ws');
const { Store } = require('./store');

const PORT = process.env.PORT || 8080;
const store = new Store();

const wss = new WebSocketServer({ port: PORT });

function send(ws, type, payload) {
  ws.send(JSON.stringify({ type, ...payload }));
}

wss.on('connection', (ws) => {
  // Identity is established AFTER the client sends `hello` (with or
  // without a reconnect token). Nothing else is processed until then.
  let player = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, 'error', { reason: 'INVALID_JSON' });
      return;
    }

    const { type } = msg;

    // --- Identity handshake ---
    if (type === 'hello') {
      if (msg.token) {
        const existing = store.getPlayerByToken(msg.token);
        if (existing) {
          player = existing;
          send(ws, 'welcome', {
            playerId: player.id,
            token: msg.token,
            resumed: true,
            collection: store.getCollection(player.id),
          });
          return;
        }
        // Bad/expired token: fall through and issue a brand-new identity.
      }
      const { player: newPlayer, token } = store.createPlayer();
      player = newPlayer;
      send(ws, 'welcome', {
        playerId: player.id,
        token,
        resumed: false,
        collection: [],
      });
      return;
    }

    // Everything below requires an established identity.
    if (!player) {
      send(ws, 'error', { reason: 'NOT_IDENTIFIED' });
      return;
    }

    if (type === 'claim_username') {
      const value = msg.value;
      const result = store.claimUsername(player.id, value);
      send(ws, 'claim_result', {
        value,
        success: result.success,
        reason: result.reason || null,
        collectionCount: store.getPlayerCollectionCount(player.id),
      });
      return;
    }

    if (type === 'get_my_usernames') {
      send(ws, 'my_usernames', {
        collection: store.getCollection(player.id),
      });
      return;
    }

    if (type === 'get_stats') {
      send(ws, 'stats', {
        totalClaimed: store.getTotalClaimedCount(),
        myCount: store.getPlayerCollectionCount(player.id),
      });
      return;
    }

    send(ws, 'error', { reason: 'UNKNOWN_MESSAGE_TYPE' });
  });
});

console.log(`Username game server listening on ws://localhost:${PORT}`);
