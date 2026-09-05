// Interfaz del screener: recibe snapshots por SSE, filtra/ordena en el cliente
// y pinta una tabla virtualizada (solo las filas visibles llegan al DOM, así
// 600 pares actualizándose cada segundo siguen yendo fluidos).

import { TIMEFRAMES, TIMEFRAME_BY_ID, DEFAULT_TIMEFRAMES, parseTimeframes } from './timeframes.js';
import { fmtUsd, fmtPrice, fmtPct, fmtFunding, fmtDuration, parseAmount, coinColor } from './format.js';

const ROW_H = 36;
const OVERSCAN = 6;
const STORE_KEY = 'bybit-screener/v1';

const $ = (id) => document.getElementById(id);

const dom = {
  search: $('search'),
  quoteChips: $('quote-chips'),
  onlyFavs: $('only-favs'),
  minVol: $('min-vol'),
  minDelta: $('min-delta'),
  deltaDir: $('delta-dir'),
  tfOptions: $('tf-options'),
  thead: $('thead'),
  viewport: $('viewport'),
  canvas: $('canvas'),
  empty: $('empty'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  banner: $('banner'),
  updated: $('updated'),
  subtitle: $('subtitle'),
  count: $('count'),
  coverage: $('coverage'),
  throughput: $('throughput'),
};

// ---------------------------------------------------------------- estado

const saved = loadSettings();

const state = {
  tfs: parseTimeframes(saved.tfs ?? DEFAULT_TIMEFRAMES).map((tf) => tf.id),
  activeTfs: [],
  sort: saved.sort ?? { col: 'd:10m', dir: -1 },
  favs: new Set(saved.favs ?? []),
  favsFirst: saved.favsFirst ?? false,
  showTfVolume: saved.showTfVolume ?? false,
  deltaAsPct: saved.deltaAsPct ?? false,
  showOi: saved.showOi ?? false,
  showFunding: saved.showFunding ?? false,
  search: '',
  quotes: new Set(saved.quotes ?? []),
  onlyFavs: saved.onlyFavs ?? false,
  minVol: saved.minVol ?? 0,
  minDelta: saved.minDelta ?? 0,
  deltaDir: saved.deltaDir ?? 'all',

  rows: [],
  visible: [],
  quotesSeen: new Set(),
  prevPrice: new Map(),
  flash: new Map(),
  snapshotAt: 0,
  receivedAt: 0,
  connected: false,
  columns: [],
  pool: [],
};

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveSettings() {
  const data = {
    tfs: state.tfs,
    sort: state.sort,
    favs: [...state.favs],
    favsFirst: state.favsFirst,
    showTfVolume: state.showTfVolume,
    deltaAsPct: state.deltaAsPct,
    showOi: state.showOi,
    showFunding: state.showFunding,
    quotes: [...state.quotes],
    onlyFavs: state.onlyFavs,
    minVol: state.minVol,
    minDelta: state.minDelta,
    deltaDir: state.deltaDir,
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    /* modo privado: la sesión funciona igual, solo no recuerda ajustes */
  }
}

// ---------------------------------------------------------------- columnas

function buildColumns() {
  const columns = [
    { id: 'fav', label: '', kind: 'fav', width: '32px', sortable: false },
    { id: 'pair', label: 'Par', kind: 'pair', width: 'minmax(150px, 1.3fr)', sortValue: (r) => r.s, defaultDir: 1 },
    { id: 'price', label: 'Precio', kind: 'price', width: '112px', num: true, sortValue: (r) => Number(r.p) || 0 },
    { id: 'chg', label: '24h %', kind: 'chg', width: '86px', num: true, sortValue: (r) => r.c },
    { id: 'vol24', label: 'Vol 24h', kind: 'usd', width: '108px', num: true, sortValue: (r) => r.v },
  ];

  for (const id of state.activeTfs) {
    columns.push({
      id: `d:${id}`,
      label: `${id} Vol Delta`,
      kind: 'delta',
      tf: id,
      width: '130px',
      num: true,
      sortValue: (r) => deltaValue(r, id),
    });
    if (state.showTfVolume) {
      columns.push({
        id: `v:${id}`,
        label: `${id} Vol`,
        kind: 'tfvol',
        tf: id,
        width: '118px',
        num: true,
        sortValue: (r) => r.d[id]?.[1] ?? 0,
      });
    }
  }

  if (state.showOi) {
    columns.push({ id: 'oi', label: 'Open interest', kind: 'usd', width: '118px', num: true, sortValue: (r) => r.oi });
  }
  if (state.showFunding) {
    columns.push({ id: 'funding', label: 'Funding', kind: 'funding', width: '96px', num: true, sortValue: (r) => r.f });
  }
  return columns;
}

/** Valor del delta según el modo elegido: dólares o % del volumen de la ventana. */
function deltaValue(row, tf) {
  const pair = row.d[tf];
  if (!pair) return 0;
  if (!state.deltaAsPct) return pair[0];
  return pair[1] > 0 ? (pair[0] / pair[1]) * 100 : 0;
}

/** Timeframe al que se aplican los filtros de delta (el que se está ordenando). */
function filterTf() {
  if (state.sort.col.startsWith('d:')) {
    const id = state.sort.col.slice(2);
    if (state.activeTfs.includes(id)) return id;
  }
  return state.activeTfs[0] ?? state.tfs[0];
}

// ---------------------------------------------------------------- datos

function onSnapshot(snap) {
  const tfsChanged = snap.tfs.join(',') !== state.activeTfs.join(',');
  state.activeTfs = snap.tfs;
  state.snapshotAt = snap.t;
  state.receivedAt = Date.now();
  state.snapshot = snap;

  for (const row of snap.rows) {
    const price = Number(row.p);
    const prev = state.prevPrice.get(row.s);
    if (prev !== undefined && price !== prev && Number.isFinite(price)) {
      state.flash.set(row.s, { dir: price > prev ? 1 : -1, token: String(snap.t) });
    }
    state.prevPrice.set(row.s, price);
    if (row.q) state.quotesSeen.add(row.q);
  }
  state.rows = snap.rows;

  if (tfsChanged) {
    rebuildColumns();
    renderTimeframeMenu();
  }
  renderQuoteChips();
  updateFilterLabels();
  refresh();
  updateStatusBar(snap);
}

/**
 * Si la columna de orden desapareció (se quitó su timeframe o se ocultó la
 * columna), cae al primer delta disponible en lugar de ordenar por otra cosa
 * sin avisar.
 */
function resolveSortColumn() {
  const current = state.columns.find((c) => c.id === state.sort.col);
  if (current && current.sortable !== false) return current;

  const firstDelta = state.activeTfs[0];
  state.sort = { col: firstDelta ? `d:${firstDelta}` : 'vol24', dir: -1 };
  const fallback = state.columns.find((c) => c.id === state.sort.col) ?? state.columns[4];
  updateHeaderSort();
  updateFilterLabels();
  return fallback;
}

// ---------------------------------------------------------------- filtros

function matchesSearch(row, terms) {
  if (terms.length === 0) return true;
  const symbol = row.s.toLowerCase();
  const base = row.b.toLowerCase();
  return terms.some((term) => symbol.includes(term) || base.includes(term));
}

function refresh() {
  if (state.columns.length === 0) return;
  const column = resolveSortColumn();
  const terms = state.search
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  const tf = filterTf();
  const minDelta = state.minDelta;
  const minVol = state.minVol;

  const visible = [];
  for (const row of state.rows) {
    if (state.onlyFavs && !state.favs.has(row.s)) continue;
    if (state.quotes.size > 0 && !state.quotes.has(row.q)) continue;
    if (minVol > 0 && row.v < minVol) continue;
    if (!matchesSearch(row, terms)) continue;

    const delta = row.d[tf]?.[0] ?? 0;
    if (state.deltaDir === 'buy' && delta <= 0) continue;
    if (state.deltaDir === 'sell' && delta >= 0) continue;
    if (minDelta > 0 && Math.abs(delta) < minDelta) continue;
    visible.push(row);
  }

  const dir = state.sort.dir;
  const favs = state.favs;
  const favsFirst = state.favsFirst;
  visible.sort((a, b) => {
    if (favsFirst) {
      const fa = favs.has(a.s);
      const fb = favs.has(b.s);
      if (fa !== fb) return fa ? -1 : 1;
    }
    const va = column.sortValue(a);
    const vb = column.sortValue(b);
    if (typeof va === 'string' || typeof vb === 'string') {
      return String(va).localeCompare(String(vb)) * dir;
    }
    if (va === vb) return a.s.localeCompare(b.s);
    return (va < vb ? -1 : 1) * dir;
  });

  state.visible = visible;
  dom.canvas.style.height = `${visible.length * ROW_H}px`;
  dom.empty.hidden = visible.length > 0;
  paint();

  dom.count.textContent = `${visible.length} de ${state.rows.length} pares`;
}

// ---------------------------------------------------------------- pintado

function rebuildColumns() {
  state.columns = buildColumns();
  const template = state.columns.map((c) => c.width).join(' ');
  document.documentElement.style.setProperty('--cols', template);

  dom.thead.replaceChildren(
    ...state.columns.map((col) => {
      const th = document.createElement('div');
      th.className = `th${col.num ? ' num' : ''}`;
      th.dataset.col = col.id;
      th.textContent = col.label;
      if (col.sortable !== false) {
        th.title = `Ordenar por ${col.label}`;
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        th.append(arrow);
      }
      return th;
    }),
  );

  // Las filas del pool quedan obsoletas si cambian las columnas.
  state.pool = [];
  dom.canvas.replaceChildren();
  updateHeaderSort();
}

function updateHeaderSort() {
  for (const th of dom.thead.children) {
    const sorted = th.dataset.col === state.sort.col;
    th.classList.toggle('sorted', sorted);
    const arrow = th.querySelector('.arrow');
    if (arrow) arrow.textContent = sorted ? (state.sort.dir === -1 ? '↓' : '↑') : '';
  }
}

function createRow() {
  const row = document.createElement('div');
  row.className = 'row';
  for (const col of state.columns) {
    const cell = document.createElement('div');
    cell.className = `cell${col.num ? ' num' : ''}${col.kind === 'fav' ? ' cell-fav' : ''}`;
    if (col.kind === 'pair') {
      cell.classList.add('cell-pair');
      const link = document.createElement('a');
      link.className = 'pair-link';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const badge = document.createElement('span');
      badge.className = 'badge';
      const name = document.createElement('span');
      name.className = 'pair-name';
      const quote = document.createElement('span');
      quote.className = 'pair-quote';
      link.append(badge, name, quote);
      cell.append(link);
    }
    row.append(cell);
  }
  dom.canvas.append(row);
  return row;
}

function paint() {
  const scrollTop = dom.viewport.scrollTop;
  const height = dom.viewport.clientHeight || 600;
  const total = state.visible.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);

  for (let i = start; i < end; i++) {
    const index = i - start;
    let el = state.pool[index];
    if (!el) {
      el = createRow();
      state.pool[index] = el;
    }
    el.hidden = false;
    el.style.transform = `translateY(${i * ROW_H}px)`;
    paintRow(el, state.visible[i]);
  }
  for (let i = end - start; i < state.pool.length; i++) state.pool[i].hidden = true;
}

function paintRow(el, row) {
  el.dataset.symbol = row.s;
  const isFav = state.favs.has(row.s);
  el.classList.toggle('fav', isFav);

  const cells = el.children;
  for (let i = 0; i < state.columns.length; i++) {
    paintCell(cells[i], state.columns[i], row, isFav);
  }
}

function setCell(cell, text, cls = '') {
  if (cell.textContent !== text) cell.textContent = text;
  // `cls` se compone por trozos y puede traer huecos ("" + " partial"):
  // classList.add('') lanza y abortaría el pintado de toda la tabla.
  const names = cls.split(/\s+/).filter(Boolean);
  const normalized = names.join(' ');
  if (cell.dataset.cls === normalized) return;
  cell.classList.remove('up', 'down', 'muted', 'partial');
  for (const name of names) cell.classList.add(name);
  cell.dataset.cls = normalized;
}

function paintCell(cell, col, row, isFav) {
  switch (col.kind) {
    case 'fav': {
      const text = isFav ? '★' : '☆';
      if (cell.textContent !== text) cell.textContent = text;
      cell.classList.toggle('on', isFav);
      break;
    }
    case 'pair': {
      const link = cell.firstChild;
      const [badge, name, quote] = link.children;
      if (link.dataset.symbol !== row.s) {
        link.dataset.symbol = row.s;
        name.textContent = row.b;
        badge.textContent = row.b.slice(0, 2);
        badge.style.background = coinColor(row.b);
        quote.textContent = row.q === 'USDT' ? '' : row.q;
        link.href = bybitUrl(row);
        link.title = `Abrir ${row.s} en Bybit`;
      }
      break;
    }
    case 'price': {
      setCell(cell, fmtPrice(row.p), '');
      applyFlash(cell, row.s);
      break;
    }
    case 'chg': {
      setCell(cell, fmtPct(row.c), row.c > 0 ? 'up' : row.c < 0 ? 'down' : 'muted');
      break;
    }
    case 'usd': {
      const value = col.id === 'oi' ? row.oi : row.v;
      setCell(cell, fmtUsd(value), value > 0 ? '' : 'muted');
      break;
    }
    case 'delta': {
      const pair = row.d[col.tf];
      const raw = pair ? pair[0] : 0;
      const shown = state.deltaAsPct
        ? pair && pair[1] > 0
          ? `${((raw / pair[1]) * 100).toFixed(1)}%`
          : '—'
        : fmtUsd(raw);
      const partial = isPartial(col.tf, row) ? ' partial' : '';
      setCell(cell, shown, `${raw > 0 ? 'up' : raw < 0 ? 'down' : 'muted'}${partial}`);
      cell.title = partial
        ? `Solo ${fmtDuration(row.cov)} de historial: la ventana de ${col.tf} aún no está completa`
        : '';
      break;
    }
    case 'tfvol': {
      const total = row.d[col.tf]?.[1] ?? 0;
      setCell(cell, fmtUsd(total), `${total > 0 ? '' : 'muted'}${isPartial(col.tf, row) ? ' partial' : ''}`);
      break;
    }
    case 'funding': {
      setCell(cell, fmtFunding(row.f), row.f > 0 ? 'up' : row.f < 0 ? 'down' : 'muted');
      break;
    }
    default:
      break;
  }
}

function isPartial(tfId, row) {
  const tf = TIMEFRAME_BY_ID.get(tfId);
  return tf ? row.cov < tf.ms - 1000 : false;
}

function applyFlash(cell, symbol) {
  const flash = state.flash.get(symbol);
  const token = flash && flash.token === String(state.snapshotAt) ? flash.token + flash.dir : '';
  if (cell.dataset.flash === token) return;
  cell.classList.remove('flash-up', 'flash-down');
  if (token) {
    void cell.offsetWidth; // reinicia la animación en una fila reutilizada
    cell.classList.add(flash.dir > 0 ? 'flash-up' : 'flash-down');
  }
  cell.dataset.flash = token;
}

function bybitUrl(row) {
  return row.q === 'USDT' || row.q === 'USDC'
    ? `https://www.bybit.com/trade/usdt/${row.s}`
    : `https://www.bybit.com/trade/inverse/${row.s}`;
}

// ---------------------------------------------------------------- controles

function renderTimeframeMenu() {
  if (dom.tfOptions.childElementCount > 0) {
    for (const input of dom.tfOptions.querySelectorAll('input')) {
      input.checked = state.tfs.includes(input.value);
    }
    return;
  }
  dom.tfOptions.replaceChildren(
    ...TIMEFRAMES.map((tf) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = tf.id;
      input.checked = state.tfs.includes(tf.id);
      input.addEventListener('change', () => {
        const next = new Set(state.tfs);
        if (input.checked) next.add(tf.id);
        else next.delete(tf.id);
        state.tfs = parseTimeframes([...next]).map((t) => t.id);
        // Reflejar el mínimo permitido: siempre queda al menos un timeframe.
        input.checked = state.tfs.includes(tf.id);
        saveSettings();
        connect();
      });
      label.append(input, document.createTextNode(` ${tf.label}`));
      return label;
    }),
  );
}

function renderQuoteChips() {
  const quotes = [...state.quotesSeen].sort();
  if (quotes.length < 2) {
    dom.quoteChips.replaceChildren();
    return;
  }
  const signature = quotes.join(',');
  if (dom.quoteChips.dataset.signature === signature) {
    for (const chip of dom.quoteChips.children) {
      chip.classList.toggle('on', state.quotes.has(chip.dataset.quote));
    }
    return;
  }
  dom.quoteChips.dataset.signature = signature;
  dom.quoteChips.replaceChildren(
    ...quotes.map((quote) => {
      const chip = document.createElement('button');
      chip.className = `chip${state.quotes.has(quote) ? ' on' : ''}`;
      chip.dataset.quote = quote;
      chip.textContent = quote;
      chip.addEventListener('click', () => {
        if (state.quotes.has(quote)) state.quotes.delete(quote);
        else state.quotes.add(quote);
        chip.classList.toggle('on', state.quotes.has(quote));
        saveSettings();
        refresh();
      });
      return chip;
    }),
  );
}

function updateFilterLabels() {
  const tf = filterTf();
  const label = dom.minDelta.parentElement.firstChild;
  if (label) label.textContent = `|Δ ${tf}| ≥ `;
  dom.deltaDir.parentElement.firstChild.textContent = `Δ ${tf} `;
}

function updateStatusBar(snap) {
  const live = snap.live !== false;
  dom.statusDot.classList.toggle('live', live);
  dom.statusDot.classList.toggle('down', !live);
  dom.statusText.textContent = live ? 'en vivo' : 'datos no actualizados';
  dom.coverage.textContent = `historial acumulado: ${fmtDuration(snap.cov)}`;
  updateBanner();
}

/**
 * Aviso explícito cuando lo que se ve en pantalla ya no viene de Bybit ahora
 * mismo: sin conexión al servidor, stream caído, precios estancados o todavía
 * sin trades. Nunca se muestran cifras antiguas como si fueran actuales.
 */
function updateBanner() {
  const snap = state.snapshot;
  const ageMs = state.receivedAt ? Date.now() - state.receivedAt : Infinity;
  let message = '';
  let level = 'error';

  if (!state.connected) {
    message = 'Sin conexión con el servidor del screener. Reintentando…';
  } else if (ageMs > 10_000) {
    message = `Sin datos nuevos desde hace ${Math.round(ageMs / 1000)} s. Los valores de la tabla no son actuales.`;
  } else if (snap && snap.streamsUp === false) {
    message = 'El stream de trades de Bybit está caído: el volume delta no se está actualizando. Reconectando…';
  } else if (snap && snap.tickersFresh === false) {
    const age = snap.tickerAgeMs ? `${Math.round(snap.tickerAgeMs / 1000)} s` : 'demasiado tiempo';
    message = `Los precios y el volumen de 24 h llevan ${age} sin actualizarse (REST de Bybit).`;
  } else if (snap && snap.trades === 0) {
    message = 'Conectado a Bybit, esperando los primeros trades para calcular el delta…';
    level = 'warn';
  }

  dom.banner.hidden = message === '';
  dom.banner.textContent = message;
  dom.banner.classList.toggle('warn', level === 'warn');
}

/** Reloj local: deja claro en todo momento cuándo llegó el último dato. */
function tickFreshness() {
  if (state.receivedAt === 0) {
    dom.updated.textContent = 'esperando datos…';
    dom.updated.classList.add('stale');
  } else {
    const seconds = Math.round((Date.now() - state.receivedAt) / 1000);
    dom.updated.textContent = seconds <= 1 ? 'actualizado ahora mismo' : `actualizado hace ${seconds} s`;
    dom.updated.classList.toggle('stale', seconds > 10);
  }
  updateBanner();
}

function bindNumberInput(input, key) {
  const apply = () => {
    const value = parseAmount(input.value);
    const invalid = Number.isNaN(value);
    input.classList.toggle('invalid', invalid);
    if (invalid) return;
    state[key] = Math.max(0, value);
    saveSettings();
    refresh();
  };
  input.addEventListener('input', apply);
}

function bindCheckbox(id, key, onChange) {
  const input = $(id);
  input.checked = state[key];
  input.addEventListener('change', () => {
    state[key] = input.checked;
    saveSettings();
    onChange();
  });
}

function wireControls() {
  dom.search.addEventListener('input', () => {
    state.search = dom.search.value;
    refresh();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== dom.search) {
      event.preventDefault();
      dom.search.focus();
      dom.search.select();
    }
    if (event.key === 'Escape' && document.activeElement === dom.search) {
      dom.search.value = '';
      state.search = '';
      refresh();
    }
  });

  dom.onlyFavs.classList.toggle('on', state.onlyFavs);
  dom.onlyFavs.addEventListener('click', () => {
    state.onlyFavs = !state.onlyFavs;
    dom.onlyFavs.classList.toggle('on', state.onlyFavs);
    saveSettings();
    refresh();
  });

  dom.minVol.value = state.minVol ? String(state.minVol) : '';
  dom.minDelta.value = state.minDelta ? String(state.minDelta) : '';
  bindNumberInput(dom.minVol, 'minVol');
  bindNumberInput(dom.minDelta, 'minDelta');

  dom.deltaDir.value = state.deltaDir;
  dom.deltaDir.addEventListener('change', () => {
    state.deltaDir = dom.deltaDir.value;
    saveSettings();
    refresh();
  });

  bindCheckbox('opt-tf-volume', 'showTfVolume', () => {
    rebuildColumns();
    refresh();
  });
  bindCheckbox('opt-delta-pct', 'deltaAsPct', () => refresh());
  bindCheckbox('opt-oi', 'showOi', () => {
    rebuildColumns();
    refresh();
  });
  bindCheckbox('opt-funding', 'showFunding', () => {
    rebuildColumns();
    refresh();
  });
  bindCheckbox('opt-favs-first', 'favsFirst', () => refresh());

  dom.thead.addEventListener('click', (event) => {
    const th = event.target.closest('.th');
    if (!th) return;
    const column = state.columns.find((c) => c.id === th.dataset.col);
    if (!column || column.sortable === false) return;
    if (state.sort.col === column.id) state.sort.dir = -state.sort.dir;
    else state.sort = { col: column.id, dir: column.defaultDir ?? -1 };
    updateHeaderSort();
    updateFilterLabels();
    saveSettings();
    refresh();
  });

  dom.canvas.addEventListener('click', (event) => {
    const cell = event.target.closest('.cell-fav');
    if (!cell) return;
    const symbol = cell.parentElement.dataset.symbol;
    if (!symbol) return;
    if (state.favs.has(symbol)) state.favs.delete(symbol);
    else state.favs.add(symbol);
    saveSettings();
    refresh();
  });

  let scrollPending = false;
  dom.viewport.addEventListener(
    'scroll',
    () => {
      if (scrollPending) return;
      scrollPending = true;
      requestAnimationFrame(() => {
        scrollPending = false;
        paint();
      });
    },
    { passive: true },
  );

  window.addEventListener('resize', () => paint());

  // Cierra los menús desplegables al pinchar fuera.
  document.addEventListener('click', (event) => {
    for (const menu of document.querySelectorAll('details.menu[open]')) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });
}

// ---------------------------------------------------------------- conexión

let source = null;

function connect() {
  source?.close();
  source = new EventSource(`/api/stream?tfs=${encodeURIComponent(state.tfs.join(','))}`);
  source.addEventListener('open', () => {
    state.connected = true;
    updateBanner();
  });
  source.addEventListener('message', (event) => {
    state.connected = true;
    try {
      onSnapshot(JSON.parse(event.data));
    } catch (err) {
      console.error('snapshot ilegible', err);
    }
  });
  source.addEventListener('error', () => {
    state.connected = false;
    dom.statusDot.classList.remove('live');
    dom.statusDot.classList.add('down');
    dom.statusText.textContent = 'sin conexión con el servidor';
    updateBanner();
  });
}

async function pollHealth(previous = null) {
  try {
    const health = await (await fetch('/api/health')).json();
    if (previous) {
      const seconds = Math.max(1, (health.uptimeMs - previous.uptimeMs) / 1000);
      const perSecond = Math.max(0, Math.round((health.trades - previous.trades) / seconds));
      dom.throughput.textContent = `${perSecond.toLocaleString('es-ES')} trades/s · ${health.instruments} perpetuos`;
    }
    const conexiones = health.streams.reduce((total, s) => total + s.connections.length, 0);
    const plural = conexiones === 1 ? 'conexión' : 'conexiones';
    dom.subtitle.textContent = `Bybit v5 · ${health.instruments} perpetuos · ${conexiones} ${plural} WebSocket`;
    setTimeout(() => pollHealth(health), 5000);
  } catch {
    setTimeout(() => pollHealth(previous), 5000);
  }
}

function init() {
  state.activeTfs = [...state.tfs];
  rebuildColumns();
  renderTimeframeMenu();
  updateFilterLabels();
  wireControls();
  connect();
  pollHealth();
  tickFreshness();
  setInterval(tickFreshness, 1000);
}

init();
