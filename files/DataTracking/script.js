// Initialize the map and set its view to a default location
var map = L.map('map').setView([51.505, -0.09], 13);

// Add the OpenStreetMap tiles
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

var gpxLayer = null;

// Listen for file input changes
document.getElementById('gpx-file').addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) {
        return;
    }

    var reader = new FileReader();
    reader.onload = function(e) {
        var gpxContent = e.target.result;

        // Remove the old GPX layer if it exists
        if (gpxLayer) {
            map.removeLayer(gpxLayer);
        }

        // Create a new GPX layer
        gpxLayer = new L.GPX(gpxContent, {
            async: true,
            marker_options: {
                startIconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet-gpx/1.5.1/pin-icon-start.png',
                endIconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet-gpx/1.5.1/pin-icon-end.png',
                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet-gpx/1.5.1/pin-shadow.png'
            }
        }).on('loaded', function(e) {
            // Fit the map to the GPX track bounds
            map.fitBounds(e.target.getBounds());
            
            var gpx = e.target;
            displayGpxDetails(gpx);
            displayGpxStats(gpx);
            displayGpxPoints(gpx);

        }).addTo(map);
    };
    reader.readAsText(file);
});

function displayGpxDetails(gpx) {
    var detailsDiv = document.getElementById('gpx-details');
    detailsDiv.innerHTML = `
        <p><strong>Tracknaam:</strong> ${gpx.get_name()}</p>
        <p><strong>Beschrijving:</strong> ${gpx.get_desc() || 'N.v.t.'}</p>
        <p><strong>Auteur:</strong> ${gpx.get_author() || 'N.v.t.'}</p>
    `;
}

// Haversine distance (meters) between two lat/lon points
function haversineMeters(lat1, lon1, lat2, lon2) {
    var R = 6371000; // Earth radius in meters
    var toRad = function(deg) { return deg * Math.PI / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function computeSpeedsFromTrackpoints(points) {
    // returns { segments: [{distance_m, dt_s, speed_m_s, speed_kmh}], avg_moving_kmh, max_kmh }
    var segments = [];
    var totalMovingDistance = 0;
    var totalMovingTime = 0;
    var maxSpeedKmh = 0;

    for (var i = 1; i < points.length; i++) {
        var p1 = points[i-1];
        var p2 = points[i];

        if (!p1.time || !p2.time) {
            continue; // skip if missing timestamps
        }

        var dt = (p2.time.getTime() - p1.time.getTime()) / 1000.0; // seconds
        if (dt <= 0) {
            continue; // skip zero or negative time diffs
        }

        var dist = haversineMeters(p1.lat, p1.lon, p2.lat, p2.lon); // meters

        var speedMs = dist / dt; // m/s
        var speedKmh = speedMs * 3.6;

        segments.push({
            distance_m: dist,
            dt_s: dt,
            speed_m_s: speedMs,
            speed_kmh: speedKmh
        });

        // Consider as "moving" if distance > small threshold (e.g. 1 meter) to avoid GPS jitter
        if (dist > 1) {
            totalMovingDistance += dist;
            totalMovingTime += dt;
        }

        if (speedKmh > maxSpeedKmh) {
            maxSpeedKmh = speedKmh;
        }
    }

    var avgMovingKmh = (totalMovingTime > 0) ? ((totalMovingDistance / totalMovingTime) * 3.6) : 0;

    return {
        segments: segments,
        avg_moving_kmh: avgMovingKmh,
        max_kmh: maxSpeedKmh
    };
}

function displayGpxStats(gpx) {
    var statsDiv = document.getElementById('gpx-stats');

    // Totale afstand in km (plugin geeft meters)
    var distance = (gpx.get_distance() / 1000).toFixed(2);

    // Elevatie in meters (veilig ophalen)
    var elevationGain = (typeof gpx.get_elevation_gain === 'function' && gpx.get_elevation_gain() !== undefined)
        ? gpx.get_elevation_gain().toFixed(2)
        : '0.00';
    var elevationLoss = (typeof gpx.get_elevation_loss === 'function' && gpx.get_elevation_loss() !== undefined)
        ? gpx.get_elevation_loss().toFixed(2)
        : '0.00';

    // Start / eindtijd
    var startTime = gpx.get_start_time();
    var endTime = gpx.get_end_time();

    // Compute speeds from trackpoints for reliable results
    var points = gpx.get_trackpoints() || [];
    var computed = { avg_moving_kmh: 'N.v.t.', max_kmh: 'N.v.t.' };
    if (points.length >= 2) {
        var speeds = computeSpeedsFromTrackpoints(points);
        computed.avg_moving_kmh = speeds.avg_moving_kmh.toFixed(2);
        computed.max_kmh = speeds.max_kmh.toFixed(2);
    }

    statsDiv.innerHTML = `
        <p><strong>Totale afstand:</strong> ${distance} km</p>
        <p><strong>Gemiddelde snelheid (bewegend):</strong> ${computed.avg_moving_kmh} km/u</p>
        <p><strong>Maximale snelheid:</strong> ${computed.max_kmh} km/u</p>
        <p><strong>Hoogtewinst:</strong> ${elevationGain} m</p>
        <p><strong>Hoogteverlies:</strong> ${elevationLoss} m</p>
        <p><strong>Starttijd:</strong> ${startTime ? startTime.toLocaleString() : 'N.v.t.'}</p>
        <p><strong>Eindtijd:</strong> ${endTime ? endTime.toLocaleString() : 'N.v.t.'}</p>
    `;
}

function displayGpxPoints(gpx) {
    var pointsDiv = document.getElementById('gpx-points');
    var points = gpx.get_trackpoints();
    if (points.length === 0) {
        pointsDiv.innerHTML = '<p>Geen trackpunten gevonden in het bestand.</p>';
        return;
    }

    var table = '<table><thead><tr><th>Breedtegraad</th><th>Lengtegraad</th><th>Hoogte (m)</th><th>Tijd</th></tr></thead><tbody>';
    points.forEach(function(p) {
        table += `
            <tr>
                <td>${p.lat.toFixed(5)}</td>
                <td>${p.lon.toFixed(5)}</td>
                <td>${p.ele.toFixed(2)}</td>
                <td>${p.time ? p.time.toLocaleString() : 'N.v.t.'}</td>
            </tr>
        `;
    });
    table += '</tbody></table>';

    pointsDiv.innerHTML = table;
}
