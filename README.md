# Sensor Data Receiver

The Flask server accepts Sensor Logger batches at `POST /data`, aligns each
microphone reading with the closest moving GPS reading (`speed > 0`), and
keeps aligned rows in memory while running. It writes aligned readings to
Firestore in one-second UTC batches, with one document per batch:

```text
sensor-data/<epoch-second>
```

Each document has an `interval_start` timestamp in `dd:mm:yyyy hh:mm:ss` UTC
format and a `readings` array. `interval_start` labels the beginning of the
one-second batch; it does not mean every reading was recorded exactly at that
`.00` timestamp. Readings whose timestamps fall anywhere within that second
are included in the same batch. Reading `time` values are currently formatted
to whole-second precision. If a later GPS reading changes the closest match,
that interval's object is overwritten with the updated alignment.
Until writing succeeds, each JSON document is kept in
`data/Assignment2/.firebase-outbox/` so it survives server restarts and can be
written on a later request. Aligned readings held only in memory are lost when
the server stops. Successfully written batches remain in Firestore.
`GET /api/sensor-data` returns the stored batches as a flat list of readings
for the map.

## Firebase setup
1. Install the Google Cloud CLI if needed, then authenticate for local
   development:

   ```sh
   gcloud auth application-default login
   ```

   This opens a browser to authenticate your Google account. The server uses
   these Application Default Credentials; no service-account JSON key is
   needed for local development.
2. Copy `.env.example` to `.env` and set the project ID:

   ```sh
   cp .env.example .env
   ```

   Set `FIREBASE_PROJECT_ID` to the project ID shown in Firebase Project
   settings.
3. Install dependencies and run the server:

   ```sh
   pip install -r requirements.txt
   python server.py
   ```

The server listens on port `8000`. The endpoint returns `503` when the Firestore
project is not configured. If a Firestore write fails, the request fails and the
batch remains in the local outbox for retry.

The Flask server uses the Firebase Admin SDK, so no browser Firebase
configuration is required. Admin SDK access bypasses Firestore Security Rules;
your Google account's IAM permissions control local server access.

## Uploading the assignment dataset
With the Firebase setup above complete, run this command from the repository
root to upload `backend/data/Assignment1/Dataset.csv` to `sensor-data`:

```sh
flask --app backend.server upload-dataset
```

The command groups readings into the same one-second UTC documents used by the
live receiver. Existing documents with matching timestamps are replaced. To
upload a different CSV with the same columns, pass its path after the command.

## LUAS stops
The LUAS Forecasting API provides the current stop list. To fetch Red Line
stops and sync them to Firestore, run this command from the project directory:

```sh
flask --app server sync-luas-stops
```

The command reads the LUAS XML stops feed and writes one document per Red Line
stop to `luas-stops/<abbreviation>`. Each document contains only the `line`,
`abbreviation`, `stop_name`, `sequence`, `latitude`, and `longitude` fields.
Re-running the command
updates existing Red Line stops and adds new ones to the collection. It requires the same Firebase project
configuration and Application Default Credentials as the sensor data receiver.
The command also fetches the Red Line GeoJSON from the source described below
and stores the FeatureCollection in `luas-line/red-line`.
Run this command again after upgrading so existing stop documents receive the
name and sequence fields used to position trams.

When started with `python server.py`, the app polls the LUAS Forecasting
API immediately and every 60 seconds for arrivals at each Red Line stop. The
latest response for each stop is written to
`luas-forecasts/<abbreviation>`; each document contains the line, stop
abbreviation and name, API and poll timestamps, service message, and arrivals
grouped by direction (due minutes and destination). A failed stop request is
logged and does not prevent successful forecasts for other stops from being
stored. The poller needs the same Firebase configuration and credentials.
The map reads these records from `GET /api/luas/forecasts` and refreshes the
tram shapes every 60 seconds. Each forecast's due time estimates a tram's
position between the corresponding ordered stops along the shortest connected
path through the original LUAS route geometry, assuming an average 2.5 minutes
between stops; duplicate estimates from nearby stop forecasts are combined.
These are approximate positions because the API provides arrival estimates,
not live tram coordinates.

The [Luas Forecasting API dataset](https://data.gov.ie/dataset/luas-forecasting-api)
documents the API and its stop abbreviations.

## LUAS Red Line track geometry
The sync command fetches the latest Red Line GeoJSON from
[LUAS_Red_Line.geojson](https://github.com/BuildingCityDashboards/bcd-dd-v2.1/blob/master/public/data/Transport/LUAS_Red_Line.geojson)
and stores it as the `luas-line/red-line` Firestore document. The backend
stores the GeoJSON as a JSON string because Firestore does not support the
nested coordinate arrays in GeoJSON. It decodes and serves the document at
`GET /api/luas/line`, which the frontend uses to draw the route. The source
data is OpenStreetMap-derived and provided under the
[Open Data Commons Open Database License (ODbL)](https://www.openstreetmap.org/copyright);
the map includes OpenStreetMap contributor attribution.

`server.py` contains the Flask sensor-data receiver and app startup;
`open_data.py` contains the LUAS feed parsing, Firestore writes, and forecast polling.

## Dublin map frontend
The Vite frontend is in `frontend/`. It uses Leaflet with OpenStreetMap tiles
to display the Red Line track geometry and LUAS stops on an interactive map.
From that directory, install
the JavaScript dependencies and start the development server:

```sh
cd frontend
npm install
npm run dev
```

Open the local URL printed by Vite. The frontend loads Red Line track geometry
and stop locations from Flask. The route is displayed with its original GeoJSON
geometry. Each reading from `GET /api/sensor-data` is matched to its nearest
point on the original route lines and grouped with readings in the same
10-metre route section. Sections with readings are colored over the route using
a green-to-red scale based on their average `dBFS` value; individual sensor
readings are not plotted as markers. Clicking a colored section shows its
average and reading count.
Averages at or below `-35 dBFS` are green, and louder averages transition from
green to red up to `0 dBFS`. These are digital microphone levels, not
calibrated environmental sound-pressure levels such as dB(A). Readings more
than 10 metres from the Red Line geometry are omitted from the map.