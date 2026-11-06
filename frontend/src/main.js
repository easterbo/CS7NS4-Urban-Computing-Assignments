import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { loadLuasRoute } from './route.js';
import { loadLuasStops } from './stops.js';
import { addVolumeLegend, loadSensorReadings } from './sensors.js';
import { loadLuasTrams } from './trams.js';

const map = L.map('map', {
  maxBoundsViscosity: 1.0,
  zoomControl: false,
  scrollWheelZoom: true,
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

async function loadMapData() {
  const [routeResult, stopsResult] = await Promise.allSettled([
    loadLuasRoute(map),
    loadLuasStops(map),
  ]);
  const bounds = L.latLngBounds([]);

  for (const [index, result] of [routeResult, stopsResult].entries()) {
    if (result.status === 'fulfilled') { bounds.extend(result.value); }
    else if (result.status === 'rejected') {
      const dataName = ['LUAS Red Line route', 'LUAS stops'][index];
      console.error(`Unable to display ${dataName}:`, result.reason);
    }
  }

  if (!bounds.isValid()) { throw new Error('No LUAS route or stop locations could be displayed'); }

  map.fitBounds(bounds, { padding: [30, 30], animate: false });
  map.setMaxBounds(map.getBounds());
  map.setMinZoom(map.getZoom());

  await loadLuasTrams(map);

  if (routeResult.status === 'fulfilled') {
    try { addVolumeLegend(map, await loadSensorReadings(map)); }
    catch (error) {
      console.error('Unable to display sensor readings:', error);
      addVolumeLegend(map, 0, error);
    }
  }
}

loadMapData().catch((error) => { console.error('Unable to initialize the LUAS map:', error); });
