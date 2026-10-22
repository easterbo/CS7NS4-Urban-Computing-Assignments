import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Lock, Thread
from urllib.error import HTTPError, URLError
import xml.etree.ElementTree as ET
import firebase_admin
from firebase_admin import credentials, firestore
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from backend.open_data import (
	LUAS_FORECASTS_POLL_SECONDS,
	LUAS_STOPS_COLLECTION,
	fetch_luas_stops,
	store_luas_stops,
	run_luas_forecast_poller,
)

# Load local settings; deployments can provide environment variables directly.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

server = Flask(__name__)
server.logger.setLevel(logging.INFO) # DEBUG - TBR

DATA_DIR = Path(__file__).resolve().parent / "data" / "Assignment2"
PENDING_UPLOAD_DIR = DATA_DIR / ".firebase-outbox"
FIREBASE_APP_NAME = "sensor-data-uploader"
FIRESTORE_COLLECTION = "sensor-data"

gps_data = []
microphone_data = {}
aligned_data = []
aligned_data_by_time = {}

pending_upload_seconds = {
	int(path.stem)
	for path in PENDING_UPLOAD_DIR.glob("*.json")
	if path.stem.isdigit()
} if PENDING_UPLOAD_DIR.exists() else set()

alignment_lock = Lock()
forecast_poller_stop = Event()
firestore_client = None

def get_firestore_client():
	global firestore_client
	project_id = os.environ.get("FIREBASE_PROJECT_ID")
	if not project_id:
		raise RuntimeError(
			"Firebase Firestore is not configured. Set FIREBASE_PROJECT_ID in .env."
		)
	if firestore_client is None:
		try:
			firebase_app = firebase_admin.get_app(FIREBASE_APP_NAME)
		except ValueError:
			firebase_app = firebase_admin.initialize_app(
				credentials.ApplicationDefault(),
				{"projectId": project_id},
				name=FIREBASE_APP_NAME,
			)
		firestore_client = firestore.client(app=firebase_app)
	return firestore_client

@server.cli.command("sync-luas-stops")
def sync_luas_stops_cmd():
	try:
		stops = fetch_luas_stops()
	except (HTTPError, URLError, TimeoutError, ET.ParseError, ValueError) as error:
		server.logger.error("Unable to fetch LUAS stops: %s", error)
		raise

	client = get_firestore_client()
	store_luas_stops(stops, client)

	# DEBUG - TBR
	server.logger.info(
		"Stored %d Red Line LUAS stops in project=%s collection=%s",
		len(stops),
		client.project,
		LUAS_STOPS_COLLECTION,
	)
	# DEBUG - TBR

def format_timestamp(timestamp_ns):
	timestamp_seconds = timestamp_ns // 1_000_000_000
	return datetime.fromtimestamp(timestamp_seconds, tz=timezone.utc).strftime("%d:%m:%Y %H:%M:%S")

def timestamp_key(timestamp):
	try:
		return int(timestamp)
	except ValueError:
		parsed = datetime.strptime(timestamp, "%d:%m:%Y %H:%M:%S")
		return int(parsed.replace(tzinfo=timezone.utc).timestamp()) * 1_000_000_000

def stage_interval(second):
	rows = [
		aligned_data[index]
		for timestamp_ns, index in aligned_data_by_time.items()
		if timestamp_ns // 1_000_000_000 == second
	]
	rows.sort(key=lambda row: timestamp_key(row["time"]))
	document = {
		"interval_start": format_timestamp(second * 1_000_000_000),
		"readings": rows,
	}
	PENDING_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
	(PENDING_UPLOAD_DIR / f"{second}.json").write_text(
		json.dumps(document, ensure_ascii=False),
		encoding="utf-8",
	)
	pending_upload_seconds.add(second)


def upload_interval(second, client):
	document_path = PENDING_UPLOAD_DIR / f"{second}.json"
	document = json.loads(document_path.read_text(encoding="utf-8"))
	document_ref = client.collection(FIRESTORE_COLLECTION).document(str(second))
	document_ref.set(document)
	document_path.unlink()
	# DEBUG - TBR
	server.logger.info(
		"Firestore write succeeded: project=%s collection=%s document=%s readings=%d",
		client.project,
		FIRESTORE_COLLECTION,
		second,
		len(document["readings"]),
	)
	# DEBUG - TBR


@server.route("/data", methods=["POST"])
def receive_data():
	request_data = request.get_json()
	if (
		not isinstance(request_data, dict)
		or not isinstance(request_data.get("payload"), list)
		or any(
			not isinstance(reading, dict)
			or not isinstance(reading.get("values", {}), dict)
			for reading in request_data["payload"]
		)
	):
		return jsonify({"error": "Expected a JSON object with a payload list."}), 400
	
	payload = request_data["payload"]
	with alignment_lock:
		changed_seconds = set()
		# DEBUG - TBR
		microphone_readings_received = 0
		moving_locations_received = 0
		stationary_locations_received = 0
		# DEBUG - TBR
		for reading in payload:
			name = reading.get("name")
			values = reading.get("values", {})
			timestamp = reading.get("time")

			if name == "microphone" and timestamp:
				timestamp_ns = int(timestamp)
				microphone_data[timestamp_ns] = {
					"time": format_timestamp(timestamp_ns),
					"volume": values.get("dBFS"),
				}
			elif name == "location" and timestamp:
				speed = float(values.get("speed", 0) or 0)
				if speed > 0:
					gps_data.append({
						"time": int(timestamp),
						"latitude": values.get("latitude"),
						"longitude": values.get("longitude"),
					})
				# DEBUG - TBR
				else:
					print(f"Skipping location reading with speed <= 0: {reading}")
				# DEBUG - TBR

		changed = False
		for microphone_timestamp, microphone_row in microphone_data.items():
			if not gps_data:
				continue
			closest_gps_row = min(
				gps_data,
				key=lambda gps_row: abs(microphone_timestamp - gps_row["time"]),
			)
			aligned_row = {
				**microphone_row,
				"latitude": closest_gps_row["latitude"],
				"longitude": closest_gps_row["longitude"],
			}
			
			if microphone_timestamp in aligned_data_by_time:
				index = aligned_data_by_time[microphone_timestamp]
				if aligned_data[index] != aligned_row:
					aligned_data[index] = aligned_row
					changed = True
					changed_seconds.add(microphone_timestamp // 1_000_000_000)

			else:
				aligned_data_by_time[microphone_timestamp] = len(aligned_data)
				aligned_data.append(aligned_row)
				changed = True
				changed_seconds.add(microphone_timestamp // 1_000_000_000)

		for second in changed_seconds:
			stage_interval(second)

		# DEBUG - TBR
		server.logger.info(
			"Received batch: payload_readings=%d microphone=%d moving_locations=%d "
			"speed_lt_zero_locations=%d, staged_intervals=%d "
			"pending_intervals=%d",
			len(payload),
			microphone_readings_received,
			moving_locations_received,
			stationary_locations_received,
			len(changed_seconds),
			len(pending_upload_seconds),
		)
		# DEBUG - TBR
		try:
			client = get_firestore_client()
		except RuntimeError as error:
			return jsonify({
				"error": str(error),
				"local_saved": changed,
				"pending_intervals": len(pending_upload_seconds),
			}), 503
		# DEBUG - TBR
		server.logger.info(
			"Firestore destination: project=%s collection=%s",
			client.project,
			FIRESTORE_COLLECTION,
		)
		# DEBUG - TBR

		for second in sorted(pending_upload_seconds):
			upload_interval(second, client)
			pending_upload_seconds.remove(second)
	return "success"


@server.get("/api/luas/stops")
def get_luas_stops():
	try:
		documents = get_firestore_client().collection(LUAS_STOPS_COLLECTION).stream()
	except RuntimeError as error:
		return jsonify({"error": str(error)}), 503

	stops = [document.to_dict() for document in documents]
	return jsonify(stops)


if __name__ == "__main__":
	# Thread(
	# 	target=run_luas_forecast_poller,
	# 	args=(
	# 		get_firestore_client,
	# 		server.logger,
	# 		forecast_poller_stop,
	# 		LUAS_FORECASTS_POLL_SECONDS,
	# 	),
	# 	daemon=True,
	# 	name="luas-forecast-poller",
	# ).start()
	server.run(port=8000, host="0.0.0.0")