#!/bin/bash
set -euo pipefail
bridge_package="$(cd -- "$(dirname -- "$0")/.." && pwd)"
bridge_build="$(mktemp -d "${TMPDIR:-/tmp}/cursor-bridge-build.XXXXXX")"
trap 'rm -rf -- "$bridge_build"' EXIT
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'This release supports Apple Silicon macOS only.' >&2
  exit 1
fi
git clone --branch v1.0.1 --depth 1 https://github.com/leookun/cursor-byok.git "$bridge_build/source"
[ "$(git -C "$bridge_build/source" rev-parse HEAD)" = 2068ab20513288e6a0289d33febe872a30608610 ]
git -C "$bridge_build/source" apply "$bridge_package/source.patch"
CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" cargo build --manifest-path "$bridge_build/source/Cargo.toml" --release --locked -p cursor-server --bin cursor-magpie-bridge
mkdir -p "$bridge_package/bin"
cp "$bridge_build/source/target/release/cursor-magpie-bridge" "$bridge_package/bin/cursor-magpie-bridge.new"
chmod 755 "$bridge_package/bin/cursor-magpie-bridge.new"
mv "$bridge_package/bin/cursor-magpie-bridge.new" "$bridge_package/bin/cursor-magpie-bridge"
python3 - "$bridge_package" <<'PY'
import hashlib,json,pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1]);b=p/'bin/cursor-magpie-bridge'
# The engine is rebuilt only when its sources change, so the package version
# and the engine version can legitimately differ; engineVersion pins the
# binary's own --version output.
data=json.loads((p/'integrity.json').read_text()) if (p/'integrity.json').exists() else {}
engine_version=data.get('engineVersion') or json.loads((p/'package.json').read_text())['version']
assert subprocess.check_output([str(b),'--version'],text=True).strip()==engine_version, f'expected engine {engine_version}'
digest=hashlib.sha256(b.read_bytes()).hexdigest()
data['version']=json.loads((p/'package.json').read_text())['version']
data['engine']=digest
data.setdefault('platforms',{})['darwin-arm64']=digest
(p/'integrity.json').write_text(json.dumps(data,indent=2)+'\n')
PY
