// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Store } = require('./store');

const PORT = process.env.PORT || 8080;
const store = new Store();

// Serve the client as a normal webpage. We read the file fresh on each
// request rather than caching it in memory, so updates to client/index.html
// show up on the next deploy without needing a server restart logic change.
const CLIENT_PATH = path.join(__dirname, '..', 'client', 'index.html');

const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(CLIENT_PATH, 'utf8', (err, html) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Could not load client.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// Attach the WebSocket server to the SAME http server/port, rather than
// opening a second one. Render only exposes a single PORT publicly, so
// both the webpage and the game connection need to share it.
const wss = new WebSocketServer({ server: httpServer });

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

    if (type === 'signup') {
      const result = store.signup(msg.loginName, msg.password);
      if (!result.success) {
        send(ws, 'signup_result', { success: false, reason: result.reason });
        return;
      }
      player = result.player;
      send(ws, 'signup_result', {
        success: true,
        playerId: player.id,
        token: result.token,
        collection: [],
      });
      return;
    }

    if (type === 'login') {
      const result = store.login(msg.loginName, msg.password);
      if (!result.success) {
        send(ws, 'login_result', { success: false, reason: result.reason });
        return;
      }
      player = result.player;
      send(ws, 'login_result', {
        success: true,
        playerId: player.id,
        token: result.token,
        collection: store.getCollection(player.id),
      });
      return;
    }

    // Attaches login credentials to the CURRENT anonymous session, so an
    // existing collection (built up before signing up) isn't lost.
    if (type === 'attach_account') {
      if (!player) {
        send(ws, 'attach_account_result', { success: false, reason: 'NOT_IDENTIFIED' });
        return;
      }
      const result = store.attachAccountToPlayer(player.id, msg.loginName, msg.password);
      send(ws, 'attach_account_result', { success: result.success, reason: result.reason || null });
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

httpServer.listen(PORT, () => {
  console.log(`Username game serving page + websocket on port ${PORT}`);
});
