"""Create-only public evidence for v4 runs: docs/evidence/v4/<suite>/<run>/.

Any other path under docs/ is refused. Tests may point BUZZ_EVIDENCE_ROOT at a
directory under .local/ instead.
"""
from pathlib import Path
from datetime import datetime, timezone
import os
import re
import uuid

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_ROOT = ROOT / 'docs/evidence/v4'


def evidence_root():
    override = os.environ.get('BUZZ_EVIDENCE_ROOT')
    if not override:
        return PUBLIC_ROOT
    path = Path(os.path.abspath(override))
    try:
        path.relative_to(ROOT / '.local')
    except ValueError:
        raise ValueError('BUZZ_EVIDENCE_ROOT must be under .local/')
    return path


def _directory(path):
    path = Path(path)
    for parent in reversed([path, *path.parents]):
        if parent.is_symlink():
            raise ValueError('evidence directory is redirected')
    path.mkdir(parents=True, exist_ok=True)


def _sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def create_evidence_run(suite):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', suite):
        raise ValueError('invalid evidence suite')
    parent = evidence_root() / suite
    _directory(parent)
    stamp = datetime.now(timezone.utc).isoformat().replace(':', '-').replace('.', '-')
    path = parent / (stamp + '-' + str(uuid.uuid4()))
    path.mkdir()  # Exclusive: never adopt an earlier command's directory.
    _sync_directory(parent)
    return path


def _file(path):
    path = Path(os.path.abspath(path))
    root = evidence_root()
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        raise ValueError('evidence path is outside the v4 evidence root')
    if len(parts) < 3:
        raise ValueError('evidence writes require <root>/<suite>/<run>/')
    _directory(path.parent)
    return path


def write_evidence_json(path, value):
    import json
    content = json.dumps(value, indent=2) + '\n'
    path = _file(path)
    with path.open('x', encoding='utf8') as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
    _sync_directory(path.parent)


def open_evidence_log(path):
    path = _file(path)
    output = path.open('x', encoding='utf8')
    _sync_directory(path.parent)
    return output  # Incremental writes use only this exclusively owned handle.
