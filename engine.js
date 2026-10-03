(function () {
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

  const SUIT_ORDER = { c: 0, d: 1, h: 2, s: 3 };

  function fresh() {
    return {
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
      line: null,
      over: false,
      loser: null,
      loserIndex: -1,
      lock: false,
      playerCount: 3,
      beatIndex: -1,
      pending: null,
    };
  }

  const state = fresh();

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

  function rememberLoser() {
    state.loserIndex = state.loser ? state.players.indexOf(state.loser) : -1;
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
      rememberLoser();
      state.message = state.loser
        ? (state.loser.isHuman ? "Вы остались с картами. Вы дурак." : `Дурак — ${state.loser.name}.`)
        : "Ничья: карты кончились у всех.";
      return true;
    }
    rememberLoser();
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

  function note(seat, you, other, localLog) {
    state.line = { seat, you, other };
    state.log = localLog;
  }

  function deal(count, names, humans) {
    const blank = fresh();
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, blank);
    state.playerCount = count;
    state.players = Array.from({ length: count }, (_, index) => ({
      name: names[index],
      isHuman: humans[index],
      hand: [],
      out: false,
    }));
    state.deck = shuffle(SUITS.flatMap((suit) => (
      Object.keys(RANK_LABEL).map((rank) => ({ suit: suit.id, rank: Number(rank) }))
    )));
    state.trumpSuit = state.deck[0].suit;
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
    state.line = { kind: "open", symbol: trump.symbol, attacker: state.attacker };
    beginLay();
  }

  function dealLocal(count) {
    deal(
      count,
      Array.from({ length: count }, (_, index) => (index === 0 ? "Вы" : `Соперник ${index}`)),
      Array.from({ length: count }, (_, index) => index === 0),
    );
  }

  function dealMatch() {
    deal(2, ["Игрок 1", "Игрок 2"], [false, false]);
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
    note(
      state.attacker,
      `Вы кладёте ${cardName(card)}.`,
      `Соперник кладёт ${cardName(card)}.`,
      `${verb(player, "Вы кладёте", "кладёт")} ${cardName(card)}.`,
    );
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
    const beaten = cardName(target.attack);
    removeCard(player, card);
    target.defense = card;
    note(
      state.defender,
      `Вы бьёте ${beaten} картой ${cardName(card)}.`,
      `Соперник бьёт ${beaten} картой ${cardName(card)}.`,
      `${verb(player, "Вы бьёте", "бьёт")} ${beaten} картой ${cardName(card)}.`,
    );
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
    const seat = state.defender;
    const next = nextActive(state.defender);
    removeCard(player, card);
    state.table.push({ attack: card, defense: null });
    note(
      seat,
      `Вы переводите ${cardName(card)} на соперника.`,
      `Соперник переводит ${cardName(card)} на вас.`,
      `${verb(player, "Вы переводите", "переводит")} ${cardName(card)} на ${toward(state.players[next])}.`,
    );
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
    const seat = state.throwCursor;
    removeCard(player, card);
    state.table.push({ attack: card, defense: null });
    state.passes = 0;
    state.phase = "defend";
    clearSelection();
    note(
      seat,
      `Вы подкидываете ${cardName(card)}.`,
      `Соперник подкидывает ${cardName(card)}.`,
      `${verb(player, "Вы подкидываете", "подкидывает")} ${cardName(card)}.`,
    );
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
    const seat = state.throwCursor;
    const player = state.players[seat];
    state.passes += 1;
    note(seat, "Вы: бито.", "Соперник: бито.", `${player.isHuman ? "Вы" : player.name}: бито.`);
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
    state.line = { kind: "text", text: "Бито. Карты уходят в отбой." };
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
    const seat = state.defender;
    const defender = state.players[seat];
    defender.hand.push(...tableCards());
    sortHand(defender);
    state.table = [];
    note(
      seat,
      "Вы забираете карты.",
      "Соперник забирает карты.",
      `${verb(defender, "Вы забираете", "забирает")} карты.`,
    );
    clearSelection();
    const attacker = state.attacker;
    replenish(attacker, seat);
    if (checkEnd()) return;
    const next = nextActive(seat);
    if (next < 0) {
      checkEnd();
      return;
    }
    state.attacker = next;
    beginLay();
  }

  function sweepPasses() {
    let guard = 0;
    while (!state.over && state.phase === "throw" && guard < 8) {
      const actor = currentActor();
      if (actor < 0 || legalThrowCards(actor).length > 0) break;
      passThrow();
      guard += 1;
    }
  }

  function findCard(seat, key) {
    return state.players[seat].hand.find((card) => cardKey(card) === key) || null;
  }

  function perform(seat, action) {
    if (!action) return { ok: false, error: "Пустой ход." };
    if (action.type === "rematch") {
      if (!state.over) return { ok: false, error: "Партия ещё идёт." };
      dealMatch();
      return { ok: true };
    }
    if (state.over) return { ok: false, error: "Игра окончена." };
    if (currentActor() !== seat) return { ok: false, error: "Сейчас ход другого игрока." };
    const card = action.key ? findCard(seat, action.key) : null;
    let ok = false;
    if (action.type === "lay") {
      if (!card) return { ok: false, error: "Нет такой карты." };
      ok = playLay(card);
      if (ok) ok = finishLay();
    } else if (action.type === "beat") {
      if (!card) return { ok: false, error: "Нет такой карты." };
      if (action.target) {
        const index = state.table.findIndex((pair) => !pair.defense && cardKey(pair.attack) === action.target);
        if (index >= 0) state.beatIndex = index;
      }
      ok = playDefense(card);
    } else if (action.type === "transfer") {
      if (!card) return { ok: false, error: "Нет такой карты." };
      ok = playTransfer(card);
    } else if (action.type === "throw") {
      if (!card) return { ok: false, error: "Нет такой карты." };
      ok = playThrow(card);
    } else if (action.type === "take") {
      if (state.phase !== "defend") return { ok: false, error: "Сейчас не защита." };
      takeCards();
      ok = true;
    } else if (action.type === "pass") {
      if (state.phase !== "throw") return { ok: false, error: "Сейчас не подкидывание." };
      passThrow();
      ok = true;
    } else {
      return { ok: false, error: "Неизвестный ход." };
    }
    if (!ok) return { ok: false, error: state.log || "Ход не принят." };
    sweepPasses();
    return { ok: true };
  }

  function legalActions(seat) {
    if (state.over || currentActor() !== seat) return [];
    const hand = state.players[seat].hand;
    if (state.phase === "lay") {
      return hand.filter((card) => {
        if (slotsLeft() <= 0) return false;
        if (state.table.length === 0) return true;
        return card.rank === state.table[0].attack.rank;
      }).map((card) => ({ type: "lay", key: cardKey(card) }));
    }
    if (state.phase === "defend") {
      const actions = [];
      for (const card of hand) {
        if (canTransfer(card)) actions.push({ type: "transfer", key: cardKey(card) });
        for (const pair of state.table) {
          if (!pair.defense && beats(card, pair.attack)) {
            actions.push({ type: "beat", key: cardKey(card), target: cardKey(pair.attack) });
          }
        }
      }
      actions.push({ type: "take" });
      return actions;
    }
    if (state.phase === "throw") {
      const actions = legalThrowCards(seat).map((card) => ({ type: "throw", key: cardKey(card) }));
      actions.push({ type: "pass" });
      return actions;
    }
    return [];
  }

  function statusFor(seat) {
    if (!state.players.length) return "Соберите стол и раздайте карты";
    if (state.over) {
      if (state.loserIndex < 0) return "Ничья: карты кончились у всех.";
      return state.loserIndex === seat
        ? "Вы остались с картами. Вы дурак."
        : "Дурак — соперник.";
    }
    if (state.phase === "lay") {
      return state.attacker === seat ? "Ваш заход. Положите карту." : "Соперник ходит.";
    }
    if (state.phase === "defend") {
      if (state.defender !== seat) return "Соперник отбивается.";
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
    if (state.phase === "throw") {
      return state.throwCursor === seat
        ? "Подкиньте карту или нажмите «Бито»."
        : "Соперник может подкинуть.";
    }
    return state.message;
  }

  function logFor(viewer) {
    const line = state.line;
    if (!line) return state.log || "";
    if (line.kind === "open") {
      return `Козырь ${line.symbol}. Первый ход — ${line.attacker === viewer ? "ваш" : "соперника"}.`;
    }
    if (line.kind === "text") return line.text;
    return line.seat === viewer ? line.you : line.other;
  }

  function publicCard(card) {
    return { suit: card.suit, rank: card.rank };
  }

  function viewFor(seat) {
    const total = state.players.length;
    const map = (index) => (index - seat + total) % total;
    const players = state.players.map((player, index) => {
      const mine = index === seat;
      return {
        local: map(index),
        name: mine ? "Вы" : "Соперник",
        isHuman: mine,
        out: player.out,
        hand: mine
          ? player.hand.map(publicCard)
          : player.hand.map(() => ({ hidden: true })),
      };
    }).sort((a, b) => a.local - b.local);
    return {
      waiting: false,
      trumpSuit: state.trumpSuit,
      deckCount: state.deck.length,
      trumpCard: state.deck[0] ? publicCard(state.deck[0]) : null,
      discardCount: state.discardCount,
      table: state.table.map((pair) => ({
        attack: publicCard(pair.attack),
        defense: pair.defense ? publicCard(pair.defense) : null,
      })),
      attacker: map(state.attacker),
      defender: map(state.defender),
      throwCursor: map(state.throwCursor),
      phase: state.phase,
      defenseLimit: state.defenseLimit,
      passes: state.passes,
      over: state.over,
      loser: state.loserIndex < 0 ? null : {
        isHuman: state.loserIndex === seat,
        name: state.loserIndex === seat ? "Вы" : "Соперник",
      },
      message: statusFor(seat),
      log: logFor(seat),
      players,
      playerCount: total,
    };
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  function restore(raw) {
    const next = JSON.parse(JSON.stringify(raw));
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, next);
    state.loser = state.loserIndex >= 0 ? state.players[state.loserIndex] : null;
  }

  function blank() {
    const next = fresh();
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, next);
  }

  function cardCount() {
    let total = state.deck.length + state.discardCount;
    for (const player of state.players) total += player.hand.length;
    for (const pair of state.table) {
      total += 1;
      if (pair.defense) total += 1;
    }
    return total;
  }

  globalThis.Durak = {
    state,
    SUITS,
    RANK_LABEL,
    suitInfo,
    cardName,
    cardKey,
    sortHand,
    currentActor,
    beatTarget,
    cardPlayable,
    canBeat,
    canTransfer,
    nothingBeaten,
    legalThrowCards,
    wasteScore,
    playLay,
    finishLay,
    playDefense,
    playTransfer,
    playThrow,
    passThrow,
    takeCards,
    dealLocal,
    dealMatch,
    perform,
    legalActions,
    viewFor,
    snapshot,
    restore,
    blank,
    cardCount,
  };
})();
