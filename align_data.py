# Take volume.csv and gps.csv
# Align by timestamp and output csv with columns:
# - timestamp
# - volume
# - latitude
# - longitude

import csv
from pathlib import Path

volume = "/Users/ollieeasterbrook/Desktop/COMP SCI DEGREE/5th Year/Urban Computing/Assignments/CS7NS4-Urban-Computing-Assignments/data/volume.csv"
gps = "/Users/ollieeasterbrook/Desktop/COMP SCI DEGREE/5th Year/Urban Computing/Assignments/CS7NS4-Urban-Computing-Assignments/data/gps.csv"

output_file = "/Users/ollieeasterbrook/Desktop/COMP SCI DEGREE/5th Year/Urban Computing/Assignments/CS7NS4-Urban-Computing-Assignments/data/dataset.csv"

with open(volume, "r", encoding="utf-8-sig", newline="") as f:
    volume_reader = csv.DictReader(f)
    volume_data = list(volume_reader)
    reader = csv.DictReader(f)

    # Continue...

with open(gps, "r", encoding="utf-8-sig", newline="") as f:
    gps_reader = csv.DictReader(f)
    gps_data = list(gps_reader)
    reader = csv.DictReader(f)

    # Continue...

