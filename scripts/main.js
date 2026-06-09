// Target Direction Pointer — Foundry VTT v13/v14 Module
// Draws directional arrows on token borders pointing toward each target.

const MODULE_ID = 'target-direction-pointer';
const CONTAINER_KEY = '_tdpContainer';

// ── Runtime state ──────────────────────────────────────────────────────

const State = {
  active: false,
  hookIds: {},
  tickerFn: null,
  breathTime: 0,
};

// ── Settings helper ────────────────────────────────────────────────────

function cfg(key) {
  return game.settings.get(MODULE_ID, key);
}

function hexToInt(hex) {
  return parseInt(hex.replace('#', ''), 16);
}

// ── Settings registration ──────────────────────────────────────────────

function registerSettings() {
  const reg = (key, type, def, extra = {}) => {
    game.settings.register(MODULE_ID, key, {
      name: `TDP.settings.${key}.name`,
      hint: `TDP.settings.${key}.hint`,
      scope: 'client',
      config: true,
      type,
      default: def,
      onChange: () => { if (State.active) refresh(); },
      ...extra,
    });
  };

  // Master toggle — special onChange
  game.settings.register(MODULE_ID, 'enabled', {
    name: 'TDP.settings.enabled.name',
    hint: 'TDP.settings.enabled.hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true,
    onChange: (val) => val ? activate() : deactivate(),
  });

  // GM option
  reg('gmShowAll', Boolean, true);

  // Arrow geometry
  reg('baseHalfWidth', Number, 6,   { range: { min: 2, max: 20, step: 1 } });
  reg('baseLength',    Number, 12,  { range: { min: 4, max: 40, step: 1 } });
  reg('maxLength',     Number, 30,  { range: { min: 10, max: 80, step: 1 } });
  reg('distFactor',    Number, 1.5, { range: { min: 0, max: 5, step: 0.1 } });
  reg('offset',        Number, 2,   { range: { min: 0, max: 10, step: 1 } });
  reg('outlineWidth',  Number, 1.5, { range: { min: 0, max: 4, step: 0.5 } });

  // Opacity
  reg('alphaClose',   Number, 0.90, { range: { min: 0.1, max: 1, step: 0.05 } });
  reg('alphaFar',     Number, 0.35, { range: { min: 0, max: 1, step: 0.05 } });
  reg('alphaFalloff', Number, 20,   { range: { min: 5, max: 60, step: 1 } });

  // Breathing
  reg('breathSpeed', Number, 0.0015, { range: { min: 0, max: 0.01, step: 0.0005 } });
  reg('breathDepth', Number, 0.12,   { range: { min: 0, max: 0.4, step: 0.02 } });

  // Colors
  reg('colorHostile',  String, '#ff4444');
  reg('colorFriendly', String, '#44ddaa');
  reg('colorNeutral',  String, '#f0c020');
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
    return hexToInt(cfg('colorHostile'));
  }
  if (s === FRIENDLY && t === FRIENDLY) return hexToInt(cfg('colorFriendly'));
  return hexToInt(cfg('colorNeutral'));
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
  const t = Math.min(dist / cfg('alphaFalloff'), 1);
  return cfg('alphaClose') + (cfg('alphaFar') - cfg('alphaClose')) * t;
}

// ── Drawing ────────────────────────────────────────────────────────────

function clearPointers(token) {
  if (!token[CONTAINER_KEY]) return;
  token[CONTAINER_KEY].destroy({ children: true });
  delete token[CONTAINER_KEY];
}

function drawPointers(srcToken, targets) {
  clearPointers(srcToken);
  if (!targets.length) return;

  const baseHalfWidth = cfg('baseHalfWidth');
  const baseLength    = cfg('baseLength');
  const distFactor    = cfg('distFactor');
  const maxLength     = cfg('maxLength');
  const alphaClose    = cfg('alphaClose');
  const offset        = cfg('offset');
  const outlineWidth  = cfg('outlineWidth');
  const outlineColor  = 0x000000;

  const container = new PIXI.Container();
  srcToken.addChild(container);
  srcToken[CONTAINER_KEY] = container;

  const cx = srcToken.w / 2;
  const cy = srcToken.h / 2;
  const scale = tokenScale(srcToken);
  const radius = Math.min(srcToken.w, srcToken.h) / 2 + offset;

  for (const tgt of targets) {
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

function refresh() {
  if (!canvas?.tokens?.placeables) return;
  canvas.tokens.placeables.forEach(clearPointers);
  if (!State.active) return;

  if (game.user.isGM && cfg('gmShowAll')) {
    // Show pointers on every user's character token
    for (const user of game.users) {
      const targets = [...user.targets];
      if (!targets.length) continue;
      const charActor = user.character;
      if (!charActor) continue;
      for (const src of canvas.tokens.placeables) {
        if (src.actor?.id === charActor.id) drawPointers(src, targets);
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

// ── Breathing animation ────────────────────────────────────────────────

function breathTick(delta) {
  const depth = cfg('breathDepth');
  if (depth <= 0) return;
  State.breathTime += delta;
  const speed = cfg('breathSpeed');
  const pulse = Math.sin(State.breathTime * speed * 60) * depth;
  const alpha = 1.0 + pulse;
  for (const t of canvas.tokens.placeables) {
    if (t[CONTAINER_KEY]) t[CONTAINER_KEY].alpha = alpha;
  }
}

// ── Activate / Deactivate / Toggle ─────────────────────────────────────

function activate() {
  if (State.active) return;

  State.hookIds = {
    targetToken:  Hooks.on('targetToken',  () => setTimeout(refresh, 50)),
    updateToken:  Hooks.on('updateToken',  () => setTimeout(refresh, 100)),
    controlToken: Hooks.on('controlToken', () => setTimeout(refresh, 50)),
    refreshToken: Hooks.on('refreshToken', (token) => {
      if (token[CONTAINER_KEY] ||
          canvas.tokens.controlled.includes(token) ||
          game.user.targets.has(token)) {
        setTimeout(refresh, 50);
      }
    }),
  };

  State.tickerFn = breathTick;
  State.breathTime = 0;
  canvas.app.ticker.add(breathTick);
  State.active = true;
  refresh();
}

function deactivate() {
  if (!State.active) return;

  for (const [hook, id] of Object.entries(State.hookIds)) Hooks.off(hook, id);
  State.hookIds = {};

  if (State.tickerFn) {
    canvas.app.ticker.remove(State.tickerFn);
    State.tickerFn = null;
  }

  canvas.tokens?.placeables?.forEach(clearPointers);
  State.active = false;
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
  if (cfg('enabled')) activate();
});

Hooks.on('canvasReady', () => {
  if (State.active) setTimeout(refresh, 200);
});