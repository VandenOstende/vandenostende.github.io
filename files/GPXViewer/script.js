/**
 * GPX Viewer - Main Script
 * Handles GPX file import, parsing, and visualization
 */

// Mapbox access token (same as used in DataTracking)
const MAPBOX_ACCESS_TOKEN = 'pk.eyJ1IjoidmFuZGVub3N0ZW5kZWsiLCJhIjoiY203eWl6NGtnMDhueTJpcjY2dnlpc2Z5NSJ9.udMeaVqcH38IfX0ME1wbAQ';

// State
let currentGPXData = null;
let map = null;
let elevationChart = null;

// DOM Elements
const uploadSection = document.getElementById('upload-section');
const detailsSection = document.getElementById('details-section');
const uploadBtn = document.getElementById('upload-btn');
const fileInput = document.getElementById('gpx-file-input');
const fileInfo = document.getElementById('file-info');
const fileName = document.getElementById('file-name');
const clearBtn = document.getElementById('clear-btn');
const backBtn = document.getElementById('back-btn');
const uploadCard = document.querySelector('.upload-card');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
});

/**
 * Setup event listeners
 */
function setupEventListeners() {
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileSelect);
    clearBtn.addEventListener('click', clearFile);
    backBtn.addEventListener('click', resetViewer);
    
    // Drag and drop
    uploadCard.addEventListener('dragover', handleDragOver);
    uploadCard.addEventListener('dragleave', handleDragLeave);
    uploadCard.addEventListener('drop', handleDrop);
    
    // Collapsible sections
    const trackpointsHeader = document.getElementById('trackpoints-header');
    if (trackpointsHeader) {
        trackpointsHeader.addEventListener('click', toggleTrackPoints);
    }
}

/**
 * Handle file selection
 */
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        processFile(file);
    }
}

/**
 * Handle drag over
 */
function handleDragOver(event) {
    event.preventDefault();
    event.stopPropagation();
    uploadCard.classList.add('drag-over');
}

/**
 * Handle drag leave
 */
function handleDragLeave(event) {
    event.preventDefault();
    event.stopPropagation();
    uploadCard.classList.remove('drag-over');
}

/**
 * Handle drop
 */
function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    uploadCard.classList.remove('drag-over');
    
    const file = event.dataTransfer.files[0];
    if (file && file.name.endsWith('.gpx')) {
        processFile(file);
    } else {
        alert('Selecteer een geldig GPX-bestand');
    }
}

/**
 * Process GPX file
 */
function processFile(file) {
    fileName.textContent = file.name;
    fileInfo.style.display = 'flex';
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const gpxText = e.target.result;
            const parser = new DOMParser();
            const gpxDoc = parser.parseFromString(gpxText, 'text/xml');
            
            // Check for parse errors
            const parseError = gpxDoc.querySelector('parsererror');
            if (parseError) {
                throw new Error('Ongeldig GPX-bestand');
            }
            
            currentGPXData = parseGPX(gpxDoc, file.name);
            displayGPXData(currentGPXData);
        } catch (error) {
            console.error('Error parsing GPX:', error);
            alert('Fout bij het verwerken van het GPX-bestand: ' + error.message);
        }
    };
    
    reader.onerror = () => {
        alert('Fout bij het lezen van het bestand');
    };
    
    reader.readAsText(file);
}

/**
 * Parse GPX document
 */
function parseGPX(gpxDoc, filename) {
    const data = {
        filename: filename,
        metadata: extractMetadata(gpxDoc),
        waypoints: extractWaypoints(gpxDoc),
        tracks: extractTracks(gpxDoc),
        routes: extractRoutes(gpxDoc),
        statistics: {}
    };
    
    // Calculate statistics
    if (data.tracks.length > 0) {
        data.statistics = calculateStatistics(data.tracks);
    }
    
    return data;
}

/**
 * Extract metadata from GPX
 */
function extractMetadata(gpxDoc) {
    const metadata = {};
    const metadataEl = gpxDoc.querySelector('metadata');
    
    if (metadataEl) {
        metadata.name = getElementText(metadataEl, 'name');
        metadata.desc = getElementText(metadataEl, 'desc');
        metadata.author = getElementText(metadataEl, 'author name');
        metadata.time = getElementText(metadataEl, 'time');
        metadata.link = metadataEl.querySelector('link')?.getAttribute('href');
    }
    
    // Try to get name from GPX root if not in metadata
    if (!metadata.name) {
        metadata.name = getElementText(gpxDoc, 'gpx > name');
    }
    
    return metadata;
}

/**
 * Extract waypoints from GPX
 */
function extractWaypoints(gpxDoc) {
    const waypoints = [];
    const wptElements = gpxDoc.querySelectorAll('wpt');
    
    wptElements.forEach((wpt, index) => {
        waypoints.push({
            index: index + 1,
            lat: parseFloat(wpt.getAttribute('lat')),
            lon: parseFloat(wpt.getAttribute('lon')),
            ele: parseFloat(getElementText(wpt, 'ele')) || null,
            name: getElementText(wpt, 'name') || `Waypoint ${index + 1}`,
            desc: getElementText(wpt, 'desc'),
            sym: getElementText(wpt, 'sym'),
            time: getElementText(wpt, 'time')
        });
    });
    
    return waypoints;
}

/**
 * Extract tracks from GPX
 */
function extractTracks(gpxDoc) {
    const tracks = [];
    const trkElements = gpxDoc.querySelectorAll('trk');
    
    trkElements.forEach((trk, trackIndex) => {
        const track = {
            name: getElementText(trk, 'name') || `Track ${trackIndex + 1}`,
            desc: getElementText(trk, 'desc'),
            segments: []
        };
        
        const trksegs = trk.querySelectorAll('trkseg');
        trksegs.forEach((trkseg, segIndex) => {
            const segment = {
                index: segIndex,
                points: []
            };
            
            const trkpts = trkseg.querySelectorAll('trkpt');
            trkpts.forEach((trkpt, ptIndex) => {
                segment.points.push({
                    index: ptIndex,
                    lat: parseFloat(trkpt.getAttribute('lat')),
                    lon: parseFloat(trkpt.getAttribute('lon')),
                    ele: parseFloat(getElementText(trkpt, 'ele')) || null,
                    time: getElementText(trkpt, 'time'),
                    speed: parseFloat(getElementText(trkpt, 'speed')) || null
                });
            });
            
            track.segments.push(segment);
        });
        
        tracks.push(track);
    });
    
    return tracks;
}

/**
 * Extract routes from GPX
 */
function extractRoutes(gpxDoc) {
    const routes = [];
    const rteElements = gpxDoc.querySelectorAll('rte');
    
    rteElements.forEach((rte, index) => {
        const route = {
            name: getElementText(rte, 'name') || `Route ${index + 1}`,
            desc: getElementText(rte, 'desc'),
            points: []
        };
        
        const rtepts = rte.querySelectorAll('rtept');
        rtepts.forEach((rtept, ptIndex) => {
            route.points.push({
                index: ptIndex,
                lat: parseFloat(rtept.getAttribute('lat')),
                lon: parseFloat(rtept.getAttribute('lon')),
                ele: parseFloat(getElementText(rtept, 'ele')) || null,
                name: getElementText(rtept, 'name'),
                desc: getElementText(rtept, 'desc')
            });
        });
        
        routes.push(route);
    });
    
    return routes;
}

/**
 * Calculate statistics from tracks
 */
function calculateStatistics(tracks) {
    let totalDistance = 0;
    let totalElevationGain = 0;
    let totalElevationLoss = 0;
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    let maxSpeed = 0;
    let totalPoints = 0;
    let firstTime = null;
    let lastTime = null;
    let speeds = [];
    
    tracks.forEach(track => {
        track.segments.forEach(segment => {
            const points = segment.points;
            
            for (let i = 0; i < points.length; i++) {
                const point = points[i];
                totalPoints++;
                
                // Elevation stats
                if (point.ele !== null) {
                    minElevation = Math.min(minElevation, point.ele);
                    maxElevation = Math.max(maxElevation, point.ele);
                    
                    if (i > 0 && points[i - 1].ele !== null) {
                        const elevDiff = point.ele - points[i - 1].ele;
                        if (elevDiff > 0) {
                            totalElevationGain += elevDiff;
                        } else {
                            totalElevationLoss += Math.abs(elevDiff);
                        }
                    }
                }
                
                // Distance calculation
                if (i > 0) {
                    const dist = calculateDistance(
                        points[i - 1].lat, points[i - 1].lon,
                        point.lat, point.lon
                    );
                    totalDistance += dist;
                }
                
                // Speed stats
                if (point.speed !== null) {
                    speeds.push(point.speed);
                    maxSpeed = Math.max(maxSpeed, point.speed);
                }
                
                // Time stats
                if (point.time) {
                    const time = new Date(point.time);
                    if (!firstTime) firstTime = time;
                    lastTime = time;
                }
            }
        });
    });
    
    // Calculate duration
    let duration = null;
    if (firstTime && lastTime) {
        duration = (lastTime - firstTime) / 1000; // in seconds
    }
    
    // Calculate average speed
    let avgSpeed = null;
    if (speeds.length > 0) {
        avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    } else if (duration && duration > 0) {
        avgSpeed = (totalDistance / 1000) / (duration / 3600); // km/h
    }
    
    return {
        totalDistance: totalDistance / 1000, // Convert to km
        totalElevationGain,
        totalElevationLoss,
        minElevation: minElevation === Infinity ? null : minElevation,
        maxElevation: maxElevation === -Infinity ? null : maxElevation,
        maxSpeed: maxSpeed > 0 ? maxSpeed : null,
        avgSpeed: avgSpeed,
        duration: duration,
        totalPoints: totalPoints,
        firstTime: firstTime,
        lastTime: lastTime
    };
}

/**
 * Calculate distance between two coordinates (Haversine formula)
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    return R * c; // Distance in meters
}

/**
 * Get text content from element
 */
function getElementText(parent, selector) {
    const element = parent.querySelector(selector);
    return element ? element.textContent.trim() : null;
}

/**
 * Display GPX data
 */
function displayGPXData(data) {
    // Hide upload section, show details
    uploadSection.style.display = 'none';
    detailsSection.style.display = 'block';
    
    // Display each section
    displayMetadata(data.metadata, data.filename);
    displayStatistics(data.statistics);
    displayMap(data);
    displayElevationProfile(data);
    displayWaypoints(data.waypoints);
    displayTrackPoints(data.tracks);
}

/**
 * Display metadata
 */
function displayMetadata(metadata, filename) {
    const container = document.getElementById('metadata-content');
    const items = [];
    
    items.push({ label: 'Bestandsnaam', value: filename });
    
    if (metadata.name) {
        items.push({ label: 'Naam', value: metadata.name });
    }
    
    if (metadata.desc) {
        items.push({ label: 'Beschrijving', value: metadata.desc });
    }
    
    if (metadata.author) {
        items.push({ label: 'Auteur', value: metadata.author });
    }
    
    if (metadata.time) {
        items.push({ label: 'Tijdstempel', value: formatDateTime(metadata.time) });
    }
    
    if (metadata.link) {
        items.push({ label: 'Link', value: `<a href="${metadata.link}" target="_blank" style="color: var(--accent-primary);">${metadata.link}</a>` });
    }
    
    container.innerHTML = items.map(item => `
        <div class="info-item">
            <div class="label">${item.label}</div>
            <div class="value">${item.value}</div>
        </div>
    `).join('');
}

/**
 * Display statistics
 */
function displayStatistics(stats) {
    const container = document.getElementById('stats-content');
    const cards = [];
    
    if (stats.totalDistance !== undefined) {
        cards.push({
            icon: '📏',
            label: 'Totale Afstand',
            value: stats.totalDistance.toFixed(2),
            unit: 'km'
        });
    }
    
    if (stats.duration !== null) {
        cards.push({
            icon: '⏱️',
            label: 'Duur',
            value: formatDuration(stats.duration),
            unit: ''
        });
    }
    
    if (stats.avgSpeed !== null) {
        cards.push({
            icon: '🚴',
            label: 'Gem. Snelheid',
            value: stats.avgSpeed.toFixed(1),
            unit: 'km/h'
        });
    }
    
    if (stats.maxSpeed !== null) {
        cards.push({
            icon: '⚡',
            label: 'Max Snelheid',
            value: stats.maxSpeed.toFixed(1),
            unit: 'km/h'
        });
    }
    
    if (stats.totalElevationGain !== undefined) {
        cards.push({
            icon: '⬆️',
            label: 'Stijging',
            value: stats.totalElevationGain.toFixed(0),
            unit: 'm'
        });
    }
    
    if (stats.totalElevationLoss !== undefined) {
        cards.push({
            icon: '⬇️',
            label: 'Daling',
            value: stats.totalElevationLoss.toFixed(0),
            unit: 'm'
        });
    }
    
    if (stats.minElevation !== null && stats.maxElevation !== null) {
        cards.push({
            icon: '🏔️',
            label: 'Hoogte Bereik',
            value: `${stats.minElevation.toFixed(0)} - ${stats.maxElevation.toFixed(0)}`,
            unit: 'm'
        });
    }
    
    if (stats.totalPoints !== undefined) {
        cards.push({
            icon: '🎯',
            label: 'Track Points',
            value: stats.totalPoints.toLocaleString('nl-NL'),
            unit: ''
        });
    }
    
    container.innerHTML = cards.map(card => `
        <div class="stat-card">
            <div class="stat-icon">${card.icon}</div>
            <div class="stat-label">${card.label}</div>
            <div class="stat-value">${card.value}<span class="stat-unit">${card.unit}</span></div>
        </div>
    `).join('');
}

/**
 * Display map
 */
function displayMap(data) {
    // Check if Mapbox GL is available
    if (typeof mapboxgl === 'undefined') {
        document.getElementById('map').innerHTML = '<p class="empty-state">Kaart kan niet worden geladen. Mapbox GL JS is niet beschikbaar.</p>';
        return;
    }
    
    // Initialize Mapbox
    if (!map) {
        mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;
        map = new mapboxgl.Map({
            container: 'map',
            style: 'mapbox://styles/mapbox/outdoors-v12',
            center: [4.75, 51.25],
            zoom: 10
        });
        
        map.addControl(new mapboxgl.NavigationControl());
        map.addControl(new mapboxgl.FullscreenControl());
    }
    
    map.on('load', () => {
        // Clear existing layers and sources
        if (map.getLayer('track-layer')) {
            map.removeLayer('track-layer');
        }
        if (map.getSource('track-source')) {
            map.removeSource('track-source');
        }
        
        // Prepare GeoJSON
        const coordinates = [];
        data.tracks.forEach(track => {
            track.segments.forEach(segment => {
                segment.points.forEach(point => {
                    coordinates.push([point.lon, point.lat]);
                });
            });
        });
        
        if (coordinates.length === 0) return;
        
        // Add track line
        map.addSource('track-source', {
            type: 'geojson',
            data: {
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: coordinates
                }
            }
        });
        
        map.addLayer({
            id: 'track-layer',
            type: 'line',
            source: 'track-source',
            paint: {
                'line-color': '#3b82f6',
                'line-width': 4
            }
        });
        
        // Add waypoint markers
        data.waypoints.forEach(waypoint => {
            const el = document.createElement('div');
            el.className = 'waypoint-marker';
            el.style.backgroundColor = '#10b981';
            el.style.width = '12px';
            el.style.height = '12px';
            el.style.borderRadius = '50%';
            el.style.border = '2px solid white';
            
            new mapboxgl.Marker(el)
                .setLngLat([waypoint.lon, waypoint.lat])
                .setPopup(new mapboxgl.Popup().setHTML(`
                    <strong>${waypoint.name}</strong><br>
                    ${waypoint.desc ? waypoint.desc + '<br>' : ''}
                    ${waypoint.ele !== null ? `Hoogte: ${waypoint.ele.toFixed(1)}m` : ''}
                `))
                .addTo(map);
        });
        
        // Fit bounds
        const bounds = new mapboxgl.LngLatBounds();
        coordinates.forEach(coord => bounds.extend(coord));
        map.fitBounds(bounds, { padding: 50 });
    });
}

/**
 * Display elevation profile
 */
function displayElevationProfile(data) {
    const ctx = document.getElementById('elevation-chart');
    
    // Check if Chart.js is available
    if (typeof Chart === 'undefined') {
        ctx.parentElement.innerHTML = '<p class="empty-state">Elevatieprofiel kan niet worden geladen. Chart.js is niet beschikbaar.</p>';
        return;
    }
    
    // Collect elevation data
    const elevationData = [];
    let distance = 0;
    
    data.tracks.forEach(track => {
        track.segments.forEach(segment => {
            const points = segment.points;
            
            for (let i = 0; i < points.length; i++) {
                if (points[i].ele !== null) {
                    if (i > 0) {
                        distance += calculateDistance(
                            points[i - 1].lat, points[i - 1].lon,
                            points[i].lat, points[i].lon
                        ) / 1000; // Convert to km
                    }
                    
                    elevationData.push({
                        x: distance,
                        y: points[i].ele
                    });
                }
            }
        });
    });
    
    if (elevationData.length === 0) {
        ctx.parentElement.innerHTML = '<p class="empty-state">Geen hoogtegegevens beschikbaar</p>';
        return;
    }
    
    // Destroy existing chart
    if (elevationChart) {
        elevationChart.destroy();
    }
    
    // Create new chart
    elevationChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Hoogte (m)',
                data: elevationData,
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                fill: true,
                tension: 0.1,
                pointRadius: 0,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: (context) => `${context.parsed.y.toFixed(1)} m`
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    title: {
                        display: true,
                        text: 'Afstand (km)',
                        color: '#cbd5e1'
                    },
                    ticks: {
                        color: '#94a3b8'
                    },
                    grid: {
                        color: 'rgba(148, 163, 184, 0.1)'
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: 'Hoogte (m)',
                        color: '#cbd5e1'
                    },
                    ticks: {
                        color: '#94a3b8'
                    },
                    grid: {
                        color: 'rgba(148, 163, 184, 0.1)'
                    }
                }
            }
        }
    });
}

/**
 * Display waypoints
 */
function displayWaypoints(waypoints) {
    const container = document.getElementById('waypoints-content');
    
    if (waypoints.length === 0) {
        container.innerHTML = '<p class="empty-state">Geen waypoints gevonden</p>';
        return;
    }
    
    container.innerHTML = waypoints.map(wp => `
        <div class="waypoint-item">
            <div class="waypoint-info">
                <div class="waypoint-name">${wp.name}</div>
                ${wp.desc ? `<div class="waypoint-desc">${wp.desc}</div>` : ''}
                <div class="waypoint-coords">
                    ${wp.lat.toFixed(6)}, ${wp.lon.toFixed(6)}
                    ${wp.ele !== null ? ` - ${wp.ele.toFixed(1)}m` : ''}
                </div>
            </div>
            <div class="waypoint-marker">📍</div>
        </div>
    `).join('');
}

/**
 * Display track points
 */
function displayTrackPoints(tracks) {
    const container = document.getElementById('trackpoints-content');
    
    if (tracks.length === 0) {
        container.innerHTML = '<p class="empty-state">Geen track points gevonden</p>';
        return;
    }
    
    // Collect all points
    const allPoints = [];
    tracks.forEach(track => {
        track.segments.forEach(segment => {
            allPoints.push(...segment.points);
        });
    });
    
    // Create table
    const table = document.createElement('table');
    table.className = 'trackpoints-table';
    table.innerHTML = `
        <thead>
            <tr>
                <th>#</th>
                <th>Lat</th>
                <th>Lon</th>
                <th>Hoogte (m)</th>
                <th>Tijd</th>
                <th>Snelheid (km/h)</th>
            </tr>
        </thead>
        <tbody>
            ${allPoints.map((pt, idx) => `
                <tr>
                    <td>${idx + 1}</td>
                    <td>${pt.lat.toFixed(6)}</td>
                    <td>${pt.lon.toFixed(6)}</td>
                    <td>${pt.ele !== null ? pt.ele.toFixed(1) : '-'}</td>
                    <td>${pt.time ? formatTime(pt.time) : '-'}</td>
                    <td>${pt.speed !== null ? pt.speed.toFixed(1) : '-'}</td>
                </tr>
            `).join('')}
        </tbody>
    `;
    
    container.innerHTML = '';
    container.appendChild(table);
}

/**
 * Toggle track points section
 */
function toggleTrackPoints() {
    const header = document.getElementById('trackpoints-header');
    const content = document.getElementById('trackpoints-content');
    const isCollapsed = content.style.display === 'none';
    
    content.style.display = isCollapsed ? 'block' : 'none';
    header.classList.toggle('collapsed', !isCollapsed);
}

/**
 * Format date time
 */
function formatDateTime(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleString('nl-NL', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Format time
 */
function formatTime(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleTimeString('nl-NL', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/**
 * Format duration
 */
function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return `${hours}u ${minutes}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${secs}s`;
    } else {
        return `${secs}s`;
    }
}

/**
 * Clear file
 */
function clearFile() {
    fileInput.value = '';
    fileInfo.style.display = 'none';
    fileName.textContent = '';
}

/**
 * Reset viewer
 */
function resetViewer() {
    currentGPXData = null;
    clearFile();
    detailsSection.style.display = 'none';
    uploadSection.style.display = 'flex';
    
    // Destroy chart
    if (elevationChart) {
        elevationChart.destroy();
        elevationChart = null;
    }
    
    // Reset map
    if (map) {
        if (map.getLayer('track-layer')) {
            map.removeLayer('track-layer');
        }
        if (map.getSource('track-source')) {
            map.removeSource('track-source');
        }
    }
}
