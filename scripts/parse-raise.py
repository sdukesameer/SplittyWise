#!/usr/bin/env python3
"""Pull the results out of a deliberately-raised Postgres exception.

The Management API does not return notices, so supabase/security-tests.sql
collects its results into one string and raises it. That comes back as JSON
containing an error message which itself contains another JSON document —
so the escaping has to be undone twice, not once.
"""
import json
import re
import sys


def deepest_message(value, found):
    """Collect every string reachable in the decoded structure."""
    if isinstance(value, str):
        found.append(value)
        # A string that is itself JSON, or contains an embedded JSON object.
        inner = re.search(r'\{.*\}', value, re.S)
        if inner:
            try:
                deepest_message(json.loads(inner.group(0)), found)
            except ValueError:
                pass
    elif isinstance(value, dict):
        for item in value.values():
            deepest_message(item, found)
    elif isinstance(value, list):
        for item in value:
            deepest_message(item, found)


raw = sys.stdin.read()
strings = []
try:
    deepest_message(json.loads(re.search(r'\{.*\}', raw, re.S).group(0)), strings)
except (ValueError, AttributeError):
    strings = [raw]

# The one we want is the fully-unescaped message holding the results.
candidates = [s for s in strings if 'P0001' in s and '\n' in s]
text = max(candidates, key=len) if candidates else raw

body = re.search(r'ERROR:\s+P0001:\s*(.*?)(?:\nCONTEXT|$)', text, re.S)
out = (body.group(1) if body else text).strip('\n')

lines = out.split('\n')
for line in lines:
    print(('  ' + line) if line.strip() else '')

fails = sum(1 for l in lines if l.strip().startswith('FAIL'))
passes = sum(1 for l in lines if l.strip().startswith('PASS'))

print()
if passes == 0 and fails == 0:
    print('  Could not read any results — raw output above.')
    sys.exit(2)
print('  %d passed, %d failed' % (passes, fails))
sys.exit(1 if fails else 0)
