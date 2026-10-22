import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';

const map = L.map('map', {
  maxBoundsViscosity: 1.0,
  zoomControl: false,
  scrollWheelZoom: true,
});

// Add OpenStreetMap tiles to the map.
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

// Call the Red Line stop locations from the backend and use their bounds as the
// basis for initial map size and zoom limits.
const stopLayer = L.layerGroup().addTo(map);

async function loadLuasStops() {
  const response = await fetch('/api/luas/stops');
  if (!response.ok) {
    throw new Error(`Could not load LUAS stops (${response.status})`);
  }

  const stops = await response.json();
  const stopBounds = L.latLngBounds([]);

  for (const stop of stops) {
    const latitude = Number(stop.latitude);
    const longitude = Number(stop.longitude);

    const location = [latitude, longitude];
    stopBounds.extend(location);

    const marker = L.circleMarker(location, {
      radius: 5,
      color: '#fffdf8',
      weight: 2,
      fillColor: '#e76f51',
      fillOpacity: 1,
    }).addTo(stopLayer);

    const popup = document.createElement('strong');
    popup.textContent = `${stop.stop_name ?? stop.abbreviation} — ${stop.line}`;
    marker.bindPopup(popup);
  }

  map.fitBounds(stopBounds, { padding: [30, 30], animate: false });
  map.setMaxBounds(map.getBounds());
  map.setMinZoom(map.getZoom());
}

loadLuasStops().catch((error) => {
  console.error('Unable to display LUAS stops:', error);
});
