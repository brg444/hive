#!/usr/bin/env python3
"""Run the pinned local MeshLLM fixture under an explicit macOS sandbox."""
import argparse
import hashlib
import json
import os
import shlex
import signal
import runpy
import tarfile
from pathlib import Path
import socket
import subprocess
import time
import urllib.request
from evidence import create_evidence_run, write_evidence_json

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / '.local/mesh'
EVIDENCE = None  # Allocated by main for this command, never while importing pins.
BASE = 'http://127.0.0.1:9337'


def sha(content): return hashlib.sha256(content).hexdigest()
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

def write_once(path, content):
    if path.exists():
        if path.read_text() != content: raise RuntimeError('existing isolated configuration changed: ' + path.name)
    else:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream: stream.write(content); stream.flush(); os.fsync(stream.fileno())

def prepare():
    metadata = json.loads((STATE / 'bootstrap.json').read_text())
    pins = runpy.run_path(str(ROOT / 'tools/mesh-bootstrap.py'))
    if metadata['artifacts'] != pins['ARTIFACTS'] or metadata['sourceCommit'] != pins['COMMIT']:
        raise RuntimeError('bootstrap metadata differs from committed artifact pins')
    if STATE.resolve() != STATE: raise RuntimeError('fixture directory must not be redirected')
    for name, info in metadata['artifacts'].items():
        path = STATE / 'downloads' / name
        if path.is_symlink() or path.stat().st_size != info['size'] or digest(path) != info['sha256']:
            raise RuntimeError('pinned artifact changed: ' + name)
    expected_files = {}
    archive = STATE / 'downloads/mesh-llm-v0.78.1-aarch64-apple-darwin.tar.gz'
    with tarfile.open(archive, 'r:gz') as package:
        for member in package:
            if member.issym(): expected_files[member.name] = {'symlink':member.linkname}
            elif member.isfile():
                content = package.extractfile(member).read()
                expected_files[member.name] = {'sha256':sha(content),'size':len(content)}
    if metadata['extractedFiles'] != expected_files: raise RuntimeError('release metadata differs from pinned archive')
    if metadata['binaryPath'] != str(STATE / 'release/mesh-bundle/mesh-llm') or metadata['modelPath'] != str(STATE / 'downloads/Qwen3-0.6B-Q4_K_M.gguf'):
        raise RuntimeError('bootstrap executable or model path changed')
    for name, info in expected_files.items():
        path = STATE / 'release' / name
        if 'symlink' in info:
            if not path.is_symlink() or os.readlink(path) != info['symlink']: raise RuntimeError('release symlink changed')
        elif path.is_symlink() or digest(path) != info['sha256']: raise RuntimeError('release content changed: ' + name)
    for name in ['runtime', 'hf/hub', 'hf/xet', 'data', 'native-cache', 'metal', 'stages', 'tmp', 'app-state']:
        (STATE / name).mkdir(parents=True, exist_ok=True, mode=0o700)
    config = 'version = 1\n[telemetry]\nenabled = false\n[analytics]\nenabled = false\n[logging]\nenabled = false\napplication_state_root = ' + json.dumps(str(STATE / 'app-state')) + '\n'
    write_once(STATE / 'config.toml', config)
    # HOME is preserved exactly. Read denials protect existing identity directories;
    # write denials make incidental upstream cache locations fail closed.
    protected = [Path.home() / name for name in ['.mesh-llm', '.bitcoin', '.lnd', '.spark', '.arkade']]
    protected += [ROOT / '.secrets']
    profile = '(version 1)\n(allow default)\n(deny file-write*)\n' + '(allow file-write* (subpath ' + json.dumps(str(STATE)) + ') (literal "/dev/null"))\n'
    for path in protected: profile += '(deny file-read* (subpath ' + json.dumps(str(path)) + '))\n'
    profile += '(deny network*)\n(allow network* (local ip "localhost:*") (remote ip "localhost:*"))\n'
    write_once(STATE / 'sandbox.sb', profile)
    # A small allowlist excludes inherited authentication, endpoint and plugin overrides.
    environment = {key: os.environ[key] for key in ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL'] if key in os.environ}
    environment.update({
        'MESH_LLM_CONFIG': str(STATE / 'config.toml'),
        'MESH_LLM_RUNTIME_ROOT': str(STATE / 'runtime'),
        'HF_HUB_CACHE': str(STATE / 'hf/hub'), 'HF_XET_CACHE': str(STATE / 'hf/xet'),
        'MESH_LLM_DATA_DIR': str(STATE / 'data'),
        'MESH_LLM_NATIVE_RUNTIME_CACHE_DIR': str(STATE / 'native-cache'),
        'GGML_METAL_PIPELINE_CACHE_DIR': str(STATE / 'metal'),
        'SKIPPY_MATERIALIZED_DIR': str(STATE / 'stages'), 'TMPDIR': str(STATE / 'tmp') + '/',
    })
    # sandbox-exec drops inherited DYLD variables. Set this Apple framework
    # preload only after entering the sandbox; keep the published binary intact.
    prefix = ['/usr/bin/sandbox-exec', '-f', str(STATE / 'sandbox.sb'), '/usr/bin/env',
        'DYLD_INSERT_LIBRARIES=/System/Library/Frameworks/CoreGraphics.framework/Versions/A/CoreGraphics']
    return metadata, environment, prefix

def get(path, timeout=10):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as response:
        data = response.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024: raise RuntimeError('response exceeds fixture bound')
        return json.loads(data)

def inspect(metadata, environment, prefix):
    binary = metadata['binaryPath']
    version = subprocess.run(prefix + [binary, '--version'], cwd=STATE, env=environment, capture_output=True, text=True, timeout=30)
    help_result = subprocess.run(prefix + [binary, 'serve', '--help'], cwd=STATE, env=environment, capture_output=True, text=True, timeout=30)
    advanced = subprocess.run(prefix + [binary, '--help-advanced'], cwd=STATE, env=environment, capture_output=True, text=True, timeout=30)
    if version.returncode != 0 or help_result.returncode != 0 or advanced.returncode != 0:
        raise RuntimeError('sandboxed binary inspection failed: ' + (version.stderr + help_result.stderr)[-3000:])
    if '0.78.1' not in version.stdout: raise RuntimeError('published binary reports an unexpected version')
    for flag in ['--local-model-only', '--config', '--gguf', '--port', '--ctx-size', '--parallel', '--device']:
        if flag not in advanced.stdout: raise RuntimeError('published help lacks required flag: ' + flag)
    proof = {'version': version.stdout.strip(), 'versionCommand': prefix + [binary, '--version'],
        'serveHelp': help_result.stdout, 'serveHelpSha256': sha(help_result.stdout.encode()),
        'advancedHelp': advanced.stdout, 'advancedHelpSha256': sha(advanced.stdout.encode()),
        'sandboxProfile': (STATE / 'sandbox.sb').read_text(), 'environmentOverrides': {k:v for k,v in environment.items() if k not in ['HOME','USER','LOGNAME','PATH','LANG','LC_ALL']},
        'homeUnchanged': environment.get('HOME') == os.environ.get('HOME'), 'config': (STATE / 'config.toml').read_text()}
    write_evidence_json(EVIDENCE / 'mesh-inspection.json', proof)
    return proof

def process_details(pid):
    if type(pid) is not int or pid < 2: raise RuntimeError('invalid saved server PID')
    fields = {}
    for name in ['lstart', 'command', 'stat']:
        result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', name + '='], capture_output=True, text=True)
        if result.returncode == 1 and not result.stdout: return None
        if result.returncode != 0: raise RuntimeError('cannot inspect isolated server PID')
        fields[name] = result.stdout.strip()
    if fields['stat'].startswith('Z'): return None
    return fields

def verify_own_process(metadata, saved):
    actual = process_details(saved['pid'])
    if actual is None: return None
    command = saved['command']
    if metadata['binaryPath'] not in command: raise RuntimeError('saved command lacks pinned binary')
    expected = command[command.index(metadata['binaryPath']):]
    if shlex.split(actual['command']) != expected or '--local-model-only' not in expected:
        raise RuntimeError('saved PID does not match the isolated server command')
    if saved.get('processStartedAt') and actual['lstart'] != saved['processStartedAt']:
        raise RuntimeError('saved PID was reused by a different process')
    return actual

def stop(metadata):
    record = STATE / 'process.json'
    if not record.exists():
        print(json.dumps({'status':'not-started'})); return
    saved = json.loads(record.read_text())
    actual = verify_own_process(metadata, saved)
    if actual is None:
        print(json.dumps({'status':'already-stopped','pid':saved['pid']})); return
    # Bind every signal to the creation time as well as the exact pinned command.
    saved['processStartedAt'] = actual['lstart']
    os.kill(saved['pid'], signal.SIGTERM)
    for _ in range(100):
        if verify_own_process(metadata, saved) is None:
            print(json.dumps({'status':'stopped','pid':saved['pid'],'signal':'SIGTERM'})); return
        time.sleep(0.1)
    if verify_own_process(metadata, saved) is not None: os.kill(saved['pid'], signal.SIGKILL)
    for _ in range(20):
        if process_details(saved['pid']) is None:
            print(json.dumps({'status':'stopped','pid':saved['pid'],'signal':'SIGKILL'})); return
        time.sleep(0.1)
    raise RuntimeError('isolated server did not exit after bounded stop')

def start(metadata, environment, prefix):
    record = STATE / 'process.json'
    saved = json.loads(record.read_text()) if record.exists() else None
    actual = verify_own_process(metadata, saved) if saved else None
    with socket.socket() as sock:
        sock.settimeout(1); listening = sock.connect_ex(('127.0.0.1', 9337)) == 0
    if listening:
        if actual is None: raise RuntimeError('port 9337 already belongs to an unrecorded process')
        if not saved.get('processStartedAt'):
            saved['processStartedAt'] = actual['lstart']; save(record, saved)
        print(json.dumps({'status':'already-running', 'pid':saved['pid'], 'models':get('/v1/models')})); return
    if actual is not None: raise RuntimeError('recorded server is still starting; refusing another process')
    inspect(metadata, environment, prefix)
    command = prefix + [metadata['binaryPath'], 'serve', '--local-model-only', '--config', str(STATE / 'config.toml'),
        '--gguf', metadata['modelPath'], '--port', '9337', '--ctx-size', '2048', '--parallel', '1', '--device', 'MTL0']
    log = (STATE / 'server.log').open('ab', buffering=0); os.chmod(STATE / 'server.log', 0o600)
    child = subprocess.Popen(command, cwd=STATE, env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    log.close()
    saved = {'pid':child.pid, 'startedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()), 'command':command,
        'endpoint':BASE + '/v1', 'sandboxProfileSha256':digest(STATE / 'sandbox.sb')}
    details = process_details(child.pid)
    if details is not None: saved['processStartedAt'] = details['lstart']
    save(record, saved)
    for _ in range(180):
        if child.poll() is not None:
            raise RuntimeError('isolated MeshLLM exited ' + str(child.returncode) + '; inspect ignored server.log')
        try:
            models = get('/v1/models', 1)
            if models.get('data'):
                saved['models'] = models; write_evidence_json(EVIDENCE / 'mesh-runtime.json', saved)
                print(json.dumps({'status':'ready', 'pid':child.pid, 'endpoint':BASE + '/v1', 'models':models})); return
        except (OSError, ValueError): pass
        time.sleep(1)
    raise RuntimeError('MeshLLM startup readiness timed out; recorded process remains available for diagnosis')

def post(body):
    encoded = json.dumps(body,separators=(',',':')).encode()
    req = urllib.request.Request(BASE + '/v1/chat/completions', data=encoded, headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=120) as response:
        data = response.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024: raise RuntimeError('inference response exceeds fixture bound')
        return {'request':body,'requestSha256':sha(encoded),'status':response.status,'contentType':response.headers.get('Content-Type'),
            'body':data.decode(),'responseSha256':sha(data)}

def check_usage(usage):
    if not isinstance(usage,dict): raise RuntimeError('missing actual model usage')
    for key in ['prompt_tokens','completion_tokens','total_tokens']:
        if type(usage.get(key)) is not int or not 0 <= usage[key] <= 0xffffffff: raise RuntimeError('invalid usage integer')
    if usage['total_tokens'] != usage['prompt_tokens'] + usage['completion_tokens']: raise RuntimeError('usage sum differs')
    if usage['prompt_tokens'] <= 0 or not 0 < usage['completion_tokens'] <= 32: raise RuntimeError('usage is outside fixture bounds')

def proof():
    models = get('/v1/models'); model = models['data'][0]['id']
    common = {'model':model,'messages':[{'role':'user','content':'Reply with exactly: Hive local test.'}],
        'max_tokens':32,'temperature':0,'chat_template_kwargs':{'enable_thinking':False}}
    plain = post({**common,'stream':False}); parsed = json.loads(plain['body']); check_usage(parsed.get('usage'))
    plain['usage'] = parsed['usage']
    streaming = post({**common,'stream':True,'stream_options':{'include_usage':True}})
    frames = [line[5:].strip() for line in streaming['body'].splitlines() if line.startswith('data:')]
    if not frames or frames[-1] != '[DONE]': raise RuntimeError('stream lacks terminal DONE')
    chunks = [json.loads(frame) for frame in frames[:-1]]
    usages = [value['usage'] for value in chunks if value.get('usage') is not None]
    if len(usages) != 1: raise RuntimeError('free local fixture expected one terminal usage event')
    check_usage(usages[0]); streaming['usage'] = usages[0]
    usage_index = next(i for i,value in enumerate(chunks) if value.get('usage') is not None)
    if any(any(choice.get('delta',{}).get('content') for choice in value.get('choices',[])) for value in chunks[usage_index+1:]):
        raise RuntimeError('output content arrived after final usage')
    streaming['usageChunkIndex'] = usage_index; streaming['chunkCount'] = len(chunks)
    evidence = {'schema':'hive-mesh-usage/v1','status':'passed','testedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
        'command':'python3 tools/mesh-run.py proof','endpoint':BASE + '/v1','models':models,'nonstream':plain,'stream':streaming,
        'spending':False,'limitation':'Standalone usage proof only; receipt gating and the regtest claim are separate checks.'}
    write_evidence_json(EVIDENCE / 'mesh-usage.json',evidence)
    print(json.dumps({'status':'passed','model':model,'nonstreamUsage':plain['usage'],'streamUsage':streaming['usage']}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('action',choices=['inspect','start','proof','stop']); arguments=parser.parse_args()
    EVIDENCE = create_evidence_run('mesh-' + arguments.action)
    metadata, environment, prefix = prepare()
    if arguments.action == 'inspect': print(json.dumps({'status':'inspected','version':inspect(metadata, environment, prefix)['version']}))
    elif arguments.action == 'start': start(metadata, environment, prefix)
    elif arguments.action == 'stop': stop(metadata)
    else: proof()
