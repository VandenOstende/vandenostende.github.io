/*
  GPX Tracker Dashboard – hoofdscript
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

    const state = {
      markers: [],
      trackSourceId: 'gpx-track-source',
      trackLayerId: 'gpx-track-layer'
    };

    const showMessage = (message) => {
      if (detailsContainer) detailsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;
      if (statsContainer) statsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;
      if (pointsContainer) pointsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;
    };

    const renderRide = ({ fileName, parsed, rideDate, weather }) => {
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
    };

    return { renderRide, showError: showMessage, map, geolocateControl };
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
      totalDistance += haversineDistance(prev, curr);

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
      averageSpeedKmh: averageSpeed
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

    const mapEl = qs('#map');
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
  });
})();console.log('test');// Smooth scroll functionaliteit// Smooth scroll functionaliteit


document.addEventListener('DOMContentLoaded', () => {document.addEventListener('DOMContentLoaded', () => {

    const navLinks = document.querySelectorAll('a[href^="#"]');    const navLinks = document.querySelectorAll('a[href^="#"]');

    navLinks.forEach((link) => {    navLinks.forEach((link) => {

        link.addEventListener('click', (event) => {        link.addEventListener('click', (event) => {

            event.preventDefault();            event.preventDefault();

            const targetId = link.getAttribute('href');            const targetId = link.getAttribute('href');

            if (targetId === '#') {            if (targetId === '#') {

                return;                return;

            }            }



            const targetElement = document.querySelector(targetId);            const targetElement = document.querySelector(targetId);

            if (targetElement) {            if (targetElement) {

                targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });                targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });

            }            }

        });        });

    });    });



    const observerOptions = {    const observerOptions = {

        threshold: 0.1,        threshold: 0.1,

        rootMargin: '0px 0px -100px 0px'        rootMargin: '0px 0px -100px 0px'

    };    };



    const observer = new IntersectionObserver((entries) => {    const observer = new IntersectionObserver((entries) => {

        entries.forEach((entry) => {        entries.forEach((entry) => {

            if (entry.isIntersecting) {            if (entry.isIntersecting) {

                entry.target.style.animation = 'fadeInUp 0.6s ease-out forwards';                entry.target.style.animation = 'fadeInUp 0.6s ease-out forwards';

                observer.unobserve(entry.target);                observer.unobserve(entry.target);

            }            }

        });        });

    }, observerOptions);    }, observerOptions);



    const appCards = document.querySelectorAll('.app-card');    const appCards = document.querySelectorAll('.app-card');

    appCards.forEach((card) => {    appCards.forEach((card) => {

        card.style.opacity = '0';        card.style.opacity = '0';

        observer.observe(card);        observer.observe(card);

    });    });



    appCards.forEach((card) => {    appCards.forEach((card) => {

        card.addEventListener('click', (event) => {        card.addEventListener('click', (event) => {

            if (event.target.tagName !== 'A') {            if (event.target.tagName !== 'A') {

                const link = card.querySelector('.cta-button');                const link = card.querySelector('.cta-button');

                if (link) {                if (link) {

                    window.location.href = link.getAttribute('href');                    window.location.href = link.getAttribute('href');

                }                }

            }            }

        });        });

    });    });



    let mouseX = 0;    let mouseX = 0;

    let mouseY = 0;    let mouseY = 0;

    let currentX = 0;    let currentX = 0;

    let currentY = 0;    let currentY = 0;



    document.addEventListener('mousemove', (event) => {    document.addEventListener('mousemove', (event) => {

        mouseX = event.clientX / window.innerWidth - 0.5;        mouseX = event.clientX / window.innerWidth - 0.5;

        mouseY = event.clientY / window.innerHeight - 0.5;        mouseY = event.clientY / window.innerHeight - 0.5;

    });    });



    function animate() {    function animate() {

        currentX += (mouseX - currentX) * 0.1;        currentX += (mouseX - currentX) * 0.1;

        currentY += (mouseY - currentY) * 0.1;        currentY += (mouseY - currentY) * 0.1;



        const shapes = document.querySelectorAll('.floating-shape');        const shapes = document.querySelectorAll('.floating-shape');

        shapes.forEach((shape, index) => {        shapes.forEach((shape, index) => {

            const speed = (index + 1) * 20;            const speed = (index + 1) * 20;

            shape.style.transform = `translate(${currentX * speed}px, ${currentY * speed}px)`;            shape.style.transform = `translate(${currentX * speed}px, ${currentY * speed}px)`;

        });        });



        requestAnimationFrame(animate);        requestAnimationFrame(animate);

    }    }



    animate();    animate();



    const subtitle = document.querySelector('.hero p');    const subtitle = document.querySelector('.hero p');

    if (subtitle) {    if (subtitle) {

        const text = subtitle.textContent;        const text = subtitle.textContent;

        subtitle.textContent = '';        subtitle.textContent = '';

        let i = 0;        let i = 0;



        function typeWriter() {        function typeWriter() {

            if (i < text.length) {            if (i < text.length) {

                subtitle.textContent += text.charAt(i);                subtitle.textContent += text.charAt(i);

                i += 1;                i += 1;

                setTimeout(typeWriter, 50);                setTimeout(typeWriter, 50);

            }            }

        }        }



        setTimeout(typeWriter, 1000);        setTimeout(typeWriter, 1000);

    }    }



    const header = document.querySelector('header');    const header = document.querySelector('header');

    window.addEventListener('scroll', () => {    window.addEventListener('scroll', () => {

        const currentScroll = window.pageYOffset;        const currentScroll = window.pageYOffset;



        if (currentScroll > 100) {        if (currentScroll > 100) {

            header.style.background = 'rgba(30, 41, 59, 0.95)';            header.style.background = 'rgba(30, 41, 59, 0.95)';

            header.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.3)';            header.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.3)';

        } else {        } else {

            header.style.background = 'rgba(30, 41, 59, 0.3)';            header.style.background = 'rgba(30, 41, 59, 0.3)';

            header.style.boxShadow = 'none';            header.style.boxShadow = 'none';

        }        }

    });    });



    const mapContainer = document.getElementById('map');    const mapContainer = document.getElementById('map');

    let tracker = null;    let tracker = null;

    if (mapContainer) {    if (mapContainer) {

        tracker = initMapboxTracker(mapContainer);        tracker = initMapboxTracker(mapContainer);

    }    }



    const addRideBtn = document.getElementById('add-ride-btn');    const addRideBtn = document.getElementById('add-ride-btn');

    if (tracker) {    if (tracker) {

        initRideForm(tracker);        initRideForm(tracker);

    } else if (addRideBtn) {    } else if (addRideBtn) {

        addRideBtn.disabled = true;        addRideBtn.disabled = true;

        addRideBtn.classList.add('is-disabled');        addRideBtn.classList.add('is-disabled');

    }    }

});});



function updateTime() {function updateTime() {

    const now = new Date();    const now = new Date();

    const timeString = now.toLocaleTimeString('nl-BE', {    const timeString = now.toLocaleTimeString('nl-BE', {

        hour: '2-digit',        hour: '2-digit',

        minute: '2-digit'        minute: '2-digit'

    });    });



    const timeElement = document.getElementById('current-time');    const timeElement = document.getElementById('current-time');

    if (timeElement) {    if (timeElement) {

        timeElement.textContent = timeString;        timeElement.textContent = timeString;

    }    }

}}



setInterval(updateTime, 60000);setInterval(updateTime, 60000);

updateTime();updateTime();



function initMapboxTracker(mapContainer) {function initMapboxTracker(mapContainer) {

    const detailsContainer = document.getElementById('gpx-details');    const detailsContainer = document.getElementById('gpx-details');

    const statsContainer = document.getElementById('gpx-stats');    const statsContainer = document.getElementById('gpx-stats');

    const pointsContainer = document.getElementById('gpx-points');    const pointsContainer = document.getElementById('gpx-points');



    const accessToken = window.MAPBOX_ACCESS_TOKEN;    const accessToken = window.MAPBOX_ACCESS_TOKEN;

    if (!accessToken || accessToken === 'VUL_HIER_JE_MAPBOX_ACCESS_TOKEN_IN') {    if (!accessToken || accessToken === 'VUL_HIER_JE_MAPBOX_ACCESS_TOKEN_IN') {

        const message = 'Voeg een geldige Mapbox access token toe in GPXTracker.html om de kaart te laden.';        const message = 'Voeg een geldige Mapbox access token toe in GPXTracker.html om de kaart te laden.';

        mapContainer.innerHTML = `<p style="padding: 16px;">${escapeHtml(message)}</p>`;        mapContainer.innerHTML = `<p style="padding: 16px;">${escapeHtml(message)}</p>`;

        if (detailsContainer) {        if (detailsContainer) {

            detailsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;            detailsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;

        }        }

        if (statsContainer) {        if (statsContainer) {

            statsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;            statsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;

        }        }

        if (pointsContainer) {        if (pointsContainer) {

            pointsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;            pointsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;

        }        }

        return null;        return null;

    }    }



    mapboxgl.accessToken = accessToken;    mapboxgl.accessToken = accessToken;



    const map = new mapboxgl.Map({    const map = new mapboxgl.Map({

        container: mapContainer,        container: mapContainer,

        style: 'mapbox://styles/mapbox/standard',        style: 'mapbox://styles/mapbox/standard',

        center: [4.75, 51.25],        center: [4.75, 51.25],

        zoom: 8.5,        zoom: 8.5,

        attributionControl: true        attributionControl: true

    });    });



    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');

    map.addControl(new mapboxgl.ScaleControl({ maxWidth: 150, unit: 'metric' }));    map.addControl(new mapboxgl.ScaleControl({ maxWidth: 150, unit: 'metric' }));

    map.addControl(new mapboxgl.FullscreenControl());    map.addControl(new mapboxgl.FullscreenControl());

    const geolocateControl = new mapboxgl.GeolocateControl({    const geolocateControl = new mapboxgl.GeolocateControl({

        positionOptions: {        positionOptions: {

            enableHighAccuracy: true            enableHighAccuracy: true

        },        },

        trackUserLocation: true,        trackUserLocation: true,

        showUserHeading: true        showUserHeading: true

    });    });

    map.addControl(geolocateControl, 'top-right');    map.addControl(geolocateControl, 'top-right');



    const state = {    const state = {

        markers: [],        markers: [],

        trackSourceId: 'gpx-track-source',        trackSourceId: 'gpx-track-source',

        trackLayerId: 'gpx-track-layer',        trackLayerId: 'gpx-track-layer',

        styleReady: false        styleReady: false

    };    };



    map.on('load', () => {    map.on('load', () => {

        state.styleReady = true;        state.styleReady = true;

        map.resize();        map.resize();

    });    });



    const showMessage = (message) => {    const showMessage = (message) => {

        if (detailsContainer) {        if (detailsContainer) {

            detailsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;            detailsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;

        }        }

        if (statsContainer) {        if (statsContainer) {

            statsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;            statsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;

        }        }

        if (pointsContainer) {        if (pointsContainer) {

            pointsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;            pointsContainer.innerHTML = `<p>${escapeHtml(message)}</p>`;

        }        }

    };    };



    const renderRide = ({ fileName, parsed, rideDate, weather }) => {    const renderRide = ({ fileName, parsed, rideDate, weather }) => {

        if (!parsed) {        if (!parsed) {

            showMessage('Geen gegevens beschikbaar voor deze rit.');            showMessage('Geen gegevens beschikbaar voor deze rit.');

            return;            return;

        }        }



        renderMapData(map, state, parsed.geojsonLine, parsed.bounds, parsed.trackPoints);        renderMapData(map, state, parsed.geojsonLine, parsed.bounds, parsed.trackPoints);

        renderTrackInsights({        renderTrackInsights({

            fileName,            fileName,

            metadata: parsed.metadata,            metadata: parsed.metadata,

            stats: parsed.stats,            stats: parsed.stats,

            trackPoints: parsed.trackPoints,            trackPoints: parsed.trackPoints,

            rideDate,            rideDate,

            weather,            weather,

            detailsContainer,            detailsContainer,

            statsContainer,            statsContainer,

            pointsContainer            pointsContainer

        });        });

    };    };



    return {    return {

        renderRide,        renderRide,

        showError: showMessage,        showError: showMessage,

        map,        map,

        geolocateControl        geolocateControl

    };    };

}}



function initRideForm(tracker) {function initRideForm(tracker) {

    const addRideBtn = document.getElementById('add-ride-btn');    const addRideBtn = document.getElementById('add-ride-btn');

    const modal = document.getElementById('ride-modal');    const modal = document.getElementById('ride-modal');

    const backdrop = document.getElementById('modal-backdrop');    const backdrop = document.getElementById('modal-backdrop');

    const closeBtn = document.getElementById('ride-modal-close');    const closeBtn = document.getElementById('ride-modal-close');

    const cancelBtn = document.getElementById('ride-cancel-btn');    const cancelBtn = document.getElementById('ride-cancel-btn');

    const form = document.getElementById('ride-form');    const form = document.getElementById('ride-form');

    const fileInput = document.getElementById('ride-gpx-file');    const fileInput = document.getElementById('ride-gpx-file');

    const dateInput = document.getElementById('ride-date');    const dateInput = document.getElementById('ride-date');

    const errorContainer = document.getElementById('ride-form-error');    const errorContainer = document.getElementById('ride-form-error');



    if (!addRideBtn || !modal || !backdrop || !closeBtn || !cancelBtn || !form || !fileInput || !dateInput || !errorContainer) {    if (!addRideBtn || !modal || !backdrop || !closeBtn || !cancelBtn || !form || !fileInput || !dateInput || !errorContainer) {

        tracker.showError('Formulierelementen ontbreken in de pagina.');        tracker.showError('Formulierelementen ontbreken in de pagina.');

        return;        return;

    }    }



    let parsedResult = null; // Cache het geparste resultaat voor snelle submit.    let parsedResult = null; // Cache het geparste resultaat voor snelle submit.



    const resetForm = () => {    const resetForm = () => {

        form.reset();        form.reset();

        dateInput.value = '';        dateInput.value = '';

        if (fileInput.value) {        if (fileInput.value) {

            fileInput.value = '';            fileInput.value = '';

        }        }

        errorContainer.textContent = '';        errorContainer.textContent = '';

        parsedResult = null;        parsedResult = null;

    };    };



    const openModal = () => {    const openModal = () => {

        resetForm();        resetForm();

        modal.classList.remove('hidden');        modal.classList.remove('hidden');

        backdrop.classList.remove('hidden');        backdrop.classList.remove('hidden');

        modal.setAttribute('aria-hidden', 'false');        modal.setAttribute('aria-hidden', 'false');

        backdrop.setAttribute('aria-hidden', 'false');        backdrop.setAttribute('aria-hidden', 'false');

        document.body.classList.add('modal-open');        document.body.classList.add('modal-open');

        setTimeout(() => fileInput.focus(), 50);        setTimeout(() => fileInput.focus(), 50);

    };    };



    const closeModal = () => {    const closeModal = () => {

        modal.classList.add('hidden');        modal.classList.add('hidden');

        backdrop.classList.add('hidden');        backdrop.classList.add('hidden');

        modal.setAttribute('aria-hidden', 'true');        modal.setAttribute('aria-hidden', 'true');

        backdrop.setAttribute('aria-hidden', 'true');        backdrop.setAttribute('aria-hidden', 'true');

        document.body.classList.remove('modal-open');        document.body.classList.remove('modal-open');

        resetForm();        resetForm();

        addRideBtn.focus();        addRideBtn.focus();

    };    };



    const handleKeydown = (event) => {    const handleKeydown = (event) => {

        if (event.key === 'Escape' && !modal.classList.contains('hidden')) {        if (event.key === 'Escape' && !modal.classList.contains('hidden')) {

            closeModal();            closeModal();

        }        }

    };    };



    addRideBtn.addEventListener('click', openModal);    addRideBtn.addEventListener('click', openModal);

    closeBtn.addEventListener('click', closeModal);    closeBtn.addEventListener('click', closeModal);

    cancelBtn.addEventListener('click', closeModal);    cancelBtn.addEventListener('click', closeModal);

    backdrop.addEventListener('click', (event) => {    backdrop.addEventListener('click', (event) => {

        if (event.target === backdrop) {        if (event.target === backdrop) {

            closeModal();            closeModal();

        }        }

    });    });

    document.addEventListener('keydown', handleKeydown);    document.addEventListener('keydown', handleKeydown);



    fileInput.addEventListener('change', (event) => {    fileInput.addEventListener('change', (event) => {

        parsedResult = null;        parsedResult = null;

        errorContainer.textContent = '';        errorContainer.textContent = '';

        const file = event.target.files && event.target.files[0];        const file = event.target.files && event.target.files[0];



        if (!file) {        if (!file) {

            dateInput.value = '';            dateInput.value = '';

            return;            return;

        }        }



        if (!file.name.toLowerCase().endsWith('.gpx')) {        if (!file.name.toLowerCase().endsWith('.gpx')) {

            errorContainer.textContent = 'Het geselecteerde bestand is geen geldig GPX-bestand.';            errorContainer.textContent = 'Het geselecteerde bestand is geen geldig GPX-bestand.';

            fileInput.value = '';            fileInput.value = '';

            dateInput.value = '';            dateInput.value = '';

            return;            return;

        }        }



        const reader = new FileReader();        const reader = new FileReader();

        reader.onload = (loadEvent) => {        reader.onload = (loadEvent) => {

            const gpxText = loadEvent.target && loadEvent.target.result;            const gpxText = loadEvent.target && loadEvent.target.result;

            if (typeof gpxText !== 'string') {            if (typeof gpxText !== 'string') {

                errorContainer.textContent = 'Kon het GPX-bestand niet lezen.';                errorContainer.textContent = 'Kon het GPX-bestand niet lezen.';

                return;                return;

            }            }



            try {            try {

                const parsed = parseGpxFile(gpxText);                const parsed = parseGpxFile(gpxText);

                parsedResult = { file, parsed };                parsedResult = { file, parsed };

                const startTime = parsed.stats.startTime;                const startTime = parsed.stats.startTime;

                if (startTime instanceof Date && !Number.isNaN(startTime.getTime())) {                if (startTime instanceof Date && !Number.isNaN(startTime.getTime())) {

                    dateInput.value = formatDateForInput(startTime);                    dateInput.value = formatDateForInput(startTime);

                }                }

                errorContainer.textContent = '';                errorContainer.textContent = '';

            } catch (error) {            } catch (error) {

                parsedResult = null;                parsedResult = null;

                errorContainer.textContent = error.message || 'Er ging iets mis bij het verwerken van het GPX-bestand.';                errorContainer.textContent = error.message || 'Er ging iets mis bij het verwerken van het GPX-bestand.';

            }            }

        };        };

        reader.onerror = () => {        reader.onerror = () => {

            parsedResult = null;            parsedResult = null;

            errorContainer.textContent = 'Het GPX-bestand kon niet worden ingelezen.';            errorContainer.textContent = 'Het GPX-bestand kon niet worden ingelezen.';

        };        };

        reader.readAsText(file);        reader.readAsText(file);

    });    });



    form.addEventListener('submit', (event) => {    form.addEventListener('submit', (event) => {

        event.preventDefault();        event.preventDefault();

        errorContainer.textContent = '';        errorContainer.textContent = '';



        const file = fileInput.files && fileInput.files[0];        const file = fileInput.files && fileInput.files[0];

        if (!file) {        if (!file) {

            errorContainer.textContent = 'Selecteer een GPX-bestand.';            errorContainer.textContent = 'Selecteer een GPX-bestand.';

            return;            return;

        }        }



        if (!parsedResult || parsedResult.file !== file) {        if (!parsedResult || parsedResult.file !== file) {

            errorContainer.textContent = 'Het GPX-bestand wordt nog verwerkt. Wacht even en probeer opnieuw.';            errorContainer.textContent = 'Het GPX-bestand wordt nog verwerkt. Wacht even en probeer opnieuw.';

            return;            return;

        }        }



        const dateValue = dateInput.value;        const dateValue = dateInput.value;

        if (!dateValue) {        if (!dateValue) {

            errorContainer.textContent = 'Vul de datum van de rit in.';            errorContainer.textContent = 'Vul de datum van de rit in.';

            return;            return;

        }        }



        const weatherInput = form.querySelector('input[name="ride-weather"]:checked');        const weatherInput = form.querySelector('input[name="ride-weather"]:checked');

        if (!weatherInput) {        if (!weatherInput) {

            errorContainer.textContent = 'Selecteer de weersomstandigheden.';            errorContainer.textContent = 'Selecteer de weersomstandigheden.';

            return;            return;

        }        }



        const rideDate = new Date(`${dateValue}T00:00:00`);        const rideDate = new Date(`${dateValue}T00:00:00`);

        const weather = weatherInput.value;        const weather = weatherInput.value;



        try {        try {

            tracker.renderRide({            tracker.renderRide({

                fileName: file.name,                fileName: file.name,

                parsed: parsedResult.parsed,                parsed: parsedResult.parsed,

                rideDate,                rideDate,

                weather                weather

            });            });

            closeModal();            closeModal();

        } catch (error) {        } catch (error) {

            console.error(error);            console.error(error);

            const message = error.message || 'Kon de fietsrit niet verwerken.';            const message = error.message || 'Kon de fietsrit niet verwerken.';

            errorContainer.textContent = message;            errorContainer.textContent = message;

            tracker.showError(message);            tracker.showError(message);

        }        }

    });    });

}}



function parseGpxFile(gpxText) {function parseGpxFile(gpxText) {

    const parser = new DOMParser();    const parser = new DOMParser();

    const xml = parser.parseFromString(gpxText, 'text/xml');    const xml = parser.parseFromString(gpxText, 'text/xml');

    if (xml.getElementsByTagName('parsererror').length > 0) {    if (xml.getElementsByTagName('parsererror').length > 0) {

        throw new Error('Het GPX-bestand bevat een syntaxisfout.');        throw new Error('Het GPX-bestand bevat een syntaxisfout.');

    }    }



    if (!window.toGeoJSON || !window.toGeoJSON.gpx) {    if (!window.toGeoJSON || !window.toGeoJSON.gpx) {

        throw new Error('De toGeoJSON-bibliotheek is niet beschikbaar.');        throw new Error('De toGeoJSON-bibliotheek is niet beschikbaar.');

    }    }



    const geojson = window.toGeoJSON.gpx(xml);    const geojson = window.toGeoJSON.gpx(xml);

    if (!geojson || !Array.isArray(geojson.features) || geojson.features.length === 0) {    if (!geojson || !Array.isArray(geojson.features) || geojson.features.length === 0) {

        throw new Error('Geen geometrie gevonden in het GPX-bestand.');        throw new Error('Geen geometrie gevonden in het GPX-bestand.');

    }    }



    const lineCoordinates = collectLineCoordinates(geojson.features);    const lineCoordinates = collectLineCoordinates(geojson.features);

    if (lineCoordinates.length === 0) {    if (lineCoordinates.length === 0) {

        throw new Error('Geen lijninformatie gevonden in het GPX-bestand.');        throw new Error('Geen lijninformatie gevonden in het GPX-bestand.');

    }    }



    const trackPoints = extractTrackPoints(xml);    const trackPoints = extractTrackPoints(xml);

    if (trackPoints.length === 0) {    if (trackPoints.length === 0) {

        throw new Error('Geen trackpunten gevonden in het GPX-bestand.');        throw new Error('Geen trackpunten gevonden in het GPX-bestand.');

    }    }



    const bounds = computeBounds(lineCoordinates);    const bounds = computeBounds(lineCoordinates);

    const stats = calculateTrackStats(trackPoints);    const stats = calculateTrackStats(trackPoints);

    const metadata = extractMetadata(xml);    const metadata = extractMetadata(xml);



    return {    return {

        geojsonLine: {        geojsonLine: {

            type: 'Feature',            type: 'Feature',

            geometry: {            geometry: {

                type: 'LineString',                type: 'LineString',

                coordinates: lineCoordinates                coordinates: lineCoordinates

            },            },

            properties: {}            properties: {}

        },        },

        bounds,        bounds,

        trackPoints,        trackPoints,

        stats,        stats,

        metadata        metadata

    };    };

}}



function collectLineCoordinates(features) {function collectLineCoordinates(features) {

    const coords = [];    const coords = [];

    features.forEach((feature) => {    features.forEach((feature) => {

        if (!feature.geometry) {        if (!feature.geometry) {

            return;            return;

        }        }

        if (feature.geometry.type === 'LineString') {        if (feature.geometry.type === 'LineString') {

            feature.geometry.coordinates.forEach((coordinate) => coords.push(coordinate));            feature.geometry.coordinates.forEach((coordinate) => coords.push(coordinate));

        } else if (feature.geometry.type === 'MultiLineString') {        } else if (feature.geometry.type === 'MultiLineString') {

            feature.geometry.coordinates.forEach((line) => {            feature.geometry.coordinates.forEach((line) => {

                line.forEach((coordinate) => coords.push(coordinate));                line.forEach((coordinate) => coords.push(coordinate));

            });            });

        }        }

    });    });

    return coords;    return coords;

}}



function extractTrackPoints(xml) {function extractTrackPoints(xml) {

    const nodes = Array.from(xml.getElementsByTagName('trkpt'));    const nodes = Array.from(xml.getElementsByTagName('trkpt'));

    return nodes    return nodes

        .map((node) => {        .map((node) => {

            const lat = parseFloat(node.getAttribute('lat'));            const lat = parseFloat(node.getAttribute('lat'));

            const lon = parseFloat(node.getAttribute('lon'));            const lon = parseFloat(node.getAttribute('lon'));

            const eleNode = node.getElementsByTagName('ele')[0];            const eleNode = node.getElementsByTagName('ele')[0];

            const timeNode = node.getElementsByTagName('time')[0];            const timeNode = node.getElementsByTagName('time')[0];

            const elevation = eleNode ? parseFloat(eleNode.textContent) : null;            const elevation = eleNode ? parseFloat(eleNode.textContent) : null;

            const timeString = timeNode ? timeNode.textContent : null;            const timeString = timeNode ? timeNode.textContent : null;

            const time = timeString ? new Date(timeString) : null;            const time = timeString ? new Date(timeString) : null;

            return {            return {

                lat,                lat,

                lon,                lon,

                elevation: Number.isFinite(elevation) ? elevation : null,                elevation: Number.isFinite(elevation) ? elevation : null,

                time: time instanceof Date && !Number.isNaN(time.getTime()) ? time : null                time: time instanceof Date && !Number.isNaN(time.getTime()) ? time : null

            };            };

        })        })

        .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));        .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));

}}



function computeBounds(coordinates) {function computeBounds(coordinates) {

    const initial = {    const initial = {

        minLng: Infinity,        minLng: Infinity,

        maxLng: -Infinity,        maxLng: -Infinity,

        minLat: Infinity,        minLat: Infinity,

        maxLat: -Infinity        maxLat: -Infinity

    };    };



    const reduced = coordinates.reduce((acc, [lng, lat]) => {    const reduced = coordinates.reduce((acc, [lng, lat]) => {

        if (Number.isFinite(lng) && Number.isFinite(lat)) {        if (Number.isFinite(lng) && Number.isFinite(lat)) {

            acc.minLng = Math.min(acc.minLng, lng);            acc.minLng = Math.min(acc.minLng, lng);

            acc.maxLng = Math.max(acc.maxLng, lng);            acc.maxLng = Math.max(acc.maxLng, lng);

            acc.minLat = Math.min(acc.minLat, lat);            acc.minLat = Math.min(acc.minLat, lat);

            acc.maxLat = Math.max(acc.maxLat, lat);            acc.maxLat = Math.max(acc.maxLat, lat);

        }        }

        return acc;        return acc;

    }, initial);    }, initial);



    return reduced;    return reduced;

}}



function calculateTrackStats(points) {function calculateTrackStats(points) {

    if (points.length < 2) {    if (points.length < 2) {

        return {        return {

            totalDistanceKm: 0,            totalDistanceKm: 0,

            totalAscent: 0,            totalAscent: 0,

            totalDescent: 0,            totalDescent: 0,

            minElevation: null,            minElevation: null,

            maxElevation: null,            maxElevation: null,

            startTime: points[0] ? points[0].time : null,            startTime: points[0] ? points[0].time : null,

            endTime: points[0] ? points[0].time : null,            endTime: points[0] ? points[0].time : null,

            durationMs: 0,            durationMs: 0,

            averageSpeedKmh: null            averageSpeedKmh: null

        };        };

    }    }



    let totalDistance = 0;    let totalDistance = 0;

    let totalAscent = 0;    let totalAscent = 0;

    let totalDescent = 0;    let totalDescent = 0;

    let minElevation = Infinity;    let minElevation = Infinity;

    let maxElevation = -Infinity;    let maxElevation = -Infinity;



    if (Number.isFinite(points[0].elevation)) {    if (Number.isFinite(points[0].elevation)) {

        minElevation = Math.min(minElevation, points[0].elevation);        minElevation = Math.min(minElevation, points[0].elevation);

        maxElevation = Math.max(maxElevation, points[0].elevation);        maxElevation = Math.max(maxElevation, points[0].elevation);

    }    }



    const firstWithTime = points.find((point) => point.time);    const firstWithTime = points.find((point) => point.time);

    const lastWithTime = [...points].reverse().find((point) => point.time);    const lastWithTime = [...points].reverse().find((point) => point.time);

    const startTime = firstWithTime ? firstWithTime.time : null;    const startTime = firstWithTime ? firstWithTime.time : null;

    const endTime = lastWithTime ? lastWithTime.time : null;    const endTime = lastWithTime ? lastWithTime.time : null;



    for (let i = 1; i < points.length; i += 1) {    for (let i = 1; i < points.length; i += 1) {

        const prev = points[i - 1];        const prev = points[i - 1];

        const curr = points[i];        const curr = points[i];

        totalDistance += haversineDistance(prev, curr);        totalDistance += haversineDistance(prev, curr);



        if (Number.isFinite(curr.elevation)) {        if (Number.isFinite(curr.elevation)) {

            minElevation = Math.min(minElevation, curr.elevation);            minElevation = Math.min(minElevation, curr.elevation);

            maxElevation = Math.max(maxElevation, curr.elevation);            maxElevation = Math.max(maxElevation, curr.elevation);

        }        }

        if (Number.isFinite(prev.elevation) && Number.isFinite(curr.elevation)) {        if (Number.isFinite(prev.elevation) && Number.isFinite(curr.elevation)) {

            const delta = curr.elevation - prev.elevation;            const delta = curr.elevation - prev.elevation;

            if (delta > 0) {            if (delta > 0) {

                totalAscent += delta;                totalAscent += delta;

            } else {            } else {

                totalDescent += Math.abs(delta);                totalDescent += Math.abs(delta);

            }            }

        }        }

    }    }



    const durationMs = startTime && endTime ? Math.max(0, endTime.getTime() - startTime.getTime()) : null;    const durationMs = startTime && endTime ? Math.max(0, endTime.getTime() - startTime.getTime()) : null;

    const durationHours = typeof durationMs === 'number' && durationMs > 0 ? durationMs / (1000 * 60 * 60) : null;    const durationHours = typeof durationMs === 'number' && durationMs > 0 ? durationMs / (1000 * 60 * 60) : null;

    const averageSpeed = durationHours && durationHours > 0 ? totalDistance / durationHours : null;    const averageSpeed = durationHours && durationHours > 0 ? totalDistance / durationHours : null;



    return {    return {

        totalDistanceKm: totalDistance,        totalDistanceKm: totalDistance,

        totalAscent,        totalAscent,

        totalDescent,        totalDescent,

        minElevation: Number.isFinite(minElevation) ? minElevation : null,        minElevation: Number.isFinite(minElevation) ? minElevation : null,

        maxElevation: Number.isFinite(maxElevation) ? maxElevation : null,        maxElevation: Number.isFinite(maxElevation) ? maxElevation : null,

        startTime,        startTime,

        endTime,        endTime,

        durationMs,        durationMs,

        averageSpeedKmh: averageSpeed        averageSpeedKmh: averageSpeed

    };    };

}}



function haversineDistance(a, b) {function haversineDistance(a, b) {

    const toRadians = (value) => value * (Math.PI / 180);    const toRadians = (value) => value * (Math.PI / 180);

    const earthRadiusKm = 6371;    const earthRadiusKm = 6371;



    const lat1 = toRadians(a.lat);    const lat1 = toRadians(a.lat);

    const lat2 = toRadians(b.lat);    const lat2 = toRadians(b.lat);

    const deltaLat = toRadians(b.lat - a.lat);    const deltaLat = toRadians(b.lat - a.lat);

    const deltaLon = toRadians(b.lon - a.lon);    const deltaLon = toRadians(b.lon - a.lon);



    const sinLat = Math.sin(deltaLat / 2);    const sinLat = Math.sin(deltaLat / 2);

    const sinLon = Math.sin(deltaLon / 2);    const sinLon = Math.sin(deltaLon / 2);



    const c = 2 * Math.atan2(    const c = 2 * Math.atan2(

        Math.sqrt(sinLat ** 2 + Math.cos(lat1) * Math.cos(lat2) * sinLon ** 2),        Math.sqrt(sinLat ** 2 + Math.cos(lat1) * Math.cos(lat2) * sinLon ** 2),

        Math.sqrt(1 - (sinLat ** 2 + Math.cos(lat1) * Math.cos(lat2) * sinLon ** 2))        Math.sqrt(1 - (sinLat ** 2 + Math.cos(lat1) * Math.cos(lat2) * sinLon ** 2))

    );    );



    return earthRadiusKm * c;    return earthRadiusKm * c;

}}



function extractMetadata(xml) {function extractMetadata(xml) {

    const getText = (tagName) => {    const getText = (tagName) => {

        const node = xml.getElementsByTagName(tagName)[0];        const node = xml.getElementsByTagName(tagName)[0];

        return node ? node.textContent : null;        return node ? node.textContent : null;

    };    };



    return {    return {

        name: getText('name'),        name: getText('name'),

        description: getText('desc') || getText('description') || null,        description: getText('desc') || getText('description') || null,

        author: getText('author')        author: getText('author')

    };    };

}}



function renderMapData(map, state, geojsonLine, bounds, trackPoints) {function renderMapData(map, state, geojsonLine, bounds, trackPoints) {

    const applyData = () => {    const applyData = () => {

        if (map.getLayer(state.trackLayerId)) {        if (map.getLayer(state.trackLayerId)) {

            map.removeLayer(state.trackLayerId);            map.removeLayer(state.trackLayerId);

        }        }

        if (map.getSource(state.trackSourceId)) {        if (map.getSource(state.trackSourceId)) {

            map.removeSource(state.trackSourceId);            map.removeSource(state.trackSourceId);

        }        }



        map.addSource(state.trackSourceId, {        map.addSource(state.trackSourceId, {

            type: 'geojson',            type: 'geojson',

            data: {            data: {

                type: 'FeatureCollection',                type: 'FeatureCollection',

                features: [geojsonLine]                features: [geojsonLine]

            }            }

        });        });



        map.addLayer({        map.addLayer({

            id: state.trackLayerId,            id: state.trackLayerId,

            type: 'line',            type: 'line',

            source: state.trackSourceId,            source: state.trackSourceId,

            layout: {            layout: {

                'line-join': 'round',                'line-join': 'round',

                'line-cap': 'round'                'line-cap': 'round'

            },            },

            paint: {            paint: {

                'line-color': '#60a5fa',                'line-color': '#60a5fa',

                'line-width': 4,                'line-width': 4,

                'line-opacity': 0.9                'line-opacity': 0.9

            }            }

        });        });



        state.markers.forEach((marker) => marker.remove());        state.markers.forEach((marker) => marker.remove());

        state.markers = [];        state.markers = [];



        if (trackPoints.length > 0) {        if (trackPoints.length > 0) {

            const startPoint = trackPoints[0];            const startPoint = trackPoints[0];

            const endPoint = trackPoints[trackPoints.length - 1];            const endPoint = trackPoints[trackPoints.length - 1];

            state.markers.push(            state.markers.push(

                new mapboxgl.Marker({ color: '#22c55e' })                new mapboxgl.Marker({ color: '#22c55e' })

                    .setLngLat([startPoint.lon, startPoint.lat])                    .setLngLat([startPoint.lon, startPoint.lat])

                    .setPopup(new mapboxgl.Popup({ offset: 12 }).setHTML('<strong>Start</strong>'))                    .setPopup(new mapboxgl.Popup({ offset: 12 }).setHTML('<strong>Start</strong>'))

                    .addTo(map)                    .addTo(map)

            );            );

            state.markers.push(            state.markers.push(

                new mapboxgl.Marker({ color: '#ef4444' })                new mapboxgl.Marker({ color: '#ef4444' })

                    .setLngLat([endPoint.lon, endPoint.lat])                    .setLngLat([endPoint.lon, endPoint.lat])

                    .setPopup(new mapboxgl.Popup({ offset: 12 }).setHTML('<strong>Finish</strong>'))                    .setPopup(new mapboxgl.Popup({ offset: 12 }).setHTML('<strong>Finish</strong>'))

                    .addTo(map)                    .addTo(map)

            );            );

        }        }



        const hasBounds =        const hasBounds =

            Number.isFinite(bounds.minLng) &&            Number.isFinite(bounds.minLng) &&

            Number.isFinite(bounds.maxLng) &&            Number.isFinite(bounds.maxLng) &&

            Number.isFinite(bounds.minLat) &&            Number.isFinite(bounds.minLat) &&

            Number.isFinite(bounds.maxLat);            Number.isFinite(bounds.maxLat);

        if (hasBounds) {        if (hasBounds) {

            const lngLatBounds = new mapboxgl.LngLatBounds(            const lngLatBounds = new mapboxgl.LngLatBounds(

                [bounds.minLng, bounds.minLat],                [bounds.minLng, bounds.minLat],

                [bounds.maxLng, bounds.maxLat]                [bounds.maxLng, bounds.maxLat]

            );            );

            map.fitBounds(lngLatBounds, { padding: 60, maxZoom: 15, duration: 1000 });            map.fitBounds(lngLatBounds, { padding: 60, maxZoom: 15, duration: 1000 });

        }        }

    };    };



    if (map.isStyleLoaded()) {    if (map.isStyleLoaded()) {

        applyData();        applyData();

    } else {    } else {

        map.once('load', applyData);        map.once('load', applyData);

    }    }

}}



function renderTrackInsights({ fileName, metadata, stats, trackPoints, rideDate, weather, detailsContainer, statsContainer, pointsContainer }) {function renderTrackInsights({ fileName, metadata, stats, trackPoints, rideDate, weather, detailsContainer, statsContainer, pointsContainer }) {

    if (detailsContainer) {    if (detailsContainer) {

        const details = [        const details = [

            `<p><strong>Bestand:</strong> ${escapeHtml(fileName)}</p>`,            `<p><strong>Bestand:</strong> ${escapeHtml(fileName)}</p>`,

            metadata.name ? `<p><strong>Tracknaam:</strong> ${escapeHtml(metadata.name)}</p>` : '',            metadata.name ? `<p><strong>Tracknaam:</strong> ${escapeHtml(metadata.name)}</p>` : '',

            metadata.description ? `<p><strong>Beschrijving:</strong> ${escapeHtml(metadata.description)}</p>` : '',            metadata.description ? `<p><strong>Beschrijving:</strong> ${escapeHtml(metadata.description)}</p>` : '',

            metadata.author ? `<p><strong>Auteur:</strong> ${escapeHtml(metadata.author)}</p>` : '',            metadata.author ? `<p><strong>Auteur:</strong> ${escapeHtml(metadata.author)}</p>` : '',

            rideDate instanceof Date && !Number.isNaN(rideDate.getTime()) ? `<p><strong>Ritdatum:</strong> ${formatDateOnly(rideDate)}</p>` : '',            rideDate instanceof Date && !Number.isNaN(rideDate.getTime()) ? `<p><strong>Ritdatum:</strong> ${formatDateOnly(rideDate)}</p>` : '',

            `<p><strong>Starttijd:</strong> ${formatDateTime(stats.startTime)}</p>`,            `<p><strong>Starttijd:</strong> ${formatDateTime(stats.startTime)}</p>`,

            `<p><strong>Eindtijd:</strong> ${formatDateTime(stats.endTime)}</p>`,            `<p><strong>Eindtijd:</strong> ${formatDateTime(stats.endTime)}</p>`,

            weather ? `<p><strong>Weer:</strong> ${formatWeather(weather)}</p>` : '',            weather ? `<p><strong>Weer:</strong> ${formatWeather(weather)}</p>` : '',

            `<p><strong>Trackpunten:</strong> ${trackPoints.length}</p>`            `<p><strong>Trackpunten:</strong> ${trackPoints.length}</p>`

        ]        ]

            .filter(Boolean)            .filter(Boolean)

            .join('');            .join('');

        detailsContainer.innerHTML = details;        detailsContainer.innerHTML = details;

    }    }



    if (statsContainer) {    if (statsContainer) {

        statsContainer.innerHTML = [        statsContainer.innerHTML = [

            `<p><strong>Totale afstand:</strong> ${formatDistance(stats.totalDistanceKm)}</p>`,            `<p><strong>Totale afstand:</strong> ${formatDistance(stats.totalDistanceKm)}</p>`,

            `<p><strong>Duur:</strong> ${formatDuration(stats.durationMs)}</p>`,            `<p><strong>Duur:</strong> ${formatDuration(stats.durationMs)}</p>`,

            `<p><strong>Gemiddelde snelheid:</strong> ${formatSpeed(stats.averageSpeedKmh)}</p>`,            `<p><strong>Gemiddelde snelheid:</strong> ${formatSpeed(stats.averageSpeedKmh)}</p>`,

            `<p><strong>Totaal stijgen:</strong> ${formatElevation(stats.totalAscent)}</p>`,            `<p><strong>Totaal stijgen:</strong> ${formatElevation(stats.totalAscent)}</p>`,

            `<p><strong>Totaal dalen:</strong> ${formatElevation(stats.totalDescent)}</p>`,            `<p><strong>Totaal dalen:</strong> ${formatElevation(stats.totalDescent)}</p>`,

            `<p><strong>Minimum hoogte:</strong> ${formatElevation(stats.minElevation)}</p>`,            `<p><strong>Minimum hoogte:</strong> ${formatElevation(stats.minElevation)}</p>`,

            `<p><strong>Maximum hoogte:</strong> ${formatElevation(stats.maxElevation)}</p>`            `<p><strong>Maximum hoogte:</strong> ${formatElevation(stats.maxElevation)}</p>`

        ].join('');        ].join('');

    }    }



    if (pointsContainer) {    if (pointsContainer) {

        if (trackPoints.length === 0) {        if (trackPoints.length === 0) {

            pointsContainer.innerHTML = '<p>Geen trackpunten om te tonen.</p>';            pointsContainer.innerHTML = '<p>Geen trackpunten om te tonen.</p>';

            return;            return;

        }        }



        const maxRows = 300;        const maxRows = 300;

        const limitedPoints = trackPoints.slice(0, maxRows);        const limitedPoints = trackPoints.slice(0, maxRows);

        const rows = limitedPoints        const rows = limitedPoints

            .map(            .map(

                (point, index) => `                (point, index) => `

            <tr>            <tr>

                <td>${index + 1}</td>                <td>${index + 1}</td>

                <td>${formatCoordinate(point.lat)}</td>                <td>${formatCoordinate(point.lat)}</td>

                <td>${formatCoordinate(point.lon)}</td>                <td>${formatCoordinate(point.lon)}</td>

                <td>${formatElevation(point.elevation)}</td>                <td>${formatElevation(point.elevation)}</td>

                <td>${formatTime(point.time)}</td>                <td>${formatTime(point.time)}</td>

            </tr>            </tr>

        `        `

            )            )

            .join('');            .join('');



        const table = `        const table = `

            <table>            <table>

                <thead>                <thead>

                    <tr>                    <tr>

                        <th>#</th>                        <th>#</th>

                        <th>Latitude</th>                        <th>Latitude</th>

                        <th>Longitude</th>                        <th>Longitude</th>

                        <th>Hoogte</th>                        <th>Hoogte</th>

                        <th>Tijd</th>                        <th>Tijd</th>

                    </tr>                    </tr>

                </thead>                </thead>

                <tbody>                <tbody>

                    ${rows}                    ${rows}

                </tbody>                </tbody>

            </table>            </table>

        `;        `;



        const note = trackPoints.length > maxRows ? `<p>Toont de eerste ${maxRows} van ${trackPoints.length} punten.</p>` : '';        const note = trackPoints.length > maxRows ? `<p>Toont de eerste ${maxRows} van ${trackPoints.length} punten.</p>` : '';

        pointsContainer.innerHTML = table + note;        pointsContainer.innerHTML = table + note;

    }    }

}}



function escapeHtml(value) {function escapeHtml(value) {

    if (typeof value !== 'string') {    if (typeof value !== 'string') {

        return value;        return value;

    }    }

    return value.replace(/[&<>"']/g, (char) => {    return value.replace(/[&<>"']/g, (char) => {

        const map = {        const map = {

            '&': '&amp;',            '&': '&amp;',

            '<': '&lt;',            '<': '&lt;',

            '>': '&gt;',            '>': '&gt;',

            '"': '&quot;',            '"': '&quot;',

            "'": '&#39;'            "'": '&#39;'

        };        };

        return map[char] || char;        return map[char] || char;

    });    });

}}



function formatDistance(distanceKm) {function formatDistance(distanceKm) {

    if (!Number.isFinite(distanceKm)) {    if (!Number.isFinite(distanceKm)) {

        return 'Niet beschikbaar';        return 'Niet beschikbaar';

    }    }

    return `${distanceKm.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;    return `${distanceKm.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;

}}



function formatDuration(durationMs) {function formatDuration(durationMs) {

    if (!Number.isFinite(durationMs) || durationMs <= 0) {    if (!Number.isFinite(durationMs) || durationMs <= 0) {

        return 'Niet beschikbaar';        return 'Niet beschikbaar';

    }    }

    const totalSeconds = Math.floor(durationMs / 1000);    const totalSeconds = Math.floor(durationMs / 1000);

    const hours = Math.floor(totalSeconds / 3600);    const hours = Math.floor(totalSeconds / 3600);

    const minutes = Math.floor((totalSeconds % 3600) / 60);    const minutes = Math.floor((totalSeconds % 3600) / 60);

    const seconds = totalSeconds % 60;    const seconds = totalSeconds % 60;

    const segments = [hours, minutes, seconds].map((segment) => segment.toString().padStart(2, '0'));    const segments = [hours, minutes, seconds].map((segment) => segment.toString().padStart(2, '0'));

    return `${segments[0]}:${segments[1]}:${segments[2]}`;    return `${segments[0]}:${segments[1]}:${segments[2]}`;

}}



function formatSpeed(speedKmh) {function formatSpeed(speedKmh) {

    if (!Number.isFinite(speedKmh)) {    if (!Number.isFinite(speedKmh)) {

        return 'Niet beschikbaar';        return 'Niet beschikbaar';

    }    }

    return `${speedKmh.toLocaleString('nl-BE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km/u`;    return `${speedKmh.toLocaleString('nl-BE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km/u`;

}}



function formatElevation(value) {function formatElevation(value) {

    if (!Number.isFinite(value)) {    if (!Number.isFinite(value)) {

        return 'Niet beschikbaar';        return 'Niet beschikbaar';

    }    }

    return `${value.toLocaleString('nl-BE', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} m`;    return `${value.toLocaleString('nl-BE', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} m`;

}}



function formatCoordinate(value) {function formatCoordinate(value) {

    if (!Number.isFinite(value)) {    if (!Number.isFinite(value)) {

        return '-';        return '-';

    }    }

    return value.toFixed(5);    return value.toFixed(5);

}}



function formatDateTime(date) {function formatDateTime(date) {

    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {

        return 'Niet beschikbaar';        return 'Niet beschikbaar';

    }    }

    return date.toLocaleString('nl-BE');    return date.toLocaleString('nl-BE');

}}



function formatTime(date) {function formatTime(date) {

    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {

        return '-';        return '-';

    }    }

    return date.toLocaleTimeString('nl-BE');    return date.toLocaleTimeString('nl-BE');

}}



function formatDateOnly(date) {function formatDateOnly(date) {

    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {

        return 'Niet beschikbaar';        return 'Niet beschikbaar';

    }    }

    return date.toLocaleDateString('nl-BE');    return date.toLocaleDateString('nl-BE');

}}



function formatDateForInput(date) {function formatDateForInput(date) {

    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {

        return '';        return '';

    }    }

    const year = date.getFullYear();    const year = date.getFullYear();

    const month = `${date.getMonth() + 1}`.padStart(2, '0');    const month = `${date.getMonth() + 1}`.padStart(2, '0');

    const day = `${date.getDate()}`.padStart(2, '0');    const day = `${date.getDate()}`.padStart(2, '0');

    return `${year}-${month}-${day}`;    return `${year}-${month}-${day}`;

}}



function formatWeather(value) {function formatWeather(value) {

    switch (value) {    switch (value) {

        case 'rain':        case 'rain':

            return 'Regen';            return 'Regen';

        case 'snow':        case 'snow':

            return 'Sneeuw';            return 'Sneeuw';

        case 'sun':        case 'sun':

            return 'Zon';            return 'Zon';

        default:        default:

            return 'Onbekend';            return 'Onbekend';

    }    }

}}

// Smooth scroll functionaliteit
document.addEventListener('DOMContentLoaded', () => {
    // Smooth scroll voor navigatie links
    const navLinks = document.querySelectorAll('a[href^="#"]');
    
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = link.getAttribute('href');
            if (targetId === '#') return;

            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                targetElement.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });

// Functie om de huidige tijd te tonen (indien gewenst)
function updateTime() {
    const now = new Date();
    const timeString = now.toLocaleTimeString('nl-BE', { 
        hour: '2-digit', 
        minute: '2-digit' 
    });
    
    const timeElement = document.getElementById('current-time');
    if (timeElement) {
        timeElement.textContent = timeString;
    }
}

// Update tijd elke minuut
setInterval(updateTime, 60000);
updateTime();


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
            geometry: {
                type: 'LineString',
                coordinates: lineCoordinates
            },
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
        if (!feature.geometry) {
            return;
        }
        if (feature.geometry.type === 'LineString') {
            feature.geometry.coordinates.forEach((coordinate) => coords.push(coordinate));
        } else if (feature.geometry.type === 'MultiLineString') {
            feature.geometry.coordinates.forEach((line) => {
                line.forEach((coordinate) => coords.push(coordinate));
            });
        }
    });
    return coords;
}

function extractTrackPoints(xml) {
    const nodes = Array.from(xml.getElementsByTagName('trkpt'));
    return nodes.map((node) => {
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
    }).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
}

function computeBounds(coordinates) {
    const initial = {
        minLng: Infinity,
        maxLng: -Infinity,
        minLat: Infinity,
        maxLat: -Infinity
    };

    const reduced = coordinates.reduce((acc, [lng, lat]) => {
        if (Number.isFinite(lng) && Number.isFinite(lat)) {
            acc.minLng = Math.min(acc.minLng, lng);
            acc.maxLng = Math.max(acc.maxLng, lng);
            acc.minLat = Math.min(acc.minLat, lat);
            acc.maxLat = Math.max(acc.maxLat, lat);
        }
        return acc;
    }, initial);

    return reduced;
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

    if (Number.isFinite(points[0].elevation)) {
        minElevation = Math.min(minElevation, points[0].elevation);
        maxElevation = Math.max(maxElevation, points[0].elevation);
    }

    const firstWithTime = points.find((point) => point.time);
    const lastWithTime = [...points].reverse().find((point) => point.time);
    const startTime = firstWithTime ? firstWithTime.time : null;
    const endTime = lastWithTime ? lastWithTime.time : null;

    for (let i = 1; i < points.length; i += 1) {
        const prev = points[i - 1];
        const curr = points[i];
        totalDistance += haversineDistance(prev, curr);

        if (Number.isFinite(curr.elevation)) {
            minElevation = Math.min(minElevation, curr.elevation);
            maxElevation = Math.max(maxElevation, curr.elevation);
        }
        if (Number.isFinite(prev.elevation) && Number.isFinite(curr.elevation)) {
            const delta = curr.elevation - prev.elevation;
            if (delta > 0) {
                totalAscent += delta;
            } else {
                totalDescent += Math.abs(delta);
            }
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
        averageSpeedKmh: averageSpeed
    };
}

function haversineDistance(a, b) {
    const toRadians = (value) => value * (Math.PI / 180);
    const earthRadiusKm = 6371;

    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const deltaLat = toRadians(b.lat - a.lat);
    const deltaLon = toRadians(b.lon - a.lon);

    const sinLat = Math.sin(deltaLat / 2);
    const sinLon = Math.sin(deltaLon / 2);

    const c = 2 * Math.atan2(
        Math.sqrt(sinLat ** 2 + Math.cos(lat1) * Math.cos(lat2) * sinLon ** 2),
        Math.sqrt(1 - (sinLat ** 2 + Math.cos(lat1) * Math.cos(lat2) * sinLon ** 2))
    );

    return earthRadiusKm * c;
}

function extractMetadata(xml) {
    const getText = (tagName) => {
        const node = xml.getElementsByTagName(tagName)[0];
        return node ? node.textContent : null;
    };

    return {
        name: getText('name'),
        description: getText('desc') || getText('description') || null,
        author: getText('author')
    };
}

function renderMapData(map, state, geojsonLine, bounds, trackPoints) {
    const applyData = () => {
        if (map.getLayer(state.trackLayerId)) {
            map.removeLayer(state.trackLayerId);
        }
        if (map.getSource(state.trackSourceId)) {
            map.removeSource(state.trackSourceId);
        }

        map.addSource(state.trackSourceId, {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: [geojsonLine]
            }
        });

        map.addLayer({
            id: state.trackLayerId,
            type: 'line',
            source: state.trackSourceId,
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': '#60a5fa',
                'line-width': 4,
                'line-opacity': 0.9
            }
        });

        state.markers.forEach((marker) => marker.remove());
        state.markers = [];

        if (trackPoints.length > 0) {
            const startPoint = trackPoints[0];
            const endPoint = trackPoints[trackPoints.length - 1];
            state.markers.push(new mapboxgl.Marker({ color: '#22c55e' }).setLngLat([startPoint.lon, startPoint.lat]).setPopup(new mapboxgl.Popup({ offset: 12 }).setHTML('<strong>Start</strong>')).addTo(map));
            state.markers.push(new mapboxgl.Marker({ color: '#ef4444' }).setLngLat([endPoint.lon, endPoint.lat]).setPopup(new mapboxgl.Popup({ offset: 12 }).setHTML('<strong>Finish</strong>')).addTo(map));
        }

        const hasBounds = Number.isFinite(bounds.minLng) && Number.isFinite(bounds.maxLng) && Number.isFinite(bounds.minLat) && Number.isFinite(bounds.maxLat);
        if (hasBounds) {
            const lngLatBounds = new mapboxgl.LngLatBounds(
                [bounds.minLng, bounds.minLat],
                [bounds.maxLng, bounds.maxLat]
            );
            map.fitBounds(lngLatBounds, { padding: 60, maxZoom: 15, duration: 1000 });
        }
    };

    if (map.isStyleLoaded()) {
        applyData();
    } else {
        map.once('load', applyData);
    }
}

function renderTrackInsights({ fileName, metadata, stats, trackPoints, detailsContainer, statsContainer, pointsContainer }) {
    if (detailsContainer) {
        const details = [
            `<p><strong>Bestand:</strong> ${escapeHtml(fileName)}</p>`,
            metadata.name ? `<p><strong>Tracknaam:</strong> ${escapeHtml(metadata.name)}</p>` : '',
            metadata.description ? `<p><strong>Beschrijving:</strong> ${escapeHtml(metadata.description)}</p>` : '',
            metadata.author ? `<p><strong>Auteur:</strong> ${escapeHtml(metadata.author)}</p>` : '',
            `<p><strong>Starttijd:</strong> ${formatDateTime(stats.startTime)}</p>`,
            `<p><strong>Eindtijd:</strong> ${formatDateTime(stats.endTime)}</p>`,
            `<p><strong>Trackpunten:</strong> ${trackPoints.length}</p>`
        ].filter(Boolean).join('');
        detailsContainer.innerHTML = details;
    }

    if (statsContainer) {
        statsContainer.innerHTML = [
            `<p><strong>Totale afstand:</strong> ${formatDistance(stats.totalDistanceKm)}</p>`,
            `<p><strong>Duur:</strong> ${formatDuration(stats.durationMs)}</p>`,
            `<p><strong>Gemiddelde snelheid:</strong> ${formatSpeed(stats.averageSpeedKmh)}</p>`,
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
        const limitedPoints = trackPoints.slice(0, maxRows);
        const rows = limitedPoints.map((point, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>${formatCoordinate(point.lat)}</td>
                <td>${formatCoordinate(point.lon)}</td>
                <td>${formatElevation(point.elevation)}</td>
                <td>${formatTime(point.time)}</td>
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
                <tbody>
                    ${rows}
                </tbody>
            </table>
        `;

        const note = trackPoints.length > maxRows ? `<p>Toont de eerste ${maxRows} van ${trackPoints.length} punten.</p>` : '';
        pointsContainer.innerHTML = table + note;
    }
}

function escapeHtml(value) {
    if (typeof value !== 'string') {
        return value;
    }
    return value.replace(/[&<>"']/g, (char) => {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };
        return map[char] || char;
    });
}

function formatDistance(distanceKm) {
    if (!Number.isFinite(distanceKm)) {
        return 'Niet beschikbaar';
    }
    return `${distanceKm.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;
}

function formatDuration(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return 'Niet beschikbaar';
    }
    const totalSeconds = Math.floor(durationMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const segments = [hours, minutes, seconds].map((segment) => segment.toString().padStart(2, '0'));
    return `${segments[0]}:${segments[1]}:${segments[2]}`;
}

function formatSpeed(speedKmh) {
    if (!Number.isFinite(speedKmh)) {
        return 'Niet beschikbaar';
    }
    return `${speedKmh.toLocaleString('nl-BE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km/u`;
}

function formatElevation(value) {
    if (!Number.isFinite(value)) {
        return 'Niet beschikbaar';
    }
    return `${value.toLocaleString('nl-BE', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} m`;
}

function formatCoordinate(value) {
    if (!Number.isFinite(value)) {
        return '-';
    }
    return value.toFixed(5);
}

function formatDateTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return 'Niet beschikbaar';
    }
    return date.toLocaleString('nl-BE');
}

function formatTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return '-';
    }
    return date.toLocaleTimeString('nl-BE');
}
