import json
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
import firebase_admin
from firebase_admin import credentials, storage
from dotenv import load_dotenv
from flask import Flask, jsonify, request

# Load local settings; deployments can provide environment variables directly.
load_dotenv(Path(__file__).resolve().parent / ".env")

server = Flask(__name__)

DATA_DIR = Path(__file__).resolve().parent / "data" / "Assignment2"
PENDING_UPLOAD_DIR = DATA_DIR / ".firebase-outbox"
FIREBASE_APP_NAME = "sensor-data-uploader"
FIREBASE_STORAGE_PREFIX = "sensor-data"

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
firebase_bucket = None

def get_firebase_bucket():
	global firebase_bucket
	bucket_name = os.environ.get("FIREBASE_STORAGE_BUCKET")
	if not bucket_name:
		raise RuntimeError(
			"Firebase Storage is not configured. Set FIREBASE_STORAGE_BUCKET "
			"in .env or the server environment."
		)
	if firebase_bucket is None:
		try:
			firebase_app = firebase_admin.get_app(FIREBASE_APP_NAME)
		except ValueError:
			firebase_app = firebase_admin.initialize_app(
				credentials.ApplicationDefault(),
				{"storageBucket": bucket_name},
				name=FIREBASE_APP_NAME,
			)
		firebase_bucket = storage.bucket(bucket_name, app=firebase_app)
	return firebase_bucket

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


def upload_interval(second, bucket):
	document_path = PENDING_UPLOAD_DIR / f"{second}.json"
	blob = bucket.blob(f"{FIREBASE_STORAGE_PREFIX}/{second}.json")
	blob.upload_from_string(
		document_path.read_text(encoding="utf-8"),
		content_type="application/json",
	)
	document_path.unlink()


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
				if float(values.get("speed", 0) or 0) > 0:
					gps_data.append({
						"time": int(timestamp),
						"latitude": values.get("latitude"),
						"longitude": values.get("longitude"),
					})

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

		try:
			bucket = get_firebase_bucket()
		except RuntimeError as error:
			return jsonify({
				"error": str(error),
				"local_saved": changed,
				"pending_intervals": len(pending_upload_seconds),
			}), 503

		for second in sorted(pending_upload_seconds):
			upload_interval(second, bucket)
			pending_upload_seconds.remove(second)
	return "success"


if __name__ == "__main__":
	server.run(port=8000, host="0.0.0.0")
