import logging
from datetime import datetime, timezone
from time import monotonic
from threading import Event
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

LUAS_STOPS_COLLECTION = "luas-stops"
LUAS_RED_LINE = "Luas Red Line"
LUAS_FORECASTS_COLLECTION = "luas-forecasts"
LUAS_FORECASTS_POLL_SECONDS = 60
LUAS_STOPS_API_URL = (
	"https://luasforecasts.rpa.ie/xml/get.ashx?action=stops&encrypt=false"
)

def fetch_luas_stops():
	api_request = Request(
		LUAS_STOPS_API_URL,
		headers={"User-Agent": "UrbanComputingAssignments/1.0"},
	)

	with urlopen(api_request, timeout=20) as response:
		xml_data = response.read()
	root = ET.fromstring(xml_data)
	if root.tag != "stops":
		raise ValueError("LUAS API response did not contain a stops document.")

	stops = []
	for line in root.findall("line"):
		line_name = line.get("name")
		if not line_name:
			raise ValueError("LUAS API response contains a line without a name.")

		if line_name != LUAS_RED_LINE:
			continue
		for stop in line.findall("stop"):
			abbreviation = stop.get("abrev")
			if not abbreviation:
				raise ValueError("LUAS API response contains a stop without an ID.")
			try:
				latitude = float(stop.attrib["lat"])
				longitude = float(stop.attrib["long"])
			except (KeyError, ValueError) as error:
				raise ValueError(
					f"LUAS stop {abbreviation} has invalid coordinates."
				) from error

			stops.append({
				"abbreviation": abbreviation,
				"line": line_name,
				"latitude": latitude,
				"longitude": longitude,
			})

	if not stops:
		raise ValueError("LUAS API response did not contain any stops.")
	return stops

def fetch_luas_forecast(stop):
	query = urlencode({
		"action": "forecast",
		"stop": stop["abbreviation"].lower(),
		"encrypt": "false",
	})
	api_request = Request(
		f"https://luasforecasts.rpa.ie/xml/get.ashx?{query}",
		headers={"User-Agent": "UrbanComputingAssignments/1.0"},
	)
	with urlopen(api_request, timeout=20) as response:
		xml_data = response.read()

	root = ET.fromstring(xml_data)
	if root.tag != "stopInfo":
		raise ValueError(
			f"LUAS forecast for {stop['abbreviation']} did not contain stopInfo."
		)
	response_abbreviation = root.get("stopAbv", "").upper()
	if response_abbreviation != stop["abbreviation"]:
		raise ValueError(
			f"LUAS forecast stop ID mismatch for {stop['abbreviation']}."
		)

	directions = []
	for direction in root.findall("direction"):
		trams = []
		for tram in direction.findall("tram"):
			due_minutes = tram.get("dueMins")
			if due_minutes is not None and due_minutes.isdigit():
				due_minutes = int(due_minutes)
			else:
				due_minutes = None
			trams.append({
				"due_minutes": due_minutes,
				"destination": tram.get("destination", ""),
			})
		directions.append({
			"name": direction.get("name", ""),
			"trams": trams,
		})

	return {
		"line": stop["line"],
		"abbreviation": stop["abbreviation"],
		"stop_name": root.get("stop", ""),
		"api_updated_at": root.get("created", ""),
		"polled_at": datetime.now(timezone.utc).isoformat(),
		"message": root.findtext("message", default=""),
		"directions": directions,
	}

def sync_luas_forecasts(client, logger):
	stops = fetch_luas_stops()
	forecasts = []
	for stop in stops:
		try:
			forecasts.append(fetch_luas_forecast(stop))
		except (HTTPError, URLError, TimeoutError, ET.ParseError, ValueError) as error:
			logger.warning(
				"Unable to fetch LUAS forecast for %s: %s",
				stop["abbreviation"],
				error,
			)

	if forecasts:
		batch = client.batch()
		collection = client.collection(LUAS_FORECASTS_COLLECTION)
		for forecast in forecasts:
			batch.set(
				collection.document(forecast["abbreviation"]),
				forecast,
			)
		batch.commit()

	return len(forecasts), len(stops) - len(forecasts)

def run_luas_forecast_poller(client_factory, logger, stop_event, interval):
	while not stop_event.is_set():
		poll_started_at = datetime.now(timezone.utc)
		started_at = monotonic()
		logger.info(
			"Starting LUAS forecast poll at %s",
			poll_started_at.isoformat(),
		)
		try:
			client = client_factory()
			uploaded, failed = sync_luas_forecasts(client, logger)
			logger.info(
				"Finished LUAS forecast poll at %s: uploaded=%d failed=%d "
				"duration=%.2fs",
				datetime.now(timezone.utc).isoformat(),
				uploaded,
				failed,
				monotonic() - started_at,
			)
		except Exception:
			logger.exception(
				"LUAS forecast poll failed at %s after %.2fs",
				datetime.now(timezone.utc).isoformat(),
				monotonic() - started_at,
			)
		stop_event.wait(interval)

def store_luas_stops(stops, client):
	collection = client.collection(LUAS_STOPS_COLLECTION)
	for offset in range(0, len(stops), 500):
		batch = client.batch()
		for stop in stops[offset:offset + 500]:
			batch.set(collection.document(stop["abbreviation"]), stop)
		batch.commit()
