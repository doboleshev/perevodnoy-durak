const SUITS = [
  { id: "s", symbol: "♠", red: false },
  { id: "c", symbol: "♣", red: false },
  { id: "d", symbol: "♦", red: true },
  { id: "h", symbol: "♥", red: true },
];

const RANK_LABEL = {
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "10",
  11: "В",
  12: "Д",
  13: "К",
  14: "Т",
};

const state = {
  players: [],
  deck: [],
  trumpSuit: null,
  table: [],
  attacker: 0,
  defender: 1,
  defenseLimit: 6,
  phase: "lay",
  throwCursor: 0,
  passes: 0,
  discardCount: 0,
  message: "Соберите стол и раздайте карты",
  log: "",
  over: false,
  loser: null,
  lock: false,
  playerCount: 3,
  beatIndex: -1,
  pending: null,
};

let gameId = 0;
const net = { on: false, token: "", rev: 0, pollId: 0 };

function makeToken() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const rand = Math.floor(Math.random() * 16);
    return (char === "x" ? rand : ((rand % 4) + 8)).toString(16);
  });
}

function showSetup() {
  document.getElementById("overlay").classList.remove("hidden");
  document.getElementById("setup").classList.remove("hidden");
  document.getElementById("wait-panel").classList.add("hidden");
  document.getElementById("result").classList.add("hidden");
}

function showWait() {
  document.getElementById("overlay").classList.remove("hidden");
  document.getElementById("setup").classList.add("hidden");
  document.getElementById("wait-panel").classList.remove("hidden");
  document.getElementById("result").classList.add("hidden");
}

function hideLobby() {
  document.getElementById("overlay").classList.add("hidden");
  document.getElementById("wait-panel").classList.add("hidden");
  document.getElementById("setup").classList.remove("hidden");
}

function stopNet() {
  net.on = false;
  net.pollId += 1;
  net.rev = 0;
}

function leaveOnline() {
  const token = net.token;
  const wasOnline = net.on;
  stopNet();
  if (!wasOnline || !token) return;
  fetch("/api/leave", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => {});
}

function applyView(view) {
  const beatKey = state.beatIndex >= 0 && state.table[state.beatIndex] && !state.table[state.beatIndex].defense
    ? cardKey(state.table[state.beatIndex].attack)
    : "";
  const pendingKey = state.pending ? cardKey(state.pending) : "";
  state.players = view.players.map((player) => ({
    name: player.name,
    isHuman: player.isHuman,
    out: player.out,
    hand: player.hand.map((card) => ({ ...card })),
  }));
  state.trumpSuit = view.trumpSuit;
  state.deck = view.deckCount > 0 && view.trumpCard
    ? Array.from({ length: view.deckCount }, (_, index) => (
      index === 0 ? { ...view.trumpCard } : { hidden: true }
    ))
    : [];
  state.table = view.table.map((pair) => ({
    attack: { ...pair.attack },
    defense: pair.defense ? { ...pair.defense } : null,
  }));
  state.attacker = view.attacker;
  state.defender = view.defender;
  state.throwCursor = view.throwCursor;
  state.phase = view.phase;
  state.defenseLimit = view.defenseLimit;
  state.passes = view.passes;
  state.discardCount = view.discardCount;
  state.over = view.over;
  state.loser = view.loser ? state.players[view.loser.isHuman ? 0 : 1] : null;
  state.message = view.message;
  state.log = view.log;
  state.playerCount = view.playerCount;
  state.lock = false;
  const human = state.players[0];
  state.pending = pendingKey && human
    ? human.hand.find((card) => !card.hidden && cardKey(card) === pendingKey) || null
    : null;
  const beatIndex = state.table.findIndex((pair) => !pair.defense && cardKey(pair.attack) === beatKey);
  state.beatIndex = beatIndex;
  net.rev = view.rev;
  hideLobby();
  render();
}

async function sendMove(action) {
  if (!net.on || state.lock) return;
  state.lock = true;
  render();
  try {
    const response = await fetch("/api/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: net.token, action }),
    });
    const data = await response.json();
    if (!net.on) return;
    if (!response.ok) {
      state.lock = false;
      state.log = data.error || "Ход не принят.";
      render();
      return;
    }
    applyView(data.view);
  } catch (error) {
    if (!net.on) return;
    state.lock = false;
    state.log = "Нет связи с сервером.";
    render();
  }
}

async function poll() {
  const id = ++net.pollId;
  while (net.on && id === net.pollId) {
    try {
      const response = await fetch(`/api/state?token=${encodeURIComponent(net.token)}&rev=${net.rev}`);
      if (!net.on || id !== net.pollId) return;
      if (!response.ok) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        continue;
      }
      const data = await response.json();
      if (!net.on || id !== net.pollId) return;
      if (data.abandoned) {
        stopNet();
        showSetup();
        state.message = "Соперник вышел. Можно сесть за стол снова.";
        render();
        return;
      }
      if (data.waiting) showWait();
      else if (data.view && data.view.rev !== net.rev) applyView(data.view);
    } catch (error) {
      if (!net.on || id !== net.pollId) return;
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
  }
}

async function sitDown() {
  leaveOnline();
  gameId += 1;
  state.lock = false;
  if (!net.token) {
    net.token = sessionStorage.getItem("durak-token") || makeToken();
    sessionStorage.setItem("durak-token", net.token);
  }
  net.on = true;
  net.rev = 0;
  showWait();
  try {
    const response = await fetch("/api/sit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: net.token }),
    });
    const data = await response.json();
    if (!net.on) return;
    if (!response.ok) {
      stopNet();
      showSetup();
      state.message = data.error || "Не удалось сесть за стол.";
      render();
      return;
    }
    if (data.waiting) showWait();
    else applyView(data.view);
    poll();
  } catch (error) {
    stopNet();
    showSetup();
    state.message = "Сервер игры не отвечает.";
    render();
  }
}

function suitInfo(id) {
  return SUITS.find((suit) => suit.id === id);
}

function cardName(card) {
  return `${RANK_LABEL[card.rank]}${suitInfo(card.suit).symbol}`;
}

function cardKey(card) {
  return `${card.suit}${card.rank}`;
}

function verb(player, humanForm, otherForm) {
  return player.isHuman ? humanForm : `${player.name} ${otherForm}`;
}

function toward(player) {
  return player.isHuman ? "вас" : player.name;
}

function clearSelection() {
  state.beatIndex = -1;
  state.pending = null;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function beats(card, other) {
  if (card.suit === other.suit) return card.rank > other.rank;
  return card.suit === state.trumpSuit && other.suit !== state.trumpSuit;
}

function nextActive(from) {
  const total = state.players.length;
  for (let step = 1; step <= total; step += 1) {
    const idx = (from + step) % total;
    if (!state.players[idx].out) return idx;
  }
  return -1;
}

const SUIT_ORDER = { c: 0, d: 1, h: 2, s: 3 };

function sortHand(player) {
  player.hand.sort((a, b) => {
    const aTrump = a.suit === state.trumpSuit ? 1 : 0;
    const bTrump = b.suit === state.trumpSuit ? 1 : 0;
    if (aTrump !== bTrump) return aTrump - bTrump;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
  });
}

function drawCard() {
  if (!state.deck.length) return null;
  return state.deck.pop();
}

function ranksOnTable() {
  const ranks = new Set();
  for (const pair of state.table) {
    ranks.add(pair.attack.rank);
    if (pair.defense) ranks.add(pair.defense.rank);
  }
  return ranks;
}

function firstUnbeaten() {
  return state.table.find((pair) => !pair.defense) || null;
}

function beatTarget() {
  const chosen = state.beatIndex >= 0 ? state.table[state.beatIndex] : null;
  if (chosen && !chosen.defense) return chosen;
  return firstUnbeaten();
}

function nothingBeaten() {
  return state.table.every((pair) => !pair.defense);
}

function slotsLeft() {
  return state.defenseLimit - state.table.length;
}

function activePlayers() {
  return state.players.filter((player) => !player.out);
}

function currentActor() {
  if (state.over) return -1;
  if (state.phase === "lay") return state.attacker;
  if (state.phase === "defend") return state.defender;
  if (state.phase === "throw") return state.throwCursor;
  return -1;
}

function setDefender(idx) {
  state.defender = idx;
  state.defenseLimit = Math.min(6, state.players[idx].hand.length);
}

function removeCard(player, card) {
  const index = player.hand.indexOf(card);
  if (index >= 0) player.hand.splice(index, 1);
}

function markOut() {
  if (state.deck.length > 0) return;
  for (const player of state.players) {
    if (player.hand.length === 0) player.out = true;
  }
}

function checkEnd() {
  markOut();
  const active = activePlayers();
  if (state.deck.length === 0 && active.length <= 1) {
    state.over = true;
    state.phase = "over";
    state.loser = active[0] || null;
    state.message = state.loser
      ? (state.loser.isHuman ? "Вы остались с картами. Вы дурак." : `Дурак — ${state.loser.name}.`)
      : "Ничья: карты кончились у всех.";
    return true;
  }
  return false;
}

function throwers() {
  return state.players
    .map((_, index) => index)
    .filter((index) => !state.players[index].out && index !== state.defender);
}

function canBeat(card, target) {
  const aim = target && target.attack ? target : beatTarget();
  return Boolean(aim) && beats(card, aim.attack);
}

function canTransfer(card) {
  if (state.phase !== "defend" || state.table.length === 0 || !nothingBeaten()) return false;
  if (card.rank !== state.table[0].attack.rank) return false;
  const next = nextActive(state.defender);
  if (next < 0 || next === state.defender) return false;
  const limit = Math.min(6, state.players[next].hand.length);
  return state.table.length + 1 <= limit;
}

function legalThrowCards(idx) {
  if (slotsLeft() <= 0) return [];
  const ranks = ranksOnTable();
  return state.players[idx].hand.filter((card) => ranks.has(card.rank));
}

function cardPlayable(card) {
  if (state.lock || state.over || currentActor() !== 0) return false;
  if (state.phase === "lay") {
    if (slotsLeft() <= 0) return false;
    if (state.table.length === 0) return true;
    return card.rank === state.table[0].attack.rank;
  }
  if (state.phase === "defend") return canBeat(card) || canTransfer(card);
  if (state.phase === "throw") return legalThrowCards(0).includes(card);
  return false;
}

function wasteScore(card) {
  return card.rank + (card.suit === state.trumpSuit ? 20 : 0);
}

function startGame(count) {
  leaveOnline();
  gameId += 1;
  const id = gameId;
  state.playerCount = count;
  state.players = Array.from({ length: count }, (_, index) => ({
    name: index === 0 ? "Вы" : `Соперник ${index}`,
    isHuman: index === 0,
    hand: [],
    out: false,
  }));
  state.deck = shuffle(SUITS.flatMap((suit) => (
    Object.keys(RANK_LABEL).map((rank) => ({ suit: suit.id, rank: Number(rank) }))
  )));
  state.trumpSuit = state.deck[0].suit;
  state.table = [];
  state.discardCount = 0;
  state.over = false;
  state.loser = null;
  state.lock = false;
  state.passes = 0;
  clearSelection();

  for (let round = 0; round < 6; round += 1) {
    for (const player of state.players) {
      const card = drawCard();
      if (card) player.hand.push(card);
    }
  }
  state.players.forEach(sortHand);

  state.attacker = lowestTrumpHolder();
  const trump = suitInfo(state.trumpSuit);
  state.log = `Козырь ${trump.symbol}. Первый ход — ${state.players[state.attacker].name}.`;
  beginLay();
  document.getElementById("overlay").classList.add("hidden");
  document.getElementById("result").classList.add("hidden");
  proceed(id);
}

function lowestTrumpHolder() {
  let best = null;
  state.players.forEach((player, index) => {
    for (const card of player.hand) {
      if (card.suit !== state.trumpSuit) continue;
      if (!best || card.rank < best.rank) best = { index, rank: card.rank };
    }
  });
  return best ? best.index : 0;
}

function beginLay() {
  if (state.over) return;
  state.table = [];
  state.phase = "lay";
  state.passes = 0;
  clearSelection();
  if (state.players[state.attacker].out || state.players[state.attacker].hand.length === 0) {
    const next = nextActive(state.attacker);
    if (next < 0) {
      checkEnd();
      return;
    }
    state.attacker = next;
  }
  const defender = nextActive(state.attacker);
  if (defender < 0 || defender === state.attacker) {
    checkEnd();
    return;
  }
  setDefender(defender);
  const attacker = state.players[state.attacker];
  state.message = attacker.isHuman
    ? "Ваш заход. Положите карту."
    : `${attacker.name} ходит.`;
}

function playLay(card) {
  const player = state.players[state.attacker];
  if (!player.hand.includes(card)) return false;
  if (slotsLeft() <= 0) {
    state.log = "В этот заход больше положить нельзя.";
    return false;
  }
  if (state.table.length > 0 && card.rank !== state.table[0].attack.rank) {
    state.log = "В одном заходе кладут карты одного достоинства.";
    return false;
  }
  removeCard(player, card);
  state.table.push({ attack: card, defense: null });
  state.log = `${verb(player, "Вы кладёте", "кладёт")} ${cardName(card)}.`;
  markOut();
  return true;
}

function defendMessage() {
  const defender = state.players[state.defender];
  if (!defender.isHuman) return `${defender.name} отбивается.`;
  const open = state.table.filter((pair) => !pair.defense).length;
  if (nothingBeaten()) {
    return open > 1
      ? "Побейте карты или переведите атаку."
      : "Побейте карту или переведите атаку.";
  }
  return open > 1
    ? "Побейте оставшиеся карты или заберите стол."
    : "Побейте карту или заберите стол.";
}

function finishLay() {
  if (state.table.length === 0) {
    state.log = "Сначала положите карту.";
    return false;
  }
  state.phase = "defend";
  clearSelection();
  state.message = defendMessage();
  return true;
}

function playDefense(card) {
  const target = beatTarget();
  const player = state.players[state.defender];
  if (!target || !player.hand.includes(card) || !beats(card, target.attack)) {
    state.log = "Этой картой не побить.";
    return false;
  }
  removeCard(player, card);
  target.defense = card;
  state.log = `${verb(player, "Вы бьёте", "бьёт")} ${cardName(target.attack)} картой ${cardName(card)}.`;
  clearSelection();
  markOut();
  if (!firstUnbeaten()) beginThrow();
  else state.message = defendMessage();
  return true;
}

function playTransfer(card) {
  const player = state.players[state.defender];
  if (!player.hand.includes(card) || !canTransfer(card)) {
    state.log = "Перевести эту карту нельзя: либо достоинство другое, либо у следующего не хватает карт, либо карту уже начали бить.";
    return false;
  }
  const next = nextActive(state.defender);
  removeCard(player, card);
  state.table.push({ attack: card, defense: null });
  state.log = `${verb(player, "Вы переводите", "переводит")} ${cardName(card)} на ${toward(state.players[next])}.`;
  clearSelection();
  markOut();
  setDefender(next);
  state.message = defendMessage();
  return true;
}

function playThrow(card) {
  const player = state.players[state.throwCursor];
  if (!player.hand.includes(card) || !legalThrowCards(state.throwCursor).includes(card)) {
    state.log = slotsLeft() <= 0
      ? "Защищающемуся больше нельзя подкидывать."
      : "Подкидывают только те достоинства, которые уже лежат на столе.";
    return false;
  }
  removeCard(player, card);
  state.table.push({ attack: card, defense: null });
  state.passes = 0;
  state.phase = "defend";
  clearSelection();
  state.log = `${verb(player, "Вы подкидываете", "подкидывает")} ${cardName(card)}.`;
  markOut();
  const defender = state.players[state.defender];
  state.message = defender.isHuman
    ? "Побейте подкинутую карту."
    : `${defender.name} отбивается.`;
  return true;
}

function advanceThrowCursor() {
  const total = state.players.length;
  for (let step = 1; step <= total; step += 1) {
    const idx = (state.throwCursor + step) % total;
    if (idx !== state.defender && !state.players[idx].out) {
      state.throwCursor = idx;
      return idx;
    }
  }
  return -1;
}

function announceThrow() {
  const player = state.players[state.throwCursor];
  state.message = player && player.isHuman
    ? "Подкиньте карту или нажмите «Бито»."
    : `${player ? player.name : "Игрок"} может подкинуть.`;
}

function beginThrow() {
  state.phase = "throw";
  state.passes = 0;
  clearSelection();
  if (throwers().length === 0 || slotsLeft() <= 0) {
    endBito();
    return;
  }
  state.throwCursor = state.attacker;
  if (state.throwCursor === state.defender || state.players[state.throwCursor].out) {
    if (advanceThrowCursor() < 0) {
      endBito();
      return;
    }
  }
  announceThrow();
}

function passThrow() {
  const player = state.players[state.throwCursor];
  state.passes += 1;
  state.log = `${player.isHuman ? "Вы" : player.name}: бито.`;
  if (state.passes >= throwers().length) {
    endBito();
    return;
  }
  if (advanceThrowCursor() < 0) {
    endBito();
    return;
  }
  announceThrow();
}

function tableCards() {
  const cards = [];
  for (const pair of state.table) {
    cards.push(pair.attack);
    if (pair.defense) cards.push(pair.defense);
  }
  return cards;
}

function replenish(attacker, defender) {
  const order = state.players.map((_, index) => (attacker + index) % state.players.length);
  const defenderPos = order.indexOf(defender);
  if (defenderPos >= 0) {
    order.splice(defenderPos, 1);
    order.push(defender);
  }
  for (const index of order) {
    const player = state.players[index];
    if (player.out) continue;
    while (player.hand.length < 6 && state.deck.length) player.hand.push(drawCard());
    sortHand(player);
  }
  markOut();
}

function endBito() {
  state.discardCount += tableCards().length;
  state.table = [];
  state.log = "Бито. Карты уходят в отбой.";
  clearSelection();
  markOut();
  const attacker = state.attacker;
  const defender = state.defender;
  replenish(attacker, defender);
  if (checkEnd()) return;
  const next = state.players[defender].out ? nextActive(defender) : defender;
  if (next < 0) {
    checkEnd();
    return;
  }
  state.attacker = next;
  beginLay();
}

function takeCards() {
  const defender = state.players[state.defender];
  defender.hand.push(...tableCards());
  sortHand(defender);
  state.table = [];
  state.log = `${verb(defender, "Вы забираете", "забирает")} карты.`;
  clearSelection();
  const attacker = state.attacker;
  const defenderIndex = state.defender;
  replenish(attacker, defenderIndex);
  if (checkEnd()) return;
  const next = nextActive(defenderIndex);
  if (next < 0) {
    checkEnd();
    return;
  }
  state.attacker = next;
  beginLay();
}

function aiTurn(idx) {
  const player = state.players[idx];
  if (state.phase === "lay") {
    const cards = [...player.hand].sort((a, b) => wasteScore(a) - wasteScore(b));
    const first = cards.find((card) => slotsLeft() > 0);
    if (!first) return;
    playLay(first);
    const twin = player.hand
      .filter((card) => card.rank === first.rank)
      .sort((a, b) => wasteScore(a) - wasteScore(b))[0];
    if (twin && wasteScore(twin) <= 10 && slotsLeft() > 0) playLay(twin);
    finishLay();
    return;
  }

  if (state.phase === "defend") {
    const beaters = player.hand.filter(canBeat).sort((a, b) => wasteScore(a) - wasteScore(b));
    const transfers = player.hand.filter(canTransfer).sort((a, b) => wasteScore(a) - wasteScore(b));
    const beat = beaters[0];
    const transfer = transfers[0];
    const transferIsBetter = transfer && (
      !beat
      || (beat.suit === state.trumpSuit && transfer.suit !== state.trumpSuit)
      || (state.deck.length === 0 && player.hand.length === 1)
    );
    if (transferIsBetter) {
      playTransfer(transfer);
      return;
    }
    if (beat) {
      playDefense(beat);
      return;
    }
    takeCards();
    return;
  }

  if (state.phase === "throw") {
    const options = legalThrowCards(idx).sort((a, b) => wasteScore(a) - wasteScore(b));
    const pick = options.find((card) => wasteScore(card) <= 12);
    if (pick) playThrow(pick);
    else passThrow();
  }
}

function proceed(id) {
  if (id !== gameId) return;
  if (state.over) {
    state.lock = false;
    render();
    return;
  }
  if (state.phase === "throw" && legalThrowCards(state.throwCursor).length === 0) {
    passThrow();
    proceed(id);
    return;
  }
  const actor = currentActor();
  if (actor < 0 || state.players[actor].isHuman) {
    state.lock = false;
    render();
    return;
  }
  state.lock = true;
  render();
  window.setTimeout(() => {
    if (id !== gameId) return;
    aiTurn(actor);
    proceed(id);
  }, 700);
}

function onCardClick(card) {
  if (state.lock || state.over) return;
  if (net.on) {
    if (currentActor() !== 0) {
      state.log = "Сейчас ход другого игрока.";
      render();
      return;
    }
    if (state.phase === "lay") {
      state.pending = null;
      sendMove({ type: "lay", key: cardKey(card) });
      return;
    }
    if (state.phase === "defend") {
      const beat = canBeat(card);
      const transfer = canTransfer(card);
      if (beat && transfer) {
        state.pending = card;
        state.log = `${cardName(card)} может и побить, и перевести. Выберите действие.`;
        render();
        return;
      }
      state.pending = null;
      if (beat) {
        const target = beatTarget();
        sendMove({ type: "beat", key: cardKey(card), target: target ? cardKey(target.attack) : "" });
        return;
      }
      if (transfer) {
        sendMove({ type: "transfer", key: cardKey(card) });
        return;
      }
      state.log = nothingBeaten()
        ? "Этой картой не побить и не перевести."
        : "Этой картой не побить.";
      render();
      return;
    }
    if (state.phase === "throw") sendMove({ type: "throw", key: cardKey(card) });
    return;
  }
  if (currentActor() !== 0) {
    state.log = "Сейчас ход другого игрока.";
    render();
    return;
  }
  if (state.phase === "lay") {
    state.pending = null;
    if (playLay(card)) {
      finishLay();
      proceed(gameId);
      return;
    }
    render();
    return;
  }
  if (state.phase === "defend") {
    const beat = canBeat(card);
    const transfer = canTransfer(card);
    if (beat && transfer) {
      state.pending = card;
      state.log = `${cardName(card)} может и побить, и перевести. Выберите действие.`;
      render();
      return;
    }
    state.pending = null;
    if (beat) {
      if (playDefense(card)) proceed(gameId);
      else render();
      return;
    }
    if (transfer) {
      if (playTransfer(card)) proceed(gameId);
      else render();
      return;
    }
    state.log = nothingBeaten()
      ? "Этой картой не побить и не перевести."
      : "Этой картой не побить.";
    render();
    return;
  }
  if (state.phase === "throw" && playThrow(card)) proceed(gameId);
  else render();
}

function onTake() {
  if (state.lock || currentActor() !== 0 || state.phase !== "defend") return;
  if (net.on) {
    state.pending = null;
    sendMove({ type: "take" });
    return;
  }
  state.pending = null;
  takeCards();
  proceed(gameId);
}

function onBito() {
  if (state.lock || currentActor() !== 0 || state.phase !== "throw") return;
  if (net.on) {
    sendMove({ type: "pass" });
    return;
  }
  passThrow();
  proceed(gameId);
}

function onBeatChoice() {
  if (state.lock || !state.pending || state.phase !== "defend" || currentActor() !== 0) return;
  const card = state.pending;
  state.pending = null;
  if (net.on) {
    const target = beatTarget();
    sendMove({ type: "beat", key: cardKey(card), target: target ? cardKey(target.attack) : "" });
    return;
  }
  if (playDefense(card)) proceed(gameId);
  else render();
}

function onTransferChoice() {
  if (state.lock || !state.pending || state.phase !== "defend" || currentActor() !== 0) return;
  const card = state.pending;
  state.pending = null;
  if (net.on) {
    sendMove({ type: "transfer", key: cardKey(card) });
    return;
  }
  if (playTransfer(card)) proceed(gameId);
  else render();
}

function onBoardClick(key) {
  if (state.lock || state.over || state.phase !== "defend" || currentActor() !== 0) return;
  const index = state.table.findIndex((pair) => !pair.defense && cardKey(pair.attack) === key);
  if (index < 0) return;
  state.beatIndex = index;
  state.pending = null;
  state.message = defendMessage();
  render();
}

const PIP_SPOTS = {
  6: [[28, 36], [28, 68], [50, 36], [50, 68], [76, 36], [76, 68]],
  7: [[24, 36], [24, 68], [46, 36], [46, 68], [72, 36], [72, 68], [50, 52]],
  8: [[20, 36], [20, 68], [40, 36], [40, 68], [60, 36], [60, 68], [80, 36], [80, 68]],
  9: [[18, 36], [18, 68], [36, 36], [36, 68], [64, 36], [64, 68], [82, 36], [82, 68], [50, 52]],
  10: [[16, 36], [16, 68], [34, 36], [34, 68], [46, 52], [58, 52], [66, 36], [66, 68], [84, 36], [84, 68]],
};

const SUIT_PATH = {
  s: "M20 1.2C20 1.2 5.2 16.4 5.2 24.6 5.2 31 10.2 35.2 15.8 34.4 14 37.4 11.2 39.2 8.8 39.2H31.2C28.8 39.2 26 37.4 24.2 34.4 29.8 35.2 34.8 31 34.8 24.6 34.8 16.4 20 1.2 20 1.2Z",
  h: "M20 37.4C5.4 26.8.4 19.2.4 12.2.4 5.6 5.6 1.2 11.6 1.2c3.8 0 6.4 2.2 8.4 5.6 2-3.4 4.6-5.6 8.4-5.6 6 0 11.2 4.4 11.2 11 0 7-5 14.6-19.6 25.2Z",
  d: "M20 .8 37.4 20 20 39.2 2.6 20Z",
  c: "M20 5.4c-3.6 0-6.4 2.8-6.4 6.2 0 1.8.8 3.4 2 4.5-4 .7-7 4-7 7.8 0 4.4 3.6 8 8 8 1.8 0 3.4-.6 4.8-1.6.2 2.8-.6 5.8-2.6 7.2h8.4c-2-1.4-2.8-4.4-2.6-7.2 1.4 1 3 1.6 4.8 1.6 4.4 0 8-3.6 8-8 0-3.8-3-7.1-7-7.8 1.2-1.1 2-2.7 2-4.5 0-3.4-2.8-6.2-6.4-6.2-1.6 0-3 .6-4.1 1.5C23 6 21.6 5.4 20 5.4Z",
};

const INK = "#1a1a1a";
const COURT_RED = "#b11226";
const COURT_GOLD = "#c6a36a";
const COURT_CREAM = "#f4e4cf";
const LINE = "#f3f1ea";

const BACK_SVG = `<svg class="back-art" viewBox="0 0 70 98" aria-hidden="true">
  <rect width="70" height="98" fill="#171a32"/>
  <rect x="2.2" y="2.2" width="65.6" height="93.6" fill="none" stroke="${LINE}" stroke-width="0.9"/>
  <rect x="5" y="5" width="60" height="88" fill="none" stroke="${LINE}" stroke-width="0.45"/>
  <path d="M9 14V9h5M56 9h5v5M9 84v5h5M56 89h5v-5" fill="none" stroke="${LINE}" stroke-width="0.8"/>
  <g fill="none" stroke="${LINE}" stroke-width="0.75" stroke-linecap="round">
    <path d="M35 49C27 40 22 34 20 26c-2-8 4-12 8-8"/>
    <path d="M35 49C43 40 48 34 50 26c2-8-4-12-8-8"/>
    <path d="M35 49C27 58 22 64 20 72c-2 8 4 12 8 8"/>
    <path d="M35 49C43 58 48 64 50 72c2 8-4 12-8 8"/>
    <path d="M35 49C24 46 16 42 13 34"/>
    <path d="M35 49C46 46 54 42 57 34"/>
    <path d="M35 49C24 52 16 56 13 64"/>
    <path d="M35 49C46 52 54 56 57 64"/>
    <path d="M35 20v10M35 68v10"/>
  </g>
  <g fill="${LINE}">
    <ellipse cx="22" cy="24" rx="2.5" ry="1.1" transform="rotate(-35 22 24)"/>
    <ellipse cx="48" cy="24" rx="2.5" ry="1.1" transform="rotate(35 48 24)"/>
    <ellipse cx="16" cy="34" rx="2.3" ry="1" transform="rotate(-20 16 34)"/>
    <ellipse cx="54" cy="34" rx="2.3" ry="1" transform="rotate(20 54 34)"/>
    <ellipse cx="22" cy="74" rx="2.5" ry="1.1" transform="rotate(35 22 74)"/>
    <ellipse cx="48" cy="74" rx="2.5" ry="1.1" transform="rotate(-35 48 74)"/>
    <ellipse cx="16" cy="64" rx="2.3" ry="1" transform="rotate(20 16 64)"/>
    <ellipse cx="54" cy="64" rx="2.3" ry="1" transform="rotate(-20 54 64)"/>
    <ellipse cx="30" cy="18" rx="2" ry="0.9" transform="rotate(-50 30 18)"/>
    <ellipse cx="40" cy="18" rx="2" ry="0.9" transform="rotate(50 40 18)"/>
    <ellipse cx="30" cy="80" rx="2" ry="0.9" transform="rotate(50 30 80)"/>
    <ellipse cx="40" cy="80" rx="2" ry="0.9" transform="rotate(-50 40 80)"/>
    <circle cx="35" cy="49" r="1.5"/>
    <circle cx="35" cy="26" r="0.8"/>
    <circle cx="35" cy="72" r="0.8"/>
  </g>
</svg>`;

function suitSvg(id, className) {
  return `<svg class="${className}" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><path fill="currentColor" d="${SUIT_PATH[id]}"/></svg>`;
}

function courtArt(kind, suitId) {
  const crown = kind === "king"
    ? `<path fill="${INK}" d="M46 10h26l-1 3-5-2-4 6-4-7-4 6-4-2-4-4z"/><rect x="48" y="18" width="22" height="2.2" fill="${COURT_GOLD}"/>`
    : kind === "queen"
      ? `<path fill="${INK}" d="M48 14c2-8 20-8 22 0v5H48z"/><path fill="${COURT_RED}" d="M52 8h16v3H52z"/>`
      : `<path fill="${INK}" d="M50 12h20l3 7H47z"/><path d="M66 10l9-6" stroke="${INK}" stroke-width="1.3" fill="none" stroke-linecap="round"/>`;
  const beard = kind === "king"
    ? `<path fill="${INK}" d="M54 40c2 5 12 5 14 0 0 3-3 5-7 5s-7-2-7-5z"/>`
    : "";
  const held = kind === "queen"
    ? `<g transform="translate(40 52)"><circle r="2.1" fill="${COURT_GOLD}"/><circle cx="3.2" cy="1.2" r="1.3" fill="${COURT_RED}"/><circle cx="-2.4" cy="1.4" r="1.2" fill="${COURT_RED}"/></g>`
    : kind === "king"
      ? `<path d="M78 28v24" stroke="${COURT_GOLD}" stroke-width="1.4" fill="none"/><path d="M74 28h8l-1 4h-6z" fill="${COURT_GOLD}"/>`
      : "";
  const figure = `
    ${crown}
    <path fill="${INK}" d="M50 16c10-5 26-2 28 8 1 5-3 9-8 9H56c-5 0-10-3-8-9z"/>
    <ellipse cx="66" cy="32" rx="9" ry="10.5" fill="${COURT_CREAM}"/>
    <circle cx="62.5" cy="31" r="0.85" fill="${INK}"/>
    <circle cx="69" cy="31" r="0.85" fill="${INK}"/>
    <path d="M62 36.5c2.2 1.6 6 1.4 8.2-.3" fill="none" stroke="${INK}" stroke-width="0.7"/>
    ${beard}
    <path fill="${COURT_RED}" d="M44 46h44l5 24H39z"/>
    <path fill="${INK}" d="M50 46h30l2 24H48z"/>
    <g fill="${COURT_GOLD}">
      <path d="M56 52h5l2.2 3.2L61 58.4h-5l-2.2-3.2z"/>
      <path d="M66 58h5l2.2 3.2-2.2 3.2h-5l-2.2-3.2z"/>
      <path d="M56 64h5l2.2 3.2L61 70.4h-5l-2.2-3.2z"/>
    </g>
    <path fill="#f7f4ee" d="M58 46l8 9 8-9z"/>
    ${held}
    <g transform="translate(6,40) scale(0.46)"><path fill="currentColor" d="${SUIT_PATH[suitId]}"/></g>
  `;
  return `<svg class="court-art" viewBox="0 0 100 146" aria-hidden="true"><g>${figure}</g><g transform="rotate(180 50 73)">${figure}</g></svg>`;
}

function faceMarkup(card) {
  if (card.rank === 14) {
    return `<span class="ace">${suitSvg(card.suit, "ace-pip")}<svg class="ace-mark" viewBox="0 0 40 24" aria-hidden="true"><path fill="none" stroke="#b08948" stroke-width="1.4" stroke-linejoin="round" d="M4 18 10 8l6 7 4-12 4 12 6-7 6 10"/><path stroke="#b08948" stroke-width="1.1" d="M8 20h24"/></svg></span>`;
  }
  if (card.rank >= 11) {
    const kind = card.rank === 11 ? "jack" : card.rank === 12 ? "queen" : "king";
    return `<span class="court">${courtArt(kind, card.suit)}</span>`;
  }
  const spots = PIP_SPOTS[card.rank];
  return `<span class="pips">${spots.map(([top, left]) => (
    `<i class="spot${top > 55 ? " flip" : ""}" style="top:${top}%;left:${left}%">${suitSvg(card.suit, "")}</i>`
  )).join("")}</span>`;
}

function cardHTML(card, className, asButton, markTrump = true) {
  const suit = suitInfo(card.suit);
  const classes = [
    "card",
    suit.red ? "red" : "",
    markTrump && card.suit === state.trumpSuit ? "is-trump" : "",
    className,
  ].filter(Boolean).join(" ");
  const rank = RANK_LABEL[card.rank];
  const inner = `<span class="idx top"><b>${rank}</b>${suitSvg(card.suit, "idx-suit")}</span>${faceMarkup(card)}<span class="idx bot"><b>${rank}</b>${suitSvg(card.suit, "idx-suit")}</span>`;
  if (asButton) {
    return `<button type="button" class="${classes}" data-key="${cardKey(card)}">${inner}</button>`;
  }
  return `<div class="${classes}">${inner}</div>`;
}

function bindAction(id, handler) {
  const button = document.getElementById(id);
  if (button) button.addEventListener("click", handler);
}

function render() {
  const opponents = document.getElementById("opponents");
  const actor = currentActor();
  opponents.innerHTML = state.players.slice(1).map((player, offset) => {
    const index = offset + 1;
    const backs = player.out
      ? ""
      : player.hand.slice(0, 8).map(() => `<span class="back">${BACK_SVG}</span>`).join("");
    const meta = player.out ? "вышел" : `${player.hand.length} карт`;
    return `<article class="seat ${actor === index ? "active" : ""} ${player.out ? "out" : ""}">
      <div class="seat-name"><strong>${player.name}</strong><span>${meta}</span></div>
      <div class="backs">${backs}</div>
    </article>`;
  }).join("");

  const deck = document.getElementById("deck-pile");
  const trumpSlot = document.getElementById("trump-slot");
  const trumpCard = state.deck[0];
  document.querySelector(".deck-area").classList.toggle("lonely", state.deck.length <= 1);
  const layers = Math.min(3, Math.max(0, state.deck.length - 1));
  deck.innerHTML = Array.from({ length: layers }, () => `<span class="back">${BACK_SVG}</span>`).join("");
  trumpSlot.innerHTML = trumpCard ? cardHTML(trumpCard, "", false, false) : "";
  const trump = state.trumpSuit ? suitInfo(state.trumpSuit) : null;
  document.getElementById("deck-count").innerHTML = state.players.length
    ? `<span>Колода: ${state.deck.length}</span><span>Отбой: ${state.discardCount}</span>${trump ? `<span>Козырь ${trump.symbol}</span>` : ""}`
    : "";

  const board = document.getElementById("board");
  const canPick = state.phase === "defend" && actor === 0 && !state.lock && !state.over;
  if (!state.table.length) {
    board.innerHTML = `<p class="empty">${state.over ? state.message : "Стол пуст"}</p>`;
  } else {
    const chosen = state.beatIndex >= 0 ? state.table[state.beatIndex] : null;
    board.innerHTML = state.table.map((pair) => {
      const attackClass = [
        pair === chosen && !pair.defense ? "target" : "",
        canPick && !pair.defense ? "selectable" : "",
      ].filter(Boolean).join(" ");
      return `<div class="pair">
        ${cardHTML(pair.attack, attackClass, canPick && !pair.defense)}
        ${pair.defense ? cardHTML(pair.defense, "defense", false) : ""}
      </div>`;
    }).join("");
  }

  document.getElementById("status").textContent = state.message;
  document.getElementById("log").textContent = state.log;

  const human = state.players[0];
  const humanBox = document.querySelector(".human");
  humanBox.classList.toggle("active", actor === 0 && !state.over);
  document.getElementById("human-name").textContent = human
    ? `Вы${human.out ? " — вышли" : ` · ${human.hand.length} карт`}`
    : "Вы";
  if (human) sortHand(human);
  const hand = document.getElementById("hand");
  hand.classList.toggle("quiet-defend", state.phase === "defend");
  hand.innerHTML = human
    ? human.hand.map((card, index) => {
      const previous = human.hand[index - 1];
      const gap = previous && previous.suit !== state.trumpSuit && card.suit === state.trumpSuit;
      let className = gap ? "group-gap " : "";
      const showHints = state.phase !== "defend";
      if (card === state.pending) className += "selected";
      else if (showHints && cardPlayable(card)) className += "playable";
      else if (showHints) className += "muted";
      return cardHTML(card, className.trim(), true);
    }).join("")
    : "";

  const actions = document.getElementById("actions");
  const result = document.getElementById("result");
  const setupOpen = !document.getElementById("overlay").classList.contains("hidden");
  result.classList.toggle("hidden", !state.over || setupOpen);
  if (state.over) {
    document.getElementById("result-title").textContent = state.loser
      ? (state.loser.isHuman ? "Вы дурак" : "Партия окончена")
      : "Ничья";
    document.getElementById("result-text").textContent = state.message;
  }

  if (!human || state.over || actor !== 0) {
    actions.innerHTML = "";
    return;
  }
  if (state.pending && !human.hand.includes(state.pending)) state.pending = null;
  if (state.phase === "lay") {
    actions.innerHTML = "";
  } else if (state.phase === "defend") {
    const choice = state.pending
      ? `<button type="button" id="beat-btn" class="action">Побить ${cardName(state.pending)}</button>
         <button type="button" id="transfer-btn" class="action">Перевести</button>`
      : "";
    actions.innerHTML = `${choice}<button type="button" id="take-btn" class="action danger">Взять</button>`;
  } else if (state.phase === "throw") {
    actions.innerHTML = '<button type="button" id="bito-btn" class="action">Бито</button>';
  } else {
    actions.innerHTML = "";
  }
  bindAction("take-btn", onTake);
  bindAction("bito-btn", onBito);
  bindAction("beat-btn", onBeatChoice);
  bindAction("transfer-btn", onTransferChoice);
}

document.getElementById("hand").addEventListener("click", (event) => {
  const button = event.target.closest("[data-key]");
  if (!button || !state.players[0]) return;
  const card = state.players[0].hand.find((item) => cardKey(item) === button.dataset.key);
  if (card) onCardClick(card);
});

document.getElementById("board").addEventListener("click", (event) => {
  const button = event.target.closest("[data-key]");
  if (button) onBoardClick(button.dataset.key);
});

document.getElementById("setup").addEventListener("submit", (event) => {
  event.preventDefault();
  startGame(Number(document.getElementById("player-count").value));
});

document.getElementById("new-game-btn").addEventListener("click", () => {
  leaveOnline();
  gameId += 1;
  showSetup();
});

document.getElementById("sit-btn").addEventListener("click", () => {
  sitDown();
});

document.getElementById("wait-cancel").addEventListener("click", () => {
  leaveOnline();
  showSetup();
});

document.getElementById("rules-btn").addEventListener("click", () => {
  document.getElementById("rules").classList.remove("hidden");
});

document.getElementById("rules-close").addEventListener("click", () => {
  document.getElementById("rules").classList.add("hidden");
});

document.getElementById("result-again").addEventListener("click", () => {
  if (net.on) sendMove({ type: "rematch" });
  else startGame(state.playerCount);
});

document.getElementById("result-setup").addEventListener("click", () => {
  leaveOnline();
  gameId += 1;
  showSetup();
});
