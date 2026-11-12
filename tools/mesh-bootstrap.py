#!/usr/bin/env python3
"""Fetch pinned public MeshLLM artifacts into the ignored .local/mesh directory."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request
import shutil
from evidence import create_evidence_run, write_evidence_json

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / '.local/mesh'
RELEASE = 'v0.78.1'
COMMIT = 'bc215ce5b880e21c6c3840b8574ab64f83278821'
MODEL_REVISION = '50968a4468ef4233ed78cd7c3de230dd1d61a56b'
ARTIFACTS = {
    'mesh-llm-v0.78.1-aarch64-apple-darwin.tar.gz': {
        'url': 'https://github.com/Mesh-LLM/mesh-llm/releases/download/v0.78.1/mesh-llm-v0.78.1-aarch64-apple-darwin.tar.gz',
        'size': 57456378, 'sha256': 'a00fd8c7c3d4cf5a543c83b2034dcf7a7cfe02198f9056faa09305d774ae5001'},
    'Qwen3-0.6B-Q4_K_M.gguf': {
        'url': 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/' + MODEL_REVISION + '/Qwen3-0.6B-Q4_K_M.gguf',
        'size': 396705472, 'sha256': 'ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a'},
}

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)


def fetch(name, metadata):
    path = STATE / 'downloads' / name
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.exists():
        partial = path.with_suffix(path.suffix + '.partial')
        # A stale incomplete download is never treated as verified content.
        if partial.exists(): partial.unlink()
        request = urllib.request.Request(metadata['url'], headers={'User-Agent': 'Hive/1'})
        h = hashlib.sha256(); size = 0
        with urllib.request.urlopen(request, timeout=60) as response, partial.open('xb') as out:
            os.chmod(partial, 0o600)
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk: break
                size += len(chunk)
                if size > metadata['size']: raise RuntimeError('artifact exceeds its pinned size: ' + name)
                h.update(chunk); out.write(chunk)
            out.flush(); os.fsync(out.fileno())
        if size != metadata['size'] or h.hexdigest() != metadata['sha256']:
            raise RuntimeError('download integrity mismatch: ' + name)
        os.replace(partial, path)
    if path.is_symlink() or path.stat().st_size != metadata['size'] or digest(path) != metadata['sha256']:
        raise RuntimeError('existing artifact integrity mismatch: ' + name)
    print(json.dumps({'verified': name, **metadata}), flush=True)
    return path


def release_tree(archive):
    target = STATE / 'release'
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest = {}
    with tarfile.open(archive, 'r:gz') as package:
        members = package.getmembers()
        for member in members:
            relative = PurePosixPath(member.name)
            if relative.is_absolute() or '..' in relative.parts:
                raise RuntimeError('unsafe archive path')
            path = target / str(relative)
            if member.isdir():
                if path.is_symlink(): raise RuntimeError('extracted directory is a symlink')
                path.mkdir(parents=True, exist_ok=True, mode=0o700)
                continue
            if member.issym():
                resolved = (path.parent / member.linkname).resolve()
                if not str(resolved).startswith(str(target) + os.sep): raise RuntimeError('unsafe archive symlink')
                if path.is_symlink():
                    if os.readlink(path) != member.linkname: raise RuntimeError('altered archive symlink')
                elif path.exists(): raise RuntimeError('extracted link type changed')
                else:
                    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700); path.symlink_to(member.linkname)
                manifest[member.name] = {'symlink': member.linkname}
                continue
            if not member.isfile(): raise RuntimeError('unsupported archive member')
            content = package.extractfile(member).read()
            expected = hashlib.sha256(content).hexdigest()
            if path.is_symlink(): raise RuntimeError('extracted regular file is a symlink')
            if path.exists():
                if digest(path) != expected: raise RuntimeError('altered extracted release file: ' + member.name)
            else:
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with path.open('xb') as out: out.write(content)
                os.chmod(path, 0o700 if member.mode & 0o111 else 0o600)
            manifest[member.name] = {'sha256': expected, 'size': len(content)}
    binaries = [target / name for name in manifest if PurePosixPath(name).name == 'mesh-llm' and 'sha256' in manifest[name]]
    if len(binaries) != 1: raise RuntimeError('release must contain exactly one mesh-llm executable')
    return binaries[0], manifest


def main():
    if os.uname().sysname != 'Darwin' or os.uname().machine != 'arm64': raise RuntimeError('this fixture requires macOS arm64')
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    if STATE.resolve() != STATE: raise RuntimeError('fixture directory must not be redirected')
    paths = {name: fetch(name, metadata) for name, metadata in ARTIFACTS.items()}
    binary, manifest = release_tree(paths['mesh-llm-v0.78.1-aarch64-apple-darwin.tar.gz'])
    evidence = {'schema': 'hive-mesh-bootstrap/v1', 'release': RELEASE, 'sourceCommit': COMMIT,
        'artifacts': ARTIFACTS, 'modelRevision': MODEL_REVISION, 'modelPath': str(paths['Qwen3-0.6B-Q4_K_M.gguf']),
        'binaryPath': str(binary), 'extractedFiles': manifest,
        'commands': ['python3 tools/mesh-bootstrap.py', 'python3 tools/mesh-run.py start', 'python3 tools/mesh-run.py proof'],
        'sources': ['https://api.github.com/repos/Mesh-LLM/mesh-llm/releases/tags/v0.78.1',
            'https://huggingface.co/api/models/unsloth/Qwen3-0.6B-GGUF/tree/' + MODEL_REVISION,
            'https://github.com/Mesh-LLM/mesh-llm/blob/' + COMMIT + '/crates/mesh-llm-node/src/catalog.json#L466']}
    save(STATE / 'bootstrap.json', evidence)
    write_evidence_json(create_evidence_run('mesh-bootstrap') / 'mesh-bootstrap.json', evidence)
    print(json.dumps({'status': 'verified', 'binaryPath': str(binary), 'modelPath': evidence['modelPath']}))

if __name__ == '__main__': main()
