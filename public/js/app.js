// Disk Space Over Time: draws /api/drives as a card per drive, each with a chart of the space used.
(() => {
  const $ = (id) => document.getElementById(id);
  const DAY = 86400000;
  let data = null;
  let range = Number(load('dsot-range', 91));
  const openTables = new Set(load('dsot-tables', []));

  function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* no storage */ } }

  // Build elements without innerHTML, so drive names can never become markup.
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style') e.setAttribute('style', v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
  }
  const SVG = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...kids) {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v);
    for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  }

  // Sizes as Windows Explorer and most NAS pages show them (1 TB = 1024 GB).
  function bytes(n, places) {
    if (n == null) return '';
    const neg = n < 0;
    n = Math.abs(n);
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    const p = places ?? (n >= 100 || i === 0 ? 0 : n >= 10 ? 1 : 2);
    return `${neg ? '-' : ''}${n.toFixed(p)} ${u[i]}`;
  }
  const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY);
  const dateOf = (n) => new Date(n * DAY);
  const fmt = (n, opts) => dateOf(n).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
  const longDay = (d) => fmt(dayNum(d), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  function ago(iso) {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return 'just now';
    const m = s / 60, h = m / 60, d = h / 24;
    if (m < 90) return `${Math.round(m)} minutes ago`;
    if (h < 36) return `${Math.round(h)} hours ago`;
    return `${Math.round(d)} days ago`;
  }
  function inTime(days) {
    if (days < 1) return 'now';
    if (days < 14) return `${days} day${days === 1 ? '' : 's'}`;
    if (days < 61) return `${Math.round(days / 7)} weeks`;
    if (days < 730) return `${Math.round(days / 30.4)} months`;
    const y = days / 365.25;
    return y > 20 ? 'over 20 years' : `${y < 5 ? y.toFixed(1) : Math.round(y)} years`;
  }
  function rate(perDay) { return `${bytes(Math.abs(perDay) * 30)} a month`; }

  // --- Summary tiles ---
  function tile(n, l, cls) { return el('div', { class: `tile${cls ? ` ${cls}` : ''}` }, el('div', { class: 'n', text: n }), el('div', { class: 'l', text: l })); }
  function drawSummary() {
    const read = data.drives.filter((d) => d.latest);
    const free = read.reduce((s, d) => s + d.latest.free, 0);
    const filling = read.filter((d) => d.forecast && d.forecast.kind === 'filling').sort((a, b) => a.forecast.daysLeft - b.forecast.daysLeft);
    const low = read.filter((d) => d.status === 'low' || d.status === 'soon');
    const tiles = [
      tile(String(data.drives.length), data.drives.length === 1 ? 'drive' : 'drives'),
      tile(bytes(free), 'free on all of them'),
      filling.length ? tile(inTime(filling[0].forecast.daysLeft), `until ${filling[0].name} is full`, filling[0].status === 'ok' ? '' : 'warn') : tile('None', 'filling up'),
      tile(String(low.length), low.length === 1 ? 'needs a look' : 'need a look', low.length ? 'bad' : ''),
    ];
    if (data.firstDay) tiles.push(tile(fmt(dayNum(data.firstDay), { day: 'numeric', month: 'short', year: 'numeric' }), 'readings since'));
    const t = lastAt();
    tiles.push(el('div', { class: 'tile', role: 'status' },
      el('div', { class: 'n', id: 'lastRecorded', text: data.recording ? 'Reading...' : t ? ago(t) : 'Not yet' }),
      el('div', { class: 'l', text: `last reading · next at ${data.recordTime}` })));
    $('summary').replaceChildren(...tiles);
  }

  // --- One drive ---
  const STATUS = {
    low: { text: 'Low on space', mark: '!', cls: 'bad' },
    soon: { text: 'Filling up', mark: '▲', cls: 'warn' },
    ok: { text: 'OK', mark: '✓', cls: 'good' },
    none: { text: 'No readings yet', mark: '…', cls: 'idle' },
  };

  function forecastText(d) {
    const f = d.forecast;
    if (!f) return null;
    if (f.kind === 'learning') return el('span', { class: 'muted', text: `Full in: worked out after a week of readings (${f.days} more day${f.days === 1 ? '' : 's'})` });
    if (f.kind === 'steady') return el('span', {}, el('b', { text: 'Not filling up' }), el('span', { class: 'muted', text: f.slow ? ` (over 10 years from full, at ${rate(f.perDay)})` : ` (about the same over the last ${Math.min(f.span, f.trendDays)} days)` }));
    if (f.kind === 'emptying') return el('span', {}, el('b', { text: 'Emptying' }), el('span', { class: 'muted', text: ` (${rate(f.perDay)} freed)` }));
    return el('span', {}, 'Full in about ', el('b', { text: inTime(f.daysLeft) }),
      el('span', { class: 'muted', text: ` (around ${fmt(dayNum(f.fullOn), { month: 'long', year: 'numeric' })}, at ${rate(f.perDay)})` }));
  }

  function driveCard(d) {
    const st = STATUS[d.status] || STATUS.ok;
    const head = el('header', {},
      el('h2', { text: d.name }),
      el('span', { class: 'kind', text: d.kind === 'ssh' ? 'over SSH' : 'this machine', title: d.url }),
      el('span', { class: `pill ${st.cls}` }, el('span', { 'aria-hidden': 'true', text: st.mark }), st.text));
    const body = [head];
    if (d.error) body.push(el('p', { class: 'small bad', role: 'status', text: `Last try didn't read it: ${d.error}` }));
    if (!d.latest) {
      body.push(el('p', { class: 'muted', text: d.error ? 'It will be tried again in 30 minutes, or press Record now.' : 'Its first reading is on the way.' }));
      return el('section', { class: 'card' }, body);
    }
    const l = d.latest;
    const usedPct = l.size ? ((l.size - l.free) / l.size) * 100 : 0;
    body.push(
      el('div', { class: 'now' },
        el('span', { class: 'big', text: bytes(l.free) }),
        el('span', { class: 'muted', text: ` free of ${bytes(l.size)} (${d.freePercent.toFixed(d.freePercent < 10 ? 1 : 0)}%)` })),
      el('div', { class: `meter ${st.cls}`, role: 'img', 'aria-label': `${usedPct.toFixed(0)}% used` }, el('span', { style: `width:${Math.min(100, usedPct).toFixed(2)}%` })),
      el('div', { class: 'facts small' },
        d.change30 ? el('span', {}, 'Last 30 days: ', el('b', { text: `${d.change30.bytes >= 0 ? '+' : ''}${bytes(Math.abs(d.change30.bytes))}` }), el('span', { class: 'muted', text: d.change30.bytes >= 0 ? ' used' : ' freed' })) : el('span', { class: 'muted', text: 'Last 30 days: not enough readings yet' }),
        forecastText(d)));
    const plot = el('div', { class: 'plot' });
    body.push(plot, readingsTable(d));
    const card = el('section', { class: `card is-${st.cls}` }, body);
    card._draw = () => drawChart(plot, d);
    return card;
  }

  function shownPoints(d) {
    if (!range || !d.points.length) return d.points;
    const from = dayNum(d.points[d.points.length - 1].day) - range;
    return d.points.filter((p) => dayNum(p.day) >= from);
  }

  function readingsTable(d) {
    const box = el('details', { class: 'readings' }, el('summary', { class: 'small', text: 'Readings' }));
    if (openTables.has(d.id)) box.open = true;
    box.addEventListener('toggle', () => {
      if (box.open) openTables.add(d.id); else openTables.delete(d.id);
      save('dsot-tables', [...openTables]);
    });
    const pts = shownPoints(d);
    const rows = [];
    for (let i = pts.length - 1; i >= 0 && rows.length < 400; i--) {
      const p = pts[i], prev = pts[i - 1];
      const ch = prev ? p.used - prev.used : null;
      rows.push(el('tr', {},
        el('td', { text: longDay(p.day) }),
        el('td', { class: 'num', text: bytes(p.used) }),
        el('td', { class: 'num', text: bytes(p.free) }),
        el('td', { class: 'num', text: `${p.size ? ((p.free / p.size) * 100).toFixed(1) : '0'}%` }),
        el('td', { class: 'num muted', text: ch == null ? '' : `${ch >= 0 ? '+' : ''}${bytes(ch)}` })));
    }
    box.append(el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ['Day', 'Used', 'Free', 'Free %', 'Change'].map((h, i) => el('th', { class: i ? 'num' : null, scope: 'col', text: h })))),
      el('tbody', {}, rows))));
    return box;
  }

  // --- The chart: used space over time, the drive's size, and the trend carried on ---
  function niceDates(startN, endN, width) {
    const span = Math.max(1, endN - startN);
    const count = Math.max(2, Math.min(7, Math.floor(width / 110)));
    const steps = [1, 2, 7, 14, 30.44, 61, 91.3, 182.6, 365.25, 730.5];
    const step = steps.find((s) => span / s <= count) || span / count;
    const ticks = [];
    if (step >= 30) {
      // On month starts, so the labels read as months.
      const months = Math.round(step / 30.44);
      const d = dateOf(startN);
      let m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      while (m.getUTCMonth() % months) m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
      for (; m.getTime() / DAY <= endN; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + months, 1))) ticks.push(Math.round(m.getTime() / DAY));
    } else {
      for (let n = Math.ceil(startN / step) * step; n <= endN; n += step) ticks.push(Math.round(n));
    }
    return { ticks, monthly: step >= 30, yearly: span > 400 };
  }

  function drawChart(box, d) {
    const pts = shownPoints(d);
    const W = Math.max(260, box.clientWidth || 400);
    const H = 190;
    const M = { l: 58, r: 14, t: 12, b: 24 };
    const last = pts[pts.length - 1];
    const lastN = dayNum(last.day);
    let startN = range ? lastN - range : dayNum(pts[0].day);
    if (lastN - startN < 7) startN = lastN - 7;
    const f = d.forecast;
    const filling = f && f.kind === 'filling';
    const endN = filling ? lastN + Math.max(7, Math.round((lastN - startN) * 0.25)) : lastN;
    // From a little under the least used space in view up to the drive's size, so a drive filling
    // slowly still shows its slope (the labels on the left give the real sizes).
    const size = last.size;
    const sizeTop = Math.max(...pts.map((p) => p.size));
    const least = Math.min(...pts.map((p) => p.used));
    const lo = Math.max(0, least - Math.max((sizeTop - least) * 0.25, sizeTop * 0.02));
    const top = sizeTop + (sizeTop - lo) * 0.04 || 1;
    const x = (n) => M.l + ((n - startN) / (endN - startN || 1)) * (W - M.l - M.r);
    const y = (v) => M.t + (1 - (v - lo) / (top - lo)) * (H - M.t - M.b);

    const g = [];
    // Grid and space labels: four steps from the bottom of the chart up to the drive's size.
    for (const q of [0, 0.25, 0.5, 0.75, 1]) {
      const v = lo + (size - lo) * q;
      g.push(svg('line', { class: 'grid', x1: M.l, x2: W - M.r, y1: y(v), y2: y(v) }));
      g.push(svg('text', { class: 'axis', x: M.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, bytes(v, v === 0 ? 0 : null)));
    }
    const dates = niceDates(startN, endN, W - M.l - M.r);
    for (const n of dates.ticks) {
      if (n < startN || n > endN) continue;
      g.push(svg('text', { class: 'axis', x: x(n), y: H - 6, 'text-anchor': 'middle' },
        dates.monthly ? fmt(n, dates.yearly ? { month: 'short', year: 'numeric' } : { month: 'short' }) : fmt(n, { day: 'numeric', month: 'short' })));
    }
    // Today's edge, when the trend carries on past it.
    if (filling) g.push(svg('line', { class: 'today', x1: x(lastN), x2: x(lastN), y1: M.t, y2: H - M.b }));

    // The drive's size, dashed (it moves only if a drive is swapped for a bigger one).
    const sizePath = pts.map((p, i) => `${i ? 'L' : 'M'}${x(dayNum(p.day)).toFixed(1)},${y(p.size).toFixed(1)}`).join('') + (filling ? `L${x(endN).toFixed(1)},${y(size).toFixed(1)}` : '');
    g.push(svg('path', { class: 'size', d: pts.length > 1 || filling ? sizePath : `M${M.l},${y(size)}L${W - M.r},${y(size)}` }));

    // Used space: area and line.
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(dayNum(p.day)).toFixed(1)},${y(p.used).toFixed(1)}`).join('');
    if (pts.length > 1) {
      g.push(svg('path', { class: 'area', d: `${line}L${x(lastN).toFixed(1)},${y(lo)}L${x(dayNum(pts[0].day)).toFixed(1)},${y(lo)}Z` }));
      g.push(svg('path', { class: 'used', d: line }));
    }
    // The trend carried on, stopping where the drive would be full.
    if (filling) {
      const fullN = lastN + last.free / f.perDay;
      const stopN = Math.min(endN, fullN);
      const stopV = Math.min(last.size, last.used + f.perDay * (stopN - lastN));
      g.push(svg('path', { class: 'trend', d: `M${x(lastN).toFixed(1)},${y(last.used).toFixed(1)}L${x(stopN).toFixed(1)},${y(stopV).toFixed(1)}` }));
      if (fullN <= endN) g.push(svg('text', { class: 'axis full', x: x(stopN), y: y(stopV) - 6, 'text-anchor': 'end' }, 'Full'));
    }
    g.push(svg('circle', { class: 'last', cx: x(lastN), cy: y(last.used), r: 4 }));

    // Hover: the nearest day's reading.
    const guide = svg('line', { class: 'guide', y1: M.t, y2: H - M.b, visibility: 'hidden' });
    const dot = svg('circle', { class: 'last', r: 4.5, visibility: 'hidden' });
    const hit = svg('rect', { class: 'hit', x: M.l, y: 0, width: W - M.l - M.r, height: H, tabindex: '0', 'aria-label': `Chart of ${d.name}: use the left and right arrow keys to step through the readings` });
    g.push(guide, dot, hit);
    const tip = $('tip');
    let at = pts.length - 1;
    function show(i, cx, cy) {
      at = Math.max(0, Math.min(pts.length - 1, i));
      const p = pts[at];
      const px = x(dayNum(p.day)), py = y(p.used);
      guide.setAttribute('x1', px); guide.setAttribute('x2', px); guide.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
      tip.replaceChildren(el('b', { text: longDay(p.day) }),
        el('div', {}, `Used ${bytes(p.used)} (${p.size ? (100 - (p.free / p.size) * 100).toFixed(1) : 0}%)`),
        el('div', {}, `Free ${bytes(p.free)} of ${bytes(p.size)}`));
      tip.hidden = false;
      const r = hit.getBoundingClientRect();
      const left = cx ?? r.left + px - M.l;
      const topPx = cy ?? r.top + py;
      tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, left + 14))}px`;
      tip.style.top = `${Math.max(8, topPx - tip.offsetHeight - 12)}px`;
    }
    function hide() { guide.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; }
    function nearest(clientX) {
      const r = hit.getBoundingClientRect();
      const n = startN + ((clientX - r.left) / r.width) * (endN - startN);
      let best = 0;
      for (let i = 1; i < pts.length; i++) if (Math.abs(dayNum(pts[i].day) - n) < Math.abs(dayNum(pts[best].day) - n)) best = i;
      return best;
    }
    hit.addEventListener('pointermove', (e) => show(nearest(e.clientX), e.clientX, e.clientY));
    hit.addEventListener('pointerdown', (e) => show(nearest(e.clientX), e.clientX, e.clientY));
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('blur', hide);
    hit.addEventListener('focus', () => show(at));
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(at + (e.key === 'ArrowLeft' ? -1 : 1)); }
      if (e.key === 'Escape') hide();
    });

    box.replaceChildren(svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Space used on ${d.name} over time` }, g));
  }

  // --- Page ---
  function draw() {
    $('signOut').hidden = !data.signIn;
    $('aboutVersion').textContent = `Version ${data.version}`;
    for (const [cls, v] of [['recordTime', data.recordTime], ['trendDays', data.trendDays], ['lowPercent', data.lowPercent], ['soonDays', data.soonDays]]) {
      document.querySelectorAll(`.${cls}`).forEach((s) => { s.textContent = v; });
    }
    document.querySelectorAll('#range button').forEach((b) => b.classList.toggle('on', Number(b.dataset.days) === range));
    drawSummary();
    if (!data.drives.length) {
      $('cards').replaceChildren(el('div', { class: 'card wide' },
        el('h2', { text: 'No drives yet' }),
        el('p', {}, 'Open ', el('b', { text: 'Settings' }), ' to add the drives to keep an eye on: the ones mounted into the app in docker-compose.yml, or a NAS over SSH.')));
      return;
    }
    const cards = data.drives.map(driveCard);
    $('cards').replaceChildren(...cards);
    for (const c of cards) if (c._draw) c._draw();
  }
  function lastAt() {
    const times = data.drives.filter((d) => d.latest && d.latest.at).map((d) => d.latest.at).sort();
    return times[times.length - 1] || null;
  }

  async function refresh() {
    try {
      const res = await fetch('/api/drives', { cache: 'no-store' });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) throw new Error(`The server answered ${res.status}`);
      data = await res.json();
      draw();
      // While a reading is being made, look again shortly.
      if (data.recording) setTimeout(refresh, 3000);
    } catch (e) {
      $('summary').replaceChildren(el('p', { class: 'bad', role: 'alert', text: `Can't reach the app: ${e.message}` }));
    }
  }

  $('recordNow').addEventListener('click', async () => {
    const b = $('recordNow');
    b.disabled = true;
    if ($('lastRecorded')) $('lastRecorded').textContent = 'Reading...';
    try {
      const res = await fetch('/api/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.status === 401) { window.location.href = '/login'; return; }
    } finally { b.disabled = false; await refresh(); }
  });
  document.querySelectorAll('#range button').forEach((b) => b.addEventListener('click', () => {
    range = Number(b.dataset.days);
    save('dsot-range', range);
    if (data) draw();
  }));

  const theme = $('theme');
  try { theme.value = localStorage.getItem('dsot-theme') || 'auto'; } catch { theme.value = 'auto'; }
  if (!theme.value) theme.value = 'auto';
  theme.addEventListener('change', () => {
    if (theme.value === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme.value;
    try { localStorage.setItem('dsot-theme', theme.value); } catch { /* no storage */ }
  });
  $('helpBtn').addEventListener('click', () => $('help').showModal());
  $('aboutBtn').addEventListener('click', () => $('about').showModal());
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('signOut').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login'; });

  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (data) draw(); }, 150); });
  document.addEventListener('scroll', () => { $('tip').hidden = true; }, { passive: true });

  window.dsot = { el, bytes, refresh };
  refresh();
  setInterval(refresh, 5 * 60 * 1000);
})();
