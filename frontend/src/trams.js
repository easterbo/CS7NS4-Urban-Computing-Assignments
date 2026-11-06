import L from 'leaflet';
import { interpolateRouteBetweenStops } from './route.js';

const FORECAST_REFRESH_MS = 60_000;
const MINUTES_PER_STOP = 2.5;
const TRAM_DEDUPLICATION_DISTANCE_METERS = 250;

async function fetchJson(url, label) {
  const response = await fetch(url);
  if (!response.ok) { throw new Error(`Could not load ${label} (${response.status})`); }
  return response.json();
}

function getTramPositions(stops, forecasts) {
  const orderedStops = [...stops].sort((a, b) => a.sequence - b.sequence);
  const stopsByName = new Map(
    orderedStops.map((stop, index) => [stop.stop_name?.trim().toLowerCase(), index]),
  );
  const stopsByAbbreviation = new Map(
    orderedStops.map((stop, index) => [stop.abbreviation.toUpperCase(), index]),
  );
  const positions = [];

  for (const forecast of forecasts) {
    const stopIndex = stopsByAbbreviation.get(forecast.abbreviation?.toUpperCase());
    if (stopIndex == null) { continue; }
    const stop = orderedStops[stopIndex];

    for (const direction of forecast.directions ?? []) {
      for (const tram of direction.trams ?? []) {
        if (tram.due_minutes == null) { continue; }
        const dueMinutes = Number(tram.due_minutes);
        const destinationIndex = stopsByName.get(tram.destination?.trim().toLowerCase());
        if (
          !Number.isFinite(dueMinutes) ||
          dueMinutes < 0 ||
          destinationIndex == null ||
          destinationIndex === stopIndex
        ) { continue; }

        const destinationDirection = Math.sign(destinationIndex - stopIndex);
        let approachDirection = -destinationDirection;
        if (!orderedStops[stopIndex + approachDirection]) {
          approachDirection = destinationDirection;
        }

        const intervalsAway = dueMinutes / MINUTES_PER_STOP;
        const intervalOffset = Math.floor(intervalsAway);
        const fraction = intervalsAway - intervalOffset;
        const firstStopIndex = stopIndex + approachDirection * intervalOffset;
        const secondStopIndex = stopIndex + approachDirection * (intervalOffset + 1);
        const firstStop = orderedStops[firstStopIndex];
        const secondStop = orderedStops[secondStopIndex];
        if (!firstStop || !secondStop) { continue; }

        const routePosition = interpolateRouteBetweenStops(firstStop, secondStop, fraction);
        if (!routePosition) { continue; }
        positions.push({
          ...routePosition,
          direction: direction.name,
          dueMinutes,
          destination: orderedStops[destinationIndex].stop_name,
          arrivingStop: stop.stop_name,
        });
      }
    }
  }

  return deduplicatePositions(positions);
}

function deduplicatePositions(positions) {
  const uniquePositions = [];
  for (const position of positions.sort((a, b) => a.dueMinutes - b.dueMinutes)) {
    const tooClose = uniquePositions.some((existing) => {
      if (
        existing.destination !== position.destination ||
        existing.direction !== position.direction
      ) { return false; }
      const latitudeDistance = (existing.latitude - position.latitude) * 111_320;
      const longitudeDistance =
        (existing.longitude - position.longitude) *
        111_320 *
        Math.cos((position.latitude * Math.PI) / 180);
      return Math.hypot(latitudeDistance, longitudeDistance) < TRAM_DEDUPLICATION_DISTANCE_METERS;
    });
    if (!tooClose) { uniquePositions.push(position); }
  }
  return uniquePositions;
}

function createTramMarker(position) {
  const shape = document.createElement('span');
  const directionClass = position.direction?.toLowerCase();
  shape.className = `tram-shape tram-shape--${directionClass === 'inbound' || directionClass === 'outbound' ? directionClass : 'unknown'}`;
  shape.style.transform = `rotate(${position.bearing}deg)`;
  const marker = L.marker([position.latitude, position.longitude], {
    pane: 'trams',
    icon: L.divIcon({
      className: 'tram-marker-icon',
      html: shape,
      iconSize: [26, 14],
      iconAnchor: [13, 7],
    }),
    keyboard: false,
  });
  const popup = document.createElement('div');
  const destination = document.createElement('strong');
  destination.textContent = `Tram towards ${position.destination}`;
  const arrival = document.createElement('div');
  arrival.textContent = `${position.direction} — due at ${position.arrivingStop} in ${position.dueMinutes} min`;
  popup.append(destination, arrival);
  marker.bindPopup(popup);
  return marker;
}

function addTramLegend(map) {
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const container = L.DomUtil.create('div', 'tram-legend');
    container.innerHTML =
      '<strong>Tram direction</strong>' +
      '<div><span class="tram-legend-swatch tram-legend-swatch--inbound"></span>Inbound</div>' +
      '<div><span class="tram-legend-swatch tram-legend-swatch--outbound"></span>Outbound</div>';
    return container;
  };
  legend.addTo(map);
}

export async function loadLuasTrams(map) {
  map.createPane('trams').style.zIndex = '640';
  const tramLayer = L.layerGroup().addTo(map);
  addTramLegend(map);

  const updateTrams = async () => {
    try {
      const [stops, forecasts] = await Promise.all([
        fetchJson('/api/luas/stops', 'LUAS stops'),
        fetchJson('/api/luas/forecasts', 'LUAS arrival forecasts'),
      ]);
      if (!Array.isArray(stops) || !Array.isArray(forecasts)) {
        throw new Error('LUAS stops and forecasts must be arrays');
      }

      const positions = getTramPositions(stops, forecasts);
      tramLayer.clearLayers();
      for (const position of positions) {
        createTramMarker(position).addTo(tramLayer);
      }
    } catch (error) {
      console.error('Unable to update LUAS tram positions:', error);
    }
  };

  await updateTrams();
  window.setInterval(updateTrams, FORECAST_REFRESH_MS);
}
