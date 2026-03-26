#!/bin/bash
python3 -c "
import json, glob, os
for sf in glob.glob(os.path.expanduser('~/.openclaw/agents/*/sessions/sessions.json')):
    d=json.load(open(sf))
    keys=[k for k in d if 'slash' in k]
    if keys:
        for k in keys: del d[k]
        json.dump(d, open(sf,'w'), indent=2)
"
