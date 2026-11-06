import L from 'leaflet';
import {
  MAX_ROUTE_DISTANCE_METERS,
  ROUTE_SECTION_LENGTH_METERS,
  nearestRouteLocation,
  routeSectionLines,
} from './route.js';

const GREEN_THRESHOLD_DBFS = -35;
const MAX_DBFS = 0;

function getVolumeColor(volume) {
  const ratio = Math.max(0, Math.min(1, (volume - GREEN_THRESHOLD_DBFS) / (MAX_DBFS - GREEN_THRESHOLD_DBFS),),);
  const low = [42, 157, 85];
  const high = [214, 40, 40];
  const color = low.map((channel, index) => Math.round(channel + (high[index] - channel) * ratio));
  return `rgb(${color.join(', ')})`;
}

export async function loadSensorReadings(map) {
  const response = await fetch('/api/sensor-data');
  if (!response.ok) { throw new Error(`Could not load sensor readings (${response.status})`); }
  const readings = await response.json();
  if (!Array.isArray(readings)) { throw new Error('Sensor readings response was not an array'); }

  const volumeSectionLayer = L.layerGroup().addTo(map);
  const plottedReadings = [];
  const volumeTotalsBySection = new Map();
  const readingCountsBySection = new Map();

  for (const reading of readings) {
    if (
      !reading ||
      typeof reading !== 'object' ||
      reading.latitude == null ||
      reading.longitude == null ||
      reading.volume == null
    ) { continue; }

    const latitude = Number(reading.latitude);
    const longitude = Number(reading.longitude);
    const volume = Number(reading.volume);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(volume) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      continue;
    }

    const nearestLocation = nearestRouteLocation(latitude, longitude);
    if (!nearestLocation || nearestLocation.distanceMeters > MAX_ROUTE_DISTANCE_METERS) { continue; }

    const sectionIndex = Math.floor(nearestLocation.distanceAlongPartMeters / ROUTE_SECTION_LENGTH_METERS);
    const sectionKey = `${nearestLocation.routePartIndex}:${sectionIndex}`;
    plottedReadings.push({ reading, latitude, longitude, volume, sectionKey });
    volumeTotalsBySection.set(sectionKey, (volumeTotalsBySection.get(sectionKey) ?? 0) + volume);
    readingCountsBySection.set(sectionKey, (readingCountsBySection.get(sectionKey) ?? 0) + 1);
  }

  for (const [sectionKey, volumeTotal] of volumeTotalsBySection) {
    const sectionAverage = volumeTotal / readingCountsBySection.get(sectionKey);
    const color = getVolumeColor(sectionAverage);
    const sectionLine = routeSectionLines.get(sectionKey);
    if (!sectionLine) { continue;}

    const line = L.polyline(
      sectionLine.map(([longitude, latitude]) => [latitude, longitude]),
      {
        color,
        weight: 6,
        opacity: 1,
        lineCap: 'butt',
        lineJoin: 'round',
      },
    ).addTo(volumeSectionLayer);

    const popup = document.createElement('div');
    const volumeLabel = document.createElement('strong');
    volumeLabel.textContent = `${sectionAverage.toFixed(1)} dBFS section average`;
    popup.append(volumeLabel);
    const readingCount = readingCountsBySection.get(sectionKey);
    const countLabel = document.createElement('div');
    countLabel.textContent = `${readingCount} reading${readingCount === 1 ? '' : 's'}`;
    popup.append(countLabel);
    line.bindPopup(popup);
  }

  return plottedReadings.length;
}

export function addVolumeLegend(map, readingCount, error = null) {
  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const container = L.DomUtil.create('div', 'volume-legend');
    const title = document.createElement('strong');

    if (error) {
      title.textContent = 'Sensor readings unavailable';
      const details = document.createElement('div');
      details.textContent = error instanceof Error ? error.message : String(error);
      container.append(title, details);
      return container;
    }

    title.textContent = `Microphone level (${readingCount} readings)`;
    container.append(title);
    if (readingCount === 0) {
      const details = document.createElement('div');
      details.textContent = 'No readings returned by the backend. Upload the dataset or check live sensor data.';
      container.append(details);
      return container;
    }

    const gradient = document.createElement('div');
    gradient.className = 'volume-legend-gradient';
    const labels = document.createElement('div');
    labels.className = 'volume-legend-labels';
    labels.innerHTML = '<span>Low (≤ -35 dBFS)</span><span>High (0 dBFS)</span>';
    container.append(gradient, labels);
    return container;
  };
  legend.addTo(map);
}
