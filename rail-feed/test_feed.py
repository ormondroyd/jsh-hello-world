"""Basic Network Rail feed test: connect over STOMP and print live train movements for 30 seconds."""
import json
import os
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

import stomp

HOST = "publicdatafeeds.networkrail.co.uk"
PORT = 61618
TOPIC = "/topic/TRAIN_MVT_ALL_TOC"
RUN_SECONDS = 30

MSG_TYPES = {
    "0001": "activation",
    "0002": "cancellation",
    "0003": "movement",
    "0005": "reinstatement",
    "0006": "change of origin",
    "0007": "change of identity",
    "0008": "change of location",
}


def load_env(path):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


class Listener(stomp.ConnectionListener):
    def __init__(self):
        self.counts = Counter()

    def on_message(self, frame):
        for msg in json.loads(frame.body):
            msg_type = msg["header"]["msg_type"]
            self.counts[MSG_TYPES.get(msg_type, msg_type)] += 1
            if msg_type == "0003":
                b = msg["body"]
                when = datetime.fromtimestamp(int(b["actual_timestamp"]) / 1000).strftime("%H:%M:%S")
                late = f"{b['timetable_variation']} min {b['variation_status'].lower()}"
                print(f"{when}  {b['event_type']:<9}  train {b['train_id']}  at STANOX {b['loc_stanox']:<5}  {late}")

    def on_error(self, frame):
        print("Broker error:", frame.headers.get("message"), frame.body)


def main():
    load_env(Path(__file__).with_name(".env"))
    username, password = os.environ.get("NR_USERNAME"), os.environ.get("NR_PASSWORD")
    if not username or not password:
        sys.exit("Set NR_USERNAME and NR_PASSWORD in rail-feed/.env")

    listener = Listener()
    conn = stomp.Connection12([(HOST, PORT)], heartbeats=(15000, 15000))
    conn.set_listener("", listener)
    try:
        conn.connect(username=username, passcode=password, wait=True)
    except stomp.exception.ConnectFailedException:
        sys.exit("Connection refused: check your login, and that the account is active.")

    conn.subscribe(destination=TOPIC, id=1, ack="auto")
    print(f"Connected. Listening to {TOPIC} for {RUN_SECONDS}s...\n")
    time.sleep(RUN_SECONDS)
    conn.disconnect()

    print("\nMessages received:")
    for name, n in listener.counts.most_common():
        print(f"  {name:<20} {n}")
    if not listener.counts:
        print("  none - check you're subscribed to TRAIN_MVT_ALL_TOC on the data feeds portal")


if __name__ == "__main__":
    main()
