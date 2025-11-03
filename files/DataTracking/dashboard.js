(function(){
  'use strict';

  const STATUS = document.getElementById('charts-status');

  function logStatus(msg, isError){
    if (!STATUS) return;
    // Harmoniseer met RideTracker status styling: gebruik classes
    try {
      STATUS.textContent = msg || '';
      STATUS.classList.remove('status--error');
      if (!msg) {
        STATUS.classList.add('hidden');
      } else {
        STATUS.classList.remove('hidden');
      }
      if (isError) {
        STATUS.classList.add('status--error');
      }
    } catch (_) {
      // Fallback: inline color
      STATUS.textContent = msg || '';
      STATUS.style.color = isError ? '#ef4444' : '#94a3b8';
    }
  }

  function initFirebase(){
    try {
      if (!window.firebase || !window.firebase.initializeApp) {
        logStatus('Firebase SDK niet geladen.', true);
        return null;
      }
      if (!window.FIREBASE_CONFIG || !window.FIREBASE_CONFIG.apiKey) {
        logStatus('Firebase-config ontbreekt.', true);
        return null;
      }
      if (!initFirebase._app){
        initFirebase._app = window.firebase.initializeApp(window.FIREBASE_CONFIG);
        initFirebase._db = window.firebase.firestore();
      }
      return initFirebase._db;
    } catch(e){
      console.error(e);
      logStatus('Kon Firebase niet initialiseren.', true);
      return null;
    }
  }

  function ensureAuth(){
    try{
      if (!window.firebase || !window.firebase.auth) return Promise.resolve();
      const auth = window.firebase.auth();
      if (auth.currentUser) return Promise.resolve();
      return auth.signInAnonymously().catch(()=>{});
    } catch(_){ return Promise.resolve(); }
  }

  function startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
  function startOfMonth(d){ const x=new Date(d); x.setDate(1); x.setHours(0,0,0,0); return x; }
  function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
  function addHours(d,n){ const x=new Date(d); x.setHours(x.getHours()+n); return x; }
  function addMonths(d,n){ const x=new Date(d); x.setMonth(x.getMonth()+n); return x; }

  function fmtHour(d){ return d.toLocaleTimeString('nl-BE',{hour:'2-digit'}); }
  function fmtDay(d){ return d.toLocaleDateString('nl-BE',{weekday:'short', day:'2-digit'}); }
  function fmtDayShort(d){ return d.toLocaleDateString('nl-BE',{day:'2-digit', month:'2-digit'}); }
  function fmtMonth(d){ return d.toLocaleDateString('nl-BE',{month:'short', year:'2-digit'}); }
  function fmtMonthLong(y,m){ return new Date(y,m,1).toLocaleDateString('nl-BE',{month:'long', year:'numeric'}); }
  function getDaysInMonth(y,m){ return new Date(y, m+1, 0).getDate(); }

  function km(num){ return Number.isFinite(num) ? Number(num) : 0; }

  // Filter helper: verwijder alle buckets zonder data (>0)
  function filterNonZeroBuckets(labels, data){
    const outL = []; const outD = [];
    for (let i=0;i<labels.length;i++){
      const v = Number(data[i]);
      if (Number.isFinite(v) && v > 0){ outL.push(labels[i]); outD.push(v); }
    }
    return { labels: outL, data: outD };
  }

  function bucketizeDay(rides){
    const now = new Date();
    const from = new Date(now.getTime() - 24*60*60*1000);
    const labels = []; const data = [];
    for(let i=0;i<24;i++){
      const t = addHours(from, i);
      labels.push(fmtHour(t)); data.push(0);
    }
    rides.forEach(r => {
      const st = r.startTime || r.rideDate; if (!st) return;
      if (st < from || st > now) return;
      const idx = Math.floor((st - from) / (60*60*1000));
      if (idx>=0 && idx<24){ data[idx] += km(r.distance); }
    });
    return { labels, data };
  }

  function bucketizeWeek(rides){
    const today = startOfDay(new Date());
    const from = addDays(today, -6);
    const labels = []; const data = [];
    for(let i=0;i<7;i++){
      const d = addDays(from, i);
      labels.push(fmtDay(d)); data.push(0);
    }
    rides.forEach(r => {
      const d = r.rideDate || r.startTime; if (!d) return;
      const dd = startOfDay(d);
      if (dd < from || dd > today) return;
      const idx = Math.floor((dd - from)/(24*60*60*1000));
      if (idx>=0 && idx<7){ data[idx] += km(r.distance); }
    });
    return { labels, data };
  }

  // Dynamische bucketizers voor specifieke maand/jaar
  function bucketizeMonthFor(rides, year, month){
    const days = getDaysInMonth(year, month);
    const labels = []; const data = new Array(days).fill(0);
    for(let d=1; d<=days; d++){
      labels.push(d.toString().padStart(2,'0'));
    }
    rides.forEach(r => {
      const dt = r.rideDate || r.startTime; if (!dt) return;
      if (dt.getFullYear() !== year || dt.getMonth() !== month) return;
      const day = dt.getDate();
      const idx = day-1; if (idx>=0 && idx<days) data[idx] += km(r.distance);
    });
    return { labels, data };
  }

  function bucketizeYearFor(rides, year){
    const labels = []; const data = new Array(12).fill(0);
    for(let m=0; m<12; m++) labels.push(fmtMonth(new Date(year, m, 1)));
    rides.forEach(r => {
      const dt = r.rideDate || r.startTime; if (!dt) return;
      if (dt.getFullYear() !== year) return;
      const m = dt.getMonth(); data[m] += km(r.distance);
    });
    return { labels, data };
  }

  // Alle maanden over de volledige beschikbare periode
  function bucketizeAllMonths(rides){
    const dts = rides.map(r=> r.rideDate || r.startTime).filter(Boolean);
    if (dts.length === 0) return { labels: [], data: [] };
    let min = new Date(Math.min(...dts.map(d=>d.getTime())));
    let max = new Date(Math.max(...dts.map(d=>d.getTime())));
    min = startOfMonth(min);
    max = startOfMonth(max);
    const totals = new Map(); // key: y-m (0-based month), val: total km
    rides.forEach(r => {
      const dt = r.rideDate || r.startTime; if (!dt) return;
      const key = `${dt.getFullYear()}-${dt.getMonth()}`;
      totals.set(key, (totals.get(key) || 0) + km(r.distance));
    });
    const labels = []; const data = [];
    let cur = new Date(min);
    while (cur <= max){
      const key = `${cur.getFullYear()}-${cur.getMonth()}`;
      labels.push(fmtMonth(new Date(cur.getFullYear(), cur.getMonth(), 1)));
      data.push(totals.get(key) || 0);
      cur = addMonths(cur, 1);
    }
    return { labels, data };
  }

  // Alle jaren met data, per jaar totaal
  function bucketizeAllYears(rides){
    const yearMap = new Map();
    rides.forEach(r => {
      const dt = r.rideDate || r.startTime; if (!dt) return;
      const y = dt.getFullYear();
      yearMap.set(y, (yearMap.get(y) || 0) + km(r.distance));
    });
    const years = Array.from(yearMap.keys()).sort((a,b)=> a-b);
    const labels = years.map(y=> String(y));
    const data = years.map(y=> yearMap.get(y) || 0);
    return { labels, data };
  }

  function toRideModel(doc){
    const d = doc.data();
    const distance = d && d.stats && Number.isFinite(d.stats.totalDistanceKm) ? Number(d.stats.totalDistanceKm) : 0;
    const rideDate = d && d.rideDate && typeof d.rideDate.toDate === 'function' ? d.rideDate.toDate() : d.rideDate || null;
    let startTime = d && d.startTime ? d.startTime : null;
    if (startTime && typeof startTime.toDate === 'function') startTime = startTime.toDate();
    return { distance, rideDate, startTime };
  }

  function createChart(ctx, labels, data, color, chartType){
    // Maakt en retourneert een Chart.js chart (line of bar) met nette defaults
    const isLine = (chartType === 'line');
    return new Chart(ctx, {
      type: isLine ? 'line' : 'bar',
      data: {
        labels,
        datasets: [{
          label: 'km',
          data,
          tension: isLine ? 0.3 : 0,
          borderColor: color,
          backgroundColor: isLine ? (color + '33') : (color + '88'),
          fill: isLine,
          pointRadius: isLine ? 2 : 0,
          pointHoverRadius: isLine ? 4 : 0,
          borderWidth: isLine ? 2 : 0,
          barPercentage: isLine ? undefined : 0.9,
          categoryPercentage: isLine ? undefined : 0.8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 450, easing: 'easeInOutCubic' },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              // Toon km met 2 decimalen
              label: (ctx)=> `${(ctx.parsed.y ?? 0).toFixed(2)} km`
            }
          }
        },
        scales: {
          x: { ticks: { color: '#cbd5e1' }, grid: { color: 'rgba(148,163,184,0.15)' } },
          y: { ticks: { color: '#cbd5e1' }, grid: { color: 'rgba(148,163,184,0.15)' }, beginAtZero: true }
        }
      }
    });
  }

  async function loadAndRender(){
    const db = initFirebase();
    if (!db){ return; }
    await ensureAuth();

    logStatus('Gegevens laden...');

    const now = new Date();
    const threeYearsAgo = new Date(now.getTime() - 3*365*24*60*60*1000);
    try {
      // Laad ritten (laatste 3 jaar)
      const snap = await db.collection('rides').where('rideDate', '>=', threeYearsAgo).get();
      const rides = snap.docs.map(toRideModel);

      // Beschikbare maanden en jaren bepalen
      const monthSet = new Set();
      const yearSet = new Set();
      rides.forEach(r => {
        const dt = r.rideDate || r.startTime; if (!dt) return;
        const y = dt.getFullYear(); const m = dt.getMonth();
        yearSet.add(String(y));
        monthSet.add(`${y}-${String(m+1).padStart(2,'0')}`);
      });
      const availableYears = Array.from(yearSet).map(y=>Number(y)).sort((a,b)=>b-a);
      const availableMonths = Array.from(monthSet)
        .map(k=>{ const [y,mm]=k.split('-'); return { key:k, y:Number(y), m:Number(mm)-1, label: fmtMonthLong(Number(y), Number(mm)-1) }; })
        .sort((a,b)=> (b.y - a.y) || (b.m - a.m));

      // Vaste datasets voor dag en week
      const datasets = {
        day: { ...bucketizeDay(rides), color: '#60a5fa', title: 'Dag' },
        week: { ...bucketizeWeek(rides), color: '#34d399', title: 'Week' }
      };

      // Gebruikersvoorkeur lezen
      let pref = 'week';
      let prefPeriod = null; // 'YYYY-MM' of 'YYYY'
      try {
        const auth = window.firebase && window.firebase.auth && window.firebase.auth();
        const uid = auth && auth.currentUser ? auth.currentUser.uid : null;
        if (uid) {
          const prefDoc = await db.collection('users').doc(uid).get();
          const data = prefDoc.exists ? prefDoc.data() : null;
          if (data && typeof data.preferredChart === 'string') {
            pref = data.preferredChart;
          }
          if (data && typeof data.preferredPeriod === 'string') {
            prefPeriod = data.preferredPeriod;
          }
        }
      } catch(_){}

      // UI setup
      const canvas = document.getElementById('main-chart');
      if (!canvas) { logStatus('Canvas voor grafiek ontbreekt.', true); return; }
      let chart = null;
      // Lees grafiektype-voorkeur (line/bar)
      let graphType = 'line';
      try {
        const auth = window.firebase && window.firebase.auth && window.firebase.auth();
        const uid = auth && auth.currentUser ? auth.currentUser.uid : null;
        if (uid) {
          const prefDoc = await db.collection('users').doc(uid).get();
          const pdata = prefDoc.exists ? prefDoc.data() : null;
          if (pdata && (pdata.preferredGraph === 'line' || pdata.preferredGraph === 'bar')) graphType = pdata.preferredGraph;
        } else {
          const ls = localStorage.getItem('preferredGraph');
          if (ls === 'line' || ls === 'bar') graphType = ls;
        }
      } catch(_){
        const ls = localStorage.getItem('preferredGraph');
        if (ls === 'line' || ls === 'bar') graphType = ls;
      }

      // Uitklapbare kaart (hele card): standaard ingeklapt op mobiel tenzij voorkeur bestaat
      const kmBody = document.getElementById('km-card-body');
      const kmToggle = document.getElementById('km-toggle');
      const isMobile = window.matchMedia ? window.matchMedia('(max-width: 900px)').matches : (window.innerWidth <= 900);
      const LS_KEY = `dashboardKmCollapsed.${isMobile ? 'mobile' : 'desktop'}`;
      function readCollapsed(){
        try {
          const val = localStorage.getItem(LS_KEY);
          if (val !== null) return JSON.parse(val);
        } catch(_){ }
        // Fallback: alleen op mobiel oude keys lezen, om desktop niet te beïnvloeden
        if (isMobile){
          const fallbacks = ['dashboardKmCollapsed','dashboardChartCollapsed'];
          for (const k of fallbacks){
            try { const v = localStorage.getItem(k); if (v !== null) return JSON.parse(v); } catch(_){ }
          }
        }
        return null;
      }
      let isCollapsed = (function(){
        const saved = readCollapsed();
        // Enkel auto-ingeklapt op mobiel; desktop standaard open
        return typeof saved === 'boolean' ? saved : (isMobile ? true : false);
      })();
      function writeCollapsed(v){ try{ localStorage.setItem(LS_KEY, JSON.stringify(v)); }catch(_){ } }

      function applyCollapseUI(){
        if (!kmBody || !kmToggle) return;
        if (isCollapsed){
          kmBody.classList.add('is-collapsed');
          kmToggle.setAttribute('aria-expanded','false');
          kmToggle.textContent = '▾';
          kmToggle.classList.add('is-collapsed');
        } else {
          kmBody.classList.remove('is-collapsed');
          kmToggle.setAttribute('aria-expanded','true');
          kmToggle.textContent = '▾';
          kmToggle.classList.remove('is-collapsed');
        }
      }
      applyCollapseUI();
      kmToggle?.addEventListener('click', ()=>{
        isCollapsed = !isCollapsed;
        writeCollapsed(isCollapsed);
        applyCollapseUI();
        if (!isCollapsed && chart){
          setTimeout(()=>{ try{ chart.resize(); chart.update(); }catch(_){} }, 50);
        }
      });

      function setActiveButton(type){
        const btns = document.querySelectorAll('.segmented button');
        btns.forEach(b => {
          const isActive = b.getAttribute('data-type') === type;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-selected', String(isActive));
        });
        const selMonth = document.getElementById('select-month');
        const selYear = document.getElementById('select-year');
        if (type === 'month' && availableMonths.length > 0) {
          selMonth?.classList.remove('hidden');
          selYear?.classList.add('hidden');
        } else if (type === 'year' && availableYears.length > 0) {
          selYear?.classList.remove('hidden');
          selMonth?.classList.add('hidden');
        } else {
          selMonth?.classList.add('hidden');
          selYear?.classList.add('hidden');
        }
      }

      function updateSummary(type, periodLabel){
        const el = document.getElementById('chart-summary');
        if (!el) return;
        const d = type==='month'||type==='year' ? updateSummary._last : datasets[type];
        const arr = d?.data || [];
        const sum = arr.reduce((a,b)=>a+(Number.isFinite(b)?b:0), 0);
        const sumStr = sum.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const title = d?.title || (type==='month'?'Maand':'Jaar');
        const suffix = periodLabel ? ` ${periodLabel}` : '';
        el.innerHTML = `<span class="muted">Totaal (${title}${suffix}):</span> ${sumStr} km`;
      }

      // Selects vullen
      const selMonth = document.getElementById('select-month');
      const selYear = document.getElementById('select-year');
      if (selMonth){
        const monthOpts = [`<option value="all">Alle maanden</option>`]
          .concat(availableMonths.map(m=>`<option value="${m.key}">${m.label}</option>`));
        selMonth.innerHTML = monthOpts.join('');
      }
      if (selYear){
        const yearOpts = [`<option value="all">Alle jaren</option>`]
          .concat(availableYears.map(y=>`<option value="${y}">${y}</option>`));
        selYear.innerHTML = yearOpts.join('');
      }

      function renderChart(type, periodKey){
        let d = null; let periodLabel = '';
        if (type === 'month') {
          const preferredKey = (pref==='month' && typeof prefPeriod === 'string') ? prefPeriod : null;
          const key = periodKey || preferredKey || (availableMonths[0]?.key) || 'all';
          if (key === 'all'){
            d = { ...bucketizeAllMonths(rides), color: '#f59e0b', title: 'Alle maanden' };
            periodLabel = `– Alle maanden`;
            if (selMonth) selMonth.value = 'all';
            updateSummary._last = d;
          } else {
            const found = availableMonths.find(x=>x.key===key);
            if (!found) { logStatus('Geen maanden met data beschikbaar.', true); return; }
            d = { ...bucketizeMonthFor(rides, found.y, found.m), color: '#f59e0b', title: 'Maand' };
            periodLabel = `– ${found.label}`;
            if (selMonth) selMonth.value = key;
            updateSummary._last = d;
          }
        } else if (type === 'year') {
          const preferredKey = (pref==='year' && typeof prefPeriod === 'string') ? prefPeriod : null;
          const key = periodKey || preferredKey || (availableYears[0] ? String(availableYears[0]) : 'all');
          if (key === 'all'){
            d = { ...bucketizeAllYears(rides), color: '#f472b6', title: 'Alle jaren' };
            periodLabel = `– Alle jaren`;
            if (selYear) selYear.value = 'all';
            updateSummary._last = d;
          } else {
            if (!key) { logStatus('Geen jaren met data beschikbaar.', true); return; }
            const y = Number(key);
            d = { ...bucketizeYearFor(rides, y), color: '#f472b6', title: 'Jaar' };
            periodLabel = `– ${y}`;
            if (selYear) selYear.value = String(y);
            updateSummary._last = d;
          }
        } else {
          d = datasets[type];
        }
        if (!d) return;
        // Alleen voor maand/jaar: periodes zonder data verwijderen.
        // Voor dag/week altijd de huidige dag/week tonen (ook als er 0 km zijn),
        // zodat de as en context behouden blijven.
        let isEmpty = false;
        if (type === 'month' || type === 'year'){
          const filtered = filterNonZeroBuckets(d.labels, d.data);
          d = { ...d, labels: filtered.labels, data: filtered.data };
          isEmpty = (d.data.length === 0);
        }
        const wrap = document.querySelector('.chart-wrap');
        if (wrap) { wrap.classList.remove('fade'); void wrap.offsetWidth; wrap.classList.add('fade'); }
        const desiredType = (graphType === 'line') ? 'line' : 'bar';
        if (!chart || (chart.config && chart.config.type !== desiredType)){
          if (chart) { try { chart.destroy(); } catch(_){} }
          chart = createChart(canvas, d.labels, d.data, d.color, graphType);
        } else {
          chart.data.labels = d.labels;
          chart.data.datasets[0].data = d.data;
          chart.data.datasets[0].borderColor = d.color;
          chart.data.datasets[0].backgroundColor = (graphType === 'line') ? (d.color + '33') : (d.color + '88');
          chart.update();
        }
        // Als net uitgeklapt of bij eerste render op mobiel, zorg voor juiste grootte
        if (chart && !isCollapsed){
          setTimeout(()=>{ try{ chart.resize(); }catch(_){} }, 0);
        }
        setActiveButton(type);
        logStatus(isEmpty ? 'Geen data voor deze selectie.' : '');
        updateSummary(type, periodLabel);
      }

      async function savePreference(type, period, graph){
        try {
          const auth = window.firebase && window.firebase.auth && window.firebase.auth();
          const uid = auth && auth.currentUser ? auth.currentUser.uid : null;
          if (!uid) return;
          const payload = { preferredChart: type };
          if (period) payload.preferredPeriod = period;
          if (graph) payload.preferredGraph = graph;
          await db.collection('users').doc(uid).set(payload, { merge: true });
        } catch(_){ }
        try { if (graph) localStorage.setItem('preferredGraph', graph); } catch(_){ }
      }

      // Events
      document.getElementById('tab-day')?.addEventListener('click', () => { renderChart('day'); savePreference('day', undefined, graphType); });
      document.getElementById('tab-week')?.addEventListener('click', () => { renderChart('week'); savePreference('week', undefined, graphType); });
      document.getElementById('tab-month')?.addEventListener('click', () => {
        const key = selMonth && selMonth.value ? selMonth.value : null;
        renderChart('month', key);
        savePreference('month', key || availableMonths[0]?.key || null, graphType);
      });
      document.getElementById('tab-year')?.addEventListener('click', () => {
        const key = selYear && selYear.value ? selYear.value : null;
        renderChart('year', key);
        savePreference('year', key || (availableYears[0] ? String(availableYears[0]) : null), graphType);
      });
      selMonth?.addEventListener('change', (e)=>{
        const key = e.target.value;
        renderChart('month', key);
        savePreference('month', key, graphType);
      });
      selYear?.addEventListener('change', (e)=>{
        const key = e.target.value;
        renderChart('year', key);
        savePreference('year', key, graphType);
      });

      // Grafiektype schakelaar (line/bar)
      const btnLine = document.getElementById('type-line');
      const btnBar = document.getElementById('type-bar');
      function setActiveGraphType(gt){
        graphType = (gt === 'bar') ? 'bar' : 'line';
        btnLine?.classList.toggle('active', graphType === 'line');
        btnBar?.classList.toggle('active', graphType === 'bar');
        btnLine?.setAttribute('aria-pressed', String(graphType === 'line'));
        btnBar?.setAttribute('aria-pressed', String(graphType === 'bar'));
      }
      btnLine?.addEventListener('click', ()=>{
        setActiveGraphType('line');
        savePreference(pref, undefined, 'line');
        // herteken met huidige periode-keys
        const key = (pref==='month') ? (selMonth?.value || null) : (pref==='year') ? (selYear?.value || null) : undefined;
        renderChart(pref, key);
      });
      btnBar?.addEventListener('click', ()=>{
        setActiveGraphType('bar');
        savePreference(pref, undefined, 'bar');
        const key = (pref==='month') ? (selMonth?.value || null) : (pref==='year') ? (selYear?.value || null) : undefined;
        renderChart(pref, key);
      });
      setActiveGraphType(graphType);

      // Init render
      if (pref === 'month') {
        renderChart('month', prefPeriod);
      } else if (pref === 'year') {
        renderChart('year', prefPeriod);
      } else {
        renderChart(pref);
      }
    } catch(e){
      console.error(e);
      logStatus('Laden uit Firestore is mislukt. Controleer je rechten of verbinding.', true);
    }
  }

  document.addEventListener('DOMContentLoaded', loadAndRender);
})();
