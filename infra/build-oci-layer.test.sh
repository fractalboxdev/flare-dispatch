#!/bin/sh
set -eu

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 755 "$work"
cat > "$work/main.c" <<'SOURCE'
int main(void) { return 0; }
SOURCE
zig cc -target x86_64-linux-musl -static -o "$work/contextful" "$work/main.c"
/opt/build-oci-layer.sh "$work/contextful" "$work/root" "$work/layer.tar.gz" > "$work/result"
[ "$(wc -l < "$work/result")" -eq 3 ]
file "$work/contextful" | grep -q 'ELF 64-bit.*x86-64'
tar --numeric-owner -tvf "$work/layer.tar" | grep -q '65532/65532.* ./data/'
mkdir "$work/extracted"
tar -C "$work/extracted" -xf "$work/layer.tar"
setpriv --reuid 65532 --regid 65532 --clear-groups -- touch "$work/extracted/data/write-smoke"
[ -f "$work/extracted/data/write-smoke" ]
