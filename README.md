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

## LUAS stops
The LUAS Forecasting API provides the current stop list. To fetch Red Line
stops and sync them to Firestore, run this command from the project directory:

```sh
flask --app server sync-luas-stops
```

The command reads the LUAS XML stops feed and writes one document per Red Line
stop to `luas-stops/<abbreviation>`. Each document contains only the `line`,
`abbreviation`, `latitude`, and `longitude` fields. Re-running the command
updates existing Red Line stops and adds new ones to the collection. It requires the same Firebase project
configuration and Application Default Credentials as the sensor data receiver.

When started with `python server.py`, the app polls the LUAS Forecasting
API immediately and every 60 seconds for arrivals at each Red Line stop. The
latest response for each stop is written to
`luas-forecasts/<abbreviation>`; each document contains the line, stop
abbreviation and name, API and poll timestamps, service message, and arrivals
grouped by direction (due minutes and destination). A failed stop request is
logged and does not prevent successful forecasts for other stops from being
stored. The poller needs the same Firebase configuration and credentials.

The [Luas Forecasting API dataset](https://data.gov.ie/dataset/luas-forecasting-api)
documents the API and its stop abbreviations.

`server.py` contains the Flask sensor-data receiver and app startup;
`open_data.py` contains the LUAS feed parsing, Firestore writes, and forecast polling.

## Dublin map frontend
The Vite frontend is in `frontend/`. It uses Leaflet with OpenStreetMap tiles
to display an interactive map centered on Dublin. From that directory, install
the JavaScript dependencies and start the development server:

```sh
cd frontend
npm install
npm run dev
```

Open the local URL printed by Vite. The frontend is currently a standalone map;
it does not yet load sensor readings or LUAS data from Flask.