"use strict";
/*
 * Canvas AltSnap
 * AltSnap style hotkey + mouse move/resize for Obsidian canvas groups and nodes.
 * Resize zone logic is ported from AltSnap's hooks.c (SetEdgeAndOffsetCF, SetEdgeToClosestSide, ActionResize).
 * Only changes node position/size through Obsidian's own canvas API. Never touches files directly.
 */
const obsidian = require("obsidian");

const BUTTONS = [
  { id: "left", btn: 0, name: "Left mouse button" },
  { id: "middle", btn: 1, name: "Middle mouse button" },
  { id: "right", btn: 2, name: "Right mouse button" },
  { id: "back", btn: 3, name: "Mouse button 4 (back)" },
  { id: "forward", btn: 4, name: "Mouse button 5 (forward)" },
];
const ACTIONS = { nothing: "Nothing (pass click through)", move: "Move", resize: "Resize" };
const DBL_ACTIONS = {
  nothing: "Nothing",
  fit: "Fit group to its contents",
  zoom: "Zoom to node",
  select: "Select node",
};
const HOTKEYS = {
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  ControlLeft: "Left Ctrl",
  ControlRight: "Right Ctrl",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  MetaLeft: "Left Win / Cmd",
  MetaRight: "Right Win / Cmd",
};
const FLAG = { Alt: "altKey", Control: "ctrlKey", Shift: "shiftKey", Meta: "metaKey" };

const DEFAULT_SETTINGS = {
  enabled: true,
  // Keyboard
  hotkeys: ["AltLeft", "AltRight"],
  keyCombo: false,
  altActionKey: "none",
  escCancels: true,
  blockAltKeyup: true,
  // Mouse
  actions: { left: "move", middle: "nothing", right: "resize", back: "nothing", forward: "nothing" },
  altActions: { left: "nothing", middle: "nothing", right: "nothing", back: "nothing", forward: "nothing" },
  dblActions: { left: "nothing", middle: "nothing", right: "nothing", back: "nothing", forward: "nothing" },
  dblClickMs: 400,
  clickNoDrag: "block",
  // General
  targetMode: "nodesFirst",
  pickOrder: "innermost",
  resizeCenter: "all",
  centerFraction: 24,
  sidesFraction: 24,
  moveChildren: true,
  selectAfter: false,
  selectOnGrab: true,
  touchLongPress: true,
  longPressMs: 350,
  longPressTolerance: 10,
  touchButton: "mobile",
  touchVibrate: true,
  touchSmoothing: 0.3,
  skipCollapsed: true,
  minWidth: 60,
  minHeight: 60,
  fitPadding: 40,
  blacklistLabels: "",
  blacklistColors: "",
  // Alignment snapping
  alignEnabled: true,
  alignThreshold: 5,
  snapRelease: 2,
  shiftSnaps: true,
  gridSize: 0,
  stickyResize: "off",
  // Performance
  dragThreshold: 3,
  refreshRate: 0,
  moveRate: 1,
  resizeRate: 1,
  // Visual
  dragOpacity: 255,
  cursorMode: "1",
};

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function isPortalId(id) { return typeof id === "string" && id.includes("||"); }
function bboxOf(d) { return { minX: d.x, minY: d.y, maxX: d.x + d.width, maxY: d.y + d.height }; }
function containsBox(outer, inner) {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

/* ---------- AltSnap resize zone logic (ported) ---------- */
// "Think of the window as nine boxes". rx/ry: -1 = left/top, 0 = center, 1 = right/bottom
function edgeCF(w, h, lx, ly, cf) {
  const sideS = Math.floor((100 - cf) / 2);
  const centeR = 100 - sideS;
  const rx = lx < (w * sideS) / 100 ? -1 : lx < (w * centeR) / 100 ? 0 : 1;
  const ry = ly < (h * sideS) / 100 ? -1 : ly < (h * centeR) / 100 ? 0 : 1;
  return { rx, ry };
}
// Use diagonals to determine the closest side. Only sets one axis, like AltSnap.
function closestSide(w, h, lx, ly, e) {
  const TR = ly * w <= h * lx;
  const TL = (h - ly) * w >= h * lx;
  if (TR) { if (TL) e.ry = -1; else e.rx = 1; }
  else { if (TL) e.rx = -1; else e.ry = 1; }
  return e;
}
function pickEdge(s, w, h, lx, ly) {
  const cf = clamp(s.centerFraction, 0, 100);
  const sf = clamp(s.sidesFraction, 0, 100);
  let e = edgeCF(w, h, lx, ly, cf);
  if (sf !== cf && (e.rx !== 0 || e.ry !== 0)) {
    e = edgeCF(w, h, lx, ly, sf);
    if (sf > cf) closestSide(w, h, lx, ly, e);
  }
  let mode = "resize";
  if (e.rx === 0 && e.ry === 0) {
    if (s.resizeCenter === "bottomright") { e.rx = 1; e.ry = 1; }
    else if (s.resizeCenter === "move") mode = "move";
    else if (s.resizeCenter === "closest") closestSide(w, h, lx, ly, e);
    else mode = "sym"; // all directions
  }
  return { rx: e.rx, ry: e.ry, mode };
}

class CanvasAltSnapPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.pressed = new Set();
    this.st = null;
    this.suppressUntil = 0;
    this.actedSinceKeyDown = false;
    this.lp = null;
    this.touchPaused = false;
    this.lastClick = null;
    this.hooked = new WeakSet();

    this.addSettingTab(new CanvasAltSnapSettingTab(this.app, this));
    this.addCommand({
      id: "toggle",
      name: "Toggle on/off",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
        new obsidian.Notice("Canvas AltSnap " + (this.settings.enabled ? "on" : "off"));
        this.refreshButtons();
      },
    });

    this.hookWindow(window);
    this.addCommand({ id: "toggle-touch-mode", name: "Toggle touch AltSnap", callback: () => this.toggleTouchMode() });
    const refresh = () => this.refreshButtons();
    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.iterateAllLeaves((leaf) => {
        const doc = leaf.view && leaf.view.containerEl && leaf.view.containerEl.ownerDocument;
        if (doc && doc.defaultView) this.hookWindow(doc.defaultView);
      });
      refresh();
    });
    this.registerEvent(this.app.workspace.on("layout-change", refresh));
    this.registerEvent(this.app.workspace.on("active-leaf-change", refresh));
    this.registerEvent(this.app.workspace.on("file-open", refresh));
    this.registerEvent(this.app.workspace.on("window-open", (_ww, win) => this.hookWindow(win)));
  }

  onunload() {
    this.cancelLongPress();
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const g = leaf.view && leaf.view.containerEl && leaf.view.containerEl.querySelector(".cas-touch-group");
      if (g) g.remove();
    }
    if (this.st) this.finish(false);
  }

  hookWindow(win) {
    if (!win || this.hooked.has(win)) return;
    this.hooked.add(win);
    const opt = { capture: true, passive: false };
    this.registerDomEvent(win, "keydown", (e) => this.onKeyDown(e), opt);
    this.registerDomEvent(win, "keyup", (e) => this.onKeyUp(e), opt);
    this.registerDomEvent(win, "blur", () => this.onBlur(), opt);
    this.registerDomEvent(win, "pointerdown", (e) => this.onPointerDown(e), opt);
    this.registerDomEvent(win, "pointermove", (e) => this.onPointerMove(e), opt);
    this.registerDomEvent(win, "pointerup", (e) => this.onPointerUp(e), opt);
    this.registerDomEvent(win, "pointercancel", (e) => this.onPointerUp(e), opt);
    for (const t of ["mousedown", "mousemove", "mouseup", "contextmenu", "auxclick", "click", "dblclick", "touchstart", "touchmove", "touchend"]) {
      this.registerDomEvent(win, t, (e) => this.onBlockable(e), opt);
    }
  }

  /* ---------- keys ---------- */
  onKeyDown(e) {
    if (e.code === "Escape" && this.st) {
      if (this.settings.escCancels) {
        e.preventDefault(); e.stopPropagation();
        this.finish(true);
        this.suppressUntil = Date.now() + 400;
      }
      return;
    }
    if (!e.repeat && HOTKEYS[e.code]) {
      if (!this.pressed.has(e.code) && this.settings.hotkeys.includes(e.code)) this.actedSinceKeyDown = false;
      this.pressed.add(e.code);
    }
  }
  onKeyUp(e) {
    this.pressed.delete(e.code);
    if (this.settings.blockAltKeyup && this.actedSinceKeyDown && this.settings.hotkeys.includes(e.code)) {
      e.preventDefault(); e.stopPropagation();
    }
  }
  onBlur() {
    this.pressed.clear();
    if (this.st) { this.finish(false); this.suppressUntil = Date.now() + 400; }
  }

  keyHeld(code, e) {
    const fam = code.replace(/Left|Right/, "");
    if (this.pressed.has(code)) {
      if (e[FLAG[fam]] === false) { this.pressed.delete(code); return false; }
      return true;
    }
    // Fallback when the keydown was missed (key pressed before window had focus)
    const famTracked = [...this.pressed].some((c) => c.replace(/Left|Right/, "") === fam);
    return !famTracked && !!e[FLAG[fam]];
  }
  hotkeyHeld(e) {
    const sel = this.settings.hotkeys;
    if (!sel.length) return false;
    let count = 0;
    const famsCounted = new Set();
    for (const code of sel) {
      const fam = code.replace(/Left|Right/, "");
      if (this.pressed.has(code)) { if (this.keyHeld(code, e)) count++; continue; }
      if (!famsCounted.has(fam) && this.keyHeld(code, e)) { count++; famsCounted.add(fam); }
    }
    return this.settings.keyCombo ? count >= 2 : count >= 1;
  }
  shiftHeld(e) { return this.pressed.has("ShiftLeft") || this.pressed.has("ShiftRight") || e.shiftKey; }
  ctrlHeld(e) { return this.pressed.has("ControlLeft") || this.pressed.has("ControlRight") || e.ctrlKey; }

  /* ---------- canvas helpers ---------- */
  findCanvas(target) {
    if (!target || !target.ownerDocument) return null;
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const c = leaf.view && leaf.view.canvas;
      if (c && c.wrapperEl && c.wrapperEl.contains(target)) return c;
    }
    return null;
  }
  scaleOf(canvas) {
    if (typeof canvas.scale === "number" && canvas.scale > 0) return canvas.scale;
    if (typeof canvas.zoom === "number") return Math.pow(2, canvas.zoom);
    return 1;
  }
  blacklisted(d) {
    const s = this.settings;
    if (isPortalId(d.id)) return true;
    if (s.skipCollapsed && d.collapsed) return true;
    if (s.blacklistColors.trim()) {
      const cols = s.blacklistColors.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
      if (d.color && cols.includes(String(d.color).toLowerCase())) return true;
    }
    if (s.blacklistLabels.trim() && d.type === "group") {
      for (const line of s.blacklistLabels.split("\n")) {
        const p = line.trim();
        if (!p) continue;
        try { if (new RegExp(p, "i").test(d.label || "")) return true; }
        catch (_) { if ((d.label || "").toLowerCase().includes(p.toLowerCase())) return true; }
      }
    }
    return false;
  }
  // Nodes first: a note under the cursor wins. Otherwise the innermost (smallest) group in the stack.
  hitTest(canvas, pos) {
    const s = this.settings;
    const inner = s.pickOrder === "innermost";
    let node = null, nodeArea = 0, group = null, groupArea = 0;
    for (const n of canvas.nodes.values()) {
      const d = n.getData();
      if (pos.x < d.x || pos.x > d.x + d.width || pos.y < d.y || pos.y > d.y + d.height) continue;
      if (this.blacklisted(d)) continue;
      const area = d.width * d.height;
      if (d.type === "group") {
        if (!group || (inner ? area < groupArea : area > groupArea)) { group = n; groupArea = area; }
      } else if (!node || area < nodeArea) { node = n; nodeArea = area; }
    }
    if (s.targetMode === "groups") return group;
    return node || group;
  }
  childrenOf(canvas, node) {
    const d = node.getData();
    if (d.type !== "group") return [];
    const box = bboxOf(d);
    const out = [];
    for (const n of canvas.nodes.values()) {
      if (n === node) continue;
      const nd = n.getData();
      if (isPortalId(nd.id)) continue;
      if (containsBox(box, bboxOf(nd))) out.push(n);
    }
    return out;
  }
  applyGeom(canvas, node, g) {
    if (![g.x, g.y, g.width, g.height].every(Number.isFinite) || g.width <= 0 || g.height <= 0) return;
    const cur = node.getData();
    if (cur.x === g.x && cur.y === g.y && cur.width === g.width && cur.height === g.height) return;
    node.setData(Object.assign({}, cur, { x: g.x, y: g.y, width: g.width, height: g.height }));
    if (typeof canvas.markMoved === "function") canvas.markMoved(node);
  }

  /* ---------- pointer ---------- */
  onBlockable(e) {
    if (this.lp && e.type === "contextmenu") { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return; }
    if (e.type.startsWith("touch") && !(this.st && this.st.touch)) return;
    if (this.st || Date.now() < this.suppressUntil) {
      if (e.type === "contextmenu" && this.passContextOnce && (!this.st || !this.st.started)) { this.passContextOnce = false; return; }
      if (e.type === "mousemove" && !this.st) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    }
  }

  onPointerDown(e) {
    try { this.pointerDown(e); }
    catch (err) {
      console.error("[canvas-altsnap]", err);
      new obsidian.Notice("Canvas AltSnap error: " + (err && err.message), 5000);
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (this.st) this.finish(true);
    }
  }

  pointerDown(e) {
    const s = this.settings;
    if (e.pointerType === "touch") return this.touchDown(e);
    if (this.st) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return; }
    if (!s.enabled) return;
    const b = BUTTONS.find((x) => x.btn === e.button);
    if (!b) return;
    const canvas = this.findCanvas(e.target);
    if (!canvas) return;
    if (!this.hotkeyHeld(e)) return;
    if (canvas.readonly) return;
    if (e.target.closest && e.target.closest(".canvas-controls, .canvas-card-menu, .canvas-menu, .menu, .modal")) return;

    // Alternate key only counts if it isn't one of the hotkeys themselves
    const altHeld = s.altActionKey !== "none" && !s.hotkeys.includes(s.altActionKey) && this.keyHeld(s.altActionKey, e);
    const action = (altHeld ? s.altActions : s.actions)[b.id] || "nothing";
    const dbl = s.dblActions[b.id] || "nothing";
    if (action === "nothing" && dbl === "nothing") return;

    // Hotkey + a mapped button inside the canvas is always ours, so it never pans the canvas
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    this.actedSinceKeyDown = true;
    this.suppressUntil = Date.now() + 400;
    this.passContextOnce = false;

    if (typeof canvas.posFromEvt !== "function") return;
    const pos = canvas.posFromEvt(e);
    // Several nodes selected and the cursor inside their box: the whole selection is the target
    const sel = this.selectionAt(canvas, pos);
    const node = sel ? null : this.hitTest(canvas, pos);
    if (!sel && !node) return;
    this.passContextOnce = s.clickNoDrag === "pass" && e.button === 2;
    if (node && s.selectOnGrab && typeof canvas.selectOnly === "function") canvas.selectOnly(node);
    const targetId = node ? node.id : "selection";

    const now = Date.now();
    const lc = this.lastClick;
    this.lastClick = { t: now, btn: e.button, id: targetId };
    if (node && dbl !== "nothing" && lc && lc.btn === e.button && lc.id === targetId && now - lc.t <= s.dblClickMs) {
      this.lastClick = null;
      this.suppressUntil = now + 400;
      this.doDouble(canvas, node, dbl);
      return;
    }
    if (action === "nothing") { this.suppressUntil = now + 400; return; }
    this.begin(canvas, sel || node, pos, e, action, false);
  }

  /* ---------- touch ---------- */
  touchDown(e) {
    const s = this.settings;
    if (!e.isPrimary && !this.st) { this.cancelLongPress(); return; }
    if (this.st) {
      // A second finger cancels a touch drag so pinch zoom stays usable
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (this.st.touch && e.pointerId !== this.st.pointerId) { this.finish(true); this.suppressUntil = Date.now() + 400; }
      return;
    }
    this.cancelLongPress();
    if (!s.enabled || !s.touchLongPress || this.touchPaused) return;
    const canvas = this.findCanvas(e.target);
    if (!canvas || canvas.readonly || typeof canvas.posFromEvt !== "function") return;
    if (e.target.closest && e.target.closest(".canvas-controls, .canvas-card-menu, .canvas-menu, .menu, .modal")) return;
    const pos = canvas.posFromEvt(e);
    const sel = this.selectionAt(canvas, pos);
    const node = sel ? null : this.hitTest(canvas, pos);
    if (!sel && !node) return;
    // Touch and drag = resize from where you touched. Hold still, then drag = move.
    // A plain tap is left alone so Obsidian still selects/opens the node.
    const lp = { id: e.pointerId, x: e.clientX, y: e.clientY, canvas, target: sel || node, node, pos, e };
    lp.timer = window.setTimeout(() => {
      if (this.lp !== lp || this.st) return;
      this.cancelLongPress();
      this.activateTouch(lp, "move", null);
      if (s.touchVibrate && navigator.vibrate) { try { navigator.vibrate(25); } catch (_) {} }
    }, s.longPressMs);
    this.lp = lp;
  }
  // Takes over a touch the canvas has already seen
  activateTouch(lp, action, moveEvt) {
    const s = this.settings, canvas = lp.canvas, e = lp.e;
    // Tell the canvas its own pan/drag from this touch is over
    const el = e.target && e.target.isConnected ? e.target : canvas.wrapperEl;
    try { el.dispatchEvent(new PointerEvent("pointercancel", { pointerId: e.pointerId, pointerType: "touch", isPrimary: true, bubbles: true })); } catch (_) {}
    try { el.dispatchEvent(new TouchEvent("touchcancel", { bubbles: true, cancelable: false })); } catch (_) {}
    if (lp.node && s.selectOnGrab && typeof canvas.selectOnly === "function") canvas.selectOnly(lp.node);
    this.begin(canvas, lp.target, lp.pos, e, action, true);
    if (moveEvt && this.st) {
      // Measure the drag from here so the node doesn't jump by the distance it took to start
      this.st.startPos = canvas.posFromEvt(moveEvt);
      this.st.startClient = { x: moveEvt.clientX, y: moveEvt.clientY };
      this.st.lastApplied = { x: moveEvt.clientX, y: moveEvt.clientY };
    }
  }
  cancelLongPress() {
    if (!this.lp) return;
    window.clearTimeout(this.lp.timer);
    this.lp = null;
  }
  toggleTouchMode(on) {
    this.touchPaused = on === undefined ? !this.touchPaused : !on;
    this.refreshButtons();
    new obsidian.Notice("Touch AltSnap " + (this.touchPaused ? "off" : "on"), 1500);
  }
  refreshButtons() {
    const s = this.settings;
    const show = s.enabled && (s.touchButton === "always" || (s.touchButton === "mobile" && obsidian.Platform.isMobile));
    if (!show) this.touchPaused = false;
    for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
      const root = leaf.view && leaf.view.containerEl;
      const controls = root && root.querySelector(".canvas-controls");
      if (!controls) continue;
      let grp = controls.querySelector(".cas-touch-group");
      if (!show) { if (grp) grp.remove(); continue; }
      if (!grp) {
        grp = controls.createDiv({ cls: "canvas-control-group cas-touch-group" });
        const btn = grp.createDiv({ cls: "canvas-control-item cas-touch-btn", attr: { "aria-label": "Touch AltSnap on/off" } });
        obsidian.setIcon(btn, "scaling");
        btn.addEventListener("click", () => this.toggleTouchMode());
      }
      grp.querySelector(".cas-touch-btn").toggleClass("is-active", s.touchLongPress && !this.touchPaused);
    }
  }

  /* ---------- start of a move/resize (mouse or touch) ---------- */
  // A multi selection target: the selected nodes plus the box around them, or null
  selectionAt(canvas, pos) {
    if (!canvas.selection || !canvas.nodes) return null;
    const nodes = [...canvas.selection].filter((it) => it && canvas.nodes.get(it.id) === it && !isPortalId(it.id));
    if (nodes.length < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const b = bboxOf(n.getData());
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
    }
    if (pos.x < minX || pos.x > maxX || pos.y < minY || pos.y > maxY) return null;
    return { nodes, box: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
  }

  begin(canvas, target, pos, e, action, touch) {
    const s = this.settings;
    if (touch) this.passContextOnce = false;
    const multi = target && target.nodes ? target : null;
    const node = multi ? null : target;
    // For a selection, the box around it acts as the node being moved/resized
    const d0 = multi
      ? Object.assign({ type: multi.nodes.some((n) => n.getData().type === "group") ? "group" : "text" }, multi.box)
      : node.getData();
    let mode = action, rx = 0, ry = 0;
    if (action === "resize") {
      const pe = pickEdge(s, d0.width, d0.height, pos.x - d0.x, pos.y - d0.y);
      rx = pe.rx; ry = pe.ry;
      mode = pe.mode === "move" ? "move" : pe.mode === "sym" ? "sym" : "resize";
    }

    let children, exclude;
    if (multi) {
      // Everything selected, plus the contents of selected groups, follows the box
      const all = new Set(multi.nodes);
      if (s.moveChildren) for (const n of multi.nodes) for (const c of this.childrenOf(canvas, n)) all.add(c);
      children = [...all];
      exclude = new Set(children);
    } else {
      const contents = this.childrenOf(canvas, node);
      children = mode === "move" && s.moveChildren ? contents : [];
      exclude = new Set([node, ...contents]);
    }

    this.st = {
      canvas, node, mode, rx, ry,
      multi: !!multi,
      d0: Object.assign({}, d0),
      kids: children.map((n) => ({ n, d0: Object.assign({}, n.getData()) })),
      sticky: [],
      button: e.button,
      pointerId: e.pointerId,
      touch: !!touch,
      startClient: { x: e.clientX, y: e.clientY },
      lastApplied: { x: e.clientX, y: e.clientY },
      startPos: pos,
      started: false,
      lastEvt: null,
      lastTime: 0,
      raf: 0,
      exclude,
      opacity: [],
      win: e.target.ownerDocument.defaultView,
      body: e.target.ownerDocument.body,
    };
    this.buildSnapCands();
    if (mode === "resize" || mode === "sym") {
      const sk = s.stickyResize;
      if (sk === "always" || (sk === "shift" && this.shiftHeld(e)) || (sk === "ctrl" && this.ctrlHeld(e))) this.buildSticky();
    }
    try { canvas.wrapperEl.setPointerCapture(e.pointerId); this.st.capture = e.pointerId; } catch (_) {}
  }

  onPointerMove(e) {
    if (this.lp && e.pointerId === this.lp.id && Math.hypot(e.clientX - this.lp.x, e.clientY - this.lp.y) > this.settings.longPressTolerance) {
      // Finger moved before the hold time: resize from where it touched down
      const lp = this.lp;
      this.cancelLongPress();
      this.activateTouch(lp, "resize", e);
    }
    const st = this.st;
    if (!st) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (e.pointerId !== st.pointerId) return;
    const bit = [1, 4, 2, 8, 16][st.button];
    if (bit && !(e.buttons & bit)) {
      if (st.started) this.update(e);
      this.finish(false);
      this.suppressUntil = Date.now() + 400;
      return;
    }
    st.lastEvt = e;
    if (!st.started) {
      const dist = Math.hypot(e.clientX - st.startClient.x, e.clientY - st.startClient.y);
      if (dist < this.settings.dragThreshold) return;
      this.start();
    }
    if (!st.raf) st.raf = st.win.requestAnimationFrame(() => this.tick());
  }

  tick() {
    const st = this.st;
    if (!st) return;
    st.raf = 0;
    const s = this.settings;
    const now = Date.now();
    if (s.refreshRate > 0 && now - st.lastTime < s.refreshRate) {
      st.raf = st.win.requestAnimationFrame(() => this.tick());
      return;
    }
    const e = st.lastEvt;
    if (!e) return;
    const rate = st.mode === "move" ? s.moveRate : s.resizeRate;
    if (rate > 1 && Math.hypot(e.clientX - st.lastApplied.x, e.clientY - st.lastApplied.y) < rate) return;
    st.lastApplied = { x: e.clientX, y: e.clientY };
    st.lastTime = now;
    this.update(e);
  }

  onPointerUp(e) {
    if (this.lp && e.pointerId === this.lp.id) this.cancelLongPress();
    const st = this.st;
    if (!st || e.pointerId !== st.pointerId || e.button !== st.button && e.type !== "pointercancel") {
      if (st) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (st.started && e.type === "pointerup") this.update(e);
    const passContext = this.passContextOnce && !st.started;
    this.finish(false);
    this.suppressUntil = Date.now() + 400;
    this.passContextOnce = passContext;
  }

  start() {
    const st = this.st;
    st.started = true;
    this.lastClick = null;
    this.passContextOnce = false;
    const s = this.settings;
    // A full window layer for the drag: holds the cursor and stops text selection, no global CSS overrides needed
    const cls = this.cursorClass();
    st.overlay = st.body.createDiv({ cls: "cas-overlay" + (cls ? " " + cls : "") });
    if (st.capture !== undefined) { try { st.overlay.setPointerCapture(st.capture); } catch (_) {} }
    if (s.dragOpacity >= 0 && s.dragOpacity < 255) {
      const op = String(s.dragOpacity / 255);
      for (const n of [st.node, ...st.kids.map((k) => k.n)]) {
        if (!n || !n.nodeEl) continue;
        st.opacity.push({ el: n.nodeEl, prev: n.nodeEl.style.opacity });
        n.nodeEl.style.opacity = op;
      }
    }
  }

  cursorClass() {
    const st = this.st, m = this.settings.cursorMode;
    if (m === "0") return null;
    if (st.mode === "move") {
      if (m === "2") return null;
      if (m === "4") return "cas-cursor-move";
      return "cas-cursor-grab";
    }
    if (m === "3") return null;
    if (st.mode === "sym") return "cas-cursor-all";
    if (st.rx !== 0 && st.ry !== 0) return st.rx === st.ry ? "cas-cursor-nwse" : "cas-cursor-nesw";
    return st.rx !== 0 ? "cas-cursor-ew" : "cas-cursor-ns";
  }

  /* ---------- snapping ---------- */
  // Alignment candidates: groups align with groups, nodes with nodes. Containers and contents don't count.
  buildSnapCands() {
    const st = this.st, canvas = st.canvas;
    const tb = bboxOf(st.d0);
    const isGroup = st.d0.type === "group";
    st.cands = [];
    for (const n of canvas.nodes.values()) {
      if (st.exclude.has(n)) continue;
      const d = n.getData();
      if (isPortalId(d.id) || (d.type === "group") !== isGroup) continue;
      const ob = bboxOf(d);
      if (containsBox(ob, tb)) continue;
      st.cands.push(ob);
    }
  }
  // Nearest neighbour on each side. vertical = the ones stacked above/below, otherwise the ones beside it.
  nearestNeighbors(box, vertical) {
    let a = null, ad = Infinity, b = null, bd = Infinity;
    for (const o of this.st.cands) {
      if (vertical) {
        if (o.maxX <= box.minX || o.minX >= box.maxX) continue;
        if (o.maxY <= box.minY) { const g = box.minY - o.maxY; if (g < ad) { ad = g; a = o; } }
        else if (o.minY >= box.maxY) { const g = o.minY - box.maxY; if (g < bd) { bd = g; b = o; } }
      } else {
        if (o.maxY <= box.minY || o.minY >= box.maxY) continue;
        if (o.maxX <= box.minX) { const g = box.minX - o.maxX; if (g < ad) { ad = g; a = o; } }
        else if (o.minX >= box.maxX) { const g = o.minX - box.maxX; if (g < bd) { bd = g; b = o; } }
      }
    }
    return [a, b].filter(Boolean);
  }
  // Finds the single closest alignment among the given edges, so only one axis snaps at a time.
  // Left/right edges align with the neighbours above/below, top/bottom edges with the neighbours beside it.
  bestAlign(box, edges, thr) {
    const st = this.st;
    // Stay on the current snap until the edge is pulled clearly away from it.
    // Without this, small wobble right at the edge of the range makes it flicker on and off.
    const lock = st.snapLock;
    if (lock && edges.includes(lock.edge)) {
      const d = lock.v - box[lock.edge];
      if (Math.abs(d) <= thr * Math.max(1, this.settings.snapRelease)) return { edge: lock.edge, d };
    }
    const vn = this.nearestNeighbors(box, true), hn = this.nearestNeighbors(box, false);
    let best = null;
    for (const edge of edges) {
      const nbs = edge === "minX" || edge === "maxX" ? vn : hn;
      for (const o of nbs) {
        const d = o[edge] - box[edge];
        if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { edge, d, v: o[edge] };
      }
    }
    st.snapLock = best ? { edge: best.edge, v: best.v } : null;
    return best;
  }
  grid(v) {
    const g = this.settings.gridSize;
    return g > 0 ? Math.round(v / g) * g : v;
  }

  buildSticky() {
    const st = this.st, canvas = st.canvas;
    if (st.multi) return;
    if (st.d0.type !== "group") return;
    const t = bboxOf(st.d0);
    const eps = 2;
    for (const n of canvas.nodes.values()) {
      if (st.exclude.has(n)) continue;
      const d = n.getData();
      if (d.type !== "group" || this.blacklisted(d)) continue;
      const o = bboxOf(d);
      if (containsBox(o, t)) continue;
      const yOver = o.maxY > t.minY && o.minY < t.maxY;
      const xOver = o.maxX > t.minX && o.minX < t.maxX;
      const edges = [];
      if (yOver && (st.rx === 1 || st.mode === "sym") && Math.abs(o.minX - t.maxX) <= eps) edges.push(["minX", "maxX"]);
      if (yOver && (st.rx === -1 || st.mode === "sym") && Math.abs(o.maxX - t.minX) <= eps) edges.push(["maxX", "minX"]);
      if (xOver && (st.ry === 1 || st.mode === "sym") && Math.abs(o.minY - t.maxY) <= eps) edges.push(["minY", "maxY"]);
      if (xOver && (st.ry === -1 || st.mode === "sym") && Math.abs(o.maxY - t.minY) <= eps) edges.push(["maxY", "minY"]);
      if (edges.length) st.sticky.push({ n, d0: Object.assign({}, d), edges });
    }
  }

  /* ---------- the actual move/resize ---------- */
  update(e) {
    const st = this.st, s = this.settings, canvas = st.canvas;
    let pos = canvas.posFromEvt(e);
    if (st.touch && s.touchSmoothing > 0) {
      // Ease toward the finger instead of jumping to it, which irons out digitizer wobble
      const k = clamp(s.touchSmoothing, 0, 0.9), prev = st.spos || st.startPos;
      pos = { x: prev.x + (pos.x - prev.x) * (1 - k), y: prev.y + (pos.y - prev.y) * (1 - k) };
      st.spos = pos;
    }
    const dx = pos.x - st.startPos.x, dy = pos.y - st.startPos.y;
    const thr = s.alignThreshold / this.scaleOf(canvas);
    // Touch never snaps, so finger drags stay exactly where you put them
    const snapOn = !st.touch && s.alignEnabled !== (s.shiftSnaps && this.shiftHeld(e));
    const d0 = st.d0;
    let L = d0.x, T = d0.y, R = d0.x + d0.width, B = d0.y + d0.height;

    if (st.mode === "move") {
      L = this.grid(L + dx); T = this.grid(T + dy);
      R = L + d0.width; B = T + d0.height;
      if (snapOn) {
        const a = this.bestAlign({ minX: L, maxX: R, minY: T, maxY: B }, ["minX", "maxX", "minY", "maxY"], thr);
        if (a && (a.edge === "minX" || a.edge === "maxX")) { L += a.d; R += a.d; }
        else if (a) { T += a.d; B += a.d; }
      }
      L = Math.round(L); T = Math.round(T);
      const mx = L - d0.x, my = T - d0.y;
      if (st.node) this.applyGeom(canvas, st.node, { x: L, y: T, width: d0.width, height: d0.height });
      for (const k of st.kids) {
        this.applyGeom(canvas, k.n, { x: k.d0.x + mx, y: k.d0.y + my, width: k.d0.width, height: k.d0.height });
      }
      return;
    }

    const sym = st.mode === "sym";
    const mvL = sym || st.rx === -1, mvR = sym || st.rx === 1;
    const mvT = sym || st.ry === -1, mvB = sym || st.ry === 1;
    if (sym) { L -= dx; R += dx; T -= dy; B += dy; }
    else {
      if (mvL) L += dx; if (mvR) R += dx;
      if (mvT) T += dy; if (mvB) B += dy;
    }
    if (mvL) L = this.grid(L); if (mvR) R = this.grid(R);
    if (mvT) T = this.grid(T); if (mvB) B = this.grid(B);
    if (snapOn) {
      const edges = [];
      if (mvL) edges.push("minX"); if (mvR) edges.push("maxX");
      if (mvT) edges.push("minY"); if (mvB) edges.push("maxY");
      const a = this.bestAlign({ minX: L, maxX: R, minY: T, maxY: B }, edges, thr);
      if (a) {
        if (a.edge === "minX") { L += a.d; if (sym) R -= a.d; }
        else if (a.edge === "maxX") { R += a.d; if (sym) L -= a.d; }
        else if (a.edge === "minY") { T += a.d; if (sym) B -= a.d; }
        else { B += a.d; if (sym) T -= a.d; }
      }
    }
    // Minimum size
    const minW = Math.max(1, s.minWidth), minH = Math.max(1, s.minHeight);
    if ((sym || mvL || mvR) && R - L < minW) {
      if (sym) { const cx = (d0.x * 2 + d0.width) / 2; L = cx - minW / 2; R = cx + minW / 2; }
      else if (mvL) L = R - minW; else R = L + minW;
    }
    if ((sym || mvT || mvB) && B - T < minH) {
      if (sym) { const cy = (d0.y * 2 + d0.height) / 2; T = cy - minH / 2; B = cy + minH / 2; }
      else if (mvT) T = B - minH; else B = T + minH;
    }
    L = Math.round(L); T = Math.round(T); R = Math.round(R); B = Math.round(B);
    if (st.multi) {
      // Scale every node inside the selection box. Edges are mapped, so nodes that touched still touch.
      const sx = (R - L) / d0.width, sy = (B - T) / d0.height;
      for (const k of st.kids) {
        const x = Math.round(L + (k.d0.x - d0.x) * sx), y = Math.round(T + (k.d0.y - d0.y) * sy);
        const r = Math.round(L + (k.d0.x + k.d0.width - d0.x) * sx), b = Math.round(T + (k.d0.y + k.d0.height - d0.y) * sy);
        this.applyGeom(canvas, k.n, { x, y, width: Math.max(1, r - x), height: Math.max(1, b - y) });
      }
      return;
    }
    this.applyGeom(canvas, st.node, { x: L, y: T, width: R - L, height: B - T });

    // Sticky: drag touching edges of neighbouring groups along
    const nb = { minX: L, maxX: R, minY: T, maxY: B };
    for (const sk of st.sticky) {
      const o = bboxOf(sk.d0);
      for (const [theirs, mine] of sk.edges) o[theirs] = nb[mine];
      if (o.maxX - o.minX < minW || o.maxY - o.minY < minH) continue;
      this.applyGeom(canvas, sk.n, { x: o.minX, y: o.minY, width: o.maxX - o.minX, height: o.maxY - o.minY });
    }
  }

  finish(cancel) {
    const st = this.st;
    if (!st) return;
    this.st = null;
    if (st.raf) st.win.cancelAnimationFrame(st.raf);
    try { if (st.capture !== undefined) st.canvas.wrapperEl.releasePointerCapture(st.capture); } catch (_) {}
    if (st.overlay) st.overlay.remove();
    for (const o of st.opacity) o.el.style.opacity = o.prev;
    if (!st.started) return;
    const canvas = st.canvas;
    if (cancel) {
      if (st.node) this.applyGeom(canvas, st.node, st.d0);
      for (const k of st.kids) this.applyGeom(canvas, k.n, k.d0);
      for (const sk of st.sticky) this.applyGeom(canvas, sk.n, sk.d0);
    } else if (typeof canvas.pushHistory === "function") {
      canvas.pushHistory(canvas.getData());
    }
    if (typeof canvas.requestSave === "function") canvas.requestSave();
    if (!cancel && st.node && this.settings.selectAfter && typeof canvas.selectOnly === "function") canvas.selectOnly(st.node);
  }

  doDouble(canvas, node, act) {
    if (act === "select") {
      if (typeof canvas.selectOnly === "function") canvas.selectOnly(node);
      return;
    }
    if (act === "zoom") {
      if (typeof canvas.zoomToBbox === "function") canvas.zoomToBbox(node.getBBox ? node.getBBox() : bboxOf(node.getData()));
      return;
    }
    if (act === "fit") {
      const d = node.getData();
      if (d.type !== "group") return;
      const kids = this.childrenOf(canvas, node);
      if (!kids.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const k of kids) {
        const b = bboxOf(k.getData());
        minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
      }
      const p = this.settings.fitPadding;
      this.applyGeom(canvas, node, {
        x: Math.round(minX - p), y: Math.round(minY - p),
        width: Math.round(maxX - minX + p * 2), height: Math.round(maxY - minY + p * 2),
      });
      if (typeof canvas.pushHistory === "function") canvas.pushHistory(canvas.getData());
      if (typeof canvas.requestSave === "function") canvas.requestSave();
    }
  }

  /* ---------- settings ---------- */
  async loadSettings() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    for (const k of ["actions", "altActions", "dblActions"]) {
      this.settings[k] = Object.assign({}, DEFAULT_SETTINGS[k], saved[k] || {});
    }
    if (!Array.isArray(this.settings.hotkeys)) this.settings.hotkeys = DEFAULT_SETTINGS.hotkeys.slice();
  }
  async saveSettings() { await this.saveData(this.settings); }
}

class CanvasAltSnapSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const el = this.containerEl;
    const p = this.plugin, s = p.settings;
    el.empty();
    el.addClass("cas-settings");
    const save = () => p.saveSettings();
    const toggle = (name, desc, key) => new obsidian.Setting(el).setName(name).setDesc(desc)
      .addToggle((t) => t.setValue(!!s[key]).onChange(async (v) => { s[key] = v; await save(); }));
    const drop = (name, desc, opts, get, set) => new obsidian.Setting(el).setName(name).setDesc(desc)
      .addDropdown((d) => d.addOptions(opts).setValue(get()).onChange(async (v) => { set(v); await save(); }));
    const num = (name, desc, key, lo, hi) => new obsidian.Setting(el).setName(name).setDesc(desc)
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(s[key])).onChange(async (v) => {
          const n = Number(v);
          if (v === "" || !isFinite(n)) return;
          s[key] = clamp(n, lo, hi); await save();
        });
      });
    const slider = (name, desc, key, lo, hi, step) => new obsidian.Setting(el).setName(name).setDesc(desc)
      .addSlider((sl) => sl.setLimits(lo, hi, step).setValue(s[key]).setDynamicTooltip()
        .onChange(async (v) => { s[key] = v; await save(); }));

    new obsidian.Setting(el).setName("Enabled").setDesc("Master switch. There is also a command to toggle this.")
      .addToggle((t) => t.setValue(!!s.enabled).onChange(async (v) => { s.enabled = v; await save(); p.refreshButtons(); }));

    new obsidian.Setting(el).setName("General").setHeading();
    drop("Targets", "What gets grabbed under the cursor.",
      { nodesFirst: "Notes first, then innermost group", groups: "Groups only" }, () => s.targetMode, (v) => (s.targetMode = v));
    drop("Nested groups", "Which group is picked when groups are inside each other.",
      { innermost: "Innermost (smallest)", outermost: "Outermost (largest)" }, () => s.pickOrder, (v) => (s.pickOrder = v));
    drop("Center resize mode", "What a resize grab in the center zone does.",
      { all: "All directions", bottomright: "Bottom right", move: "Move", closest: "Closest side" },
      () => s.resizeCenter, (v) => (s.resizeCenter = v));
    slider("Center fraction (%)", "Size of the center zone. AltSnap default 24. 0 = only the 4 corner quadrants.", "centerFraction", 0, 100, 1);
    slider("Sides fraction (%)", "Size of the pure side zones. Same as center = classic 9 box mode. Higher than center = diagonal closest side mode.", "sidesFraction", 0, 100, 1);
    toggle("Move contents with group", "Nodes fully inside a group move with it.", "moveChildren");
    toggle("Select on grab", "Selects the note or group you grab, like clicking it.", "selectOnGrab");
    toggle("Select after action", "AltSnap \"Auto focus\". Selects the node after moving or resizing.", "selectAfter");
    toggle("Skip collapsed groups", "Ignore groups collapsed by Advanced Canvas.", "skipCollapsed");
    num("Minimum width", "Canvas units.", "minWidth", 1, 100000);
    num("Minimum height", "Canvas units.", "minHeight", 1, 100000);
    num("Fit padding", "Padding used by the \"Fit group to its contents\" double click action.", "fitPadding", 0, 10000);
    new obsidian.Setting(el).setName("Blacklist group labels")
      .setDesc("One per line. Regex or plain text, case insensitive. Matching groups are ignored.")
      .addTextArea((t) => t.setValue(s.blacklistLabels).onChange(async (v) => { s.blacklistLabels = v; await save(); }));
    new obsidian.Setting(el).setName("Blacklist colors")
      .setDesc("Comma separated canvas colors to ignore, e.g. 1,6 or #422c2c.")
      .addText((t) => t.setValue(s.blacklistColors).onChange(async (v) => { s.blacklistColors = v; await save(); }));

    new obsidian.Setting(el).setName("Alignment snapping").setHeading();
    toggle("Align to neighbours", "The edge you drag lines up with the matching edge of the nearest group (or note) beside, above or below it. Only one direction snaps at a time. Mouse only, touch never snaps.", "alignEnabled");
    num("Align range (px)", "Screen pixels. How close an edge has to be before it snaps.", "alignThreshold", 0, 200);
    num("Snap release", "Once snapped, how much further (times the range) you have to pull before it lets go. Higher = steadier.", "snapRelease", 1, 10);
    toggle("Shift toggles snapping", "Holding Shift while dragging flips snapping on/off.", "shiftSnaps");
    num("Grid size", "Round moving edges to this grid (canvas units). 0 = off.", "gridSize", 0, 1000);
    drop("Sticky resize", "AltSnap \"Resize other snapped windows\". Touching neighbour groups resize along.",
      { off: "Off", shift: "While Shift held at grab", ctrl: "While Ctrl held at grab", always: "Always" },
      () => s.stickyResize, (v) => (s.stickyResize = v));

    new obsidian.Setting(el).setName("Mouse").setHeading();
    for (const b of BUTTONS) {
      drop(b.name, "Action with the hotkey held.", ACTIONS, () => s.actions[b.id], (v) => (s.actions[b.id] = v));
    }
    el.createEl("p", { text: "Alternate actions (used while the alternate action key is also held)." });
    for (const b of BUTTONS) {
      drop(b.name + " (alternate)", "", ACTIONS, () => s.altActions[b.id], (v) => (s.altActions[b.id] = v));
    }
    el.createEl("p", { text: "Double click actions." });
    for (const b of BUTTONS) {
      drop(b.name + " (double click)", "", DBL_ACTIONS, () => s.dblActions[b.id], (v) => (s.dblActions[b.id] = v));
    }
    num("Double click time (ms)", "", "dblClickMs", 100, 2000);
    drop("Hotkey click without drag", "What happens when you hotkey + click but don't drag.",
      { block: "Block it", pass: "Pass right click menu through" }, () => s.clickNoDrag, (v) => (s.clickNoDrag = v));

    new obsidian.Setting(el).setName("Keyboard").setHeading();
    el.createEl("p", { text: "Hotkeys. Holding any checked key activates (or two of them with two key combo)." });
    for (const code of Object.keys(HOTKEYS)) {
      new obsidian.Setting(el).setName(HOTKEYS[code]).addToggle((t) => t.setValue(s.hotkeys.includes(code))
        .onChange(async (v) => {
          s.hotkeys = s.hotkeys.filter((c) => c !== code);
          if (v) s.hotkeys.push(code);
          await save();
        }));
    }
    toggle("Use a two keys combo", "Require two of the checked hotkeys held at once.", "keyCombo");
    drop("Alternate action key", "Hold with the hotkey to use the alternate actions.",
      Object.assign({ none: "None" }, HOTKEYS), () => s.altActionKey, (v) => (s.altActionKey = v));
    toggle("Esc cancels", "Esc during a drag puts everything back.", "escCancels");
    toggle("Block hotkey release after action", "Stops the hotkey release from reaching Obsidian after an action.", "blockAltKeyup");

    new obsidian.Setting(el).setName("Touch").setHeading();
    new obsidian.Setting(el).setName("Touch AltSnap").setDesc("Touch and drag a node to resize it from where you touched. Hold still first, then drag, to move it. Taps still work like normal. The button in the canvas zoom controls turns this off for a moment so you can pan.")
      .addToggle((t) => t.setValue(!!s.touchLongPress).onChange(async (v) => { s.touchLongPress = v; await save(); p.refreshButtons(); }));
    num("Hold time (ms)", "How long to hold still before a drag moves instead of resizes.", "longPressMs", 100, 2000);
    num("Drag start distance (px)", "How far the finger moves before it counts as a resize drag instead of a hold.", "longPressTolerance", 1, 100);
    drop("Touch on/off button", "Button in the canvas zoom controls that pauses touch AltSnap so one finger pans again.", { mobile: "Mobile only", always: "Always", never: "Never" }, () => s.touchButton, (v) => { s.touchButton = v; p.refreshButtons(); });
    toggle("Vibrate on grab", "", "touchVibrate");
    slider("Touch smoothing", "Irons out finger wobble so small adjustments are steadier. 0 = off, higher = smoother but trails the finger a little.", "touchSmoothing", 0, 0.9, 0.05);

    new obsidian.Setting(el).setName("Performance").setHeading();
    num("Drag threshold (px)", "Pixels to move before the action starts.", "dragThreshold", 0, 100);
    num("Refresh rate (ms)", "Minimum time between updates. 0 = every frame.", "refreshRate", 0, 1000);
    num("Move rate (px)", "Pixels of mouse movement between move updates.", "moveRate", 1, 100);
    num("Resize rate (px)", "Pixels of mouse movement between resize updates.", "resizeRate", 1, 100);

    new obsidian.Setting(el).setName("Visual").setHeading();
    slider("Opacity when dragging", "0 to 255. 255 = off.", "dragOpacity", 0, 255, 1);
    drop("Cursor", "AltSnap \"UseCursor\".",
      { "1": "Default", "0": "No cursor change", "2": "No hand when moving", "3": "Normal cursor when resizing", "4": "Move cursor when moving" },
      () => s.cursorMode, (v) => (s.cursorMode = v));

    new obsidian.Setting(el).setName("Reset to defaults").setDesc("Puts every setting back to how the plugin ships.")
      .addButton((b) => b.setButtonText("Reset").setWarning().onClick(async () => {
        p.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        await p.saveSettings();
        p.refreshButtons();
        this.display();
      }));
  }
}

module.exports = CanvasAltSnapPlugin;
