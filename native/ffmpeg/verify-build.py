"""Inspect build artifacts without loading a decoder or playing media."""
from pathlib import Path
import argparse, hashlib, json, re, sys

root = Path(__file__).resolve().parent
lock = json.loads((root / 'lock.json').read_text(encoding='utf-8'))
source = root / 'build/source' / lock['sourceDirectory']
install = root / 'build/install'
state = root / 'build/build-state.json'
parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
recipe_files = ['lock.json','source-patches.json','prepare.py','build.ps1','build-source.sh','mslink.sh','dependencies.mak','dependency.awk','verify-build.py']
recipe = {name:sha(root / name) for name in recipe_files}
if sha(root / 'vendor' / lock['archive']) != lock['sha256']:
    raise RuntimeError('FFmpeg source checksum mismatch')
if args.check:
    try:
        saved = json.loads(state.read_text(encoding='utf-8'))
        assert saved['recipe'] == recipe
        for name, checksum in saved['outputs'].items():
            path = (root / 'build' / name).resolve()
            assert (root / 'build').resolve() in path.parents and sha(path) == checksum
        assert sha(root / 'build-manifest.json') == saved['manifestSha256']
    except (OSError, ValueError, KeyError, AssertionError):
        print('FFmpeg build cache needs compilation')
        sys.exit(3)
    print('FFmpeg build artifacts match the controlled recipe')
    sys.exit(0)

config = (source / 'config.h').read_text(encoding='utf-8')
assert '#define FFMPEG_LICENSE "LGPL version 2.1 or later"' in config
assert '#define CONFIG_NETWORK 0' in config and '#define ARCH_X86_64 1' in config
decoders = re.findall(r'&ff_(\w+)_decoder', (source / 'libavcodec/codec_list.c').read_text())
demuxers = re.findall(r'&ff_(\w+)_demuxer', (source / 'libavformat/demuxer_list.c').read_text())
assert sorted(decoders) == sorted(lock['decoders']) and sorted(demuxers) == sorted(lock['demuxers'])
outputs = {}
files = [source / 'config.h',source / 'config_components.h',source / 'ffbuild/config.mak',source / 'libavcodec/codec_list.c',source / 'libavformat/demuxer_list.c']
files += list((install / 'include').rglob('*.h'))
libraries = []
for name in lock['libraries']:
    dll = install / 'bin' / name
    files += [dll, install / 'bin' / (name.split('-')[0] + '.lib')]
    libraries.append({'file':name,'sha256':sha(dll),'bytes':dll.stat().st_size})
for path in files:
    outputs[path.relative_to(root / 'build').as_posix()] = sha(path)
manifest = {'version':lock['version'],'commit':lock['commit'],'sourceSha256':lock['sha256'],'license':lock['license'],
            'recipe':recipe,'libraries':libraries,'registeredDecoders':sorted(decoders),'registeredDemuxers':sorted(demuxers),
            'certification':'unverified','certifications':[], 'configuration':re.search(r'^#define FFMPEG_CONFIGURATION "(.*)"$',config,re.M).group(1)}
(root / 'build-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
state.write_text(json.dumps({'recipe':recipe,'outputs':outputs,'manifestSha256':sha(root / 'build-manifest.json')},indent=2)+'\n',encoding='utf-8')
print('Recorded four compiled FFmpeg libraries; media certification remains pending')
