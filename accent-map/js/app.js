(() => {
  // ============================================================
  //  Config
  // ============================================================
  const API          = '/api';
  const SESSION_KEY  = 'accent-map.admin-token';
  const INTRO_KEY    = 'accent-map.intro-seen-session';

  // Hardcoded display values (no tweaks panel in production)
  const T = {
    defaultRadius : 60,
    fadeOutSec    : 0.5,
    fadeInSec     : 0.25,
    showZones     : false,
    showLabels    : true,
    fadeMap       : true,
    mapOpacity    : 69,
    pinColor      : '#e8413a',
    pinSize       : 14,
  };

  // ============================================================
  //  DOM refs
  // ============================================================
  const $ = sel => document.querySelector(sel);
  const mapWrap   = $('#mapWrap');
  const mapZoom   = $('#mapZoom');
  const svg       = $('#mapSvg');
  const pinsLayer = $('#pinsLayer');
  const MAP_W = 4000, MAP_H = 2000;

  // ============================================================
  //  Admin state
  // ============================================================
  let adminToken = sessionStorage.getItem(SESSION_KEY) || null;

  function isAdmin() { return document.body.classList.contains('is-admin'); }

  function setAdminMode(token) {
    adminToken = token;
    sessionStorage.setItem(SESSION_KEY, token);
    document.body.classList.add('is-admin');
  }

  function clearAdminMode() {
    adminToken = null;
    sessionStorage.removeItem(SESSION_KEY);
    document.body.classList.remove('is-admin');
  }

  // ============================================================
  //  API helpers
  // ============================================================
  async function apiFetch(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
    const res = await fetch(`${API}${path}`, { ...options, headers });
    if (res.status === 401) {
      clearAdminMode();
      openAdminModal();
      throw new Error('Session expired — please log in again.');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  }

  async function loadPinsFromAPI() {
    const data = await apiFetch('/accent-pins');
    return Array.isArray(data) ? data : [];
  }

  async function createPinAPI(pin) {
    return apiFetch('/accent-pins', { method: 'POST', body: JSON.stringify(pin) });
  }

  async function updatePinAPI(pin) {
    return apiFetch(`/accent-pins/${pin.id}`, { method: 'PUT', body: JSON.stringify(pin) });
  }

  async function deletePinAPI(id) {
    return apiFetch(`/accent-pins/${id}`, { method: 'DELETE' });
  }

  async function verifyToken(token) {
    try {
      const res = await fetch(`${API}/accent-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data.role === 'admin';
    } catch { return false; }
  }

  // ============================================================
  //  Pan + zoom
  // ============================================================
  mapZoom.style.width  = MAP_W + 'px';
  mapZoom.style.height = MAP_H + 'px';

  const ZOOM = { min: 1, max: 7, level: 1, tx: 0, ty: 0 };

  function fitScale() {
    return Math.min(mapWrap.clientWidth / MAP_W, mapWrap.clientHeight / MAP_H);
  }

  function applyTransform() {
    const f  = fitScale();
    const s  = f * ZOOM.level;
    const vw = mapWrap.clientWidth, vh = mapWrap.clientHeight;
    const sw = MAP_W * s, sh = MAP_H * s;
    if (sw <= vw) ZOOM.tx = (vw - sw) / 2;
    else ZOOM.tx = Math.max(vw - sw, Math.min(0, ZOOM.tx));
    if (sh <= vh) ZOOM.ty = (vh - sh) / 2;
    else ZOOM.ty = Math.max(vh - sh, Math.min(0, ZOOM.ty));
    mapZoom.style.transform = `translate(${ZOOM.tx}px, ${ZOOM.ty}px) scale(${s})`;
    document.body.classList.toggle('can-pan', ZOOM.level > 1.001);
    const pct  = $('#zoomPct');
    if (pct) pct.textContent = Math.round(ZOOM.level * 100) + '%';
    const zin  = $('#zoomIn'), zout = $('#zoomOut');
    if (zin)  zin.disabled  = ZOOM.level >= ZOOM.max - 0.001;
    if (zout) zout.disabled = ZOOM.level <= ZOOM.min + 0.001;
    updatePinScales();
  }

  // Keep pins a constant screen size regardless of zoom level
  function updatePinScales() {
    const inv = 1 / ZOOM.level;
    pinsLayer.querySelectorAll('.pin-group').forEach(g => {
      const pin  = pins.find(p => p.id === g.dataset.id);
      const dot  = g.querySelector('.pin-dot');
      const halo = g.querySelector('.pin-halo');
      const zone = g.querySelector('.pin-zone');
      const lbl  = g.querySelector('.pin-label');
      if (dot)  dot.setAttribute('r',  String(T.pinSize * inv));
      if (halo) halo.setAttribute('r', String(T.pinSize * 1.7 * inv));
      if (zone) zone.setAttribute('r', String((pin?.radius || T.defaultRadius) * inv));
      if (lbl && pin) lbl.setAttribute('y', String(pin.y - (T.pinSize * 1.7 + 8) * inv));
    });
  }

  function zoomTo(newLevel, focalX, focalY, animate = false) {
    newLevel = Math.max(ZOOM.min, Math.min(ZOOM.max, newLevel));
    const f    = fitScale();
    const sOld = f * ZOOM.level;
    const sNew = f * newLevel;
    if (focalX == null) focalX = mapWrap.clientWidth  / 2;
    if (focalY == null) focalY = mapWrap.clientHeight / 2;
    const mx = (focalX - ZOOM.tx) / sOld;
    const my = (focalY - ZOOM.ty) / sOld;
    ZOOM.level = newLevel;
    ZOOM.tx = focalX - mx * sNew;
    ZOOM.ty = focalY - my * sNew;
    if (animate) {
      mapZoom.classList.add('animating');
      applyTransform();
      setTimeout(() => mapZoom.classList.remove('animating'), 240);
    } else {
      applyTransform();
    }
  }

  mapWrap.addEventListener('wheel', e => {
    e.preventDefault();
    const r      = mapWrap.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.015 : 0.0015));
    zoomTo(ZOOM.level * factor, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // ============================================================
  //  Pan (mouse) — Pointer Events, mouse only
  // ============================================================
  let drag = null;

  mapWrap.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse') return;
    if (e.button !== 0) return;
    if (e.target.closest('.zoom-ctrl') || e.target.closest('.pin-group')) return;
    if (document.body.classList.contains('add-mode')) return;
    if (ZOOM.level <= ZOOM.min + 0.001) return;
    mapWrap.setPointerCapture(e.pointerId);
    drag = { x0: e.clientX, y0: e.clientY, tx0: ZOOM.tx, ty0: ZOOM.ty, moved: false };
    document.body.classList.add('panning');
  });

  mapWrap.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || !drag) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    ZOOM.tx = drag.tx0 + dx;
    ZOOM.ty = drag.ty0 + dy;
    applyTransform();
  });

  mapWrap.addEventListener('pointerup', e => {
    if (e.pointerType !== 'mouse') return;
    try { mapWrap.releasePointerCapture(e.pointerId); } catch {}
    const wasMoved = drag?.moved;
    drag = null;
    document.body.classList.remove('panning');
    if (wasMoved) {
      const stop = ev => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', stop, { capture: true, once: true });
    }
  });

  // ============================================================
  //  Pan + Pinch-to-zoom + Tap-to-play (touch)
  //
  //  We call e.preventDefault() unconditionally on touchstart and
  //  touchmove so iOS Safari never claims the gesture as a native
  //  page zoom (conditional preventDefault fires too late).
  //
  //  Pin tap detection uses a pure-JS hit test (client → SVG coords,
  //  distance check against each pin's centre/radius). This bypasses
  //  iOS Safari's broken SVG touch-event routing on transparent fills.
  // ============================================================
  let pinch   = null;
  let touchTap = null; // { pin, el, x, y } when finger down on a pin

  // Convert client coords to SVG-space and return the pin underneath,
  // or null. No DOM involvement — pure maths.
  function pinAtClientPoint(cx, cy) {
    const rect = mapZoom.getBoundingClientRect();
    const svgX = (cx - rect.left) / rect.width  * MAP_W;
    const svgY = (cy - rect.top)  / rect.height * MAP_H;
    for (const pin of pins) {
      const r = pin.radius || T.defaultRadius;
      if (Math.hypot(svgX - pin.x, svgY - pin.y) <= r) return pin;
    }
    return null;
  }

  mapWrap.addEventListener('touchstart', e => {
    e.preventDefault();

    if (e.touches.length === 1) {
      const t = e.touches[0];
      if (!document.body.classList.contains('add-mode')) {
        const hit = pinAtClientPoint(t.clientX, t.clientY);
        if (hit) {
          const el = pinsLayer.querySelector(`[data-id="${hit.id}"]`);
          touchTap = { pin: hit, el, x: t.clientX, y: t.clientY };
          return; // don't start a pan
        }
      }
      if (ZOOM.level <= ZOOM.min + 0.001) return;
      drag = { x0: t.clientX, y0: t.clientY, tx0: ZOOM.tx, ty0: ZOOM.ty, moved: false };
      document.body.classList.add('panning');
    } else if (e.touches.length === 2) {
      touchTap = null;
      drag = null;
      document.body.classList.remove('panning');
      const t0 = e.touches[0], t1 = e.touches[1];
      const r  = mapWrap.getBoundingClientRect();
      pinch = {
        dist:   Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY),
        level0: ZOOM.level, tx0: ZOOM.tx, ty0: ZOOM.ty,
        mx0:    (t0.clientX + t1.clientX) / 2 - r.left,
        my0:    (t0.clientY + t1.clientY) / 2 - r.top,
      };
    }
  }, { passive: false });

  mapWrap.addEventListener('touchmove', e => {
    e.preventDefault();

    if (e.touches.length === 1) {
      if (touchTap) {
        // If finger drifts >12px off the pin, convert to a pan
        const t = e.touches[0];
        if (Math.hypot(t.clientX - touchTap.x, t.clientY - touchTap.y) >= 12) {
          touchTap = null;
          drag = { x0: t.clientX, y0: t.clientY, tx0: ZOOM.tx, ty0: ZOOM.ty, moved: false };
          document.body.classList.add('panning');
        }
      } else if (drag) {
        const t  = e.touches[0];
        const dx = t.clientX - drag.x0, dy = t.clientY - drag.y0;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        ZOOM.tx = drag.tx0 + dx;
        ZOOM.ty = drag.ty0 + dy;
        applyTransform();
      }
    } else if (e.touches.length === 2 && pinch) {
      const t0 = e.touches[0], t1 = e.touches[1];
      const r  = mapWrap.getBoundingClientRect();
      const curDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const curMx   = (t0.clientX + t1.clientX) / 2 - r.left;
      const curMy   = (t0.clientY + t1.clientY) / 2 - r.top;
      const newLevel = Math.max(ZOOM.min, Math.min(ZOOM.max, pinch.level0 * (curDist / pinch.dist)));
      const f    = fitScale();
      const sOld = f * pinch.level0;
      const sNew = f * newLevel;
      const mapX = (pinch.mx0 - pinch.tx0) / sOld;
      const mapY = (pinch.my0 - pinch.ty0) / sOld;
      ZOOM.level = newLevel;
      ZOOM.tx    = curMx - mapX * sNew;
      ZOOM.ty    = curMy - mapY * sNew;
      applyTransform();
    }
  }, { passive: false });

  mapWrap.addEventListener('touchend', e => {
    if (e.touches.length === 0) {
      // Fire pin if this was a clean tap
      if (touchTap) {
        onPinEnter(touchTap.pin, touchTap.el || pinsLayer);
        touchTap = null;
      }
      const wasMoved = drag?.moved;
      drag = null; pinch = null;
      document.body.classList.remove('panning');
      if (wasMoved) {
        const stop = ev => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener('click', stop, { capture: true, once: true });
      }
    } else if (e.touches.length === 1) {
      pinch = null;
    }
  }, { passive: true });

  mapWrap.addEventListener('touchcancel', () => {
    drag = null; pinch = null; touchTap = null;
    document.body.classList.remove('panning');
  }, { passive: true });

  $('#zoomIn').addEventListener('click',    () => zoomTo(ZOOM.level * 1.5, null, null, true));
  $('#zoomOut').addEventListener('click',   () => zoomTo(ZOOM.level / 1.5, null, null, true));
  $('#zoomReset').addEventListener('click', () => zoomTo(ZOOM.min,         null, null, true));

  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(ZOOM.level * 1.5, null, null, true); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomTo(ZOOM.level / 1.5, null, null, true); }
    else if (e.key === '0') { e.preventDefault(); zoomTo(ZOOM.min, null, null, true); }
  });

  window.addEventListener('resize', applyTransform);
  applyTransform();

  // ============================================================
  //  Tooltip
  // ============================================================
  const tooltip  = $('#tooltip');
  const ttCountry = tooltip.querySelector('.country');
  const ttAccent  = tooltip.querySelector('.accent');
  const ttState   = tooltip.querySelector('#ttState');

  function showTooltip(country, accent, hasAudio) {
    ttCountry.textContent = country || 'untitled';
    ttAccent.textContent  = accent  || '(no label)';
    if (hasAudio) {
      ttState.classList.remove('dim');
      ttState.innerHTML = `<span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span> playing`;
    } else {
      ttState.classList.add('dim');
      ttState.textContent = isAdmin() ? 'no clip yet — double-click to add' : 'no audio';
    }
    tooltip.classList.add('show');
  }

  function hideTooltip() {
    tooltip.classList.remove('show', 'faded');
  }

  document.addEventListener('mousemove', e => {
    if (tooltip.classList.contains('show')) {
      tooltip.style.left = e.clientX + 'px';
      tooltip.style.top  = e.clientY + 'px';
    }
  });

  // ============================================================
  //  Audio crossfade engine
  // ============================================================
  const players = new Map();

  function setVolumeOver(p, target, ms) {
    cancelAnimationFrame(p.raf);
    const start = p.current;
    const t0    = performance.now();
    const tick  = now => {
      const k = ms <= 0 ? 1 : Math.min(1, (now - t0) / ms);
      p.current = start + (target - start) * k;
      try { p.audio.volume = Math.max(0, Math.min(1, p.current)); } catch {}
      if (k < 1) {
        p.raf = requestAnimationFrame(tick);
      } else if (target === 0) {
        try { p.audio.pause(); } catch {}
        players.delete(p.id);
      }
    };
    p.raf = requestAnimationFrame(tick);
  }

  function playClip(id, url) {
    if (!url) return;
    if (players.has(id)) {
      setVolumeOver(players.get(id), 1, T.fadeInSec * 1000);
      return;
    }
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    audio.preload     = 'auto';
    audio.volume      = 0;
    audio.loop        = false;
    const p = { id, audio, current: 0, target: 1, raf: 0 };
    players.set(id, p);
    // When audio finishes naturally, remove from players so hovering
    // again creates a fresh instance and replays from the start.
    audio.addEventListener('ended', () => players.delete(id));
    audio.play().catch(err => {
      console.warn('audio play failed', id, err);
      players.delete(id);
    });
    setVolumeOver(p, 1, T.fadeInSec * 1000);
  }

  function fadeOut(id)  { const p = players.get(id); if (p) setVolumeOver(p, 0, T.fadeOutSec * 1000); }
  function fadeOutAll() { for (const id of players.keys()) fadeOut(id); }

  function stopImmediate(id) {
    const p = players.get(id);
    if (!p) return;
    cancelAnimationFrame(p.raf);
    try { p.audio.pause(); p.audio.currentTime = 0; } catch {}
    players.delete(id);
  }
  function stopAll() { for (const id of [...players.keys()]) stopImmediate(id); }

  // ============================================================
  //  Pin data + render
  // ============================================================
  let pins = [];
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function hexToRgba(hex, a) {
    const m = /^#?([a-f0-9]{6})$/i.exec(hex || '');
    if (!m) return `rgba(232,65,58,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function renderPins() {
    pinsLayer.innerHTML = '';
    pins.forEach(pin => {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'pin-group');
      g.dataset.id = pin.id;

      const zone = document.createElementNS(SVG_NS, 'circle');
      zone.setAttribute('class', 'pin-zone');
      zone.setAttribute('cx', pin.x);
      zone.setAttribute('cy', pin.y);
      zone.setAttribute('r',  pin.radius || T.defaultRadius);
      g.appendChild(zone);

      const halo = document.createElementNS(SVG_NS, 'circle');
      halo.setAttribute('class', 'pin-halo');
      halo.setAttribute('cx', pin.x);
      halo.setAttribute('cy', pin.y);
      halo.setAttribute('r',  String(T.pinSize * 1.7));
      halo.setAttribute('fill', hexToRgba(T.pinColor, 0.22));
      g.appendChild(halo);

      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('class', 'pin-dot');
      dot.setAttribute('cx', pin.x);
      dot.setAttribute('cy', pin.y);
      dot.setAttribute('r',  String(T.pinSize));
      dot.setAttribute('fill', T.pinColor);
      g.appendChild(dot);

      if (pin.country || pin.accent) {
        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('class', 'pin-label');
        label.setAttribute('x', pin.x);
        label.setAttribute('y', pin.y - (T.pinSize * 1.7 + 8));
        label.textContent = pin.country || pin.accent;
        g.appendChild(label);
      }

      pinsLayer.appendChild(g);

      g.addEventListener('mouseenter', () => onPinEnter(pin, g));
      g.addEventListener('mouseleave', () => onPinLeave(pin, g));

      if (isAdmin()) {
        g.addEventListener('dblclick', e => { e.preventDefault(); openEditor(pin); });
        g.addEventListener('click', e => {
          if (e.altKey || e.ctrlKey || e.metaKey) { e.preventDefault(); openEditor(pin); }
        });
      }
    });

    updateEmpty();
    updateCounter();
    renderAccentList();
  }

  function updateEmpty() {
    $('#emptyState').style.display = (pins.length === 0 && isAdmin()) ? 'grid' : 'none';
  }

  function updateCounter() {
    const n = pins.filter(p => p.audio).length;
    $('#counter').textContent = n === 1 ? '1 clip loaded' : `${n} clips loaded`;
  }

  async function reloadPins() {
    try {
      pins = await loadPinsFromAPI();
    } catch (e) {
      console.error('Failed to load pins:', e);
      pins = [];
    }
    renderPins();
  }

  // ============================================================
  //  Hover handlers
  // ============================================================
  function onPinEnter(pin, el) {
    if (document.body.classList.contains('add-mode')) return;
    document.body.classList.add('has-hover');
    el.classList.add('is-active');
    showTooltip(pin.country, pin.accent, !!pin.audio);
    fadeOutAll();
    if (pin.audio) playClip('pin:' + pin.id, pin.audio);
  }

  function onPinLeave(pin, el) {
    el.classList.remove('is-active');
    document.body.classList.remove('has-hover');
    hideTooltip();
    stopImmediate('pin:' + pin.id);
  }

  // ============================================================
  //  Add mode (admin only)
  // ============================================================
  const btnAdd = $('#btnAdd');

  function toggleAddMode(force) {
    if (!isAdmin()) return;
    const on = typeof force === 'boolean' ? force : !document.body.classList.contains('add-mode');
    document.body.classList.toggle('add-mode', on);
    btnAdd.classList.toggle('active', on);
    fadeOutAll();
    hideTooltip();
  }

  btnAdd.addEventListener('click', () => toggleAddMode());
  $('#emptyAdd').addEventListener('click', () => toggleAddMode(true));

  function clientToSvg(clientX, clientY) {
    const rect = mapZoom.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width  * MAP_W,
      y: (clientY - rect.top)  / rect.height * MAP_H,
    };
  }

  mapWrap.addEventListener('click', e => {
    if (!document.body.classList.contains('add-mode')) return;
    if (e.target.closest('header') || e.target.closest('footer') || e.target.closest('.modal-veil')) return;
    const { x, y } = clientToSvg(e.clientX, e.clientY);
    if (x < 0 || y < 0 || x > MAP_W || y > MAP_H) return;
    openEditor({
      id      : 'pin_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      x       : Math.round(x),
      y       : Math.round(y),
      country : '',
      accent  : '',
      audio   : '',
      radius  : T.defaultRadius,
    }, true);
  });

  // ============================================================
  //  Pin editor modal (admin only)
  // ============================================================
  const modalVeil = $('#modalVeil');
  const fCountry  = $('#fCountry');
  const fAccent   = $('#fAccent');
  const fAudio    = $('#fAudio');
  const fRadius   = $('#fRadius');
  const fSave     = $('#fSave');
  const fCancel   = $('#fCancel');
  const fDelete   = $('#fDelete');
  const fSaveErr  = $('#fSaveErr');

  let editorState = null;

  function openEditor(pin, isNew = false) {
    editorState = { item: { ...pin }, isNew };
    $('#modalTitle').textContent = isNew ? 'New accent pin' : 'Edit accent pin';
    $('#modalSub').textContent   = isNew
      ? 'Add a label and a Cloudflare R2 audio URL.'
      : 'Update label, audio URL, or hover-zone size.';
    fCountry.value = pin.country || '';
    fAccent.value  = pin.accent  || '';
    fAudio.value   = pin.audio   || '';
    fRadius.value  = pin.radius  || T.defaultRadius;
    fDelete.style.display = isNew ? 'none' : 'inline-block';
    fSave.disabled   = false;
    fDelete.disabled = false;
    fSaveErr.style.display = 'none';
    modalVeil.classList.add('show');
    setTimeout(() => fCountry.focus(), 50);
  }

  function closeModal() {
    modalVeil.classList.remove('show');
    editorState = null;
  }

  fCancel.addEventListener('click', closeModal);
  modalVeil.addEventListener('click', e => { if (e.target === modalVeil) closeModal(); });

  fSave.addEventListener('click', async () => {
    if (!editorState) return;
    fSave.disabled   = true;
    fDelete.disabled = true;
    fSaveErr.style.display = 'none';

    const pin = {
      ...editorState.item,
      country : fCountry.value.trim(),
      accent  : fAccent.value.trim(),
      audio   : fAudio.value.trim(),
      radius  : parseInt(fRadius.value, 10) || T.defaultRadius,
    };

    try {
      if (editorState.isNew) {
        if (!pin.country && !pin.audio) { closeModal(); return; }
        await createPinAPI(pin);
        pins = [...pins, pin];
      } else {
        await updatePinAPI(pin);
        pins = pins.map(p => p.id === pin.id ? pin : p);
      }
      renderPins();
      closeModal();
      reloadPins().catch(() => {}); // background sync
    } catch (e) {
      fSaveErr.textContent   = e.message || 'Save failed.';
      fSaveErr.style.display = 'block';
    } finally {
      fSave.disabled   = false;
      fDelete.disabled = false;
    }
  });

  fDelete.addEventListener('click', async () => {
    if (!editorState) return;
    fSave.disabled   = true;
    fDelete.disabled = true;
    fSaveErr.style.display = 'none';
    try {
      await deletePinAPI(editorState.item.id);
      pins = pins.filter(p => p.id !== editorState.item.id);
      renderPins();
      closeModal();
      reloadPins().catch(() => {}); // background sync
    } catch (e) {
      fSaveErr.textContent   = e.message || 'Delete failed.';
      fSaveErr.style.display = 'block';
      fSave.disabled   = false;
      fDelete.disabled = false;
    }
  });


  // ============================================================
  //  Admin login modal
  // ============================================================
  const adminVeil  = $('#adminVeil');
  const adminPass  = $('#adminPass');
  const adminError = $('#adminError');

  function openAdminModal() {
    adminVeil.classList.add('show');
    adminPass.value = '';
    adminError.style.display = 'none';
    setTimeout(() => adminPass.focus(), 50);
  }

  function closeAdminModal() { adminVeil.classList.remove('show'); }

  $('#adminCancel').addEventListener('click', closeAdminModal);
  adminVeil.addEventListener('click', e => { if (e.target === adminVeil) closeAdminModal(); });

  async function doLogin() {
    const pw = adminPass.value;
    if (!pw) return;
    adminError.style.display  = 'none';
    $('#adminLogin').disabled = true;
    const ok = await verifyToken(pw);
    $('#adminLogin').disabled = false;
    if (ok) {
      setAdminMode(pw);
      closeAdminModal();
      renderPins();       // re-render to attach edit handlers
      updateEmpty();
    } else {
      adminError.style.display = 'block';
      adminPass.select();
    }
  }

  $('#adminLogin').addEventListener('click', doLogin);
  adminPass.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // Access: ?admin in URL, or Ctrl+Shift+A
  if (new URLSearchParams(window.location.search).has('admin') && !adminToken) {
    setTimeout(openAdminModal, 300);
  }
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      if (!isAdmin()) openAdminModal();
    }
  });

  // Logout
  $('#btnLogout').addEventListener('click', () => {
    clearAdminMode();
    renderPins();
    updateEmpty();
  });

  // ============================================================
  //  Global ESC
  // ============================================================
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      toggleAddMode(false);
      closeModal();
      closeAdminModal();
    }
  });

  // ============================================================
  //  Intro overlay (shown once per session)
  // ============================================================
  localStorage.removeItem('accent-map.intro-seen');
  sessionStorage.removeItem(INTRO_KEY);
  const introEl = $('#intro');
  $('#introGo').addEventListener('click', () => introEl.remove());

  // ============================================================
  //  Apply display config
  // ============================================================
  document.body.classList.toggle('show-zones',  !!T.showZones);
  document.body.classList.toggle('show-labels', !!T.showLabels);

  // ============================================================
  //  Boot: verify stored session, then load pins
  // ============================================================
  async function boot() {
    if (adminToken) {
      const ok = await verifyToken(adminToken);
      if (ok) document.body.classList.add('is-admin');
      else    clearAdminMode();
    }
    await reloadPins();
  }

  boot();

  // ============================================================
  //  Bottom-left accent list
  // ============================================================
  const accentsItems = $('#accentsItems');

  function centerOnPin(pin) {
    const f = fitScale();
    const targetLevel = Math.min(ZOOM.max, Math.max(3, ZOOM.level));
    const s = f * targetLevel;
    ZOOM.level = targetLevel;
    ZOOM.tx = mapWrap.clientWidth  / 2 - pin.x * s;
    ZOOM.ty = mapWrap.clientHeight / 2 - pin.y * s;
    mapZoom.classList.add('animating');
    applyTransform();
    setTimeout(() => mapZoom.classList.remove('animating'), 240);
  }

  function renderAccentList() {
    if (!accentsItems) return;
    const sorted = [...pins]
      .filter(p => p.accent || p.country)
      .sort((a, b) => (a.accent || a.country || '').localeCompare(b.accent || b.country || ''));
    accentsItems.innerHTML = '';
    if (sorted.length === 0) {
      accentsItems.innerHTML = '<div class="ali-empty">no accents yet</div>';
      return;
    }
    sorted.forEach(pin => {
      const item = document.createElement('div');
      item.className = 'accents-list-item';
      item.dataset.id = pin.id;
      item.innerHTML = `<span class="ali-accent">${pin.accent || '(unnamed)'}</span>${pin.country ? `<span class="ali-country">${pin.country}</span>` : ''}`;
      item.addEventListener('click', () => {
        stopAll();
        if (pin.audio) playClip('pin:' + pin.id, pin.audio);
        centerOnPin(pin);
        document.querySelectorAll('.accents-list-item').forEach(i => i.classList.remove('playing'));
        item.classList.add('playing');
      });
      accentsItems.appendChild(item);
    });
  }

  // ============================================================
  //  Sequential pin flash — first at 2 s, then every 30 s
  // ============================================================
  function flashAllSequentially() {
    const dots = [...pinsLayer.querySelectorAll('.pin-dot')];
    dots.forEach((dot, i) => {
      setTimeout(() => {
        dot.classList.add('flashing');
        setTimeout(() => dot.classList.remove('flashing'), 500);
      }, i * 180);
    });
  }
  setTimeout(() => {
    flashAllSequentially();
    setInterval(flashAllSequentially, 30000);
  }, 2000);
})();
