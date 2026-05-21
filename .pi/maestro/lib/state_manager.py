import json
import os

STATE_FILE = ".pi/maestro/state.json"

def load_state():
    if not os.path.exists(STATE_FILE):
        return {"current_issue": None, "current_phase": None, "history": []}
    with open(STATE_FILE) as f:
        return json.load(f)

def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)
