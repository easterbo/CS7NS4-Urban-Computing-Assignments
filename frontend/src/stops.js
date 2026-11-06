import L from 'leaflet';

export async function loadLuasStops(map) {
  const response = await fetch('/api/luas/stops');
  if (!response.ok) { throw new Error(`Could not load LUAS stops (${response.status})`);}
  const stops = await response.json();
  const stopBounds = L.latLngBounds([]);
  const stopPane = map.createPane('stopMarkers');
  stopPane.style.zIndex = '650';
  const stopLayer = L.layerGroup().addTo(map);

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
      pane: 'stopMarkers',
    }).addTo(stopLayer);

    const popup = document.createElement('strong');
    popup.textContent = `${stop.stop_name ?? stop.abbreviation} — ${stop.line}`;
    marker.bindPopup(popup);
  }

  return stopBounds;
}
