'use strict';

// Dashboard DSS — konsumuje strumien SSE z serwera i renderuje karty zbiornikow.

const charts = new Map();
let scenariosRendered = false;
let feedsList = [];          // dostepne pasze (do listy wyboru)
let userControlling = false; // czy uzytkownik aktywnie steruje suwakami
let simRunning = true;       // czy symulacja jest uruchomiona

function fmt(n, dp = 1) {
  return n == null ? '—' : Number(n).toFixed(dp);
}

// Formatuje godzine symulacji (np. 9.7) jako HH:MM (09:42).
function hourLabel(h) {
  if (h == null) return '';
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h % 1) * 60);
  return String(hh).padStart(2, '0') + ':' + String(mm % 60).padStart(2, '0');
}

function stressColor(idx) {
  if (idx <= 10) return '#2ecc71';
  if (idx <= 50) return '#e67e22';
  if (idx < 100) return '#f1c40f';
  return '#e74c3c';
}

function renderScenarios(scn) {
  const box = document.getElementById('scenarioButtons');
  if (!scenariosRendered) {
    box.innerHTML = '';
    scn.dostepne.forEach((s) => {
      const b = document.createElement('button');
      b.textContent = s.label;
      b.dataset.id = s.id;
      b.onclick = () => {
        userControlling = false; // zmiana scenariusza przejmuje suwaki
        fetch('/api/scenario', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario: s.id }),
        });
      };
      box.appendChild(b);
    });
    scenariosRendered = true;
  }
  [...box.children].forEach((b) => b.classList.toggle('active', b.dataset.id === scn.aktualny));
}

// Lista opcji paszy: polecane dla danego etapu (K1/K2/K3) na gorze, oznaczone gwiazdka.
function feedOptions(t) {
  const sorted = [...feedsList].sort((a, b) => (a.etap === t.etap ? 0 : 1) - (b.etap === t.etap ? 0 : 1));
  return sorted
    .map((f) => {
      const rec = f.etap === t.etap;
      const sel = f.id === t.paszaId ? ' selected' : '';
      return `<option value="${f.id}"${sel}>${rec ? '⭐ ' : ''}${f.etykieta}${rec ? ' (polecana)' : ''}</option>`;
    })
    .join('');
}

function tankCard(t) {
  const d = t.decision || {};
  const r = t.reading || {};
  const e = t.economics || {};
  const blocked = d.blocked;
  return `
  <div class="card" id="card-${t.id}">
    <div class="card-head">
      <div>
        <h2>${t.nazwa}</h2>
        <div class="meta">${t.id} · ${fmt(t.powierzchniaHa)} ha</div>
      </div>
      <span class="stage-badge">${d.stage ? d.stage.etap : t.etap} · ${d.stage ? d.stage.nazwa : ''}</span>
    </div>

    <div class="stock-wrap">
      <label class="stock-label">Obsada</label>
      <div class="stock-fields">
        <span class="field"><input type="number" class="stock-mass" data-tank="${t.id}" value="${t.masaJednostkowaG}" min="1" step="1" /> g/szt.</span>
        <span class="field"><input type="number" class="stock-count" data-tank="${t.id}" value="${t.liczbaRyb}" min="1" step="1" /> szt.</span>
        <button class="stock-apply" data-tank="${t.id}">Zastosuj</button>
      </div>
    </div>

    <div class="feed-select-wrap">
      <label class="feed-label">🥣 Pasza</label>
      <select class="feed-select" data-tank="${t.id}">${feedOptions(t)}</select>
    </div>

    <div class="metrics">
      <div class="metric temp">
        <div class="k">Temperatura wody</div>
        <div class="v">${fmt(r.temperature)}<small> °C</small></div>
        <div class="sub">optimum 23–29 °C</div>
      </div>
      <div class="metric oxy">
        <div class="k">Tlen rozpuszczony</div>
        <div class="v">${fmt(r.oxygen)}<small> mg/l</small></div>
        <div class="sub">wymagany ≥ ${fmt(d.requiredOxygen)} mg/l</div>
      </div>
    </div>

    <div class="verdict">
      <div class="verdict-head">
        <span class="status-pill status-${d.status}">${d.status || '—'}</span>
        <span class="stress-label">indeks stresu: <b>${d.stressIndex ?? '—'}%</b></span>
      </div>

      <div class="dose ${blocked ? 'blocked' : ''}">
        <span class="big">${fmt(d.recommendedDoseKg, 1)}</span>
        <span class="unit">kg / dobę</span>
        <span class="of">z ${fmt(d.baseDoseKg, 1)} kg bazowej</span>
      </div>

      <div class="multipliers">
        <span class="chip">mnożnik T: <b>${fmt(d.tempMultiplier, 2)}</b></span>
        <span class="chip">mnożnik O₂: <b>${fmt(d.oxyMultiplier, 2)}</b></span>
        <span class="chip">wynikowy: <b>${fmt(d.finalMultiplier, 2)}</b></span>
        <span class="chip">biomasa: <b>${fmt(d.biomassKg, 0)} kg</b></span>
      </div>

      <div class="stress-bar">
        <div class="stress-fill" style="width:${d.stressIndex ?? 0}%;background:${stressColor(d.stressIndex ?? 0)}"></div>
      </div>

      <ul class="reasons">
        ${(d.reasons || []).map((x) => `<li>${x}</li>`).join('')}
      </ul>
    </div>

    <div class="econ">
      <div class="e"><div class="k">Koszt dawki</div><div class="v">${fmt(e.kosztRekomendacjiPln, 0)} zł</div></div>
      <div class="e save"><div class="k">Oszczędność vs pełna</div><div class="v">${fmt(e.oszczednoscPln, 0)} zł</div></div>
      <div class="e"><div class="k">Niewydane</div><div class="v">${fmt(e.oszczednoscKg, 1)} kg</div></div>
    </div>

    <div class="chart-wrap"><canvas id="chart-${t.id}"></canvas></div>
  </div>`;
}

function updateChart(t) {
  const ctx = document.getElementById(`chart-${t.id}`);
  if (!ctx) return;
  const labels = t.historia.map((h) => hourLabel(h.simHour));
  const temps = t.historia.map((h) => h.temperature);
  const oxys = t.historia.map((h) => h.oxygen);
  const doses = t.historia.map((h) => h.recommendedKg);

  if (charts.has(t.id)) {
    const c = charts.get(t.id);
    c.data.labels = labels;
    c.data.datasets[0].data = temps;
    c.data.datasets[1].data = oxys;
    c.data.datasets[2].data = doses;
    c.update('none');
    return;
  }

  const c = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'T (°C)', data: temps, borderColor: '#ffb454', backgroundColor: 'rgba(255,180,84,0.1)', tension: 0.35, pointRadius: 0, yAxisID: 'yT', fill: true },
        { label: 'O₂ (mg/l)', data: oxys, borderColor: '#3a9bd9', backgroundColor: 'rgba(58,155,217,0.1)', tension: 0.35, pointRadius: 0, yAxisID: 'yO', fill: true },
        { label: 'Dawka (kg/dobę)', data: doses, borderColor: '#34c6a8', backgroundColor: 'rgba(52,198,168,0.12)', borderWidth: 2, borderDash: [4, 3], tension: 0.35, pointRadius: 0, yAxisID: 'yD', fill: false },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: { legend: { labels: { color: '#8aa6b8', boxWidth: 12, font: { size: 10 } } } },
      scales: {
        x: { ticks: { color: '#5d788a', maxTicksLimit: 6, font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        yT: { position: 'left', ticks: { color: '#ffb454', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        yO: { position: 'right', ticks: { color: '#3a9bd9', font: { size: 9 } }, grid: { drawOnChartArea: false } },
        yD: { position: 'right', display: false, beginAtZero: true, grid: { drawOnChartArea: false } },
      },
    },
  });
  charts.set(t.id, c);
}

function render(snapshot) {
  document.getElementById('simClock').textContent = hourLabel(snapshot.scenariusz.godzinaSym);
  feedsList = snapshot.paszeDostepne || feedsList;

  simRunning = snapshot.symulacjaDziala;
  const btn = document.getElementById('toggleSim');
  btn.textContent = simRunning ? '⏸ Stop' : '▶ Wznów';
  btn.classList.toggle('paused', !simRunning);
  document.body.classList.toggle('sim-paused', !simRunning);

  renderScenarios(snapshot.scenariusz);
  syncManualSliders(snapshot);

  const grid = document.getElementById('tanks');
  const needBuild = grid.children.length !== snapshot.zbiorniki.length;
  if (needBuild) {
    grid.innerHTML = snapshot.zbiorniki.map(tankCard).join('');
    snapshot.zbiorniki.forEach(updateChart);
    attachFeedHandlers();
    attachStockHandlers();
  } else {
    snapshot.zbiorniki.forEach((t) => {
      const card = document.getElementById(`card-${t.id}`);
      if (card) {
        const fresh = document.createElement('div');
        fresh.innerHTML = tankCard(t);
        // zachowujemy elementy, z ktorymi uzytkownik moze wchodzic w interakcje
        // (wykres, lista paszy, pola obsady) — reszte podmieniamy swiezym renderem
        const newCard = fresh.firstElementChild;
        newCard.querySelector('.chart-wrap').replaceWith(card.querySelector('.chart-wrap'));
        newCard.querySelector('.feed-select-wrap').replaceWith(card.querySelector('.feed-select-wrap'));
        newCard.querySelector('.stock-wrap').replaceWith(card.querySelector('.stock-wrap'));
        card.replaceWith(newCard);
      }
      updateChart(t);
    });
  }
}

// Synchronizuje suwaki ze scenariuszem: gdy uzytkownik nie steruje recznie,
// suwaki podazaja za biezacymi warunkami srodowiskowymi (zmiana scenariusza je przesuwa).
function syncManualSliders(snapshot) {
  if (userControlling || !snapshot.ambient) return;
  const { temperature, oxygen } = snapshot.ambient;
  tempSlider.value = temperature;
  oxySlider.value = oxygen;
  tempOut.textContent = `${fmt(temperature)} °C`;
  oxyOut.textContent = `${fmt(oxygen)} mg/l`;
}

// Podpina obsluge zmiany paszy (raz; selecty sa zachowywane miedzy odswiezeniami).
function attachFeedHandlers() {
  document.querySelectorAll('.feed-select').forEach((sel) => {
    sel.onchange = () =>
      fetch(`/api/tanks/${sel.dataset.tank}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedId: sel.value }),
      });
  });
}

// Podpina obsluge edycji obsady (masa jednostkowa + liczba ryb).
function attachStockHandlers() {
  document.querySelectorAll('.stock-apply').forEach((btn) => {
    const id = btn.dataset.tank;
    const apply = () => {
      const mass = document.querySelector(`.stock-mass[data-tank="${id}"]`).value;
      const count = document.querySelector(`.stock-count[data-tank="${id}"]`).value;
      fetch(`/api/tanks/${id}/stock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ masaJednostkowaG: Number(mass), liczbaRyb: Number(count) }),
      });
    };
    btn.onclick = apply;
    // Enter w polu rowniez zatwierdza
    document.querySelectorAll(`.stock-mass[data-tank="${id}"], .stock-count[data-tank="${id}"]`).forEach((inp) => {
      inp.onkeydown = (e) => { if (e.key === 'Enter') apply(); };
    });
  });
}

// --- sterowanie reczne ---
const tempSlider = document.getElementById('tempSlider');
const oxySlider = document.getElementById('oxySlider');
const tempOut = document.getElementById('tempOut');
const oxyOut = document.getElementById('oxyOut');

function pushManual() {
  fetch('/api/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ temperature: Number(tempSlider.value), oxygen: Number(oxySlider.value) }),
  });
}
tempSlider.oninput = () => { userControlling = true; tempOut.textContent = `${fmt(tempSlider.value)} °C`; pushManual(); };
oxySlider.oninput = () => { userControlling = true; oxyOut.textContent = `${fmt(oxySlider.value)} mg/l`; pushManual(); };
document.getElementById('resetManual').onclick = () => {
  userControlling = false; // suwaki znow podazaja za scenariuszem
  fetch('/api/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) });
};

// --- stop / wznow symulacji ---
document.getElementById('toggleSim').onclick = () => {
  fetch('/api/sim/running', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ running: !simRunning }), // przelacz stan
  });
};

// --- ustawienie czasu symulacji ---
document.getElementById('setTime').onclick = () => {
  const v = document.getElementById('timeInput').value; // "HH:MM"
  if (!v) return;
  fetch('/api/time', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hour: v }),
  });
};

// --- strumien na zywo ---
function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (ev) => {
    document.body.classList.remove('disconnected');
    render(JSON.parse(ev.data));
  };
  es.onerror = () => {
    document.body.classList.add('disconnected');
    es.close();
    setTimeout(connect, 2000);
  };
}
connect();
