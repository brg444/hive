"""Offline checks of the create-only evidence helper. Writes only under .local/."""
import json
import os
from pathlib import Path
from evidence import ROOT, create_evidence_run, open_evidence_log, write_evidence_json

os.environ['BUZZ_EVIDENCE_ROOT'] = str(ROOT / '.local/test-runs/evidence-python')
first = create_evidence_run('evidence-python')
second = create_evidence_run('evidence-python')
assert first != second
path = first / 'result.json'
write_evidence_json(path, {'run': 'first'})
original = path.read_bytes()
try:
    write_evidence_json(path, {'run': 'replacement'})
except FileExistsError:
    pass
else:
    raise AssertionError('existing evidence was replaced')
assert path.read_bytes() == original
for forbidden in [ROOT / 'docs/evidence/other/sidecar.json', ROOT / 'docs/other/x/y.json', ROOT / 'docs/evidence/v4/x.json', ROOT / 'outside.json']:
    try:
        write_evidence_json(forbidden, {})
    except ValueError:
        pass
    else:
        raise AssertionError('forbidden evidence path accepted')
os.environ['BUZZ_EVIDENCE_ROOT'] = str(ROOT / 'docs')
try:
    create_evidence_run('escape')
except ValueError:
    pass
else:
    raise AssertionError('evidence root outside .local accepted')
os.environ['BUZZ_EVIDENCE_ROOT'] = str(ROOT / '.local/test-runs/evidence-python')
log_path = first / 'stream.log'
with open_evidence_log(log_path) as log:
    log.write('first\n')
    try:
        open_evidence_log(log_path)
    except FileExistsError:
        pass
    else:
        raise AssertionError('existing evidence log was reopened')
    log.write('second\n')
assert log_path.read_text() == 'first\nsecond\n'
print(json.dumps({'status': 'passed'}))
