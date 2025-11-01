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

function displayGpxStats(gpx) {
    var statsDiv = document.getElementById('gpx-stats');
    var distance = (gpx.get_distance() / 1000).toFixed(2); // in km
    var elevationGain = gpx.get_elevation_gain().toFixed(2); // in m
    var elevationLoss = gpx.get_elevation_loss().toFixed(2); // in m
    var startTime = gpx.get_start_time();
    var endTime = gpx.get_end_time();

    statsDiv.innerHTML = `
        <p><strong>Totale afstand:</strong> ${distance} km</p>
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