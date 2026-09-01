// Corn's Target Direction Pointer — Foundry VTT v13 / v14
// Draws directional arrows on token borders pointing toward each target.
//
// Canvas drawing uses the PIXI v7 Graphics API. Foundry pins pixi.js to 7.4.3
// in both v13 and v14, so lineStyle/beginFill/endFill remain valid. The ticker
// callback deliberately reads canvas.app.ticker.deltaMS instead of trusting the
// callback argument, which changes shape under PIXI v8.

const MODULE_ID = 'target-direction-pointer';
const CONTAINER_KEY = '_tdpContainer';

// ── Setting definitions ────────────────────────────────────────────────
// Single source of truth for registration and for the runtime cache below.

const SETTINGS = {
  gmShowAll:     { type: Boolean, default: true },

  // Arrow geometry
  baseHalfWidth: { type: Number, default: 6,      range: { min: 2,   max: 20,   step: 1 } },
  baseLength:    { type: Number, default: 12,     range: { min: 4,   max: 40,   step: 1 } },
  maxLength:     { type: Number, default: 30,     range: { min: 10,  max: 80,   step: 1 } },
  distFactor:    { type: Number, default: 1.5,    range: { min: 0,   max: 5,    step: 0.1 } },
  offset:        { type: Number, default: 2,      range: { min: 0,   max: 10,   step: 1 } },
  outlineWidth:  { type: Number, default: 1.5,    range: { min: 0,   max: 4,    step: 0.5 } },

  // Opacity
  alphaClose:    { type: Number, default: 0.90,   range: { min: 0.1, max: 1,    step: 0.05 } },
  alphaFar:      { type: Number, default: 0.35,   range: { min: 0,   max: 1,    step: 0.05 } },
  alphaFalloff:  { type: Number, default: 20,     range: { min: 5,   max: 60,   step: 1 } },

  // Breathing
  breathSpeed:   { type: Number, default: 0.0015, range: { min: 0,   max: 0.01, step: 0.0005 } },
  breathDepth:   { type: Number, default: 0.12,   range: { min: 0,   max: 0.4,  step: 0.02 } },

  // Colors
  colorHostile:  { color: true, default: '#ff4444' },
  colorFriendly: { color: true, default: '#44ddaa' },
  colorNeutral:  { color: true, default: '#f0c020' },
};

const COLOR_KEYS = Object.keys(SETTINGS).filter((k) => SETTINGS[k].color);

// ── Runtime state ──────────────────────────────────────────────────────

const State = {
  active: false,
  hookIds: {},
  tickerFn: null,
  breathTime: 0, // seconds
  dirty: false,
};

// Cached setting values. Reading a client-scoped setting hits localStorage,
// which is too costly to repeat per-frame and per-arrow, so snapshot on change.
const Cfg = {};

function syncCfg() {
  for (const key of Object.keys(SETTINGS)) Cfg[key] = game.settings.get(MODULE_ID, key);
  for (const key of COLOR_KEYS) Cfg[`${key}Int`] = toColorInt(Cfg[key], SETTINGS[key].default);
}

// Accepts a hex string, a number, or a foundry.utils.Color instance — a
// ColorField-typed setting hands back the latter.
function toColorInt(value, fallback) {
  for (const candidate of [value, fallback]) {
    try {
      const n = Number(foundry.utils.Color.from(candidate));
      if (Number.isFinite(n)) return n;
    } catch (err) {
      // Unparseable as a color; fall through to the fallback, then to white.
    }
  }
  return 0xffffff;
}

// ── Settings registration ──────────────────────────────────────────────

// v12+ accepts a DataField instance as a setting type and renders it with that
// field's own widget — ColorField produces a native <color-picker>.
function colorField(initial) {
  const ColorField = foundry.data?.fields?.ColorField;
  return ColorField ? new ColorField({ required: true, nullable: false, initial }) : String;
}

function registerSettings() {
  // Master toggle — special onChange
  game.settings.register(MODULE_ID, 'enabled', {
    name: 'TDP.settings.enabled.name',
    hint: 'TDP.settings.enabled.hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true,
    onChange: (val) => (val ? activate() : deactivate()),
  });

  for (const [key, def] of Object.entries(SETTINGS)) {
    const config = {
      name: `TDP.settings.${key}.name`,
      hint: `TDP.settings.${key}.hint`,
      scope: 'client',
      config: true,
      type: def.color ? colorField(def.default) : def.type,
      default: def.default,
      onChange: () => { syncCfg(); markDirty(); },
    };
    if (def.range) config.range = def.range;
    game.settings.register(MODULE_ID, key, config);
  }
}

function registerKeybinding() {
  game.keybindings.register(MODULE_ID, 'toggle', {
    name: 'TDP.keybinding.toggle.name',
    hint: 'TDP.keybinding.toggle.hint',
    editable: [],
    onDown: () => { toggle(); return true; },
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
  });
}

// ── Color logic ────────────────────────────────────────────────────────

function arrowColor(srcDoc, tgtDoc) {
  const FRIENDLY = CONST.TOKEN_DISPOSITIONS.FRIENDLY;
  const HOSTILE = CONST.TOKEN_DISPOSITIONS.HOSTILE;
  const s = srcDoc?.disposition ?? HOSTILE;
  const t = tgtDoc?.disposition ?? HOSTILE;

  if ((s === HOSTILE && t === FRIENDLY) || (s === FRIENDLY && t === HOSTILE)) {
    return Cfg.colorHostileInt;
  }
  if (s === FRIENDLY && t === FRIENDLY) return Cfg.colorFriendlyInt;
  return Cfg.colorNeutralInt;
}

// ── Geometry helpers ───────────────────────────────────────────────────

function gridDist(a, b) {
  const gs = canvas.grid.size;
  const dx = (a.x - b.x) / gs;
  const dy = (a.y - b.y) / gs;
  return Math.sqrt(dx * dx + dy * dy);
}

function tokenScale(token) {
  return Math.min(token.w, token.h) / canvas.grid.size;
}

function distAlpha(dist) {
  const t = Math.min(dist / Cfg.alphaFalloff, 1);
  return Cfg.alphaClose + (Cfg.alphaFar - Cfg.alphaClose) * t;
}

// ── Drawing ────────────────────────────────────────────────────────────

function clearPointers(token) {
  const container = token?.[CONTAINER_KEY];
  if (!container) return;
  delete token[CONTAINER_KEY];
  if (!container.destroyed) container.destroy({ children: true });
}

function drawPointers(srcToken, targets) {
  clearPointers(srcToken);
  if (!targets.length || srcToken.destroyed) return;

  // Skip tokens this client cannot see — vision, GM-hidden, or (v14) parked on
  // a Scene Level that is not currently displayed. Controlled tokens always
  // draw, so a player never loses arrows on the token they are driving.
  if (!srcToken.controlled && !srcToken.visible) return;

  const { baseHalfWidth, baseLength, distFactor, maxLength, alphaClose, offset, outlineWidth } = Cfg;
  const outlineColor = 0x000000;

  const container = new PIXI.Container();
  container.eventMode = 'none'; // never intercept clicks or drags on the token
  srcToken.addChild(container);
  srcToken[CONTAINER_KEY] = container;

  const cx = srcToken.w / 2;
  const cy = srcToken.h / 2;
  const scale = tokenScale(srcToken);
  const radius = Math.min(srcToken.w, srcToken.h) / 2 + offset;

  for (const tgt of targets) {
    if (!tgt || tgt.destroyed) continue;
    const color = arrowColor(srcToken.document, tgt.document);
    const g = new PIXI.Graphics();

    // ── Self-target: thick stroke ring at centre ───────────────────
    if (tgt.id === srcToken.id) {
      const ringR = baseHalfWidth * scale;
      const strokeW = Math.max(ringR * 0.4, 2);
      g.lineStyle(strokeW, color, alphaClose);
      g.drawCircle(cx, cy, ringR);
      g.lineStyle(outlineWidth, outlineColor, 0.5);
      g.drawCircle(cx, cy, ringR + strokeW * 0.5);
      g.drawCircle(cx, cy, ringR - strokeW * 0.5);
      container.addChild(g);
      continue;
    }

    // ── Directional arrow ──────────────────────────────────────────
    const sc = srcToken.center;
    const tc = tgt.center;
    const angle = Math.atan2(tc.y - sc.y, tc.x - sc.x);
    const dist = gridDist(sc, tc);
    const alpha = distAlpha(dist);

    const halfW = baseHalfWidth * scale;
    const len = Math.min(baseLength + distFactor * dist, maxLength * scale);

    // Anchor point on token border (local coords)
    const bx = cx + Math.cos(angle) * radius;
    const by = cy + Math.sin(angle) * radius;

    // Triangle tip
    const tipX = bx + Math.cos(angle) * len;
    const tipY = by + Math.sin(angle) * len;

    // Triangle base corners
    const perp = angle + Math.PI / 2;
    const b1x = bx + Math.cos(perp) * halfW;
    const b1y = by + Math.sin(perp) * halfW;
    const b2x = bx - Math.cos(perp) * halfW;
    const b2y = by - Math.sin(perp) * halfW;

    g.lineStyle(outlineWidth, outlineColor, 1);
    g.beginFill(color, alpha);
    g.moveTo(tipX, tipY);
    g.lineTo(b1x, b1y);
    g.lineTo(b2x, b2y);
    g.closePath();
    g.endFill();

    container.addChild(g);
  }
}

// ── Refresh ────────────────────────────────────────────────────────────

// refreshToken fires once per animation frame while a token moves. Rather than
// rebuilding immediately (or stacking setTimeouts), flag the state dirty and
// let the ticker coalesce it into at most one rebuild per frame.
function markDirty() {
  State.dirty = true;
}

function showingAll() {
  return game.user.isGM && Cfg.gmShowAll;
}

function refresh() {
  if (!canvas?.tokens?.placeables) return;
  for (const token of canvas.tokens.placeables) clearPointers(token);
  if (!State.active) return;

  if (showingAll()) {
    // Show pointers on every connected user's character token
    for (const user of game.users) {
      if (!user.active) continue;
      const targets = [...user.targets];
      if (!targets.length) continue;
      const charId = user.character?.id;
      if (!charId) continue;
      for (const src of canvas.tokens.placeables) {
        if (src.actor?.id === charId) drawPointers(src, targets);
      }
    }
    // GM's own controlled tokens (skip any already drawn above)
    const gmTargets = [...game.user.targets];
    if (gmTargets.length) {
      for (const token of canvas.tokens.controlled) {
        if (!token[CONTAINER_KEY]) drawPointers(token, gmTargets);
      }
    }
  } else {
    // Player: controlled tokens only
    const targets = [...game.user.targets];
    if (!targets.length) return;
    for (const token of canvas.tokens.controlled) {
      drawPointers(token, targets);
    }
  }
}

function onRefreshToken(token) {
  // In GM show-all mode any token may be somebody's source or target.
  if (showingAll()) return markDirty();
  if (token[CONTAINER_KEY] || token.controlled || game.user.targets.has(token)) markDirty();
}

// ── Per-frame tick: rebuild if dirty, then breathe ─────────────────────

function tick() {
  if (State.dirty) {
    State.dirty = false;
    refresh();
  }
  if (!canvas?.tokens?.placeables) return;

  // deltaMS keeps the pulse frame-rate independent. speed * 3600 is the angular
  // rate in rad/s, matching the original frame-counted formula at 60fps.
  let alpha = 1;
  const depth = Cfg.breathDepth;
  const speed = Cfg.breathSpeed;
  if (depth > 0 && speed > 0) {
    State.breathTime += (canvas.app?.ticker?.deltaMS ?? 0) / 1000;
    const phase = State.breathTime * speed * 3600;
    // Raised cosine dips from 1 down to 1 - depth without clipping at 1.
    alpha = 1 - depth * (0.5 - 0.5 * Math.cos(phase));
  }

  for (const token of canvas.tokens.placeables) {
    const container = token[CONTAINER_KEY];
    if (container && !container.destroyed) container.alpha = alpha;
  }
}

function attachTicker() {
  if (State.tickerFn || !canvas?.app?.ticker) return;
  State.tickerFn = tick;
  canvas.app.ticker.add(tick);
}

function detachTicker() {
  if (!State.tickerFn) return;
  canvas?.app?.ticker?.remove(State.tickerFn);
  State.tickerFn = null;
}

// ── Activate / Deactivate / Toggle ─────────────────────────────────────

function activate() {
  if (State.active) return;

  State.hookIds = {
    targetToken:  Hooks.on('targetToken',  markDirty),
    updateToken:  Hooks.on('updateToken',  markDirty),
    controlToken: Hooks.on('controlToken', markDirty),
    deleteToken:  Hooks.on('deleteToken',  markDirty),
    refreshToken: Hooks.on('refreshToken', onRefreshToken),
    // Vision/level changes flip Token#visible without a token refresh.
    sightRefresh: Hooks.on('sightRefresh', markDirty),
  };

  State.breathTime = 0;
  State.active = true;
  attachTicker();
  refresh();
}

function deactivate() {
  if (!State.active) return;

  for (const [hook, id] of Object.entries(State.hookIds)) Hooks.off(hook, id);
  State.hookIds = {};

  detachTicker();
  State.dirty = false;
  State.active = false;
  canvas?.tokens?.placeables?.forEach(clearPointers);
}

function toggle() {
  if (State.active) {
    deactivate();
    ui.notifications.info(game.i18n.localize('TDP.notifications.off'));
  } else {
    activate();
    ui.notifications.info(game.i18n.localize('TDP.notifications.on'));
  }
}

// ── Module lifecycle ───────────────────────────────────────────────────

Hooks.once('init', () => {
  registerSettings();
  registerKeybinding();
});

Hooks.once('ready', () => {
  syncCfg();
  if (game.settings.get(MODULE_ID, 'enabled')) activate();
});

Hooks.on('canvasReady', () => {
  if (!State.active) return;
  attachTicker(); // the PIXI application can be rebuilt between scenes
  markDirty();
});

Hooks.on('canvasTearDown', () => {
  // Containers die with their tokens; drop the pending rebuild and release the
  // ticker so canvasReady can re-attach against whatever application is live.
  State.dirty = false;
  detachTicker();
});
