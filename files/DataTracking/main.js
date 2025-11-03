/*
  GPX Tracker Dashboard – hoofdscript (main.js)
  -------------------------------------------------
  Dit script initialiseerd de Mapbox kaart, behandelt het modaal formulier
  voor GPX-upload, parseert GPX naar GeoJSON/trackpunten, toont statistieken
  en rendert de track op de kaart. Alle code is opgeschoond en modulair.

  Opmerkingen:
  - Vereist Mapbox GL JS en togeojson (beide staan in GPXTracker.html)
  - Verwacht een globale window.MAPBOX_ACCESS_TOKEN (ingesteld in GPXTracker.html)
  - Werkt volledig client-side met FileReader; geen server nodig
*/

(() => {
  'use strict';

  // Kleine helpers ---------------------------------------------------------
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Smooth scroll voor interne ankers (best-effort, schaadt niets) --------
  function enableSmoothScroll() {
    const links = qsa('a[href^="#"]');
    links.forEach((link) => {
      link.addEventListener('click', (e) => {
        const targetId = link.getAttribute('href');
        if (!targetId || targetId === '#') return;
        const target = qs(targetId);
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  }

  // Mapbox Tracker ---------------------------------------------------------
  function initMapboxTracker(mapContainer) {
    const detailsContainer = qs('#gpx-details');
    const statsContainer = qs('#gpx-stats');
    const pointsContainer = qs('#gpx-points');

    const accessToken = window.MAPBOX_ACCESS_TOKEN;
    if (!accessToken || typeof accessToken !== 'string' || accessToken.trim().length === 0) {
      const message = 'Voeg een geldige Mapbox access token toe in GPXTracker.html om de kaart te laden.';
      mapContainer.innerHTML = `<p style="padding: 16px;">${escapeHtml(message)}</p>`;
      [detailsContainer, statsContainer, pointsContainer].forEach((el) => {
        if (el) el.innerHTML = `<p>${escapeHtml(message)}</p>`;
      });
      return null;
    }

    mapboxgl.accessToken = accessToken;
    const map = new mapboxgl.Map({
      container: mapContainer,
      style: 'mapbox://styles/mapbox/standard',
      center: [4.75, 51.25],
      zoom: 8.5,
      attributionControl: true
    });

    // Basisbesturingselementen
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new mapboxgl.ScaleControl({ maxWidth: 150, unit: 'metric' }));
    map.addControl(new mapboxgl.FullscreenControl());
    const geolocateControl = new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true
    });
    map.addControl(geolocateControl, 'top-right');

    // Dag/Nacht toggle control (Mapbox-stijl knop) voor Standard style
    const lightToggle = new LightPresetToggleControl();
    map.addControl(lightToggle, 'top-right');

    const state = {
      markers: [],
      trackSourceId: 'gpx-track-source',
      trackLayerId: 'gpx-track-layer',
      weatherOverlay: null
    };

    const showMessage = (message) => {
      if (detailsContainer) detailsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;
      if (statsContainer) statsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;
      if (pointsContainer) pointsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;
    };

    const renderRide = ({ fileName, parsed, rideDate, weather, source = 'local', stored = false }) => {
      if (!parsed) {
        showMessage('Geen gegevens beschikbaar voor deze rit.');
        return;
      }
      renderMapData(map, state, parsed.geojsonLine, parsed.bounds, parsed.trackPoints);
      renderTrackInsights({
        fileName,
        metadata: parsed.metadata,
        stats: parsed.stats,
        trackPoints: parsed.trackPoints,
        rideDate,
        weather,
        detailsContainer,
        statsContainer,
        pointsContainer
      });

      // Toon weer-overlay (regen/sneeuw) indien van toepassing
      applyWeatherOverlay(map, state, weather);

      // Opslaan naar Firestore indien lokaal geüpload en Firebase is geconfigureerd
      try {
        const db = getFirestoreDb && getFirestoreDb();
        if (db && source !== 'firestore') {
          const docData = toRideDoc({ fileName, parsed, rideDate, weather });
          saveRideToFirestore(db, docData)
            .then(() => {
              // kleine bevestiging tonen aan de gebruiker
              if (detailsContainer) {
                const ok = document.createElement('p');
                ok.style.color = '#22c55e';
                ok.textContent = 'Rit opgeslagen in de database.';
                detailsContainer.prepend(ok);
                setTimeout(() => ok.remove(), 4000);
              }
              refreshRidesUI(db);
            })
            .catch((err) => {
              console.error('Opslaan in Firestore mislukt:', err);
              if (detailsContainer) {
                const errEl = document.createElement('p');
                errEl.style.color = '#ef4444';
                const code = err && (err.code || err.name) ? ` [${err.code || err.name}]` : '';
                const msg = err && err.message ? `: ${err.message}` : '';
                errEl.textContent = `Opslaan in de database mislukt${code}${msg}. Controleer je Firestore-regels en of Anonymous Auth is ingeschakeld.`;
                detailsContainer.prepend(errEl);
                setTimeout(() => errEl.remove(), 7000);
              }
            });
        }
      } catch (e) {
        // negeer als Firebase niet is geconfigureerd
      }
    };

    const clearRide = () => {
      try { if (map.getLayer(state.trackLayerId)) map.removeLayer(state.trackLayerId); } catch (_) {}
      try { if (map.getSource(state.trackSourceId)) map.removeSource(state.trackSourceId); } catch (_) {}
      state.markers.forEach((m) => { try { m.remove(); } catch (_) {} });
      state.markers = [];
      if (state.weatherOverlay && typeof state.weatherOverlay.remove === 'function') {
        state.weatherOverlay.remove();
        state.weatherOverlay = null;
      }
      if (detailsContainer) detailsContainer.innerHTML = '<p>Voeg een fietsrit toe om details te zien.</p>';
      if (statsContainer) statsContainer.innerHTML = '<p>Voeg een fietsrit toe om statistieken te zien.</p>';
      if (pointsContainer) pointsContainer.innerHTML = '<p>Geen trackpunten om te tonen.</p>';
    };

    return { renderRide, showError: showMessage, clearRide, map, geolocateControl };
  }

  // Formulier/Modaal -------------------------------------------------------
  function initRideForm(tracker) {
    const addRideBtn = qs('#add-ride-btn');
    const modal = qs('#ride-modal');
    const backdrop = qs('#modal-backdrop');
    const closeBtn = qs('#ride-modal-close');
    const cancelBtn = qs('#ride-cancel-btn');
    const form = qs('#ride-form');
    const fileInput = qs('#ride-gpx-file');
    const dateInput = qs('#ride-date');
    const errorContainer = qs('#ride-form-error');
    const deleteBtn = qs('#delete-ride-btn');

    if (!addRideBtn || !modal || !backdrop || !closeBtn || !cancelBtn || !form || !fileInput || !dateInput || !errorContainer) {
      tracker.showError('Formulierelementen ontbreken in de pagina.');
      return;
    }

    let parsedResult = null; // cache resultaat na inlezen

    const resetForm = () => {
      form.reset();
      dateInput.value = '';
      if (fileInput.value) fileInput.value = '';
      errorContainer.textContent = '';
      parsedResult = null;
    };

    const openModal = () => {
      resetForm();
      modal.classList.remove('hidden');
      backdrop.classList.remove('hidden');
      modal.setAttribute('aria-hidden', 'false');
      backdrop.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
      setTimeout(() => fileInput.focus(), 50);
    };

    const closeModal = () => {
      modal.classList.add('hidden');
      backdrop.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      backdrop.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
      resetForm();
      addRideBtn.focus();
    };

    const handleKeydown = (event) => {
      if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
    };

    addRideBtn.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    document.addEventListener('keydown', handleKeydown);

    fileInput.addEventListener('change', (event) => {
      parsedResult = null;
      errorContainer.textContent = '';
      const file = event.target.files && event.target.files[0];
      if (!file) { dateInput.value = ''; return; }
      if (!file.name.toLowerCase().endsWith('.gpx')) {
        errorContainer.textContent = 'Het geselecteerde bestand is geen geldig GPX-bestand.';
        fileInput.value = '';
        dateInput.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = (loadEvent) => {
        const gpxText = loadEvent.target && loadEvent.target.result;
        if (typeof gpxText !== 'string') {
          errorContainer.textContent = 'Kon het GPX-bestand niet lezen.';
          return;
        }
        try {
          const parsed = parseGpxFile(gpxText);
          parsedResult = { file, parsed };
          const startTime = parsed.stats.startTime;
          if (startTime instanceof Date && !Number.isNaN(startTime.getTime())) {
            dateInput.value = formatDateForInput(startTime);
          }
          errorContainer.textContent = '';
        } catch (err) {
          parsedResult = null;
          errorContainer.textContent = err && err.message ? err.message : 'Er ging iets mis bij het verwerken van het GPX-bestand.';
        }
      };
      reader.onerror = () => {
        parsedResult = null;
        errorContainer.textContent = 'Het GPX-bestand kon niet worden ingelezen.';
        };
      reader.readAsText(file);
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      errorContainer.textContent = '';

      const file = fileInput.files && fileInput.files[0];
      if (!file) { errorContainer.textContent = 'Selecteer een GPX-bestand.'; return; }
      if (!parsedResult || parsedResult.file !== file) {
        errorContainer.textContent = 'Het GPX-bestand wordt nog verwerkt. Wacht even en probeer opnieuw.';
        return;
      }

      const dateValue = dateInput.value;
      if (!dateValue) { errorContainer.textContent = 'Vul de datum van de rit in.'; return; }
      const weatherInput = form.querySelector('input[name="ride-weather"]:checked');
      if (!weatherInput) { errorContainer.textContent = 'Selecteer de weersomstandigheden.'; return; }

      const rideDate = new Date(`${dateValue}T00:00:00`);
      const weather = weatherInput.value;

      try {
        tracker.renderRide({
          fileName: file.name,
          parsed: parsedResult.parsed,
          rideDate,
          weather
        });
        // Lokale rit getoond: centrale verwijderknop uitschakelen
        if (deleteBtn) {
          deleteBtn.disabled = true;
          deleteBtn.title = 'Selecteer eerst een rit uit de lijst';
          deleteBtn.classList.add('hidden');
        }
        // Label tonen voor lokale rit; geen highlight in de lijst
        const label = [formatDateOnly(rideDate), formatWeather(weather), file.name].filter(Boolean).join(' • ');
        setActiveRideLabel(label);
        clearRideHighlight();
        closeModal();
      } catch (err) {
        console.error(err);
        const msg = err && err.message ? err.message : 'Kon de fietsrit niet verwerken.';
        errorContainer.textContent = msg;
        tracker.showError(msg);
      }
    });
  }

  // GPX Parsing & berekeningen --------------------------------------------
  function parseGpxFile(gpxText) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(gpxText, 'text/xml');
    if (xml.getElementsByTagName('parsererror').length > 0) {
      throw new Error('Het GPX-bestand bevat een syntaxisfout.');
    }
    if (!window.toGeoJSON || !window.toGeoJSON.gpx) {
      throw new Error('De toGeoJSON-bibliotheek is niet beschikbaar.');
    }

    const geojson = window.toGeoJSON.gpx(xml);
    if (!geojson || !Array.isArray(geojson.features) || geojson.features.length === 0) {
      throw new Error('Geen geometrie gevonden in het GPX-bestand.');
    }

    const lineCoordinates = collectLineCoordinates(geojson.features);
    if (lineCoordinates.length === 0) {
      throw new Error('Geen lijninformatie gevonden in het GPX-bestand.');
    }

    const trackPoints = extractTrackPoints(xml);
    if (trackPoints.length === 0) {
      throw new Error('Geen trackpunten gevonden in het GPX-bestand.');
    }

    const bounds = computeBounds(lineCoordinates);
    const stats = calculateTrackStats(trackPoints);
    const metadata = extractMetadata(xml);

    return {
      geojsonLine: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: lineCoordinates },
        properties: {}
      },
      bounds,
      trackPoints,
      stats,
      metadata
    };
  }

  function collectLineCoordinates(features) {
    const coords = [];
    features.forEach((feature) => {
      if (!feature.geometry) return;
      if (feature.geometry.type === 'LineString') {
        feature.geometry.coordinates.forEach((c) => coords.push(c));
      } else if (feature.geometry.type === 'MultiLineString') {
        feature.geometry.coordinates.forEach((line) => line.forEach((c) => coords.push(c)));
      }
    });
    return coords;
  }

  function extractTrackPoints(xml) {
    const nodes = Array.from(xml.getElementsByTagName('trkpt'));
    return nodes
      .map((node) => {
        const lat = parseFloat(node.getAttribute('lat'));
        const lon = parseFloat(node.getAttribute('lon'));
        const eleNode = node.getElementsByTagName('ele')[0];
        const timeNode = node.getElementsByTagName('time')[0];
        const elevation = eleNode ? parseFloat(eleNode.textContent) : null;
        const timeString = timeNode ? timeNode.textContent : null;
        const time = timeString ? new Date(timeString) : null;
        return {
          lat,
          lon,
          elevation: Number.isFinite(elevation) ? elevation : null,
          time: time instanceof Date && !Number.isNaN(time.getTime()) ? time : null
        };
      })
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  }

  function computeBounds(coordinates) {
    const initial = { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity };
    return coordinates.reduce((acc, [lng, lat]) => {
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        acc.minLng = Math.min(acc.minLng, lng);
        acc.maxLng = Math.max(acc.maxLng, lng);
        acc.minLat = Math.min(acc.minLat, lat);
        acc.maxLat = Math.max(acc.maxLat, lat);
      }
      return acc;
    }, initial);
  }

  function calculateTrackStats(points) {
    if (points.length < 2) {
      return {
        totalDistanceKm: 0,
        totalAscent: 0,
        totalDescent: 0,
        minElevation: null,
        maxElevation: null,
        startTime: points[0] ? points[0].time : null,
        endTime: points[0] ? points[0].time : null,
        durationMs: 0,
        averageSpeedKmh: null
      };
    }

  let totalDistance = 0;
    let totalAscent = 0;
    let totalDescent = 0;
    let minElevation = Infinity;
    let maxElevation = -Infinity;
  let maxSpeedKmh = null; // maximale segmentsnelheid in km/u

    if (Number.isFinite(points[0].elevation)) {
      minElevation = Math.min(minElevation, points[0].elevation);
      maxElevation = Math.max(maxElevation, points[0].elevation);
    }

    const firstWithTime = points.find((p) => p.time);
    const lastWithTime = [...points].reverse().find((p) => p.time);
    const startTime = firstWithTime ? firstWithTime.time : null;
    const endTime = lastWithTime ? lastWithTime.time : null;

    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1];
      const curr = points[i];
      const segmentDistanceKm = haversineDistance(prev, curr);
      totalDistance += segmentDistanceKm;

      // Bereken segmentsnelheid indien tijden beschikbaar zijn
      if (prev.time instanceof Date && curr.time instanceof Date &&
          !Number.isNaN(prev.time.getTime()) && !Number.isNaN(curr.time.getTime())) {
        const deltaMs = curr.time.getTime() - prev.time.getTime();
        if (deltaMs > 0) {
          const hours = deltaMs / (1000 * 60 * 60);
          const speedKmh = segmentDistanceKm / hours;
          if (Number.isFinite(speedKmh)) {
            maxSpeedKmh = maxSpeedKmh == null ? speedKmh : Math.max(maxSpeedKmh, speedKmh);
          }
        }
      }

      if (Number.isFinite(curr.elevation)) {
        minElevation = Math.min(minElevation, curr.elevation);
        maxElevation = Math.max(maxElevation, curr.elevation);
      }
      if (Number.isFinite(prev.elevation) && Number.isFinite(curr.elevation)) {
        const delta = curr.elevation - prev.elevation;
        if (delta > 0) totalAscent += delta; else totalDescent += Math.abs(delta);
      }
    }

    const durationMs = startTime && endTime ? Math.max(0, endTime.getTime() - startTime.getTime()) : null;
    const durationHours = typeof durationMs === 'number' && durationMs > 0 ? durationMs / (1000 * 60 * 60) : null;
    const averageSpeed = durationHours && durationHours > 0 ? totalDistance / durationHours : null;

    return {
      totalDistanceKm: totalDistance,
      totalAscent,
      totalDescent,
      minElevation: Number.isFinite(minElevation) ? minElevation : null,
      maxElevation: Number.isFinite(maxElevation) ? maxElevation : null,
      startTime,
      endTime,
      durationMs,
      averageSpeedKmh: averageSpeed,
      maxSpeedKmh
    };
  }

  function haversineDistance(a, b) {
    const toRadians = (v) => v * (Math.PI / 180);
    const R = 6371; // km
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const dLat = toRadians(b.lat - a.lat);
    const dLon = toRadians(b.lon - a.lon);
    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const c = 2 * Math.atan2(
      Math.sqrt(sinLat ** 2 + Math.cos(lat1) * Math.cos(lat2) * sinLon ** 2),
      Math.sqrt(1 - (sinLat ** 2 + Math.cos(lat1) * Math.cos(lat2) * sinLon ** 2))
    );
    return R * c;
  }

  function extractMetadata(xml) {
    const getText = (tag) => {
      const node = xml.getElementsByTagName(tag)[0];
      return node ? node.textContent : null;
    };
    return {
      name: getText('name'),
      description: getText('desc') || getText('description') || null,
      author: getText('author')
    };
  }

  // Rendering --------------------------------------------------------------
  function renderMapData(map, state, geojsonLine, bounds, trackPoints) {
    const applyData = () => {
      if (map.getLayer(state.trackLayerId)) map.removeLayer(state.trackLayerId);
      if (map.getSource(state.trackSourceId)) map.removeSource(state.trackSourceId);

      map.addSource(state.trackSourceId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [geojsonLine] }
      });

      map.addLayer({
        id: state.trackLayerId,
        type: 'line',
        source: state.trackSourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#60a5fa', 'line-width': 4, 'line-opacity': 0.9 }
      });

      // Markers resetten
      state.markers.forEach((m) => m.remove());
      state.markers = [];

      if (trackPoints.length > 0) {
        const startPoint = trackPoints[0];
        const endPoint = trackPoints[trackPoints.length - 1];
        state.markers.push(
          new mapboxgl.Marker({ color: '#22c55e' })
            .setLngLat([startPoint.lon, startPoint.lat])
            .setPopup(new mapboxgl.Popup({ offset: 12 }).setHTML('<strong>Start</strong>'))
            .addTo(map)
        );
        state.markers.push(
          new mapboxgl.Marker({ color: '#ef4444' })
            .setLngLat([endPoint.lon, endPoint.lat])
            .setPopup(new mapboxgl.Popup({ offset: 12 }).setHTML('<strong>Finish</strong>'))
            .addTo(map)
        );
      }

      const hasBounds =
        Number.isFinite(bounds.minLng) && Number.isFinite(bounds.maxLng) &&
        Number.isFinite(bounds.minLat) && Number.isFinite(bounds.maxLat);
      if (hasBounds) {
        const lngLatBounds = new mapboxgl.LngLatBounds(
          [bounds.minLng, bounds.minLat],
          [bounds.maxLng, bounds.maxLat]
        );
        map.fitBounds(lngLatBounds, { padding: 60, maxZoom: 15, duration: 1000 });
      }
    };

    if (map.isStyleLoaded()) applyData(); else map.once('load', applyData);
  }

  // Dag/Nacht toggle ------------------------------------------------------
  class LightPresetToggleControl {
    onAdd(map) {
      this._map = map;
      this._container = document.createElement('div');
      this._container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';
      const btn = document.createElement('button');
      btn.className = 'mapboxgl-ctrl-icon';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Wissel dag/nacht kaart');
      btn.style.fontSize = '16px';
      btn.style.lineHeight = '1';
      btn.style.display = 'flex';
      btn.style.alignItems = 'center';
      btn.style.justifyContent = 'center';
      const updateIcon = () => {
        const preset = getLightPreset(map);
        btn.textContent = preset === 'night' ? '☀' : '🌙';
        btn.title = preset === 'night' ? 'Schakel naar dag' : 'Schakel naar nacht';
      };
      btn.addEventListener('click', () => {
        const preset = getLightPreset(map);
        const next = preset === 'night' ? 'day' : 'night';
        setLightPreset(map, next);
        updateIcon();
      });
      this._container.appendChild(btn);
      // initiële icon
      setTimeout(updateIcon, 0);
      return this._container;
    }
    onRemove() {
      if (this._container && this._container.parentNode) {
        this._container.parentNode.removeChild(this._container);
      }
      this._map = undefined;
    }
  }

  function getLightPreset(map) {
    try {
      // probeer uit de style-config te lezen indien beschikbaar
      const style = map.getStyle && map.getStyle();
      const basemap = style && style.metadata && style.metadata['mapbox:groups'] ? null : null; // placeholder
      // We bewaren geen state hier; val terug op dag als default
    } catch (_) {}
    // geen directe read API; houd togglestate impliciet: we kunnen proberen style props te lezen, maar als fallback pakken we 'day'
    return getLightPreset._current || 'day';
  }

  function setLightPreset(map, preset) {
    try {
      if (typeof map.setConfigProperty === 'function') {
        map.setConfigProperty('basemap', 'lightPreset', preset);
        getLightPreset._current = preset;
      } else {
        // Als setConfigProperty niet bestaat, wissel van stijl als fallback
        const styleId = preset === 'night' ? 'mapbox://styles/mapbox/standard' : 'mapbox://styles/mapbox/standard';
        map.setStyle(styleId);
        getLightPreset._current = preset;
      }
    } catch (e) {
      console.warn('Kon lightPreset niet aanpassen:', e);
    }
  }

  // Weer overlay (regen/sneeuw) ------------------------------------------
  function applyWeatherOverlay(map, state, weather) {
    // Verwijder bestaande overlay
    if (state.weatherOverlay && typeof state.weatherOverlay.remove === 'function') {
      state.weatherOverlay.remove();
      state.weatherOverlay = null;
    }
    if (weather === 'rain') {
      state.weatherOverlay = createRainOverlay(map);
    } else if (weather === 'snow') {
      state.weatherOverlay = createSnowOverlay(map);
    }
  }

  function createOverlayCanvas(map) {
    const container = map.getContainer();
    const canvas = document.createElement('canvas');
    canvas.className = 'weather-overlay-canvas';
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '5';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return { canvas, ctx, resize, ro, remove: () => { ro.disconnect(); canvas.remove(); } };
  }

  function createRainOverlay(map) {
    const overlay = createOverlayCanvas(map);
    const { ctx, canvas } = overlay;
    const drops = [];
    const maxDrops = 120;
    function spawn() {
      const w = canvas.width;
      const h = canvas.height;
      for (let i = drops.length; i < maxDrops; i++) {
        drops.push({ x: Math.random() * w, y: Math.random() * h, len: 10 + Math.random() * 15, spd: 3 + Math.random() * 4 });
      }
    }
    let raf;
    function draw() {
      const w = canvas.width; const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(96,165,250,0.5)';
      ctx.lineWidth = 1.2;
      ctx.lineCap = 'round';
      drops.forEach((d) => {
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x + 2, d.y + d.len);
        ctx.stroke();
        d.x += 1.5; d.y += d.spd + 2;
        if (d.y > h || d.x > w) { d.x = Math.random() * w; d.y = -20; }
      });
      raf = requestAnimationFrame(draw);
    }
    spawn();
    draw();
    return {
      remove() { cancelAnimationFrame(raf); overlay.remove(); }
    };
  }

  function createSnowOverlay(map) {
    const overlay = createOverlayCanvas(map);
    const { ctx, canvas } = overlay;
    const flakes = [];
    const maxFlakes = 100;
    function spawn() {
      const w = canvas.width; const h = canvas.height;
      for (let i = flakes.length; i < maxFlakes; i++) {
        flakes.push({ x: Math.random() * w, y: Math.random() * h, r: 1 + Math.random() * 2.5, spd: 0.5 + Math.random() * 1.5, drift: (Math.random() - 0.5) * 0.8 });
      }
    }
    let raf;
    function draw() {
      const w = canvas.width; const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(241,245,249,0.85)';
      flakes.forEach((f) => {
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
        f.y += f.spd; f.x += f.drift;
        if (f.y > h) { f.y = -10; f.x = Math.random() * w; }
        if (f.x < -10) f.x = w + 10; if (f.x > w + 10) f.x = -10;
      });
      raf = requestAnimationFrame(draw);
    }
    spawn();
    draw();
    return {
      remove() { cancelAnimationFrame(raf); overlay.remove(); }
    };
  }

  function renderTrackInsights({ fileName, metadata, stats, trackPoints, rideDate, weather, detailsContainer, statsContainer, pointsContainer }) {
    if (detailsContainer) {
      const details = [
        `<p><strong>Bestand:</strong> ${escapeHtml(fileName)}</p>`,
        metadata.name ? `<p><strong>Tracknaam:</strong> ${escapeHtml(metadata.name)}</p>` : '',
        metadata.description ? `<p><strong>Beschrijving:</strong> ${escapeHtml(metadata.description)}</p>` : '',
        metadata.author ? `<p><strong>Auteur:</strong> ${escapeHtml(metadata.author)}</p>` : '',
        rideDate instanceof Date && !Number.isNaN(rideDate.getTime()) ? `<p><strong>Ritdatum:</strong> ${formatDateOnly(rideDate)}</p>` : '',
        `<p><strong>Starttijd:</strong> ${formatDateTime(stats.startTime)}</p>`,
        `<p><strong>Eindtijd:</strong> ${formatDateTime(stats.endTime)}</p>`,
        weather ? `<p><strong>Weer:</strong> ${formatWeather(weather)}</p>` : '',
        `<p><strong>Trackpunten:</strong> ${trackPoints.length}</p>`
      ].filter(Boolean).join('');
      detailsContainer.innerHTML = details;
    }

    if (statsContainer) {
      statsContainer.innerHTML = [
        `<p><strong>Totale afstand:</strong> ${formatDistance(stats.totalDistanceKm)}</p>`,
        `<p><strong>Duur:</strong> ${formatDuration(stats.durationMs)}</p>`,
        `<p><strong>Gemiddelde snelheid:</strong> ${formatSpeed(stats.averageSpeedKmh)}</p>`,
        `<p><strong>Maximum snelheid:</strong> ${formatSpeed(stats.maxSpeedKmh)}</p>`,
        `<p><strong>Totaal stijgen:</strong> ${formatElevation(stats.totalAscent)}</p>`,
        `<p><strong>Totaal dalen:</strong> ${formatElevation(stats.totalDescent)}</p>`,
        `<p><strong>Minimum hoogte:</strong> ${formatElevation(stats.minElevation)}</p>`,
        `<p><strong>Maximum hoogte:</strong> ${formatElevation(stats.maxElevation)}</p>`
      ].join('');
    }

    if (pointsContainer) {
      if (trackPoints.length === 0) {
        pointsContainer.innerHTML = '<p>Geen trackpunten om te tonen.</p>';
        return;
      }
      const maxRows = 300;
      const limited = trackPoints.slice(0, maxRows);
      const rows = limited.map((p, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${formatCoordinate(p.lat)}</td>
          <td>${formatCoordinate(p.lon)}</td>
          <td>${formatElevation(p.elevation)}</td>
          <td>${formatTime(p.time)}</td>
        </tr>
      `).join('');
      const table = `
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Latitude</th>
              <th>Longitude</th>
              <th>Hoogte</th>
              <th>Tijd</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
      const note = trackPoints.length > maxRows ? `<p>Toont de eerste ${maxRows} van ${trackPoints.length} punten.</p>` : '';
      pointsContainer.innerHTML = table + note;
    }
  }

  // Formatters -------------------------------------------------------------
  function escapeHtml(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch));
  }
  function formatDistance(km) {
    if (!Number.isFinite(km)) return 'Niet beschikbaar';
    return `${km.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;
  }
  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return 'Niet beschikbaar';
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const seg = [h, m, s].map((x) => x.toString().padStart(2, '0'));
    return `${seg[0]}:${seg[1]}:${seg[2]}`;
  }
  function formatSpeed(kmh) {
    if (!Number.isFinite(kmh)) return 'Niet beschikbaar';
    return `${kmh.toLocaleString('nl-BE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km/u`;
  }
  function formatElevation(v) {
    if (!Number.isFinite(v)) return 'Niet beschikbaar';
    return `${v.toLocaleString('nl-BE', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} m`;
  }
  function formatCoordinate(v) {
    if (!Number.isFinite(v)) return '-';
    return v.toFixed(5);
  }
  function formatDateTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'Niet beschikbaar';
    return date.toLocaleString('nl-BE');
  }
  function formatTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '-';
    return date.toLocaleTimeString('nl-BE');
  }
  function formatDateOnly(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'Niet beschikbaar';
    return date.toLocaleDateString('nl-BE');
  }
  function formatDateForInput(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const y = date.getFullYear();
    const m = `${date.getMonth() + 1}`.padStart(2, '0');
    const d = `${date.getDate()}`.padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function formatWeather(value) {
    switch (value) {
      case 'rain': return 'Regen';
      case 'snow': return 'Sneeuw';
      case 'sun': return 'Zon';
      default: return 'Onbekend';
    }
  }

  // UI helpers voor actieve rit ------------------------------------------
  function setActiveRideLabel(text) {
    const cont = document.getElementById('active-ride');
    const lab = document.getElementById('active-ride-label');
    if (!cont || !lab) return;
    lab.textContent = text || '';
    cont.style.display = text ? 'inline-flex' : 'none';
  }
  function clearActiveRideLabel() { setActiveRideLabel(''); }

  function highlightRideInList(id) {
    const listEl = document.getElementById('rides-list');
    if (!listEl) return;
    const items = listEl.querySelectorAll('.ride-item');
    items.forEach((el) => {
      if (id && el.getAttribute('data-id') === id) el.classList.add('active');
      else el.classList.remove('active');
    });
  }
  function clearRideHighlight() { highlightRideInList(null); }

  // ------------------------ Firestore integratie --------------------------
  function getFirestoreDb() {
    try {
      if (!window.firebase || !window.firebase.initializeApp) return null;
      if (!window.FIREBASE_CONFIG || !window.FIREBASE_CONFIG.apiKey) return null;
      if (!getFirestoreDb._app) {
        getFirestoreDb._app = window.firebase.initializeApp(window.FIREBASE_CONFIG);
        getFirestoreDb._db = window.firebase.firestore();
        try {
          // Vermijd fouten bij undefined waarden in geneste objecten
          getFirestoreDb._db.settings({ ignoreUndefinedProperties: true });
        } catch (_) {}
        // Optionele uitgebreide logging voor diagnose
        if (window.FIREBASE_DEBUG === true && window.firebase.firestore && window.firebase.firestore.setLogLevel) {
          try { window.firebase.firestore.setLogLevel('debug'); } catch (_) {}
        }
      }
      return getFirestoreDb._db;
    } catch (e) {
      console.error('Firebase init fout:', e);
      return null;
    }
  }

  // Converteer lokale parsed rit naar Firestore document
  function toRideDoc({ fileName, parsed, rideDate, weather }) {
    const coords = parsed.geojsonLine?.geometry?.coordinates || [];
    const simplified = downsampleCoordinates(coords, 300);
    const start = parsed.trackPoints[0] || null;
    const end = parsed.trackPoints[parsed.trackPoints.length - 1] || null;
    const sampled = sampleTrackPointsByTime(parsed.trackPoints, 30);
    // Firestore ondersteunt geen geneste arrays (arrays van arrays). Converteer naar objecten.
    const lineCoordsObjs = simplified.map(([lng, lat]) => ({ lng, lat }));
    const sampledObjs = sampled
      .map((it) => {
        if (Array.isArray(it)) {
          const [lon, lat, ts, ele] = it;
          return { lon, lat, ts, ele };
        }
        if (it && typeof it === 'object') return it;
        return null;
      })
      .filter(Boolean);

    return {
      fileName,
      rideDate: rideDate instanceof Date ? rideDate : null,
      weather: weather || null,
      // expliciet ook start- en eindtijd als top-level velden opslaan
      startTime: parsed.stats && parsed.stats.startTime instanceof Date ? parsed.stats.startTime : null,
      endTime: parsed.stats && parsed.stats.endTime instanceof Date ? parsed.stats.endTime : null,
      // flatten voor sortering
      maxSpeedKmh: Number.isFinite(parsed.stats.maxSpeedKmh) ? parsed.stats.maxSpeedKmh : null,
      // stats en metadata
      stats: parsed.stats,
      metadata: parsed.metadata,
      // geometrie (gesimplificeerd) – als objecten om geneste arrays te vermijden
      lineCoords: lineCoordsObjs, // [{lng,lat}]
      bounds: parsed.bounds,
      trackPointsCount: parsed.trackPoints.length,
      // sampled punten (30s) – als objecten om geneste arrays te vermijden
      sampledPoints: sampledObjs, // [{lon,lat,ts,ele}]
      sampledPointsCount: sampled.length,
      startPoint: start ? { lat: start.lat, lon: start.lon } : null,
      endPoint: end ? { lat: end.lat, lon: end.lon } : null,
      createdAt: new Date()
    };
  }

  function downsampleCoordinates(coords, maxPoints) {
    if (!Array.isArray(coords) || coords.length === 0) return [];
    if (coords.length <= maxPoints) return coords;
    const step = Math.ceil(coords.length / maxPoints);
    const out = [];
    for (let i = 0; i < coords.length; i += step) out.push(coords[i]);
    // zorg dat laatste punt aanwezig is
    const last = coords[coords.length - 1];
    const lastOut = out[out.length - 1];
    if (!lastOut || lastOut[0] !== last[0] || lastOut[1] !== last[1]) out.push(last);
    return out;
  }

  async function saveRideToFirestore(db, docData) {
    try {
      // Zorg dat we (indien mogelijk) anoniem ingelogd zijn voordat we schrijven
      await ensureFirebaseAuth();
      await db.collection('rides').add(docData);
    } catch (e) {
      console.error('Fout bij opslaan:', e);
      throw e;
    }
  }

  async function fetchRides(db, sortValue) {
    const col = db.collection('rides');
    let query = col;
    // sortValue: date-desc | date-asc | weather-asc | maxspeed-desc | maxspeed-asc
    switch (sortValue) {
      case 'date-asc':
        query = col.orderBy('rideDate', 'asc');
        break;
      case 'weather-asc':
        query = col.orderBy('weather', 'asc');
        break;
      case 'maxspeed-asc':
        query = col.orderBy('maxSpeedKmh', 'asc');
        break;
      case 'maxspeed-desc':
        query = col.orderBy('maxSpeedKmh', 'desc');
        break;
      case 'date-desc':
      default:
        query = col.orderBy('rideDate', 'desc');
        break;
    }
    const snap = await query.get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  // Houd slechts een punt per interval (in seconden)
  function sampleTrackPointsByTime(points, intervalSeconds) {
    if (!Array.isArray(points) || points.length === 0) return [];
    const out = [];
    const intervalMs = (intervalSeconds || 30) * 1000;
    let lastTs = null;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const ts = p.time instanceof Date && !Number.isNaN(p.time.getTime()) ? p.time.getTime() : null;
      if (ts == null) continue; // zonder tijd overslaan
      if (lastTs == null || (ts - lastTs) >= intervalMs || i === points.length - 1) {
        // gebruik compacte representatie [lon, lat, tijd(ms), elev]
        const ele = Number.isFinite(p.elevation) ? p.elevation : null;
        out.push([p.lon, p.lat, ts, ele]);
        lastTs = ts;
      }
    }
    // als er geen tijd in de punten zat, val terug naar eerste en laatste punt
    if (out.length === 0) {
      const first = points[0];
      const last = points[points.length - 1];
      out.push([first.lon, first.lat, null, Number.isFinite(first.elevation) ? first.elevation : null]);
      if (points.length > 1) {
        out.push([last.lon, last.lat, null, Number.isFinite(last.elevation) ? last.elevation : null]);
      }
    }
    return out;
  }

  function renderRidesList(rides, onSelect) {
    const listEl = document.getElementById('rides-list');
    if (!listEl) return;
    if (!rides || rides.length === 0) {
      listEl.innerHTML = '<p>Er zijn nog geen ritten opgeslagen.</p>';
      return;
    }
    const items = rides.map((r) => {
      const d = r.rideDate && typeof r.rideDate.toDate === 'function' ? r.rideDate.toDate() : r.rideDate;
      const dateStr = d instanceof Date ? d.toLocaleDateString('nl-BE') : '-';
      const weatherStr = r.weather ? formatWeather(r.weather) : '-';
      const maxSpeedStr = formatSpeed(r.maxSpeedKmh);
      return `
        <div class="ride-item" data-id="${r.id}" style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(148,163,184,.2)">
          <div>
            <div style="font-weight:600;color:#f1f5f9;">${dateStr}</div>
            <div style="font-size:.9rem;color:#cbd5e1;">Weer: ${weatherStr} · Max: ${maxSpeedStr}</div>
          </div>
          <button type="button" class="secondary-btn ride-load" data-id="${r.id}">Tonen</button>
        </div>
      `;
    }).join('');
    listEl.innerHTML = items;
    listEl.querySelectorAll('.ride-load').forEach((btn) => {
      btn.addEventListener('click', () => onSelect(btn.getAttribute('data-id')));
    });
  }

  async function refreshRidesUI(db, sortValue, onSelect, currentId) {
    const sortEl = document.getElementById('rides-sort');
    const selectedSort = sortValue || (sortEl ? sortEl.value : 'date-desc');
    try {
      // Zorg dat we (indien mogelijk) ingelogd zijn voordat we lezen
      await ensureFirebaseAuth();
      const rides = await fetchRides(db, selectedSort);
      renderRidesList(rides, async (id) => {
        try {
          await ensureFirebaseAuth();
          const doc = await db.collection('rides').doc(id).get();
          if (!doc.exists) return;
          const data = doc.data();
          if (typeof onSelect === 'function') onSelect(id, data);
        } catch (e) {
          console.error('Rit laden mislukt:', e);
        }
      });
      if (currentId) { highlightRideInList(currentId); }
    } catch (e) {
      console.error('Ritten laden mislukt:', e);
      const listEl = document.getElementById('rides-list');
      if (listEl) listEl.innerHTML = '<p>Kon ritten niet laden uit Firestore.</p>';
    }
  }

  async function deleteRideFromFirestore(db, id) {
    await ensureFirebaseAuth();
    await db.collection('rides').doc(id).delete();
  }

  // Probeer (optioneel) anoniem in te loggen om Firestore-regels die auth vereisen te passeren
  function ensureFirebaseAuth() {
    try {
      if (!window.firebase || !window.firebase.auth) return Promise.resolve();
      const auth = window.firebase.auth();
      if (auth.currentUser) return Promise.resolve();
      return auth.signInAnonymously().catch(() => {});
    } catch (_) {
      return Promise.resolve();
    }
  }

  // Optioneel: klokje updaten indien #current-time bestaat -----------------
  function maybeStartClock() {
    const el = qs('#current-time');
    if (!el) return;
    const update = () => {
      const now = new Date();
      el.textContent = now.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
    };
    update();
    setInterval(update, 60_000);
  }

  // Init -------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    enableSmoothScroll();
    maybeStartClock();
    // probeer alvast anoniem in te loggen (geen fout tonen indien niet geconfigureerd)
    try { ensureFirebaseAuth(); } catch (_) {}

    const mapEl = qs('#map');
    const deleteBtn = qs('#delete-ride-btn');
    let selectedRideId = null; // huidige getoonde Firestore-rit
    const addRideBtn = qs('#add-ride-btn');
    let tracker = null;
    if (mapEl) {
      tracker = initMapboxTracker(mapEl);
    }

    if (tracker) {
      initRideForm(tracker);
    } else if (addRideBtn) {
      // Geen kaart (vaak door ontbrekende token) => knop uitschakelen
      addRideBtn.disabled = true;
      addRideBtn.classList.add('is-disabled');
    }

    // Snelkoppeling vanuit dashboard: open upload direct bij #add of ?add=1
    try {
      const url = new URL(window.location.href);
      const wantsAdd = (url.hash === '#add') || (url.searchParams.get('add') === '1');
      if (wantsAdd && addRideBtn && !addRideBtn.disabled) {
        // kleine delay zodat event listeners en modal klaar zijn
        setTimeout(() => { try { addRideBtn.click(); } catch(_){} }, 80);
      }
      // Directe import vanuit RitTracker: ?rideImport=1 en payload in localStorage
      const wantsRideImport = url.searchParams.get('rideImport') === '1';
      if (wantsRideImport && tracker) {
        try {
          const raw = localStorage.getItem('GPX_RIDE_IMPORT');
          if (raw) {
            const payload = JSON.parse(raw);
            const gpxText = payload && payload.gpxText;
            const suggestedName = (payload && payload.suggestedName) || 'Rit.gpx';
            if (typeof gpxText === 'string' && gpxText.length > 0) {
              // Parse en render zonder modaal; datum uit GPX gebruiken
              const parsed = parseGpxFile(gpxText);
              const startTime = parsed && parsed.stats && parsed.stats.startTime;
              const rideDate = (startTime instanceof Date && !Number.isNaN(startTime.getTime()))
                ? new Date(startTime.getFullYear(), startTime.getMonth(), startTime.getDate())
                : new Date();
              const weather = null; // gebruiker kan later in UI aanpassen indien gewenst
              tracker.renderRide({ fileName: suggestedName, parsed, rideDate, weather });
              // opruimen zodat herladen niet opnieuw importeert
              localStorage.removeItem('GPX_RIDE_IMPORT');
              // Active label instellen
              const label = [rideDate.toLocaleDateString('nl-BE'), 'Rit vanuit tracker', suggestedName].join(' • ');
              setActiveRideLabel(label);
            }
          }
        } catch (e) {
          console.warn('Automatische rit-import mislukt:', e);
        }
      }
    } catch(_) {}

    // Firestore UI initialisatie en sorteren
    const db = getFirestoreDb && getFirestoreDb();
    const sortEl = qs('#rides-sort');
    if (db) {
      const onSelect = (id, data) => {
        if (!tracker) {
          alert('Kaart niet beschikbaar om rit te tonen. Controleer je Mapbox token.');
          return;
        }
        // Parsed object opbouwen uit Firestore-data
        const rawLineCoords = Array.isArray(data.lineCoords) ? data.lineCoords : [];
        let lineCoords = [];
        if (rawLineCoords.length > 0) {
          if (Array.isArray(rawLineCoords[0])) {
            // oude vorm: [[lng,lat], ...]
            lineCoords = rawLineCoords;
          } else if (typeof rawLineCoords[0] === 'object' && rawLineCoords[0] !== null) {
            // nieuwe vorm: [{lng,lat}, ...]
            lineCoords = rawLineCoords
              .map((o) => [Number(o.lng), Number(o.lat)])
              .filter((a) => Number.isFinite(a[0]) && Number.isFinite(a[1]));
          }
        }
        // Trackpunten reconstrueren vanuit sampledPoints indien beschikbaar
        let trackPoints = [];
        if (Array.isArray(data.sampledPoints) && data.sampledPoints.length > 0) {
          trackPoints = data.sampledPoints.map((item) => {
            if (Array.isArray(item)) {
              const [lon, lat, ts, ele] = item;
              return {
                lat: Number(lat),
                lon: Number(lon),
                elevation: Number.isFinite(ele) ? Number(ele) : null,
                time: typeof ts === 'number' ? new Date(ts) : null
              };
            }
            const lon = Number(item.lon);
            const lat = Number(item.lat);
            const ts = typeof item.ts === 'number' ? item.ts : null;
            const ele = Number.isFinite(item.ele) ? Number(item.ele) : null;
            return {
              lat: Number.isFinite(lat) ? lat : null,
              lon: Number.isFinite(lon) ? lon : null,
              elevation: ele,
              time: ts != null ? new Date(ts) : null
            };
          }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
        } else {
          const start = data.startPoint || null;
          const end = data.endPoint || null;
          if (start) trackPoints.push({ lat: start.lat, lon: start.lon, elevation: null, time: null });
          if (end) trackPoints.push({ lat: end.lat, lon: end.lon, elevation: null, time: null });
        }
        // Converteer eventueel Firestore Timestamp naar Date in stats
        const statsFromDb = data.stats || {};
        if (statsFromDb.startTime && typeof statsFromDb.startTime.toDate === 'function') {
          statsFromDb.startTime = statsFromDb.startTime.toDate();
        }
        if (statsFromDb.endTime && typeof statsFromDb.endTime.toDate === 'function') {
          statsFromDb.endTime = statsFromDb.endTime.toDate();
        }

        const parsed = {
          geojsonLine: { type: 'Feature', geometry: { type: 'LineString', coordinates: lineCoords }, properties: {} },
          bounds: data.bounds || { minLng: null, maxLng: null, minLat: null, maxLat: null },
          trackPoints,
          stats: statsFromDb,
          metadata: data.metadata || {}
        };
        const rideDate = data.rideDate && typeof data.rideDate.toDate === 'function' ? data.rideDate.toDate() : data.rideDate;
        tracker.renderRide({
          fileName: data.fileName || 'Rit',
          parsed,
          rideDate,
          weather: data.weather || null,
          source: 'firestore',
          stored: true
        });

        // Activeer centrale verwijderknop voor deze getoonde rit
        selectedRideId = id;
        if (deleteBtn) {
          deleteBtn.disabled = false;
          deleteBtn.title = 'Verwijder de getoonde rit';
          deleteBtn.classList.remove('hidden');
        }

        // Label en lijst-highlight updaten
        const dateStr = (rideDate instanceof Date) ? rideDate.toLocaleDateString('nl-BE') : '';
        const weatherStr = data.weather ? formatWeather(data.weather) : '';
        const label = [dateStr, weatherStr || data.fileName || 'Rit'].filter(Boolean).join(' • ');
        setActiveRideLabel(label);
        highlightRideInList(id);
      };

      refreshRidesUI(db, undefined, onSelect, selectedRideId);
      if (sortEl) sortEl.addEventListener('change', () => refreshRidesUI(db, sortEl.value, onSelect, selectedRideId));

      // Centrale verwijder-actie
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
          if (!selectedRideId) return;
          const ok = window.confirm('Weet je zeker dat je deze rit wilt verwijderen? Dit kan niet ongedaan gemaakt worden.');
          if (!ok) return;
          try {
            await deleteRideFromFirestore(db, selectedRideId);
            // Feedback tonen
            const details = qs('#gpx-details');
            if (details) {
              const p = document.createElement('p');
              p.style.color = '#22c55e';
              p.textContent = 'Rit verwijderd.';
              details.prepend(p);
              setTimeout(() => p.remove(), 3000);
            }
            // UI resetten
            if (tracker && tracker.clearRide) tracker.clearRide();
            selectedRideId = null;
            deleteBtn.disabled = true;
            deleteBtn.title = 'Selecteer eerst een rit uit de lijst';
            deleteBtn.classList.add('hidden');
            clearActiveRideLabel();
            clearRideHighlight();
            // Lijst verversen
            const currentSort = sortEl ? sortEl.value : undefined;
            await refreshRidesUI(db, currentSort, onSelect, selectedRideId);
          } catch (e) {
            console.error('Verwijderen mislukt:', e);
            const details = qs('#gpx-details');
            if (details) {
              const err = document.createElement('p');
              err.style.color = '#ef4444';
              const code = e && (e.code || e.name) ? ` [${e.code || e.name}]` : '';
              const msg = e && e.message ? `: ${e.message}` : '';
              err.textContent = `Verwijderen mislukt${code}${msg}.`;
              details.prepend(err);
              setTimeout(() => err.remove(), 6000);
            }
          }
        });
      }
    } else {
      const listEl = document.getElementById('rides-list');
      if (listEl) listEl.innerHTML = '<p>Configureer Firebase om ritten op te slaan en te tonen.</p>';
  if (deleteBtn) { deleteBtn.disabled = true; deleteBtn.classList.add('hidden'); }
    }
  });
})();