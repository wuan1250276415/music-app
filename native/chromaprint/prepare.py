from pathlib import Path,PurePosixPath
import hashlib,json,tarfile
root=Path(__file__).resolve().parent
lock=json.loads((root/'lock.json').read_text(encoding='utf-8'))
archive=root/'vendor'/lock['archive']
assert hashlib.sha256(archive.read_bytes()).hexdigest()==lock['sha256'],'Chromaprint archive differs from lock'
build=root/'build';build.mkdir(exist_ok=True)
with tarfile.open(archive,'r:gz') as source:
 for member in source.getmembers():
  parts=PurePosixPath(member.name).parts
  if not parts or parts[0]!=lock['sourceDirectory'] or '..' in parts or '\\' in member.name or PurePosixPath(member.name).is_absolute():raise ValueError('Invalid Chromaprint archive path')
  if member.isdir():continue
  header_alias=member.name==lock['sourceDirectory']+'/src/include/chromaprint.h' and member.issym() and member.linkname=='../chromaprint.h'
  if not member.isfile() and not header_alias or member.size>16777216:raise ValueError('Unsupported Chromaprint archive member')
  destination=build.joinpath(*parts);destination.parent.mkdir(parents=True,exist_ok=True)
  data=source.extractfile(lock['sourceDirectory']+'/src/chromaprint.h' if header_alias else member).read()
  if not destination.exists() or destination.read_bytes()!=data:destination.write_bytes(data)
source=build/lock['sourceDirectory']
for name in ['LICENSE.md','src/3rdparty/kissfft/COPYING','src/3rdparty/kissfft/LICENSES/BSD-3-Clause']:
 p=source/name
 if p.exists():(root/'vendor'/('LICENSE-chromaprint.txt' if name=='LICENSE.md' else 'LICENSE-kissfft-full.txt' if name.endswith('BSD-3-Clause') else 'LICENSE-kissfft.txt')).write_bytes(p.read_bytes())
print('Verified and prepared Chromaprint '+lock['version'])
