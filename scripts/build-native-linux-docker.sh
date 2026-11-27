#!/bin/bash
set -euo pipefail
# Builds both Linux engines from a macOS (or Linux) host through Docker.
# Both architectures run inside the cached amd64 image: arm64 is
# cross-compiled with Debian's aarch64 toolchain, so this works even when
# Docker Hub is unreachable and only Debian/static.rust-lang.org are.
# Named volumes keep the Cargo registry and target cache between runs; remove
# them with `docker volume rm cursor-bridge-cargo-registry-x64
# cursor-bridge-target-x64` (and the arm64 pair) when a clean rebuild is needed.
bridge_package="$(cd -- "$(dirname -- "$0")/.." && pwd)"
image="${CURSOR_BRIDGE_LINUX_IMAGE:-rust:1-bookworm}"
arches="${CURSOR_BRIDGE_LINUX_ARCHES:-x64 arm64}"
for arch in $arches; do
  case "$arch" in
    x64)
      packages='cmake libssl-dev pkg-config python3 perl'
      # Keep the array non-empty: bash 3.2 on macOS rejects "${arr[@]}"
      # under `set -u` when the array has no elements.
      cross_env=(-e CURSOR_BRIDGE_LINUX_BUILD=1)
      target_env=(-e CURSOR_BRIDGE_LINUX_BUILD=1)
      ;;
    arm64)
      packages='cmake libssl-dev pkg-config python3 perl gcc-aarch64-linux-gnu g++-aarch64-linux-gnu libc6-dev-arm64-cross binutils-aarch64-linux-gnu'
      cross_env=(
        -e CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
        -e CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
        -e AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar
        -e CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
      )
      target_env=(-e CURSOR_BRIDGE_TARGET_ARCH=arm64)
      ;;
    *)
      echo "Unsupported architecture: $arch" >&2
      exit 1
      ;;
  esac
  echo "==> Building cursor-magpie-bridge for linux/$arch"
  docker run --rm --platform linux/amd64 \
    -v "$bridge_package:/work" \
    -v "cursor-bridge-cargo-registry-$arch:/usr/local/cargo/registry" \
    -v "cursor-bridge-target-$arch:/target" \
    -e CARGO_TARGET_DIR=/target \
    -e CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" \
    "${cross_env[@]}" "${target_env[@]}" \
    -w /work "$image" \
    bash -c "export PATH=/usr/local/cargo/bin:\$PATH; sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; apt-get -o Acquire::http::Pipeline-Depth=0 -o Acquire::Retries=3 update && apt-get -o Acquire::http::Pipeline-Depth=0 -o Acquire::Retries=3 install -y --no-install-recommends $packages && bash scripts/build-native-linux.sh"
done
