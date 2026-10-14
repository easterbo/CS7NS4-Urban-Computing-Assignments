# Take volume.csv and gps.csv
# Align by time and output csv with columns:
# - time
# - volume
# - latitude
# - longitude

import csv

volume = "/Users/ollieeasterbrook/Desktop/COMP SCI DEGREE/5th Year/Urban Computing/Assignments/CS7NS4-Urban-Computing-Assignments/data/Microphone.csv"
gps = "/Users/ollieeasterbrook/Desktop/COMP SCI DEGREE/5th Year/Urban Computing/Assignments/CS7NS4-Urban-Computing-Assignments/data/Location.csv"
output_file = "/Users/ollieeasterbrook/Desktop/COMP SCI DEGREE/5th Year/Urban Computing/Assignments/CS7NS4-Urban-Computing-Assignments/data/Dataset.csv"

gps_fields_to_remove = {
    "speedAccuracy",
    "bearingAccuracy",
    "altitudeAccuracy",
    "horizontalAccuracy",
    "verticalAccuracy",
    "bearing",
    "altitudeAboveMeanSeaLevel",
}

with open(gps, "r", encoding="utf-8-sig", newline="") as f:
    gps_reader = csv.DictReader(f)
    gps_data = [
        {key: value for key, value in row.items() if key not in gps_fields_to_remove}
        for row in gps_reader
        if row and row.get("time") is not None and float(row.get("speed", 0) or 0) > 0
    ]

with open(volume, "r", encoding="utf-8-sig", newline="") as f:
    volume_reader = csv.DictReader(f)
    volume_data = list(volume_reader)

merged_data = []
for v_row in volume_data:
    v_timestamp = v_row.get("time")
    if not v_timestamp:
        continue

    closest_gps_row = None
    closest_time_diff = float("inf")

    for g_row in gps_data:
        g_timestamp = g_row.get("time")
        if not g_timestamp:
            continue

        time_diff = abs(float(v_timestamp) - float(g_timestamp))
        if time_diff < closest_time_diff:
            closest_time_diff = time_diff
            closest_gps_row = g_row

    if closest_gps_row:
        merged_data.append({
            "time": v_timestamp,
            "volume": v_row.get("dBFS"),
            "latitude": closest_gps_row.get("latitude"),
            "longitude": closest_gps_row.get("longitude"),
        })

with open(output_file, "w", encoding="utf-8-sig", newline="") as f:
    fieldnames = ["time", "volume", "latitude", "longitude"]
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(merged_data)
