"""Prepare pinned sources and development tools without installing system packages."""
from pathlib import Path
import argparse, hashlib, json, subprocess, tarfile, urllib.request

root = Path(__file__).resolve().parent
lock = json.loads((root / 'lock.json').read_text(encoding='utf-8'))
build = root / 'build'
tools = build / 'tools'
tools.mkdir(parents=True, exist_ok=True)
parser = argparse.ArgumentParser()
parser.add_argument('--sevenzip', default='')
args = parser.parse_args()

def digest(p):
    with p.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

def fetch(p, url, expected):
    if p.exists() and digest(p) == expected:
        return
    temporary = p.with_suffix(p.suffix + '.download')
    request = urllib.request.Request(url, headers={'User-Agent':'Aural-controlled-build'})
    with urllib.request.urlopen(request, timeout=60) as source, temporary.open('wb') as output:
        while chunk := source.read(1024 * 1024):
            output.write(chunk)
    if digest(temporary) != expected:
        raise RuntimeError('Pinned archive checksum mismatch: ' + p.name)
    temporary.replace(p)

def unpack(archive, target, prefix):
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as source:
        members = source.getmembers()
        for member in members:
            parts = Path(member.name).parts
            if not parts or parts[0] != prefix or Path(member.name).is_absolute() or '..' in parts or not (member.isdir() or member.isfile()):
                raise RuntimeError('Invalid source archive member')
        source.extractall(target, members=members, filter='data')

archive = root / 'vendor' / lock['archive']
if not archive.is_file() or digest(archive) != lock['sha256']:
    raise RuntimeError('Vendored FFmpeg source archive is missing or changed')
source = build / 'source' / lock['sourceDirectory']
if not (source / 'configure').is_file():
    unpack(archive, build / 'source', lock['sourceDirectory'])
for patch in json.loads((root / 'source-patches.json').read_text(encoding='utf-8'))['patches']:
    target = source / patch['file']
    if source.resolve() not in target.resolve().parents:
        raise RuntimeError('Invalid FFmpeg source patch path')
    text = target.read_text(encoding='utf-8')
    current = hashlib.sha256(text.encode()).hexdigest()
    if current == patch['afterSha256']:
        continue
    if current != patch['beforeSha256'] or text.count(patch['old']) != 1:
        raise RuntimeError('Unexpected FFmpeg source before patch')
    changed = text.replace(patch['old'], patch['new'])
    if hashlib.sha256(changed.encode()).hexdigest() != patch['afterSha256']:
        raise RuntimeError('FFmpeg patch result mismatch')
    target.write_text(changed, encoding='utf-8')

make = tools / ('make-' + lock['toolchain']['makeVersion'])
make_archive = tools / (make.name + '.tar.gz')
fetch(make_archive, lock['toolchain']['makeUrl'], lock['toolchain']['makeSha256'])
if not (make / 'build_w32.bat').exists():
    unpack(make_archive, tools, make.name)
config = make / 'src/config.h.W32'
text = config.read_text(encoding='utf-8')
patched = text.replace('/*#define HAVE_CYGWIN_SHELL 1 */', '#define HAVE_CYGWIN_SHELL 1')
if patched != text:
    config.write_text(patched, encoding='utf-8')

clang = tools / 'llvm/bin/clang-cl.exe'
if not clang.is_file():
    if not args.sevenzip:
        raise RuntimeError('First build requires 7-Zip: pass -SevenZip or AURAL_SEVEN_ZIP')
    llvm = tools / ('LLVM-' + lock['toolchain']['llvmVersion'] + '-win64.exe')
    fetch(llvm, lock['toolchain']['llvmUrl'], lock['toolchain']['llvmSha256'])
    subprocess.run([args.sevenzip, 'x', str(llvm), '-o' + str(tools / 'llvm'), 'bin/clang.exe', 'bin/clang-cl.exe', 'lib/clang/*', '-r', '-y'], check=True)
if not clang.is_file():
    raise RuntimeError('Pinned C11 compiler extraction failed')
print('Pinned FFmpeg source and development tools prepared')
