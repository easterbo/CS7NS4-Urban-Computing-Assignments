import L from 'leaflet';

export const MAX_ROUTE_DISTANCE_METERS = 10;
export const ROUTE_SECTION_LENGTH_METERS = 10;

const EARTH_RADIUS_METERS = 6_371_000;

export const routeSectionLines = new Map();
let routeSegments = [];
let routePartCount = 0;
let routeGraph = new Map();
const routePathCache = new Map();

function coordinateKey([longitude, latitude]) {
  return `${longitude.toFixed(7)}:${latitude.toFixed(7)}`;
}

function distanceBetweenCoordinates([longitudeA, latitudeA], [longitudeB, latitudeB]) {
  const midpointLatitude = ((latitudeA + latitudeB) / 2 * Math.PI) / 180;
  const metersPerLongitudeDegree = (Math.PI / 180) * EARTH_RADIUS_METERS * Math.cos(midpointLatitude);
  const metersPerLatitudeDegree = (Math.PI / 180) * EARTH_RADIUS_METERS;
  return Math.hypot(
    (longitudeB - longitudeA) * metersPerLongitudeDegree,
    (latitudeB - latitudeA) * metersPerLatitudeDegree,
  );
}

function addRouteGraphEdge(start, end, lengthMeters) {
  const startKey = coordinateKey(start);
  const endKey = coordinateKey(end);
  if (!routeGraph.has(startKey)) { routeGraph.set(startKey, { coordinate: start, edges: new Map() }); }
  if (!routeGraph.has(endKey)) { routeGraph.set(endKey, { coordinate: end, edges: new Map() }); }
  routeGraph.get(startKey).edges.set(endKey, lengthMeters);
  routeGraph.get(endKey).edges.set(startKey, lengthMeters);
}

function pushPriority(queue, item) {
  queue.push(item);
  let index = queue.length - 1;
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    if (queue[parentIndex].distance <= item.distance) { break; }
    queue[index] = queue[parentIndex];
    index = parentIndex;
  }
  queue[index] = item;
}

function popPriority(queue) {
  const first = queue[0];
  const last = queue.pop();
  if (queue.length > 0) {
    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      if (leftIndex >= queue.length) { break; }
      const childIndex =
        rightIndex < queue.length && queue[rightIndex].distance < queue[leftIndex].distance
          ? rightIndex
          : leftIndex;
      if (queue[childIndex].distance >= last.distance) { break; }
      queue[index] = queue[childIndex];
      index = childIndex;
    }
    queue[index] = last;
  }
  return first;
}

function appendRouteSegments(coordinates) {
  const routePartIndex = routePartCount;
  routePartCount += 1;
  let distanceAlongPartMeters = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    const midpointLatitudeRadians = (((start[1] + end[1]) / 2) * Math.PI) / 180;
    const metersPerLongitudeDegree = (Math.PI / 180) * EARTH_RADIUS_METERS * Math.cos(midpointLatitudeRadians);
    const metersPerLatitudeDegree = (Math.PI / 180) * EARTH_RADIUS_METERS;
    const segmentLengthMeters = Math.hypot((end[0] - start[0]) * metersPerLongitudeDegree, (end[1] - start[1]) * metersPerLatitudeDegree);
    addRouteGraphEdge(start, end, segmentLengthMeters);
    routeSegments.push({
      startLongitude: start[0],
      startLatitude: start[1],
      endLongitude: end[0],
      endLatitude: end[1],
      routePartIndex,
      distanceAlongPartMeters,
      segmentLengthMeters,
    });

    let distanceIntoSegmentMeters = 0;
    while (distanceIntoSegmentMeters < segmentLengthMeters - 1e-8) {
      const sectionDistanceMeters = distanceAlongPartMeters + distanceIntoSegmentMeters;
      const sectionIndex = Math.floor( sectionDistanceMeters / ROUTE_SECTION_LENGTH_METERS );
      const nextSectionDistanceMeters = (sectionIndex + 1) * ROUTE_SECTION_LENGTH_METERS;
      const sectionLengthRemainingMeters = nextSectionDistanceMeters - sectionDistanceMeters;
      const pieceLengthMeters = Math.min( segmentLengthMeters - distanceIntoSegmentMeters, sectionLengthRemainingMeters );
      const startFraction = distanceIntoSegmentMeters / segmentLengthMeters;
      const endFraction = (distanceIntoSegmentMeters + pieceLengthMeters) / segmentLengthMeters;
      const interpolateCoordinate = (fraction) => [
        start[0] + (end[0] - start[0]) * fraction,
        start[1] + (end[1] - start[1]) * fraction,
      ];
      const sectionKey = `${routePartIndex}:${sectionIndex}`;
      const line = routeSectionLines.get(sectionKey) ?? [];
      if (line.length === 0) { line.push(interpolateCoordinate(startFraction)); }
      line.push(interpolateCoordinate(endFraction));
      routeSectionLines.set(sectionKey, line);
      distanceIntoSegmentMeters += pieceLengthMeters;
    }
    distanceAlongPartMeters += segmentLengthMeters;
  }
}

export async function loadLuasRoute(map) {
  const routeLayer = L.geoJSON(null, {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> (ODbL)',
    style: {
      color: '#c6c9c7',
      weight: 4,
      opacity: 0.85,
    },
  }).addTo(map);
  const response = await fetch('/api/luas/line');
  if (!response.ok) { throw new Error(`Could not load LUAS Red Line route (${response.status})`); }

  const route = await response.json();
  routeSegments = [];
  routePartCount = 0;
  routeGraph = new Map();
  routePathCache.clear();
  routeSectionLines.clear();
  for (const feature of route.features ?? []) {
    const geometry = feature.geometry;
    if (geometry?.type === 'LineString') { appendRouteSegments(geometry.coordinates); }
    else if (geometry?.type === 'MultiLineString') {
      for (const coordinates of geometry.coordinates) { appendRouteSegments(coordinates); }
    }
  }
  if (routeSegments.length === 0) { throw new Error('LUAS Red Line route GeoJSON contains no line segments'); }

  routeLayer.addData(route);
  const routeBounds = routeLayer.getBounds();
  if (!routeBounds.isValid()) { throw new Error('LUAS Red Line route GeoJSON contains no valid geometry'); }
  return routeBounds;
}

export function nearestRouteLocation(latitude, longitude) {
  const latitudeRadians = (latitude * Math.PI) / 180;
  const metersPerLongitudeDegree = (Math.PI / 180) * EARTH_RADIUS_METERS * Math.cos(latitudeRadians);
  const metersPerLatitudeDegree = (Math.PI / 180) * EARTH_RADIUS_METERS;
  let nearestLocation = null;

  for (const [segmentIndex, segment] of routeSegments.entries()) {
    const startX = (segment.startLongitude - longitude) * metersPerLongitudeDegree;
    const startY = (segment.startLatitude - latitude) * metersPerLatitudeDegree;
    const endX = (segment.endLongitude - longitude) * metersPerLongitudeDegree;
    const endY = (segment.endLatitude - latitude) * metersPerLatitudeDegree;
    const segmentX = endX - startX;
    const segmentY = endY - startY;
    const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
    const projection = segmentLengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(startX * segmentX + startY * segmentY) / segmentLengthSquared,));
    const nearestX = startX + projection * segmentX;
    const nearestY = startY + projection * segmentY;
    const distanceMeters = Math.hypot(nearestX, nearestY);
    if (!nearestLocation || distanceMeters < nearestLocation.distanceMeters) {
      nearestLocation = {
        distanceMeters,
        segmentIndex,
        projection,
        segmentStartLongitude: segment.startLongitude,
        segmentStartLatitude: segment.startLatitude,
        segmentEndLongitude: segment.endLongitude,
        segmentEndLatitude: segment.endLatitude,
        routePartIndex: segment.routePartIndex,
        distanceAlongPartMeters:
          segment.distanceAlongPartMeters +
          projection * segment.segmentLengthMeters,
      };
    }
  }

  return nearestLocation;
}

function routePathBetween(startLocation, endLocation, startCoordinate, endCoordinate) {
  const startSegment = routeSegments[startLocation.segmentIndex];
  const endSegment = routeSegments[endLocation.segmentIndex];
  const directSegmentPath =
    startLocation.segmentIndex === endLocation.segmentIndex
      ? Math.abs(startLocation.projection - endLocation.projection) * startSegment.segmentLengthMeters
      : Infinity;
  const startNodeOptions = [
    {
      key: coordinateKey([startSegment.startLongitude, startSegment.startLatitude]),
      distance: startLocation.projection * startSegment.segmentLengthMeters,
    },
    {
      key: coordinateKey([startSegment.endLongitude, startSegment.endLatitude]),
      distance: (1 - startLocation.projection) * startSegment.segmentLengthMeters,
    },
  ];
  const endNodeOptions = [
    {
      key: coordinateKey([endSegment.startLongitude, endSegment.startLatitude]),
      distance: endLocation.projection * endSegment.segmentLengthMeters,
    },
    {
      key: coordinateKey([endSegment.endLongitude, endSegment.endLatitude]),
      distance: (1 - endLocation.projection) * endSegment.segmentLengthMeters,
    },
  ];
  const distances = new Map();
  const previous = new Map();
  const visited = new Set();
  const queue = [];
  for (const option of startNodeOptions) {
    if (option.distance < (distances.get(option.key) ?? Infinity)) {
      distances.set(option.key, option.distance);
      previous.set(option.key, null);
      pushPriority(queue, { key: option.key, distance: option.distance });
    }
  }

  let bestEnd = null;
  while (queue.length > 0) {
    const { key: currentKey, distance: currentDistance } = popPriority(queue);
    if (visited.has(currentKey) || currentDistance !== distances.get(currentKey)) { continue; }
    visited.add(currentKey);

    for (const option of endNodeOptions) {
      if (option.key === currentKey) {
        const totalDistance = currentDistance + option.distance;
        if (!bestEnd || totalDistance < bestEnd.distance) {
          bestEnd = { key: currentKey, distance: totalDistance };
        }
      }
    }
    if (bestEnd && currentDistance >= bestEnd.distance) { break; }

    for (const [neighborKey, edgeDistance] of routeGraph.get(currentKey).edges) {
      const nextDistance = currentDistance + edgeDistance;
      if (nextDistance < (distances.get(neighborKey) ?? Infinity)) {
        distances.set(neighborKey, nextDistance);
        previous.set(neighborKey, currentKey);
        pushPriority(queue, { key: neighborKey, distance: nextDistance });
      }
    }
  }

  if (directSegmentPath <= (bestEnd?.distance ?? Infinity)) {
    return {
      coordinates: [startCoordinate, endCoordinate],
      lengthMeters: directSegmentPath,
    };
  }
  if (!bestEnd) { return null; }

  const graphCoordinates = [];
  for (let key = bestEnd.key; key != null; key = previous.get(key)) {
    graphCoordinates.push(routeGraph.get(key).coordinate);
  }
  graphCoordinates.reverse();
  return {
    coordinates: [startCoordinate, ...graphCoordinates, endCoordinate],
    lengthMeters: bestEnd.distance,
  };
}

function getRoutePath(startLatitude, startLongitude, endLatitude, endLongitude) {
  const cacheKey = [startLatitude, startLongitude, endLatitude, endLongitude].join(':');
  if (routePathCache.has(cacheKey)) { return routePathCache.get(cacheKey); }

  const startLocation = nearestRouteLocation(startLatitude, startLongitude);
  const endLocation = nearestRouteLocation(endLatitude, endLongitude);
  if (!startLocation || !endLocation) {
    routePathCache.set(cacheKey, null);
    return null;
  }
  const path = routePathBetween(
    startLocation,
    endLocation,
    [
      startLocation.segmentStartLongitude +
        (startLocation.segmentEndLongitude - startLocation.segmentStartLongitude) * startLocation.projection,
      startLocation.segmentStartLatitude +
        (startLocation.segmentEndLatitude - startLocation.segmentStartLatitude) * startLocation.projection,
    ],
    [
      endLocation.segmentStartLongitude +
        (endLocation.segmentEndLongitude - endLocation.segmentStartLongitude) * endLocation.projection,
      endLocation.segmentStartLatitude +
        (endLocation.segmentEndLatitude - endLocation.segmentStartLatitude) * endLocation.projection,
    ],
  );
  routePathCache.set(cacheKey, path);
  return path;
}

export function interpolateRouteBetweenStops(start, end, fraction) {
  const path = getRoutePath(start.latitude, start.longitude, end.latitude, end.longitude);
  if (!path) { return null; }

  const distanceAlongPath = Math.max(0, Math.min(1, fraction)) * path.lengthMeters;
  let distanceTravelled = 0;
  for (let index = 1; index < path.coordinates.length; index += 1) {
    const previousCoordinate = path.coordinates[index - 1];
    const nextCoordinate = path.coordinates[index];
    const segmentLength = distanceBetweenCoordinates(previousCoordinate, nextCoordinate);
    if (distanceTravelled + segmentLength >= distanceAlongPath || index === path.coordinates.length - 1) {
      const segmentFraction = segmentLength === 0
        ? 0
        : (distanceAlongPath - distanceTravelled) / segmentLength;
      const longitude = previousCoordinate[0] + (nextCoordinate[0] - previousCoordinate[0]) * segmentFraction;
      const latitude = previousCoordinate[1] + (nextCoordinate[1] - previousCoordinate[1]) * segmentFraction;
      return {
        latitude,
        longitude,
        bearing: Math.atan2(
          -(nextCoordinate[1] - previousCoordinate[1]),
          (nextCoordinate[0] - previousCoordinate[0]) * Math.cos((latitude * Math.PI) / 180),
        ) * (180 / Math.PI),
      };
    }
    distanceTravelled += segmentLength;
  }

  return null;
}
