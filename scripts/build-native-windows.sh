#!/bin/bash
set -euo pipefail
# Cross-compiles the Windows x64 engine from a macOS host. The resulting PE is
# self-contained (system DLLs only), so no mingw runtime has to ship with it.
bridge_package="$(cd -- "$(dirname -- "$0")/.." && pwd)"
bridge_build="$(mktemp -d "${TMPDIR:-/tmp}/cursor-bridge-win.XXXXXX")"
trap 'rm -rf -- "$bridge_build"' EXIT
if [ "$(uname -s)" != Darwin ]; then
  echo 'This cross-build script expects a macOS host.' >&2
  exit 1
fi
if ! command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
  echo 'Install the mingw-w64 toolchain first: brew install mingw-w64' >&2
  exit 1
fi
rustup target list --installed | grep -qx x86_64-pc-windows-gnu || rustup target add x86_64-pc-windows-gnu
git clone --branch v1.0.1 --depth 1 https://github.com/leookun/cursor-byok.git "$bridge_build/source"
[ "$(git -C "$bridge_build/source" rev-parse HEAD)" = 2068ab20513288e6a0289d33febe872a30608610 ]
git -C "$bridge_build/source" apply "$bridge_package/source.patch"
CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc \
AR_x86_64_pc_windows_gnu=x86_64-w64-mingw32-ar \
CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc \
CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" \
cargo build --manifest-path "$bridge_build/source/Cargo.toml" --release --locked --target x86_64-pc-windows-gnu -p cursor-server --bin cursor-magpie-bridge
mkdir -p "$bridge_package/bin/win32-x64"
cp "$bridge_build/source/target/x86_64-pc-windows-gnu/release/cursor-magpie-bridge.exe" "$bridge_package/bin/win32-x64/cursor-magpie-bridge.exe.new"
chmod 755 "$bridge_package/bin/win32-x64/cursor-magpie-bridge.exe.new"
mv "$bridge_package/bin/win32-x64/cursor-magpie-bridge.exe.new" "$bridge_package/bin/win32-x64/cursor-magpie-bridge.exe"
python3 - "$bridge_package" <<'PY'
import hashlib,json,pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1]);b=p/'bin/win32-x64/cursor-magpie-bridge.exe'
# engineVersion pins the binary's own version string; the package version may
# legitimately differ when only the JavaScript layer changes.
data=json.loads((p/'integrity.json').read_text()) if (p/'integrity.json').exists() else {}
engine_version=data.get('engineVersion') or json.loads((p/'package.json').read_text())['version']
strings=subprocess.check_output(['strings',str(b)],text=True)
assert engine_version in strings.splitlines(), f'engine version {engine_version} missing from the PE'
data['version']=json.loads((p/'package.json').read_text())['version']
data.setdefault('platforms',{})['win32-x64']=hashlib.sha256(b.read_bytes()).hexdigest()
(p/'integrity.json').write_text(json.dumps(data,indent=2)+'\n')
PY
