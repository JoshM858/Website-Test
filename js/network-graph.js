// Interactive drill-down topic graph for the #network section.
//
// Physics: d3-force. Entrance motion (node pop-in, edge draw-in, pulses): GSAP,
// layered on top of the simulation rather than driving it.
//
// Design decisions (see docs/network-graph-plan.md §9):
// - Opening a topic only ever adds to the map ("keeps growing", Obsidian-style).
//   Nothing collapses on click; "Reset graph" is the one way back to the start.
//   This keeps the physics story simple — every click is a new node or edge
//   popping in — and avoids subtrees vanishing out from under keyboard focus.
// - The old "click two dots to link them" feature stays, but behind an explicit
//   "Draw your own link" mode, since a plain click now means "open this topic".
//   Your own links are dashed accent lines so they never read as authored ones.
// - You can add your own topics (the "+" on a node, N on a focused node, the "Add a
//   topic" button, or double-click empty space) and remove them again (Delete).
//   They are held in memory only: the privacy/cookie pages promise no browser storage.
//
// Motion: nodes are masses on damped springs, stepped at a fixed 1/60s on one shared
// clock. That drives the pop-in bounce, hover squash, the elastic drag, and the
// "shuffle" — a radial + sideways shove with a short burst of extra repulsion and
// lower friction, so the whole map reshuffles and wobbles before it settles. Ideas
// borrowed from alijdens.github.io/2023-09-05-graph-animation-sms (spring-mass, fixed
// step, zero-length anchor spring) and vasturiano/force-graph (reheat on change,
// directional particles along edges, eased fit-to-view).
(function initNetworkGraph() {
  var svgEl = document.getElementById('networkSvg');
  if (!svgEl) return;
  var stage = svgEl.closest('.network-stage');
  var statusEl = document.getElementById('networkStatus');
  var hintEl = document.getElementById('networkHint');
  var resetBtn = document.getElementById('networkReset');
  var linkBtn = document.getElementById('networkLinkMode');

  if (typeof d3 === 'undefined' || !window.GRAPH_NODES) {
    if (stage) stage.classList.add('is-unavailable');
    if (hintEl) hintEl.textContent = "The interactive demo couldn't load. Try refreshing the page.";
    return;
  }

  var hasGSAP = typeof gsap !== 'undefined';
  var EASE = (window.Recall && window.Recall.EASE) || 'power3.out';
  var motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reducedMotion() { return !hasGSAP || !!(motionQuery && motionQuery.matches); }

  // ---------- content index ----------
  var DATA = {};
  var CHILDREN = {};
  var ROOT_ID = null;
  window.GRAPH_NODES.forEach(function (d) {
    DATA[d.id] = d;
    CHILDREN[d.id] = [];
    if (d.kind === 'root') ROOT_ID = d.id;
  });
  window.GRAPH_NODES.forEach(function (d) {
    (d.parents || []).forEach(function (p) { if (CHILDREN[p]) CHILDREN[p].push(d.id); });
  });

  var SIZE = { root: 9, course: 7, topic: 5, leaf: 3.5, mine: 4.6 };
  var LINK_DIST = { root: 115, course: 78, topic: 62, leaf: 62 }; // keyed by the parent's kind
  var CHARGE = { root: -320, course: -360, topic: -210, leaf: -150, mine: -170 };
  var MIN_K = 0.3, MAX_K = 2.4, FIT_MAX_K = 1.35;

  // ---------- live state ----------
  var nodes = [];
  var nodeById = {};
  var links = [];
  var linkByKey = {};
  var expanded = {};
  var linkMode = false;
  var selected = null;
  var hoverId = null;
  var autoFit = true;
  var dragging = false;
  var W = 640, H = 420;

  function linkKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
  function sizeOf(n) { return SIZE[n.data.kind] || SIZE.leaf; }
  function canOpen(id) { return !expanded[id] && CHILDREN[id].length > 0; }

  // ---------- DOM ----------
  var NS = 'http://www.w3.org/2000/svg';
  var svg = d3.select(svgEl);
  var viewport = svg.append('g').attr('class', 'net-viewport');
  var edgeLayer = viewport.append('g').attr('class', 'net-edges').node();
  var particleLayer = viewport.append('g').attr('class', 'net-particles').node();
  var nodeLayer = viewport.append('g').attr('class', 'net-nodes').node();

  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function createNodeEl(n, insertAfter) {
    var r = sizeOf(n);
    var g = el('g', { 'class': 'net-node is-' + n.data.kind, 'data-id': n.id, tabindex: '0', role: 'button' });
    var body = el('g', { 'class': 'net-node-body' }, g);
    n.hit = el('circle', { 'class': 'hit', r: Math.max(r + 8, 15) }, body);
    el('circle', { 'class': 'glow', r: r + 7 }, body);
    el('circle', { 'class': 'more', r: r + 4 }, body);
    el('circle', { 'class': 'ring', r: r + 4 }, body);
    el('circle', { 'class': 'dot', r: r }, body);
    // "+" handle: adds a topic under this one. Sits inside the hit area so the pointer
    // can reach it without leaving the node.
    var off = r + 3;
    var add = el('g', { 'class': 'add', transform: 'translate(' + off + ',' + (-off) + ')', 'aria-hidden': 'true' }, body);
    el('circle', { 'class': 'add-bg', r: 6.5 }, add);
    el('path', { 'class': 'add-plus', d: 'M-3 0H3M0 -3V3' }, add);
    var text = el('text', { 'class': 'net-label', y: r + 3, dy: '0.85em', 'text-anchor': 'middle' }, body);
    text.textContent = n.data.label;

    // Insert right after the node that revealed it so Tab goes parent -> children.
    if (insertAfter && insertAfter.parentNode === nodeLayer) {
      nodeLayer.insertBefore(g, insertAfter.nextSibling);
    } else {
      nodeLayer.appendChild(g);
    }
    n.el = g;
    n.body = body;
    d3.select(g).datum(n).call(drag);
    return g;
  }

  function createLinkEl(l) {
    l.el = el('line', { 'class': 'net-edge' + (l.custom ? ' is-custom' : '') }, edgeLayer);
  }

  // ---------- simulation ----------
  var BASE_DECAY = 0.36;
  var boost = 1;   // temporary extra repulsion after a shove (decays back to 1)
  var loose = 0;   // temporary drop in friction after a shove (decays back to 0)
  function chargeFn(n) { return (CHARGE[n.data.kind] || -150) * boost; }
  var degree = {};
  var sim = d3.forceSimulation()
    .force('link', d3.forceLink()
      .distance(function (l) { return l.custom ? 150 : (LINK_DIST[l.source.data.kind] || 62); })
      .strength(function (l) {
        if (l.custom) return 0.05;
        return 0.8 / Math.min(degree[l.source.id] || 1, degree[l.target.id] || 1);
      }))
    .force('charge', d3.forceManyBody()
      .strength(chargeFn)
      .distanceMax(460))
    .force('collide', d3.forceCollide()
      .radius(function (n) { return sizeOf(n) + 12; })
      .strength(0.85))
    .force('labels', labelCollide())
    .force('x', d3.forceX(0).strength(0.03))
    .force('y', d3.forceY(0).strength(0.055))
    .alphaDecay(0.03)
    .velocityDecay(BASE_DECAY)
    .on('tick', render)
    .stop();

  // Circles can't model wide text labels, so nodes also push apart when the
  // box around "dot + label underneath" overlaps a neighbour's box.
  var LABEL_PX = { root: 12.5, course: 12, topic: 10.5, leaf: 10.5, mine: 10.5 };
  var labelScale = 1; // the --u label counter-scale, kept in sync by applyTransform()
  function labelBox(n) {
    var r = sizeOf(n);
    var px = (LABEL_PX[n.data.kind] || 10.5) * labelScale;
    n.boxScale = labelScale;
    var top = -r - 4, bottom = r + 5 + px * 1.25;
    n.hw = Math.max(n.data.label.length * px * 0.31, r + 4) + 5;
    n.hh = (bottom - top) / 2 + 2;
    n.cy = (top + bottom) / 2;
  }
  function labelCollide() {
    var list = [];
    function force() {
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (a.boxScale !== labelScale) labelBox(a);
        for (var j = i + 1; j < list.length; j++) {
          var b = list[j];
          if (b.boxScale !== labelScale) labelBox(b);
          var dx = (b.x + b.vx) - (a.x + a.vx);
          var dy = (b.y + b.vy + b.cy) - (a.y + a.vy + a.cy);
          var ox = a.hw + b.hw - Math.abs(dx);
          var oy = a.hh + b.hh - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          // Separate along whichever axis needs the smaller move.
          if (ox < oy) {
            var px = ox * 0.25 * (dx < 0 ? -1 : 1);
            a.vx -= px; b.vx += px;
          } else {
            var py = oy * 0.25 * (dy < 0 ? -1 : 1);
            a.vy -= py; b.vy += py;
          }
        }
      }
    }
    force.initialize = function (ns) { list = ns; list.forEach(labelBox); };
    return force;
  }

  function syncSim() {
    degree = {};
    links.forEach(function (l) {
      if (l.custom) return;
      degree[l.source.id] = (degree[l.source.id] || 0) + 1;
      degree[l.target.id] = (degree[l.target.id] || 0) + 1;
    });
    sim.nodes(nodes);
    sim.force('link').links(links);
  }

  // Wake the simulation so the whole map reflows. Reduced motion: settle
  // off-screen and jump straight to the resting layout.
  function reheat(alpha) {
    if (reducedMotion()) {
      sim.stop();
      sim.alpha(1);
      for (var i = 0; i < 300; i++) sim.tick();
      render();
      fitNow();
      return;
    }
    sim.alpha(Math.max(sim.alpha(), alpha)).restart();
    startFitLoop();
  }

  function r2(v) { return Math.round(v * 100) / 100; }

  function renderLink(l) {
    var s = l.source, t = l.target, p = l.progress;
    l.el.setAttribute('x1', r2(s.x));
    l.el.setAttribute('y1', r2(s.y));
    l.el.setAttribute('x2', r2(s.x + (t.x - s.x) * p));
    l.el.setAttribute('y2', r2(s.y + (t.y - s.y) * p));
  }

  function render() {
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].el.setAttribute('transform', 'translate(' + r2(nodes[i].x) + ',' + r2(nodes[i].y) + ')');
    }
    links.forEach(renderLink);
    placeAddForm();
  }

  // ---------- adding things ----------
  function addNode(id, from, index, total) {
    var n = { id: id, data: DATA[id], x: 0, y: 0 };
    if (from) {
      // Pop out of the parent, nudged away from the centre so children bloom outward.
      var base = Math.atan2(from.y, from.x);
      var angle = (from.x === 0 && from.y === 0)
        ? (index / Math.max(total, 1)) * Math.PI * 2
        : base + (index - (total - 1) / 2) * 0.5;
      n.x = from.x + Math.cos(angle) * 6;
      n.y = from.y + Math.sin(angle) * 6;
    }
    if (id === ROOT_ID) { n.fx = 0; n.fy = 0; }
    nodes.push(n);
    nodeById[id] = n;
    createNodeEl(n, from && from.lastChildEl ? from.lastChildEl : (from ? from.el : null));
    if (from) from.lastChildEl = n.el;
    return n;
  }

  function addLink(a, b, custom) {
    var key = linkKey(a.id, b.id);
    var existing = linkByKey[key];
    if (existing) {
      // An authored edge supersedes one you drew yourself between the same pair.
      if (existing.custom && !custom) {
        existing.custom = false;
        existing.el.classList.remove('is-custom');
        existing.source = a; existing.target = b;
      }
      return null;
    }
    var l = { source: a, target: b, custom: !!custom, progress: 1, key: key };
    links.push(l);
    linkByKey[key] = l;
    createLinkEl(l);
    return l;
  }

  function animateIn(newNodes, newLinks) {
    if (reducedMotion()) return;
    newNodes.forEach(function (n, i) { popIn(n, 0.08 + i * 0.06); });
    newLinks.forEach(function (l, i) {
      l.progress = 0;
      renderLink(l);
      gsap.to(l, {
        progress: 1, duration: 0.5, delay: i * 0.06, ease: EASE,
        onUpdate: function () { renderLink(l); }
      });
      emit(l.source, l.target, 0.12 + i * 0.06);
    });
  }

  function pulse(n) { bump(n, 7); }

  function glowPulse(n) {
    if (reducedMotion() || n.data.kind !== 'course') return;
    var glow = n.el.querySelector('.glow');
    gsap.to(glow, { opacity: 0.4, duration: 2.2 + (nodes.indexOf(n) % 3), repeat: -1, yoyo: true, ease: 'sine.inOut' });
  }

  // ---------- spring motion ----------
  // One shared loop, stepped at a fixed 1/60s (so it feels the same at 60 and 144Hz)
  // with a stall guard: if the tab slept, drop the time instead of fast-forwarding.
  var STEP = 1000 / 60;
  var SPRING_K = 210, SPRING_C = 11.6;  // zeta ~0.4: a lively overshoot that settles in ~0.7s
  var DRAG_K = 320, DRAG_C = 17;        // zeta ~0.47: the held node trails the pointer, then settles
  var MAX_FLING = 14;                   // px per sim tick, so a hard throw can't leave the map
  var loopOn = false, lastFrame = 0, acc = 0;
  var dragState = null;                 // the dragged node's anchor spring
  var particles = [];
  var pending = [];                     // delayed callbacks on the same clock: { t, fn }

  function springOf(n) {
    return n.sc || (n.sc = { x: 1, v: 0, t: 1, wait: 0, pop: false, rm: false });
  }

  function ensureLoop() {
    if (loopOn || reducedMotion()) return;
    loopOn = true;
    lastFrame = performance.now();
    acc = 0;
    requestAnimationFrame(frame);
  }

  function frame(now) {
    var elapsed = now - lastFrame;
    lastFrame = now;
    if (elapsed > 3000) acc = 0;
    else acc = Math.min(acc + elapsed, STEP * 6);
    var keep = true;
    while (acc >= STEP) { keep = step(STEP / 1000); acc -= STEP; }
    if (dragState) render(); // the sim may be cooling; keep the held node moving
    if (keep) requestAnimationFrame(frame); else loopOn = false;
  }

  function applyLooseness() {
    sim.velocityDecay(BASE_DECAY - 0.16 * loose);
    sim.force('charge').strength(chargeFn);
  }

  function paint(n) {
    var s = n.sc;
    if (s.x === 1 && s.v === 0 && !s.pop) {
      n.body.removeAttribute('transform');
      n.body.style.opacity = '';
      return;
    }
    n.body.setAttribute('transform', 'scale(' + Math.max(0.001, s.x).toFixed(3) + ')');
    n.body.style.opacity = s.pop ? Math.max(0, Math.min(1, (s.x - 0.15) / 0.45)).toFixed(2) : '';
  }

  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  function step(dt) {
    var active = false, i, finished = null;

    for (i = pending.length - 1; i >= 0; i--) {
      pending[i].t -= dt;
      if (pending[i].t <= 0) pending.splice(i, 1)[0].fn();
    }
    if (pending.length) active = true;

    // Node size springs: pop-in, hover squash, bumps, shrink-out.
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i], sp = n.sc;
      if (!sp) continue;
      if (sp.wait > 0) { sp.wait -= dt; active = true; continue; }
      var c = sp.rm ? 2 * Math.sqrt(SPRING_K) : SPRING_C; // critically damped when leaving: no flip through zero
      sp.v += (-SPRING_K * (sp.x - sp.t) - c * sp.v) * dt;
      sp.x += sp.v * dt;
      if (sp.rm && sp.x < 0.05) { (finished = finished || []).push(n); continue; }
      if (Math.abs(sp.x - sp.t) < 0.002 && Math.abs(sp.v) < 0.02) {
        sp.x = sp.t; sp.v = 0;
        if (sp.t === 1) sp.pop = false;
      } else {
        active = true;
      }
      paint(n);
    }

    // The held node: a zero-length spring to the pointer (the "anchor" from the spring-mass
    // post). Its neighbours feel it through their own link springs, so the pull ripples.
    if (dragState) {
      var d = dragState;
      d.vx += (-DRAG_K * (d.x - d.tx) - DRAG_C * d.vx) * dt;
      d.vy += (-DRAG_K * (d.y - d.ty) - DRAG_C * d.vy) * dt;
      d.x += d.vx * dt; d.y += d.vy * dt;
      d.n.fx = d.x; d.n.fy = d.y;
      var home = Math.abs(d.x - d.tx) + Math.abs(d.y - d.ty) < 0.4 && Math.abs(d.vx) + Math.abs(d.vy) < 2;
      if (d.releasing && home) { d.n.fx = d.tx; d.n.fy = d.ty; dragState = null; }
      else active = true;
    }

    // Pulses travelling along edges.
    for (i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      if (p.wait > 0) { p.wait -= dt; active = true; continue; }
      p.t += dt / 0.7;
      if (p.t >= 1) { particleLayer.removeChild(p.el); particles.splice(i, 1); continue; }
      active = true;
      var e = easeInOutCubic(p.t);
      p.el.setAttribute('cx', r2(p.from.x + (p.to.x - p.from.x) * e));
      p.el.setAttribute('cy', r2(p.from.y + (p.to.y - p.from.y) * e));
      p.el.setAttribute('opacity', p.t < 0.15 ? p.t / 0.15 : p.t > 0.85 ? (1 - p.t) / 0.15 : 1);
    }

    // The shove wears off: repulsion and friction ease back to normal.
    if (boost > 1 || loose > 0) {
      boost = 1 + (boost - 1) * Math.exp(-dt / 0.4);
      loose *= Math.exp(-dt / 0.6);
      if (boost < 1.002) boost = 1;
      if (loose < 0.01) loose = 0;
      applyLooseness();
      active = true;
    }

    if (finished) finishRemove(finished);
    return active;
  }

  // A burst of life: the new node (or the one you opened) springs out from nothing.
  function popIn(n, delay) {
    if (reducedMotion()) return;
    var sp = springOf(n);
    sp.x = 0.15; sp.v = 0; sp.t = 1; sp.wait = delay || 0; sp.pop = true;
    n.body.setAttribute('transform', 'scale(0.15)');
    n.body.style.opacity = '0';
    ensureLoop();
  }

  function bump(n, v) {
    if (reducedMotion() || !n) return;
    springOf(n).v += v;
    ensureLoop();
  }

  function hoverScale(n, on) {
    if (reducedMotion() || !n || dragging) return;
    var sp = springOf(n);
    if (sp.rm) return;
    sp.t = on ? 1.16 : 1;
    ensureLoop();
  }

  // The shuffle. Everything near the origin gets a radial shove plus a sideways swirl
  // (so neighbours trade places rather than just backing away), repulsion spikes and
  // friction drops for a moment, and the map wobbles back into a new arrangement.
  function shuffle(origin, strength) {
    if (reducedMotion()) return;
    var sign = Math.random() < 0.5 ? -1 : 1;
    nodes.forEach(function (m) {
      if (m === origin || m.id === ROOT_ID) return;
      var dx = m.x - origin.x, dy = m.y - origin.y;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      var f = strength / (1 + d / 70);
      m.vx += (dx / d - sign * dy / d * 0.45) * f;
      m.vy += (dy / d + sign * dx / d * 0.45) * f;
    });
    boost = Math.max(boost, 1 + strength * 0.14);
    loose = 1;
    applyLooseness();
    ensureLoop();
  }

  // A wave through the graph: each hop out from the origin gets bumped a beat later.
  function ripple(origin, amount) {
    if (reducedMotion()) return;
    var hop = {}, queue = [origin];
    hop[origin.id] = 0;
    while (queue.length) {
      var cur = queue.shift();
      if (hop[cur.id] >= 4) continue;
      neighbors(cur.id).forEach(function (m) {
        if (hop[m.id] === undefined) { hop[m.id] = hop[cur.id] + 1; queue.push(m); }
      });
    }
    nodes.forEach(function (m) {
      var h = hop[m.id];
      if (!h) return;
      pending.push({ t: h * 0.07, fn: function () { bump(m, amount / (1 + h * 0.6)); } });
    });
    ensureLoop();
  }

  function emit(from, to, delay) {
    if (reducedMotion()) return;
    var dot = el('circle', { 'class': 'net-particle', r: 2.8, opacity: 0 }, particleLayer);
    particles.push({ from: from, to: to, t: 0, wait: delay || 0, el: dot });
    ensureLoop();
  }

  function clearMotion() {
    pending = []; particles = []; dragState = null;
    particleLayer.textContent = '';
    boost = 1; loose = 0;
    applyLooseness();
  }

  // ---------- open a topic ----------
  function open(id, viaKeyboard) {
    var parent = nodeById[id];
    var kids = CHILDREN[id];
    var newNodes = [], newLinks = [], alreadyThere = [];
    expanded[id] = true;
    parent.lastChildEl = null;

    kids.forEach(function (cid, i) {
      var child = nodeById[cid];
      if (!child) {
        child = addNode(cid, parent, i, kids.length);
        newNodes.push(child);
      } else {
        alreadyThere.push(child);
      }
      var l = addLink(parent, child, false);
      if (l) newLinks.push(l);
    });

    syncSim();
    animateIn(newNodes, newLinks);
    newNodes.forEach(glowPulse);
    reheat(0.9);
    if (newNodes.length) { shuffle(parent, 2.4); bump(parent, 5); ripple(parent, 4); }
    refreshAll();

    var msg = [];
    if (newNodes.length) {
      msg.push('Revealed ' + plural(newNodes.length, 'topic') + ' under ' + parent.data.label + ': ' +
        listJoin(newNodes.map(label)) + '.');
    }
    if (alreadyThere.length) {
      msg.push((newNodes.length ? 'Also linked to ' : parent.data.label + ' links to ') +
        listJoin(alreadyThere.map(label)) + ', already on the map.');
    }
    announce(msg.join(' '));

    if (viaKeyboard && newNodes.length) newNodes[0].el.focus({ preventScroll: true });
  }

  function activate(id, viaKeyboard) {
    if (linkMode) { linkClick(id); return; }
    var n = nodeById[id];
    if (canOpen(id)) { open(id, viaKeyboard); return; }
    // Nothing left to reveal: give it a nudge and read out what it touches.
    pulse(n);
    reheat(0.2);
    var nb = neighbors(id).map(label);
    announce(n.data.label + (nb.length ? ' connects to ' + listJoin(nb) + '.' : ' has no connections yet.'));
  }

  // ---------- your own topics ----------
  var MAX_USER = 40, LABEL_MAX = 24;
  var userIds = [], userSeq = 0;
  var lastActive = null;   // the topic "Add a topic" attaches to
  var addTarget = null;    // { parent: node|null, x, y, kb } while the name box is open
  var frameEl = svgEl.parentNode;

  var addForm = document.createElement('form');
  addForm.className = 'network-add';
  addForm.hidden = true;
  addForm.setAttribute('autocomplete', 'off');
  var addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.className = 'network-add-input';
  addInput.maxLength = LABEL_MAX;
  addInput.placeholder = 'Topic name';
  var addGo = document.createElement('button');
  addGo.type = 'submit';
  addGo.className = 'network-add-go';
  addGo.textContent = 'Add';
  var addX = document.createElement('button');
  addX.type = 'button';
  addX.className = 'network-add-x';
  addX.setAttribute('aria-label', 'Cancel');
  addX.textContent = '×';
  addForm.appendChild(addInput);
  addForm.appendChild(addGo);
  addForm.appendChild(addX);
  frameEl.appendChild(addForm);

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Keep the name box under the node it belongs to, even while the map is moving.
  function placeAddForm() {
    if (!addTarget || addForm.hidden) return;
    var t = lastTransform;
    var gx = addTarget.parent ? addTarget.parent.x : addTarget.x;
    var gy = addTarget.parent ? addTarget.parent.y : addTarget.y;
    var below = (addTarget.parent ? sizeOf(addTarget.parent) * t.k + 34 : 16);
    var fw = addForm.offsetWidth, fh = addForm.offsetHeight;
    addForm.style.left = Math.round(clamp(W / 2 + t.x + gx * t.k - fw / 2, 8, Math.max(8, W - fw - 8))) + 'px';
    addForm.style.top = Math.round(clamp(H / 2 + t.y + gy * t.k + below, 8, Math.max(8, H - fh - 8))) + 'px';
  }

  function startAdd(parentId, pos, viaKeyboard) {
    if (linkMode) return;
    if (userIds.length >= MAX_USER) {
      announce('That is the most topics you can add in one visit. Reset the graph to start again.');
      return;
    }
    closeAdd(false);
    var parent = parentId && nodeById[parentId] ? nodeById[parentId] : null;
    addTarget = { parent: parent, x: pos ? pos.x : 0, y: pos ? pos.y : 0, kb: !!viaKeyboard };
    if (parent) parent.el.classList.add('is-adding');
    addInput.value = '';
    addInput.setAttribute('aria-label', parent ? 'Name a new topic under ' + parent.data.label : 'Name a new topic');
    addForm.hidden = false;
    placeAddForm();
    addInput.focus({ preventScroll: true });
    announce(parent
      ? 'Type a name for a new topic under ' + parent.data.label + ', then press Enter. Escape cancels.'
      : 'Type a name for a new topic, then press Enter. Escape cancels.');
  }

  function closeAdd(restoreFocus) {
    var t = addTarget;
    addTarget = null;
    addForm.hidden = true;
    if (t && t.parent && t.parent.el) {
      t.parent.el.classList.remove('is-adding');
      if (restoreFocus) t.parent.el.focus({ preventScroll: true });
    }
  }

  function commitAdd() {
    if (!addTarget) return;
    var label = addInput.value.replace(/\s+/g, ' ').trim();
    var target = addTarget;
    closeAdd(false);
    if (!label) { if (target.kb && target.parent) target.parent.el.focus({ preventScroll: true }); return; }
    createUserNode(label, target);
  }

  function createUserNode(label, target) {
    var from = target.parent;
    var id = 'user-' + (++userSeq);
    DATA[id] = { id: id, label: label, kind: 'mine', parents: from ? [from.id] : [] };
    CHILDREN[id] = [];
    userIds.push(id);

    var n, l = null;
    if (from) {
      n = addNode(id, from, Math.random(), 1); // a random bearing, so repeated adds fan out
      n.userParent = from.id;
      l = addLink(from, n, false);
    } else {
      n = addNode(id, null, 0, 1);
      n.x = target.x; n.y = target.y;
    }
    n.mine = true;
    syncSim();

    if (!reducedMotion()) {
      popIn(n, 0.02);
      if (l) { l.progress = 0; renderLink(l); gsap.to(l, { progress: 1, duration: 0.45, ease: EASE, onUpdate: function () { renderLink(l); } }); }
    }
    refit();
    reheat(1);
    if (!reducedMotion()) {
      var origin = from || n;
      shuffle(origin, 3.6);
      if (from) {
        // Launch it away from its parent: the link spring then reels it back in, which is the bounce.
        var dx = n.x - from.x, dy = n.y - from.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        n.vx += dx / d * 6; n.vy += dy / d * 6;
        emit(from, n, 0.05);
        var k = 0;
        links.forEach(function (m) {
          if (m === l) return;
          if (m.source === from) emit(from, m.target, 0.14 + 0.05 * k++);
          else if (m.target === from) emit(from, m.source, 0.14 + 0.05 * k++);
        });
        bump(from, 6);
      }
      ripple(origin, 5);
    }
    refreshAll();
    announce('Added ' + label + (from ? ' under ' + from.data.label : '') + '. Press Delete on it to remove it.');
    if (target.kb) n.el.focus({ preventScroll: true });
  }

  // Remove one of your own topics (and anything you hung off it).
  function removeUser(id) {
    var n = nodeById[id];
    if (!n || !n.mine || n.dying) return;
    var doomed = [n], i;
    for (i = 0; i < doomed.length; i++) {
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].userParent === doomed[i].id && doomed.indexOf(nodes[j]) < 0) doomed.push(nodes[j]);
      }
    }
    var parentEl = n.userParent && nodeById[n.userParent] ? nodeById[n.userParent].el : null;
    var name = n.data.label;
    doomed.forEach(function (m, k) {
      m.dying = true;
      if (reducedMotion()) return;
      var sp = springOf(m);
      sp.rm = true; sp.v = 4; sp.t = 0; sp.wait = k * 0.05;
    });
    if (reducedMotion()) finishRemove(doomed); else ensureLoop();
    if (parentEl) parentEl.focus({ preventScroll: true });
    announce('Removed ' + name + (doomed.length > 1 ? ' and ' + plural(doomed.length - 1, 'topic') + ' under it' : '') + '.');
  }

  function finishRemove(list) {
    var gone = {};
    list.forEach(function (m) { gone[m.id] = true; });
    links = links.filter(function (l) {
      if (!gone[l.source.id] && !gone[l.target.id]) return true;
      if (l.el.parentNode) l.el.parentNode.removeChild(l.el);
      delete linkByKey[l.key];
      return false;
    });
    nodes = nodes.filter(function (m) { return !gone[m.id]; });
    particles = particles.filter(function (p) {
      var keep = !gone[p.from.id] && !gone[p.to.id];
      if (!keep && p.el.parentNode) p.el.parentNode.removeChild(p.el);
      return keep;
    });
    list.forEach(function (m) {
      if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
      delete nodeById[m.id];
      delete DATA[m.id];
      delete CHILDREN[m.id];
      userIds.splice(userIds.indexOf(m.id), 1);
      if (selected === m.id) selected = null;
      if (hoverId === m.id) hoverId = null;
      if (lastActive === m.id) lastActive = null;
    });
    syncSim();
    clearHighlight();
    refit();
    reheat(0.7);
    if (!reducedMotion()) { boost = Math.max(boost, 1.3); loose = 1; applyLooseness(); ensureLoop(); }
    refreshAll();
  }

  // Graph coordinates under a screen point.
  function toGraph(clientX, clientY) {
    var r = svgEl.getBoundingClientRect(), t = lastTransform;
    return { x: (clientX - r.left - W / 2 - t.x) / t.k, y: (clientY - r.top - H / 2 - t.y) / t.k };
  }

  // ---------- your own links ----------
  function setLinkMode(on) {
    linkMode = on;
    if (!on) clearSelection();
    stage.classList.toggle('is-linking', on);
    if (linkBtn) {
      linkBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      linkBtn.textContent = on ? 'Done linking' : 'Draw your own link';
    }
    if (hintEl) hintEl.textContent = on ? HINT_LINK : HINT_DEFAULT;
    refreshAll();
    announce(on
      ? 'Link mode on. Choose two topics to connect them. Press Escape when you are done.'
      : 'Link mode off. Selecting a topic opens it again.');
  }

  function clearSelection() {
    if (selected !== null && nodeById[selected]) nodeById[selected].el.classList.remove('is-selected');
    selected = null;
  }

  function linkClick(id) {
    var n = nodeById[id];
    if (selected === null) {
      selected = id;
      n.el.classList.add('is-selected');
      highlight(id);
      refreshAll();
      announce(n.data.label + ' selected. Choose another topic to link it to.');
      return;
    }
    if (selected === id) {
      clearSelection();
      clearHighlight();
      refreshAll();
      announce('Selection cleared.');
      return;
    }
    var a = nodeById[selected];
    var existing = linkByKey[linkKey(a.id, n.id)];
    clearSelection();
    if (existing) {
      clearHighlight();
      refreshAll();
      announce(a.data.label + ' and ' + n.data.label + ' are already connected.');
      return;
    }
    var l = addLink(a, n, true);
    syncSim();
    animateIn([], [l]);
    reheat(0.35);
    highlight(n.id);
    refreshAll();
    announce('Linked ' + a.data.label + ' and ' + n.data.label + '.');
  }

  // ---------- highlight (hover / focus) ----------
  function neighbors(id) {
    var out = [];
    links.forEach(function (l) {
      if (l.source.id === id) out.push(l.target);
      else if (l.target.id === id) out.push(l.source);
    });
    return out;
  }

  function highlight(id) {
    var lit = {};
    lit[id] = true;
    neighbors(id).forEach(function (m) { lit[m.id] = true; });
    nodes.forEach(function (n) {
      n.el.classList.toggle('is-lit', !!lit[n.id]);
      n.el.classList.toggle('is-dim', !lit[n.id]);
    });
    links.forEach(function (l) {
      var on = l.source.id === id || l.target.id === id;
      l.el.classList.toggle('is-lit', on);
      l.el.classList.toggle('is-dim', !on);
      if (on) l.el.classList.toggle('is-reverse', l.target.id === id);
    });
  }

  function clearHighlight() {
    nodes.forEach(function (n) { n.el.classList.remove('is-lit', 'is-dim'); });
    links.forEach(function (l) { l.el.classList.remove('is-lit', 'is-dim', 'is-reverse'); });
  }

  function restoreHighlight() {
    if (selected !== null) highlight(selected);
    else if (hoverId !== null && nodeById[hoverId]) highlight(hoverId);
    else clearHighlight();
  }

  // ---------- labels & announcements ----------
  function label(n) { return n.data.label; }
  function plural(count, word) { return count + ' ' + word + (count === 1 ? '' : 's'); }
  function listJoin(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  function describe(n) {
    var parts = [n.data.label + (n.data.kind === 'course' ? ' course' : '')];
    var nb = neighbors(n.id).map(label);
    if (n.mine) parts[0] = n.data.label + ', your topic';
    if (nb.length) parts.push('Connected to ' + listJoin(nb));
    if (linkMode) {
      if (selected === n.id) parts.push('Selected. Press Enter to cancel the link');
      else if (selected !== null) parts.push('Press Enter to link it to ' + nodeById[selected].data.label);
      else parts.push('Press Enter to start a link from it');
    } else if (canOpen(n.id)) {
      var pending = CHILDREN[n.id].filter(function (c) { return !nodeById[c]; }).length;
      var onMap = CHILDREN[n.id].length - pending;
      if (pending) parts.push('Press Enter to reveal ' + plural(pending, 'more topic'));
      else parts.push('Press Enter to link it to ' + plural(onMap, 'topic') + ' already on the map');
    }
    if (!linkMode) parts.push('Press N to add a topic under it' + (n.mine ? ', or Delete to remove it' : ''));
    return parts.join('. ') + '.';
  }

  function refreshAll() {
    nodes.forEach(function (n) {
      n.el.classList.toggle('has-more', canOpen(n.id));
      n.el.classList.toggle('is-open', !!expanded[n.id]);
      n.el.setAttribute('aria-label', describe(n));
    });
  }

  var announceTimer = null;
  function announce(msg) {
    if (!statusEl || !msg) return;
    statusEl.textContent = '';
    clearTimeout(announceTimer);
    announceTimer = setTimeout(function () { statusEl.textContent = msg; }, 60);
  }

  // ---------- zoom / pan / fit ----------
  // Plain wheel scrolls the page (no scroll-jacking); Ctrl/Cmd + wheel or a
  // trackpad pinch zooms. On touch, one finger scrolls the page and two fingers
  // pinch/pan the graph. Mouse drag on empty space pans.
  var zoom = d3.zoom()
    .scaleExtent([MIN_K, MAX_K])
    .filter(function (ev) {
      if (ev.type === 'wheel') return ev.ctrlKey || ev.metaKey;
      if (ev.type === 'touchstart') return ev.touches.length > 1;
      return !ev.button;
    })
    .on('zoom', function (ev) {
      // Only a gesture that actually moved the view takes over from auto-fit.
      // (d3-zoom also emits for a plain click, and for the mouse events a
      // browser synthesises after a tap on a node.)
      var t = ev.transform, prev = lastTransform;
      if (ev.sourceEvent && (Math.abs(t.k - prev.k) > 1e-3 || Math.abs(t.x - prev.x) > 0.5 || Math.abs(t.y - prev.y) > 0.5)) {
        autoFit = false;
      }
      applyTransform(t);
    });
  svg.call(zoom).on('dblclick.zoom', null);
  svgEl.style.touchAction = 'pan-x pan-y';

  var lastTransform = d3.zoomIdentity;
  function applyTransform(t) {
    lastTransform = t;
    viewport.attr('transform', t.toString());
    // Keep labels readable when zoomed out, and not huge when zoomed in.
    var u = Math.max(0.75, Math.min(1.9, 1 / t.k));
    labelScale = Math.round(u * 20) / 20; // coarse steps so boxes aren't rebuilt every frame
    svgEl.style.setProperty('--u', u.toFixed(3));
    nodes.forEach(function (n) { n.hit.setAttribute('r', r2(Math.max(sizeOf(n) + 8, 15) * u)); });
    placeAddForm();
  }

  function fitTransform() {
    if (!nodes.length) return d3.zoomIdentity;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    nodes.forEach(function (n) {
      var half = Math.max(24, n.data.label.length * 3.3);
      x0 = Math.min(x0, n.x - half); x1 = Math.max(x1, n.x + half);
      y0 = Math.min(y0, n.y - 16); y1 = Math.max(y1, n.y + 30);
    });
    var pad = 24;
    var k = Math.min((W - pad * 2) / (x1 - x0), (H - pad * 2) / (y1 - y0), FIT_MAX_K);
    k = Math.max(MIN_K, k);
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return d3.zoomIdentity.translate(-cx * k, -cy * k).scale(k);
  }

  function fitNow() {
    svg.call(zoom.transform, fitTransform());
  }

  var fitFrame = null;
  function startFitLoop() {
    if (fitFrame !== null || !autoFit) return;
    fitFrame = requestAnimationFrame(stepFit);
  }
  function stepFit() {
    fitFrame = null;
    if (!autoFit) return;
    if (dragging) { fitFrame = requestAnimationFrame(stepFit); return; }
    var cur = d3.zoomTransform(svgEl);
    var tgt = fitTransform();
    var a = 0.1;
    var k = cur.k + (tgt.k - cur.k) * a;
    var x = cur.x + (tgt.x - cur.x) * a;
    var y = cur.y + (tgt.y - cur.y) * a;
    var settled = Math.abs(tgt.k - cur.k) < 0.002 && Math.abs(tgt.x - cur.x) < 0.5 && Math.abs(tgt.y - cur.y) < 0.5;
    svg.call(zoom.transform, settled ? tgt : d3.zoomIdentity.translate(x, y).scale(k));
    if (!settled || sim.alpha() > sim.alphaMin()) fitFrame = requestAnimationFrame(stepFit);
  }

  function zoomBy(factor) {
    autoFit = false;
    if (reducedMotion()) svg.call(zoom.scaleBy, factor);
    else svg.transition().duration(320).ease(d3.easeCubicOut).call(zoom.scaleBy, factor);
  }
  function refit() {
    autoFit = true;
    if (reducedMotion()) fitNow(); else startFitLoop();
  }

  function resize() {
    var w = Math.round(svgEl.clientWidth) || 640;
    var h = Math.round(svgEl.clientHeight) || 420;
    if (w === W && h === H) return;
    W = w; H = h;
    svgEl.setAttribute('viewBox', (-W / 2) + ' ' + (-H / 2) + ' ' + W + ' ' + H);
    // A wide stage lets the graph spread sideways; a tall phone stage, downwards.
    sim.force('x').strength(0.03 * Math.min(1.6, Math.max(0.6, 640 / W)));
    sim.force('y').strength(0.055 * Math.min(1.6, Math.max(0.6, 420 / H)));
    if (autoFit) { if (reducedMotion() || !sim.alpha() || sim.alpha() < sim.alphaMin()) fitNow(); else startFitLoop(); }
  }

  // ---------- drag ----------
  // The node you hold is pinned to a spring that chases the pointer (see step()), so it
  // trails, overshoots a touch, and when you let go it keeps its momentum. The root
  // isn't free to roam: it snaps back to the centre on a spring.
  var drag = d3.drag()
    .clickDistance(5)
    .on('start', function (ev, n) {
      dragging = true;
      if (!ev.active) sim.alphaTarget(0.25).restart();
      n.fx = n.x; n.fy = n.y;
      if (reducedMotion()) return;
      dragState = { n: n, x: n.x, y: n.y, vx: 0, vy: 0, tx: n.x, ty: n.y, releasing: false };
      var sp = springOf(n);
      sp.t = 1.22; // lift
      ensureLoop();
    })
    .on('drag', function (ev, n) {
      if (dragState && dragState.n === n) { dragState.tx = ev.x; dragState.ty = ev.y; }
      else { n.fx = ev.x; n.fy = ev.y; }
    })
    .on('end', function (ev, n) {
      dragging = false;
      if (!ev.active) sim.alphaTarget(0);
      if (n.sc) { n.sc.t = 1; ensureLoop(); }
      if (dragState && dragState.n === n) {
        if (n.id === ROOT_ID) {
          dragState.tx = 0; dragState.ty = 0; dragState.releasing = true;
        } else {
          var sx = dragState.vx / 60, sy = dragState.vy / 60;
          var sp = Math.sqrt(sx * sx + sy * sy);
          if (sp > MAX_FLING) { sx *= MAX_FLING / sp; sy *= MAX_FLING / sp; }
          n.fx = null; n.fy = null;
          n.vx = sx; n.vy = sy;
          dragState = null;
        }
      } else if (n.id !== ROOT_ID) { n.fx = null; n.fy = null; }
      else { n.fx = 0; n.fy = 0; }
      startFitLoop();
    });

  // ---------- events ----------
  function nodeFromEvent(ev) {
    var g = ev.target.closest && ev.target.closest('.net-node');
    return g ? g.getAttribute('data-id') : null;
  }

  nodeLayer.addEventListener('pointerover', function (ev) {
    var id = nodeFromEvent(ev);
    if (id === null) return;
    var from = ev.relatedTarget && ev.relatedTarget.closest && ev.relatedTarget.closest('.net-node');
    if (!from || from.getAttribute('data-id') !== id) hoverScale(nodeById[id], true);
    hoverId = id;
    if (selected === null) highlight(id);
  });
  nodeLayer.addEventListener('pointerout', function (ev) {
    var id = nodeFromEvent(ev);
    if (id === null) return;
    var to = ev.relatedTarget && ev.relatedTarget.closest && ev.relatedTarget.closest('.net-node');
    if (to && to.getAttribute('data-id') === id) return;
    hoverScale(nodeById[id], false);
    hoverId = null;
    restoreHighlight();
  });
  nodeLayer.addEventListener('focusin', function (ev) {
    var id = nodeFromEvent(ev);
    if (id === null) return;
    hoverId = id;
    lastActive = id;
    if (selected === null) highlight(id);
  });
  nodeLayer.addEventListener('focusout', function (ev) {
    if (nodeFromEvent(ev) === null) return;
    hoverId = null;
    restoreHighlight();
  });
  nodeLayer.addEventListener('click', function (ev) {
    var id = nodeFromEvent(ev);
    if (id === null) return;
    lastActive = id;
    // The "+" handle adds a topic instead of opening this one.
    if (ev.target.closest && ev.target.closest('.add')) { startAdd(id, null, ev.detail === 0); return; }
    // detail === 0 means the click came from the keyboard (or assistive tech).
    activate(id, ev.detail === 0);
  });
  nodeLayer.addEventListener('keydown', function (ev) {
    var id = nodeFromEvent(ev);
    if (id === null) return;
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (ev.key === 'n' || ev.key === 'N' || ev.key === '+') { ev.preventDefault(); startAdd(id, null, true); return; }
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && nodeById[id] && nodeById[id].mine) { ev.preventDefault(); removeUser(id); return; }
    }
    if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
    ev.preventDefault();
    activate(id, true);
  });

  // Name box: Enter adds, Escape cancels, clicking away keeps what you typed.
  addForm.addEventListener('submit', function (ev) { ev.preventDefault(); commitAdd(); });
  addForm.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { ev.stopPropagation(); closeAdd(true); }
  });
  addX.addEventListener('click', function () { closeAdd(true); });
  addForm.addEventListener('focusout', function () {
    setTimeout(function () { if (addTarget && !addForm.contains(document.activeElement)) commitAdd(); }, 0);
  });

  // Double-click (or double-tap) on empty space drops a free topic there.
  var downAt = null, lastTap = null;
  function isBackground(t) { return !(t.closest && t.closest('.net-node')); }
  svgEl.addEventListener('pointerdown', function (ev) {
    downAt = isBackground(ev.target) && ev.isPrimary ? { x: ev.clientX, y: ev.clientY } : null;
  });
  svgEl.addEventListener('pointerup', function (ev) {
    if (!downAt) return;
    var moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 6;
    downAt = null;
    if (moved || linkMode) { lastTap = null; return; }
    var now = performance.now();
    if (lastTap && now - lastTap.t < 380 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 28) {
      lastTap = null;
      startAdd(null, toGraph(ev.clientX, ev.clientY), false);
    } else {
      lastTap = { t: now, x: ev.clientX, y: ev.clientY };
    }
  });
  svgEl.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape' || !linkMode) return;
    if (selected !== null) { clearSelection(); restoreHighlight(); refreshAll(); announce('Selection cleared.'); }
    else setLinkMode(false);
  });

  var addBtn = document.getElementById('networkAdd');
  if (addBtn) addBtn.addEventListener('click', function (ev) {
    startAdd(lastActive && nodeById[lastActive] ? lastActive : ROOT_ID, null, ev.detail === 0);
  });
  if (linkBtn) linkBtn.addEventListener('click', function () { setLinkMode(!linkMode); });
  if (resetBtn) resetBtn.addEventListener('click', function () { reset(true); });

  var zoomBtns = stage.querySelectorAll('[data-zoom]');
  for (var zb = 0; zb < zoomBtns.length; zb++) {
    zoomBtns[zb].addEventListener('click', function () {
      var action = this.getAttribute('data-zoom');
      if (action === 'in') zoomBy(1.35);
      else if (action === 'out') zoomBy(1 / 1.35);
      else refit();
    });
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resize).observe(svgEl);
  } else {
    window.addEventListener('resize', resize);
  }

  var HINT_DEFAULT = hintEl ? hintEl.textContent : '';
  var HINT_LINK = 'Link mode: choose two topics to draw your own connection between them. Press Escape or "Done linking" to go back to opening topics.';

  // ---------- start / reset ----------
  function reset(announceIt) {
    if (hasGSAP) {
      links.forEach(function (l) { gsap.killTweensOf(l); });
      nodes.forEach(function (n) { gsap.killTweensOf(n.el.querySelector('.glow')); });
    }
    sim.stop();
    closeAdd(false);
    clearMotion();
    userIds.forEach(function (id) { delete DATA[id]; delete CHILDREN[id]; });
    userIds = []; lastActive = null;
    edgeLayer.textContent = '';
    nodeLayer.textContent = '';
    nodes = []; nodeById = {}; links = []; linkByKey = {}; expanded = {};
    selected = null; hoverId = null;
    if (linkMode) {
      linkMode = false;
      stage.classList.remove('is-linking');
      if (linkBtn) { linkBtn.setAttribute('aria-pressed', 'false'); linkBtn.textContent = 'Draw your own link'; }
      if (hintEl) hintEl.textContent = HINT_DEFAULT;
    }

    var root = addNode(ROOT_ID, null, 0, 1);
    expanded[ROOT_ID] = true;
    var courses = CHILDREN[ROOT_ID];
    courses.forEach(function (cid, i) {
      var a = (i / courses.length) * Math.PI * 2 - Math.PI * 0.75;
      var c = addNode(cid, null, i, courses.length);
      c.x = Math.cos(a) * 110; c.y = Math.sin(a) * 80;
      addLink(root, c, false);
      glowPulse(c);
    });
    syncSim();
    // Settle the opening layout before anyone sees it.
    sim.alpha(1);
    for (var i = 0; i < 240; i++) sim.tick();
    render();
    refreshAll();
    autoFit = true;
    fitNow();
    if (announceIt) announce('Graph reset to your ' + plural(courses.length, 'course') + '.');
  }

  resize();
  reset(false);
})();
