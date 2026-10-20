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