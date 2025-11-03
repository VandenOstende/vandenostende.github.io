// Rit Tracker logica
// Opmerkingen in het Nederlands voor duidelijkheid en onderhoudbaarheid.

(() => {
  'use strict';

  // "Contract" in het kort:
  // Input: Geolocation updates van de browser.
  // Output: Live polyline op de kaart, metrics (afstand/snelheid/hoogte), en GPX export.
  // Fouten: Geen GPS toestemming, geen fix, of GPS zonder altitude -> we tonen status en gaan door waar mogelijk.

  const MAPBOX_TOKEN = window.MAPBOX_ACCESS_TOKEN;
  const mapContainerId = 'ride-map';

  // UI elementen
  const el = {
    status: document.getElementById('status'),
    start: document.getElementById('start-btn'),
    stop: document.getElementById('stop-btn'),
    distance: document.getElementById('m-distance'),
    speed: document.getElementById('m-speed'),
    avg: document.getElementById('m-avg'),
    ele: document.getElementById('m-ele'),
    dialog: document.getElementById('import-dialog'),
    btnDownload: document.getElementById('download-gpx'),
    btnImport: document.getElementById('import-gpx'),
  };

  // Interne staat
  let map, lineSourceId = 'ride-line-source', lineLayerId = 'ride-line-layer';
  let geolocateControl = null;
  let pulseMarker = null;
  let lastFixTs = null;
  let pausedDueToSignal = false;
  const SIGNAL_TIMEOUT_MS = 8000; // ms zonder fixes -> pauzeren
  let pauseCheckInterval = null;
  let watchId = null;
  let recording = false;
  let errorTimeout = null;
  let points = []; // [{lat, lon, ele, time, speed}]
  let totalDistanceM = 0; // meters
  let startTime = null;
  let lastUpdateTs = null;

  // Hulp: Haversine afstand in meters
  function haversine(a, b) {
    const R = 6371000; // m
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // Hulp: Formatters
  const fmtKm = m => (m / 1000).toFixed(2) + ' km';
  const fmtKmh = ms => (ms * 3.6).toFixed(1) + ' km/u';

  function setStatus(msg) {
    if (!el.status) return;
    el.status.textContent = msg || '';
    if (msg) {
      el.status.classList.remove('hidden');
    } else {
      el.status.classList.add('hidden');
    }
  }

  function showTransientError(msg, duration = 5000) {
    if (!el.status) return;
    // clear existing
    try { if (errorTimeout) { clearTimeout(errorTimeout); errorTimeout = null; } } catch (_) {}
    el.status.textContent = msg;
    el.status.classList.remove('hidden');
    el.status.classList.add('status--error');
    // Remove after duration
    errorTimeout = setTimeout(() => {
      try { el.status.classList.remove('status--error'); el.status.classList.add('hidden'); el.status.textContent = ''; } catch(_) {}
      errorTimeout = null;
    }, duration);
  }

  function updateHud() {
    el.distance.querySelector('strong').textContent = fmtKm(totalDistanceM);
    const currentSpeed = points.length ? (points[points.length - 1].speed ?? 0) : 0;
    const avgSpeed = (points.length > 1 && startTime) ? (totalDistanceM / ((Date.now() - startTime) / 1000)) : 0; // m/s

    el.speed.querySelector('strong').textContent = fmtKmh(currentSpeed || 0);
    el.avg.querySelector('strong').textContent = fmtKmh(avgSpeed || 0);

    const lastEle = points.length ? points[points.length - 1].ele : null;
    el.ele.querySelector('strong').textContent = (lastEle != null) ? `${Math.round(lastEle)} m` : '– m';
  }

  function ensureMap() {
    if (map) return;
    mapboxgl.accessToken = MAPBOX_TOKEN;
    map = new mapboxgl.Map({
      container: mapContainerId,
      style: 'mapbox://styles/mapbox/outdoors-v12',
      center: [4.4003, 51.2194],
      zoom: 13,
      pitch: 0,
    });
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');
    // Toon de Mapbox-knop voor huidige locatie (geolocate) en bewaar referentie
    geolocateControl = new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true
    });
    map.addControl(geolocateControl, 'top-right');

    map.on('load', () => {
      // Bron + laag voor de rit lijn
      map.addSource(lineSourceId, {
        type: 'geojson',
        data: emptyLine(),
      });
      map.addLayer({
        id: lineLayerId,
        type: 'line',
        source: lineSourceId,
        paint: {
          'line-color': '#22c55e',
          'line-width': 5,
          'line-opacity': 0.9,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' }
      });

      // Probeer direct te centreren op huidige positie als beschikbaar
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
          const { longitude, latitude } = pos.coords;
          map.jumpTo({ center: [longitude, latitude], zoom: 15 });
        }, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
      }

      // Maak een pulse marker (verborgen totdat we een fix hebben)
      try {
        const elPulse = document.createElement('div');
        elPulse.className = 'pulse-marker';
        elPulse.style.display = 'none';
        pulseMarker = new mapboxgl.Marker({ element: elPulse, anchor: 'center' });
        // we voegen de marker pas toe aan de kaart als we een fix hebben
      } catch (_) { pulseMarker = null; }
    });
  }

  function emptyLine() {
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [] },
        properties: {}
      }]
    };
  }

  function updateLine() {
    if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource(lineSourceId);
    if (!src) return;
    const coords = points.map(p => [p.lon, p.lat]);
    src.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }]
    });
    if (coords.length >= 2) {
      // Fit bounds met padding, maar niet bij elke sample te agressief
      const now = Date.now();
      if (!lastUpdateTs || (now - lastUpdateTs) > 1500) {
        const bounds = coords.reduce((b, c) => b.extend(c), new mapboxgl.LngLatBounds(coords[0], coords[0]));
        map.fitBounds(bounds, { padding: { top: 80, bottom: 140, left: 40, right: 40 }, duration: 400 });
        lastUpdateTs = now;
      }
    } else if (coords.length === 1) {
      map.easeTo({ center: coords[0], zoom: 16, duration: 300 });
    }
  }

  function onGeoSuccess(pos) {
    lastFixTs = Date.now();
    // Als we waren gepauzeerd vanwege signaal, hervat automatisch
    if (pausedDueToSignal) {
      pausedDueToSignal = false;
      setStatus('Signaal hersteld');
      setTimeout(() => { if (!pausedDueToSignal) setStatus(''); }, 1800);
    }
    if (!recording) return;
    const { latitude, longitude, altitude, speed, heading, accuracy } = pos.coords;
    const time = new Date(pos.timestamp);

    // Update pulse marker
    try {
      if (pulseMarker) {
        const elm = pulseMarker.getElement();
        if (elm) elm.style.display = 'block';
        if (!pulseMarker._map) pulseMarker.addTo(map);
        pulseMarker.setLngLat([longitude, latitude]);
      }
    } catch (_) {}

    const pt = { lat: latitude, lon: longitude, ele: altitude ?? null, speed: speed ?? null, time };

    if (points.length > 0) {
      const prev = points[points.length - 1];
      const d = haversine(prev, pt);
      // Filter ruis: hele kleine sprongen negeren als accuracy slecht is
      if (accuracy != null && accuracy > 50 && d < 2) {
        // te weinig betrouwbare verplaatsing, overslaan maar HUD bijwerken
        points.push(pt);
        updateHud();
        return;
      }
      totalDistanceM += d;
    }

    points.push(pt);
    updateHud();
    updateLine();
  }

  function onGeoError(err) {
    const msg = (err && err.message) ? err.message : 'onbekend';
    // Bij permissions-denied (1) stoppen we volledig; bij andere fouten pauzeren we en wachten op herstel
    if (err && err.code === 1) {
      setStatus('GPS fout (toestemming geweigerd)');
      try {
        if (watchId != null && navigator.geolocation) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      } catch(_) {}
      recording = false;
      if (el.start) { el.start.disabled = false; el.start.style.display = 'inline-block'; }
      if (el.stop) { el.stop.disabled = true; el.stop.style.display = 'none'; }
      return;
    }

    // Tijdelijke signaalfout: pauzeer opname maar behoud watch (probeert te herstellen)
    pausedDueToSignal = true;
    setStatus('Signaal verloren — pauzeert...');
  }

  function startRide() {
    if (!navigator.geolocation) {
      setStatus('Geolocatie niet ondersteund door deze browser.');
      return;
    }
    ensureMap();
    // Reset staat
    points = [];
    totalDistanceM = 0;
    startTime = Date.now();
    lastUpdateTs = null;
    try {
      if (map && map.isStyleLoaded()) {
        const src = map.getSource(lineSourceId);
        if (src) src.setData(emptyLine());
      }
    } catch (_) {}

    // UI
  el.start.disabled = true;
  el.start.style.display = 'none';
  el.stop.disabled = false;
  el.stop.style.display = 'inline-block';
    setStatus('Rit gestart…');
    updateHud();

  // Reset signaalstate
  lastFixTs = null;
  pausedDueToSignal = false;

  // Start watching
    // Activeer de geolocate control zodat de kaart naar de huidige locatie centreert en de browser om toestemming vraagt
    try {
      setStatus('Zoekt huidige locatie…');
      if (geolocateControl) {
        if (typeof geolocateControl.trigger === 'function') {
          geolocateControl.trigger();
        } else if (typeof geolocateControl._onClick === 'function') {
          // fallback voor verschillende mapbox versies
          geolocateControl._onClick();
        } else if (typeof geolocateControl._geolocate === 'function') {
          geolocateControl._geolocate();
        }
      }
    } catch (_) {}
    watchId = navigator.geolocation.watchPosition(onGeoSuccess, onGeoError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 20000,
    });
    recording = true;

    // Start interval om signaalverlies te detecteren
    try {
      if (pauseCheckInterval) clearInterval(pauseCheckInterval);
      pauseCheckInterval = setInterval(() => {
        if (!recording) return;
        const now = Date.now();
        if (!lastFixTs || (now - lastFixTs) > SIGNAL_TIMEOUT_MS) {
          if (!pausedDueToSignal) {
            pausedDueToSignal = true;
            setStatus('Signaal verloren — pauzeert...');
          }
        }
      }, 2000);
    } catch (_) { pauseCheckInterval = null; }
  }

  function stopRide() {
    recording = false;
    if (watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    if (pauseCheckInterval) { clearInterval(pauseCheckInterval); pauseCheckInterval = null; }

  el.stop.disabled = true;
  el.stop.style.display = 'none';
  el.start.disabled = false;
  el.start.style.display = 'inline-block';

    if (points.length < 2) {
      showTransientError('Te weinig data om een GPX te maken. Beweeg even of probeer opnieuw.');
      return;
    }

    setStatus('Rit gestopt. GPX wordt voorbereid…');
    const name = 'Rit ' + new Date(startTime).toLocaleString();
    const gpx = buildGpx(points, name);

    // Toon import dialoog met opties
    openImportDialog(gpx, name);
  }

  function buildGpx(pts, name) {
    // Bouw een eenvoudige GPX 1.1 met één track segment
    const xmlns = 'http://www.topografix.com/GPX/1/1';
    const xsi = 'http://www.w3.org/2001/XMLSchema-instance';
    const schemaLoc = 'http://www.topografix.com/GPX/1/1/gpx.xsd';

    const header = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<gpx version="1.1" creator="RitTracker" xmlns="${xmlns}" xmlns:xsi="${xsi}" xsi:schemaLocation="${xmlns} ${schemaLoc}">`;

    const metadata = `<metadata><time>${new Date(pts[0].time).toISOString()}</time></metadata>`;

    const trkpts = pts.map(p => {
      const ele = (p.ele != null) ? `<ele>${p.ele}</ele>` : '';
      const time = `<time>${new Date(p.time).toISOString()}</time>`;
      return `<trkpt lat="${p.lat}" lon="${p.lon}">${ele}${time}</trkpt>`;
    }).join('');

    const trk = `<trk><name>${escapeXml(name)}</name><trkseg>${trkpts}</trkseg></trk>`;
    const footer = `</gpx>`;
    return header + metadata + trk + footer;
  }

  function escapeXml(s) {
    return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  }

  function openImportDialog(gpx, name) {
    el.dialog.classList.add('active');

    el.btnDownload.onclick = () => {
      const blob = new Blob([gpx], { type: 'application/gpx+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (name.replace(/\s+/g, '_') + '.gpx');
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    };

    el.btnImport.onclick = () => {
      // Zet in localStorage en navigeer naar GPXTracker met vlag, daar wordt auto-geïmporteerd
      const payload = { gpxText: gpx, suggestedName: (name.replace(/\s+/g, '_') + '.gpx') };
      try { localStorage.setItem('GPX_RIDE_IMPORT', JSON.stringify(payload)); } catch {}
      window.location.href = 'GPXTracker.html?rideImport=1&add=1';
    };
  }

  // Event listeners
  el.start.addEventListener('click', startRide);
  el.stop.addEventListener('click', stopRide);

  // Init kaart alvast (zodat stijl en controls klaarstaan)
  ensureMap();
})();
