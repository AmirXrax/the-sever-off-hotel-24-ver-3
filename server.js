'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = 96;
const FLOOR_CAPACITY = 4;
const MIN_FLOOR = -3;
const MAX_FLOOR = 24;
const RESERVATION_MS = 24 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOCAL_STATE_FILE = path.join(DATA_DIR, 'hotel-state.json');

const players = new Map();
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const SHOP_TYPES = [
  { id: 'phone', name: 'گوشی‌فروشی', icon: '📱' },
  { id: 'butcher', name: 'گوشت‌فروشی', icon: '🥩' },
  { id: 'pets', name: 'حیوانات خانگی', icon: '🐾' },
  { id: 'market', name: 'سوپرمارکت', icon: '🛒' },
  { id: 'school', name: 'مدرسه', icon: '🏫' },
  { id: 'eggs', name: 'تخم‌فروشی', icon: '🥚' },
  { id: 'secondhand', name: 'دست‌دوم‌فروشی', icon: '♻️' },
  { id: 'restaurant', name: 'رستوران', icon: '🍽️' }
];

let shops = {};
const SHOP_ITEMS = {
  phone: [{id:'phone',name:'گوشی ساده',icon:'📱',price:80,kind:'gear'},{id:'battery',name:'باتری اضافه',icon:'🔋',price:15,kind:'gear'}],
  butcher: [{id:'meat',name:'گوشت',icon:'🥩',price:12,kind:'food',heal:18,hunger:35},{id:'steak',name:'استیک',icon:'🍖',price:25,kind:'food',heal:35,hunger:60}],
  pets: [{id:'pet_hat',name:'کلاه حیوانات',icon:'🐾',price:30,kind:'clothes'}],
  market: [{id:'bread',name:'نان',icon:'🍞',price:8,kind:'food',heal:8,hunger:25},{id:'apple',name:'سیب',icon:'🍎',price:6,kind:'food',heal:5,hunger:18},{id:'water',name:'آب',icon:'💧',price:5,kind:'food',heal:2,hunger:12}],
  school: [{id:'uniform',name:'لباس مدرسه',icon:'🎓',price:20,kind:'clothes'}],
  eggs: [{id:'egg',name:'تخم‌مرغ',icon:'🥚',price:7,kind:'food',heal:7,hunger:20}],
  secondhand: [{id:'coat',name:'کت دست‌دوم',icon:'🧥',price:18,kind:'clothes'},{id:'cap',name:'کلاه',icon:'🧢',price:10,kind:'clothes'}],
  restaurant: [{id:'meal',name:'وعده غذا',icon:'🍲',price:20,kind:'food',heal:25,hunger:55}]
};
let pool = null;
let storageMode = 'local';
let saveChain = Promise.resolve();
let lastSaveErrorAt = 0;

function randomShops() {
  const result = {};
  for (let floor = MIN_FLOOR; floor <= MAX_FLOOR; floor += 1) {
    result[floor] = SHOP_TYPES[crypto.randomInt(SHOP_TYPES.length)];
  }
  return result;
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('صفحه پیدا نشد');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, storage: storageMode, online: onlineCount(), residents: players.size }));
    return;
  }
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  sendFile(res, filePath);
});

const io = new Server(server, {
  serveClient: true,
  maxHttpBufferSize: 10_000,
  pingInterval: 25_000,
  pingTimeout: 20_000
});

function onlineCount() {
  let count = 0;
  for (const player of players.values()) if (player.connected) count += 1;
  return count;
}

function countOnFloor(floor) {
  let count = 0;
  for (const player of players.values()) if (player.floor === floor) count += 1;
  return count;
}

function getOccupancy() {
  const occupancy = {};
  for (let floor = MIN_FLOOR; floor <= MAX_FLOOR; floor += 1) occupancy[floor] = 0;
  for (const player of players.values()) occupancy[player.floor] += 1;
  return occupancy;
}

function publicState() {
  return {
    players: [...players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      floor: player.floor,
      maxFloor: player.maxFloor,
      color: player.color,
      hasKey: player.hasKey,
      health: player.health ?? 100, hunger: player.hunger ?? 100, coins: player.coins ?? 100, inventory: player.inventory || [], equipped: player.equipped || null,
      online: Boolean(player.connected),
      inHouse: Boolean(player.houseRoomId),
      reservedUntil: player.reservedUntil || null
    })),
    occupancy: getOccupancy(),
    online: onlineCount(),
    residents: players.size,
    maxPlayers: MAX_PLAYERS,
    floorCapacity: FLOOR_CAPACITY,
    floors: { min: MIN_FLOOR, max: MAX_FLOOR },
    shops,
    zombies: zombies.map((zombie) => ({ ...zombie, active: true }))
  };
}

function broadcastState() {
  io.emit('worldState', publicState());
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18);
}

function cleanToken(value) {
  if (typeof value !== 'string') return '';
  const token = value.trim();
  return /^[a-f0-9-]{32,40}$/i.test(token) ? token : '';
}

function reply(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

const COLORS = ['#ffca74', '#8bd5c6', '#b7a3ef', '#f39bb4', '#8ebcf3', '#b2d58a', '#f2a875', '#a7b6c7'];

const HOUSE_INVITE_TTL_MS = 30_000;
const MINI_GAME_DURATION_MS = 45_000;
const MINI_GAME_COOLDOWN_MS = 350;
const houseRooms = new Map();
const houseInvites = new Map();
const zombies = [
  { id: 'zombie-minus-1', floor: -1, name: 'زامبی راهرو' },
  { id: 'zombie-minus-2', floor: -2, name: 'زامبی زیرزمین' },
  { id: 'zombie-minus-3', floor: -3, name: 'زامبی تاریکی' }
];
const MINI_GAMES = {
  football: { title: 'فوتبال', icon: '⚽', action: 'شوت بزن!', description: 'در ۴۵ ثانیه بیشتر گل بزن.' },
  pingpong: { title: 'پینگ‌پنگ', icon: '🏓', action: 'ضربه بزن!', description: 'توپ را برگردان و امتیاز جمع کن.' },
  race: { title: 'مسابقه ماشین', icon: '🏁', action: 'گاز بده!', description: 'با هر بار گاز دادن جلو می‌روی.' },
  puzzle: { title: 'مسابقه معما', icon: '🧩', action: 'پاسخ بده', description: 'پاسخ درست ۳ امتیاز دارد.' },
  target: { title: 'هدف‌گیری با توپ', icon: '🎯', action: 'توپ پرتاب کن!', description: 'هدف‌های فانتزی را بزن و امتیاز بگیر.' },
  basketball: { title: 'بسکتبال', icon: '🏀', action: 'پرتاب کن!', description: 'هر پرتاب موفق ۲ امتیاز دارد.' },
  record: { title: 'رکوردزنی', icon: '🕹️', action: 'امتیاز بگیر!', description: 'در زمان محدود تا می‌توانی امتیاز جمع کن.' }
};
const PUZZLES = [
  { text: 'حاصل ۲ + ۳ چند می‌شود؟', options: ['۴', '۵', '۶'], answerIndex: 1 },
  { text: 'کدام حیوان میو میو می‌کند؟', options: ['گربه', 'سگ', 'اسب'], answerIndex: 0 },
  { text: 'یک هفته چند روز دارد؟', options: ['۵', '۶', '۷'], answerIndex: 2 },
  { text: 'کدام‌یک وسیلهٔ نقلیه است؟', options: ['صندلی', 'دوچرخه', 'مداد'], answerIndex: 1 },
  { text: 'بعد از عدد ۹ چه عددی می‌آید؟', options: ['۸', '۱۰', '۱۱'], answerIndex: 1 }
];

function connectedPlayer(socket) {
  const playerId = socket.data.playerId;
  const player = playerId ? players.get(playerId) : null;
  if (!player || !player.connected || player.socketId !== socket.id) return null;
  return player;
}

function roomPublicState(room) {
  const members = room.playerIds.map((id) => players.get(id)).filter(Boolean);
  let game = null;
  if (room.game) {
    const scores = members.map((player) => ({
      id: player.id,
      name: player.name,
      score: room.game.scores[player.id] || 0
    }));
    const puzzle = room.game.gameId === 'puzzle' ? PUZZLES[room.game.puzzleIndex % PUZZLES.length] : null;
    game = {
      gameId: room.game.gameId,
      title: MINI_GAMES[room.game.gameId].title,
      icon: MINI_GAMES[room.game.gameId].icon,
      action: MINI_GAMES[room.game.gameId].action,
      description: MINI_GAMES[room.game.gameId].description,
      endsAt: room.game.endsAt,
      ended: room.game.ended,
      winnerId: room.game.winnerId || null,
      resultText: room.game.resultText || '',
      scores,
      question: puzzle ? { text: puzzle.text, options: puzzle.options } : null
    };
  }
  return {
    roomId: room.id,
    floor: room.floor,
    players: members.map((player) => ({ id: player.id, name: player.name, color: player.color })),
    game
  };
}

function emitHouseRoom(room) {
  if (!room || !houseRooms.has(room.id)) return;
  const state = roomPublicState(room);
  io.to(`house:${room.id}`).emit('houseRoomState', state);
}

function closeHouseRoom(room, message = 'اتاق خانه بسته شد.') {
  if (!room || !houseRooms.has(room.id)) return;
  houseRooms.delete(room.id);
  for (const id of room.playerIds) {
    const player = players.get(id);
    if (!player) continue;
    if (player.socketId) {
      const memberSocket = io.sockets.sockets.get(player.socketId);
      if (memberSocket) {
        memberSocket.leave(`house:${room.id}`);
        memberSocket.emit('houseRoomClosed', { message });
      }
    }
    player.houseRoomId = null;
  }
}

function finishMiniGame(room) {
  if (!room || !houseRooms.has(room.id) || !room.game || room.game.ended) return;
  room.game.ended = true;
  const ranked = room.playerIds.map((id) => ({ id, score: room.game.scores[id] || 0 }));
  const topScore = Math.max(...ranked.map((item) => item.score));
  const winners = ranked.filter((item) => item.score === topScore);
  room.game.winnerId = winners.length === 1 ? winners[0].id : null;
  room.game.resultText = winners.length > 1 ? 'مساوی شد! هر دو عالی بودید.' : `برنده: ${players.get(winners[0].id)?.name || 'بازیکن'} 🎉`;
  emitHouseRoom(room);
}

function removeInvitesFor(playerId) {
  for (const [inviteId, invite] of houseInvites) {
    if (invite.fromId === playerId || invite.toId === playerId) houseInvites.delete(inviteId);
  }
}

function leaveHouseForPlayer(player, message) {
  if (!player?.houseRoomId) return;
  const room = houseRooms.get(player.houseRoomId);
  if (room) closeHouseRoom(room, message || `${player.name} از خانه خارج شد.`);
  else player.houseRoomId = null;
}

function pruneExpiredPlayers() {
  const now = Date.now();
  let changed = false;
  for (const [id, player] of players) {
    if (!player.connected && player.reservedUntil && player.reservedUntil <= now) {
      players.delete(id);
      changed = true;
    }
  }
  return changed;
}

function serializeState() {
  const now = Date.now();
  const savedPlayers = [...players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    floor: player.floor,
    maxFloor: player.maxFloor,
    color: player.color,
    hasKey: player.hasKey,
    health: player.health ?? 100, hunger: player.hunger ?? 100, coins: player.coins ?? 100, inventory: player.inventory || [], equipped: player.equipped || null,
    connected: Boolean(player.connected),
    disconnectedAt: player.disconnectedAt || null,
    reservedUntil: player.connected ? null : player.reservedUntil,
    lastSeenAt: player.connected ? now : (player.lastSeenAt || player.disconnectedAt || now),
    joinedAt: player.joinedAt
  }));
  return { version: 2, players: savedPlayers, shops };
}

function persistState() {
  const snapshot = serializeState();
  saveChain = saveChain.then(async () => {
    if (storageMode === 'postgres' && pool) {
      await pool.query(
        `INSERT INTO hotel96_state (id, data, updated_at)
         VALUES (1, $1::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [JSON.stringify(snapshot)]
      );
      return;
    }
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tempFile = `${LOCAL_STATE_FILE}.tmp`;
    await fs.promises.writeFile(tempFile, JSON.stringify(snapshot), 'utf8');
    await fs.promises.rename(tempFile, LOCAL_STATE_FILE);
  }).catch((error) => {
    if (Date.now() - lastSaveErrorAt > 30_000) {
      console.error('HOTEL96 save failed:', error.message);
      lastSaveErrorAt = Date.now();
    }
  });
  return saveChain;
}

async function loadState() {
  let saved = null;
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hotel96_state (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const result = await pool.query('SELECT data FROM hotel96_state WHERE id = 1');
    if (result.rows[0]) saved = result.rows[0].data;
    storageMode = 'postgres';
    console.log('HOTEL96 persistent storage: PostgreSQL');
  } else {
    try {
      saved = JSON.parse(await fs.promises.readFile(LOCAL_STATE_FILE, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read local save:', error.message);
    }
    storageMode = 'local';
    console.warn('WARNING: DATABASE_URL is not set. Local JSON saves may be lost when deployed on Render.');
  }

  if (saved && Array.isArray(saved.players)) {
    const now = Date.now();
    for (const item of saved.players) {
      if (!item || !item.id || !Number.isInteger(item.floor)) continue;
      const lastSeenAt = Number(item.lastSeenAt) || now;
      const reservedUntil = item.connected
        ? lastSeenAt + RESERVATION_MS
        : (Number(item.reservedUntil) || (Number(item.disconnectedAt || lastSeenAt) + RESERVATION_MS));
      if (reservedUntil <= now) continue;
      players.set(item.id, {
        id: item.id,
        name: cleanName(item.name) || 'بازیکن',
        floor: item.floor,
        maxFloor: Number.isInteger(item.maxFloor) ? item.maxFloor : item.floor,
        color: item.color || COLORS[0],
        hasKey: Boolean(item.hasKey),
        health: Number.isFinite(item.health) ? Math.max(0, Math.min(100,item.health)) : 100, hunger: Number.isFinite(item.hunger) ? Math.max(0, Math.min(100,item.hunger)) : 100, coins: Number.isFinite(item.coins) ? item.coins : 100, inventory: Array.isArray(item.inventory) ? item.inventory : [], equipped: item.equipped || null,
        connected: false,
        socketId: null,
        disconnectedAt: Number(item.disconnectedAt) || lastSeenAt,
        reservedUntil,
        lastSeenAt,
        joinedAt: Number(item.joinedAt) || now
      });
    }
    if (saved.shops && typeof saved.shops === 'object') shops = saved.shops;
  }
  if (!shops || Object.keys(shops).length === 0) shops = randomShops();
  pruneExpiredPlayers();
  await persistState();
}

function enterPlayer(socket, player, callback, resumed) {
  player.connected = true;
  player.socketId = socket.id;
  player.disconnectedAt = null;
  player.reservedUntil = null;
  player.lastSeenAt = Date.now();
  socket.data.playerId = player.id;
  reply(callback, {
    ok: true,
    resumed,
    playerId: player.id,
    player: {
      id: player.id,
      name: player.name,
      floor: player.floor,
      maxFloor: player.maxFloor,
      color: player.color,
      hasKey: player.hasKey,
      health: player.health ?? 100, hunger: player.hunger ?? 100, coins: player.coins ?? 100, inventory: player.inventory || [], equipped: player.equipped || null,
      online: true
    }
  });
  void persistState();
  broadcastState();
}

io.on('connection', (socket) => {
  socket.emit('worldState', publicState());

  socket.on('join', (payload = {}, callback) => {
    pruneExpiredPlayers();
    const token = cleanToken(payload.token);
    const existing = token ? players.get(token) : null;

    if (payload.resumeOnly) {
      if (!existing) {
        reply(callback, { ok: false, expired: true, message: 'مهلت نگهداری شخصیتت تمام شده یا ذخیره‌ای پیدا نشد. دوباره طبقه انتخاب کن.' });
        return;
      }
      if (existing.connected && existing.socketId !== socket.id) {
        reply(callback, { ok: false, message: 'این شخصیت هم‌اکنون در دستگاه دیگری آنلاین است.' });
        return;
      }
      enterPlayer(socket, existing, callback, true);
      return;
    }

    if (existing) {
      if (existing.connected && existing.socketId !== socket.id) {
        reply(callback, { ok: false, message: 'این شخصیت هم‌اکنون در دستگاه دیگری آنلاین است.' });
        return;
      }
      enterPlayer(socket, existing, callback, true);
      return;
    }

    const name = cleanName(payload.name);
    const requestedFloor = Number(payload.floor);
    if (!token) {
      reply(callback, { ok: false, message: 'شناسه بازیکن معتبر نیست؛ صفحه را تازه‌سازی کن.' });
      return;
    }
    if (name.length < 2) {
      reply(callback, { ok: false, message: 'اسم باید حداقل ۲ حرف داشته باشد.' });
      return;
    }
    if (!Number.isInteger(requestedFloor) || requestedFloor < 1 || requestedFloor > 24) {
      reply(callback, { ok: false, message: 'طبقه باید بین ۱ تا ۲۴ باشد.' });
      return;
    }
    if (players.size >= MAX_PLAYERS) {
      reply(callback, { ok: false, message: 'ظرفیت کل هتل پر شده است؛ فعلاً نمی‌توانی وارد شوی.' });
      return;
    }
    if (countOnFloor(requestedFloor) >= FLOOR_CAPACITY) {
      reply(callback, { ok: false, message: `طبقه ${requestedFloor} پر است! نمی‌توانی وارد شوی؛ یک طبقه دیگر انتخاب کن.` });
      return;
    }

    const player = {
      id: token,
      name,
      floor: requestedFloor,
      maxFloor: requestedFloor,
      color: COLORS[crypto.randomInt(COLORS.length)],
      hasKey: false,
      health: 100, hunger: 100, coins: 100, inventory: [], equipped: null,
      connected: false,
      socketId: null,
      disconnectedAt: null,
      reservedUntil: null,
      lastSeenAt: Date.now(),
      joinedAt: Date.now()
    };
    players.set(token, player);
    enterPlayer(socket, player, callback, false);
  });

  socket.on('moveFloor', (payload = {}, callback) => {
    const playerId = socket.data.playerId;
    const player = playerId ? players.get(playerId) : null;
    if (!player || !player.connected || player.socketId !== socket.id) {
      reply(callback, { ok: false, message: 'اول باید وارد هتل شوی.' });
      return;
    }

    if (player.houseRoomId) {
      reply(callback, { ok: false, message: 'اول از خانه مشترک خارج شو، بعد آسانسور را استفاده کن.' });
      return;
    }
    const target = Number(payload.floor);
    if (!Number.isInteger(target) || target < MIN_FLOOR || target > MAX_FLOOR) {
      reply(callback, { ok: false, message: 'این طبقه وجود ندارد.' });
      return;
    }
    if (target === player.floor) {
      reply(callback, { ok: false, message: 'الان همین طبقه هستی.' });
      return;
    }
    if (target > player.maxFloor) {
      reply(callback, { ok: false, message: `حد بالای تو طبقه ${player.maxFloor} است؛ بالاتر نمی‌توانی بروی.` });
      return;
    }
    if (target < 0 && !player.hasKey) {
      reply(callback, { ok: false, message: 'برای رفتن به زیرزمین اول باید کلید طبقه صفر را برداری.' });
      return;
    }
    if (target < 0 && player.floor > 0) {
      reply(callback, { ok: false, message: 'اول باید از طبقه ۱ وارد طبقه صفر شوی.' });
      return;
    }
    if (target === 0 && !player.hasKey) {
      reply(callback, { ok: false, message: 'درِ طبقه صفر قفل است. اول در طبقه ۱ کلید را پیدا کن.' });
      return;
    }
    if (countOnFloor(target) >= FLOOR_CAPACITY) {
      reply(callback, { ok: false, message: `طبقه ${target} پر است! یک طبقه دیگر را امتحان کن.` });
      return;
    }

    const oldFloor = player.floor;
    player.floor = target;
    player.lastSeenAt = Date.now();
    reply(callback, { ok: true, message: `از طبقه ${oldFloor} به طبقه ${target} رفتی.` });
    void persistState();
    broadcastState();
  });

  socket.on('collectKey', (_payload, callback) => {
    const playerId = socket.data.playerId;
    const player = playerId ? players.get(playerId) : null;
    if (!player || !player.connected || player.socketId !== socket.id) {
      reply(callback, { ok: false, message: 'اول باید وارد هتل شوی.' });
      return;
    }
    if (player.floor !== 1) {
      reply(callback, { ok: false, message: 'جعبه کلید فقط در طبقه ۱ قرار دارد.' });
      return;
    }
    if (player.hasKey) {
      reply(callback, { ok: true, message: 'کلید را قبلاً برداشته‌ای.' });
      return;
    }
    player.hasKey = true;
    player.lastSeenAt = Date.now();
    reply(callback, { ok: true, message: 'کلید طبقه صفر را پیدا کردی! حالا در باز می‌شود.' });
    void persistState();
    broadcastState();
  });

  socket.on('shopBuy', (payload = {}, callback) => {
    const player = connectedPlayer(socket); if (!player) return reply(callback,{ok:false,message:'اول وارد بازی شو.'});
    const shop = shops[player.floor]; const item = (SHOP_ITEMS[shop?.id] || []).find(x => x.id === payload.itemId);
    if (!item) return reply(callback,{ok:false,message:'این کالا در فروشگاه این طبقه نیست.'});
    if ((player.coins ?? 100) < item.price) return reply(callback,{ok:false,message:'سکه کافی نداری.'});
    player.coins -= item.price; player.inventory ||= []; player.inventory.push({id:item.id,name:item.name,icon:item.icon,kind:item.kind,heal:item.heal||0,hunger:item.hunger||0});
    reply(callback,{ok:true,message:`${item.name} خریدی!`}); void persistState(); broadcastState();
  });
  socket.on('useItem', (payload = {}, callback) => {
    const player = connectedPlayer(socket); if (!player) return reply(callback,{ok:false,message:'اول وارد بازی شو.'});
    const index = (player.inventory||[]).findIndex(x=>x.id===payload.itemId); if(index<0) return reply(callback,{ok:false,message:'این وسیله در کیف نیست.'});
    const item=player.inventory[index];
    if(item.kind==='food') { player.health=Math.min(100,(player.health??100)+(item.heal||0)); player.hunger=Math.min(100,(player.hunger??100)+(item.hunger||0)); player.inventory.splice(index,1); }
    else if(item.kind==='clothes') { player.equipped=item.id; }
    else { return reply(callback,{ok:false,message:'فعلاً این وسیله قابل استفاده نیست.'}); }
    reply(callback,{ok:true,message:item.kind==='food'?'غذا خوردی و وضعیتت بهتر شد.':'لباست را پوشیدی.'}); void persistState(); broadcastState();
  });
  socket.on('attackPlayer', (payload = {}, callback) => {
    const player=connectedPlayer(socket), target=players.get(String(payload.targetId||''));
    if(!player) return reply(callback,{ok:false,message:'اول وارد بازی شو.'});
    if(!target || !target.connected || target.floor!==player.floor || target.id===player.id) return reply(callback,{ok:false,message:'بازیکن مناسبی برای حمله پیدا نشد.'});
    const now=Date.now(); if(player.lastAttackAt && now-player.lastAttackAt<1800) return reply(callback,{ok:false,message:'کمی صبر کن.'});
    player.lastAttackAt=now; target.health=Math.max(0,(target.health??100)-12);
    if(target.health===0) { target.health=35; target.floor=Math.max(1,Math.min(target.maxFloor,target.floor)); target.hunger=Math.max(0,(target.hunger??100)-10); io.to(target.socketId).emit('playerNotice',{message:'بیهوش شدی و به خانه برگشتی؛ کمی از جونت برگشت.'}); }
    reply(callback,{ok:true,message:`به ${target.name} ضربه زدی.`}); if(target.socketId) io.to(target.socketId).emit('playerNotice',{message:`${player.name} به تو ضربه زد!`}); void persistState(); broadcastState();
  });

  socket.on('houseInvite', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) {
      reply(callback, { ok: false, message: 'اول باید وارد هتل شوی.' });
      return;
    }
    if (player.houseRoomId) {
      reply(callback, { ok: false, message: 'الان داخل یک خانه مشترک هستی.' });
      return;
    }
    const target = players.get(String(payload.targetId || ''));
    if (!target || !target.connected || target.floor !== player.floor || target.id === player.id) {
      reply(callback, { ok: false, message: 'فقط می‌توانی یک بازیکن آنلاین از طبقه خودت را دعوت کنی.' });
      return;
    }
    if (target.houseRoomId) {
      reply(callback, { ok: false, message: 'این بازیکن الان داخل یک خانه مشترک است.' });
      return;
    }
    const inviteId = crypto.randomUUID();
    houseInvites.set(inviteId, { fromId: player.id, toId: target.id, floor: player.floor, createdAt: Date.now() });
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      targetSocket.emit('houseInviteReceived', {
        inviteId,
        from: { id: player.id, name: player.name, floor: player.floor }
      });
    }
    const timer = setTimeout(() => houseInvites.delete(inviteId), HOUSE_INVITE_TTL_MS);
    timer.unref?.();
    reply(callback, { ok: true, message: `دعوت برای ${target.name} فرستاده شد.` });
  });

  socket.on('houseInviteRespond', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    const inviteId = String(payload.inviteId || '');
    const invite = houseInvites.get(inviteId);
    if (!player || !invite || invite.toId !== player.id || Date.now() - invite.createdAt > HOUSE_INVITE_TTL_MS) {
      houseInvites.delete(inviteId);
      reply(callback, { ok: false, message: 'این دعوت منقضی شده است.' });
      return;
    }
    houseInvites.delete(inviteId);
    const inviter = players.get(invite.fromId);
    if (!inviter || !inviter.connected || inviter.floor !== player.floor || invite.floor !== player.floor) {
      reply(callback, { ok: false, message: 'بازیکن دعوت‌کننده دیگر در طبقه شما نیست.' });
      return;
    }
    if (!payload.accept) {
      if (inviter.socketId) io.to(inviter.socketId).emit('houseInviteResult', { message: `${player.name} دعوت خانه را نپذیرفت.` });
      reply(callback, { ok: true, message: 'دعوت رد شد.' });
      return;
    }
    if (player.houseRoomId || inviter.houseRoomId) {
      reply(callback, { ok: false, message: 'یکی از شما در خانه دیگری است.' });
      return;
    }
    const room = { id: crypto.randomUUID(), floor: player.floor, playerIds: [inviter.id, player.id], game: null };
    houseRooms.set(room.id, room);
    inviter.houseRoomId = room.id;
    player.houseRoomId = room.id;
    for (const id of room.playerIds) {
      const member = players.get(id);
      const memberSocket = member?.socketId ? io.sockets.sockets.get(member.socketId) : null;
      if (memberSocket) memberSocket.join(`house:${room.id}`);
    }
    reply(callback, { ok: true, message: 'وارد خانه مشترک شدید!' });
    emitHouseRoom(room);
  });

  socket.on('houseLeave', (_payload, callback) => {
    const player = connectedPlayer(socket);
    if (!player) {
      reply(callback, { ok: false, message: 'ابتدا وارد بازی شو.' });
      return;
    }
    leaveHouseForPlayer(player, `${player.name} از خانه خارج شد.`);
    reply(callback, { ok: true, message: 'از خانه خارج شدی.' });
  });

  socket.on('miniGameStart', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    const room = player?.houseRoomId ? houseRooms.get(player.houseRoomId) : null;
    const gameId = String(payload.gameId || '');
    if (!room || !room.playerIds.includes(player.id)) {
      reply(callback, { ok: false, message: 'برای بازی باید داخل خانه مشترک باشی.' });
      return;
    }
    if (!MINI_GAMES[gameId]) {
      reply(callback, { ok: false, message: 'این مینی‌گیم شناخته نشد.' });
      return;
    }
    if (room.game && !room.game.ended) {
      reply(callback, { ok: false, message: 'اول دور فعلی تمام شود.' });
      return;
    }
    room.game = {
      gameId,
      startedAt: Date.now(),
      endsAt: Date.now() + MINI_GAME_DURATION_MS,
      ended: false,
      winnerId: null,
      resultText: '',
      scores: Object.fromEntries(room.playerIds.map((id) => [id, 0])),
      lastActionAt: {},
      puzzleIndex: 0
    };
    const timer = setTimeout(() => finishMiniGame(room), MINI_GAME_DURATION_MS);
    timer.unref?.();
    reply(callback, { ok: true, message: `شروع شد: ${MINI_GAMES[gameId].title}` });
    emitHouseRoom(room);
  });

  socket.on('miniGameAction', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    const room = player?.houseRoomId ? houseRooms.get(player.houseRoomId) : null;
    const game = room?.game;
    if (!room || !game || game.ended || Date.now() >= game.endsAt || !room.playerIds.includes(player.id)) {
      reply(callback, { ok: false, message: 'الان دور فعالی برای بازی وجود ندارد.' });
      return;
    }
    const now = Date.now();
    if (now - (game.lastActionAt[player.id] || 0) < MINI_GAME_COOLDOWN_MS) {
      reply(callback, { ok: false, message: 'کمی صبر کن و دوباره بزن.' });
      return;
    }
    game.lastActionAt[player.id] = now;
    let message = 'ادامه بده!';
    switch (game.gameId) {
      case 'football':
        if (Math.random() < 0.42) { game.scores[player.id] += 1; message = 'گللل! ⚽'; }
        else message = 'این یکی گل نشد!';
        break;
      case 'pingpong':
        if (Math.random() < 0.55) { game.scores[player.id] += 1; message = 'امتیاز پینگ‌پنگ! 🏓'; }
        else message = 'توپ برگشت خورد؛ دوباره تلاش کن.';
        break;
      case 'race':
        game.scores[player.id] += 1;
        message = 'ماشینت جلو رفت! 🏁';
        break;
      case 'puzzle': {
        const puzzle = PUZZLES[game.puzzleIndex % PUZZLES.length];
        const answerIndex = Number(payload.answerIndex);
        if (Number.isInteger(answerIndex) && answerIndex === puzzle.answerIndex) {
          game.scores[player.id] += 3;
          game.puzzleIndex += 1;
          message = 'پاسخ درست بود! +۳ امتیاز 🧩';
        } else {
          message = 'این جواب درست نبود؛ دوباره فکر کن.';
        }
        break;
      }
      case 'target':
        if (Math.random() < 0.65) { game.scores[player.id] += 1; message = 'به هدف خورد! 🎯'; }
        else message = 'نزدیک بود! یک بار دیگر.';
        break;
      case 'basketball':
        if (Math.random() < 0.52) { game.scores[player.id] += 2; message = 'توپ داخل سبد! +۲ 🏀'; }
        else message = 'توپ به حلقه خورد؛ دوباره پرتاب کن.';
        break;
      case 'record':
        game.scores[player.id] += 1;
        message = 'رکوردت بهتر شد! +۱';
        break;
      default:
        reply(callback, { ok: false, message: 'این بازی هنوز آماده نیست.' });
        return;
    }
    reply(callback, { ok: true, message });
    emitHouseRoom(room);
  });

  socket.on('disconnect', () => {
    const playerId = socket.data.playerId;
    const player = playerId ? players.get(playerId) : null;
    if (player && player.socketId === socket.id) {
      leaveHouseForPlayer(player, `${player.name} از بازی خارج شد؛ خانه مشترک بسته شد.`);
      removeInvitesFor(player.id);
      const now = Date.now();
      player.connected = false;
      player.socketId = null;
      player.disconnectedAt = now;
      player.reservedUntil = now + RESERVATION_MS;
      player.lastSeenAt = now;
      void persistState();
      broadcastState();
    }
  });
});

setInterval(() => {
  let changed=false;
  for (const player of players.values()) if (player.connected) {
    const old=player.hunger??100; player.hunger=Math.max(0,old-1);
    if(player.hunger===0) player.health=Math.max(1,(player.health??100)-2);
    if(player.hunger!==old) changed=true;
  }
  if(changed) { broadcastState(); void persistState(); }
}, 60_000);

async function start() {
  await loadState();
  server.listen(PORT, HOST, () => {
    console.log(`HOTEL 96 v2.1 is running at http://${HOST}:${PORT}`);
    console.log(`Residents: ${players.size}/${MAX_PLAYERS}; online: ${onlineCount()}`);
  });
}

const cleanupTimer = setInterval(() => {
  if (pruneExpiredPlayers()) {
    void persistState();
    broadcastState();
  } else {
    void persistState();
  }
}, 60_000);
cleanupTimer.unref();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanupTimer);
  await persistState();
  if (pool) await pool.end().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8_000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

start().catch((error) => {
  console.error('HOTEL96 could not start:', error);
  process.exit(1);
});
