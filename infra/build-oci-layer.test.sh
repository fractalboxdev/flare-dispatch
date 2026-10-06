#!/bin/sh
set -eu

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 755 "$work"
cat > "$work/main.c" <<'SOURCE'
int main(void) { return 0; }
SOURCE
zig cc -target x86_64-linux-musl -static -o "$work/contextful" "$work/main.c"
/opt/build-oci-layer.sh "$work/contextful" "$work/root" "$work/layer.tar.gz" "$work/image.oci.tar" "0.5.0" > "$work/result"
[ "$(wc -l < "$work/result")" -eq 3 ]
file "$work/contextful" | grep -q 'ELF 64-bit.*x86-64'
tar --numeric-owner -tvf "$work/layer.tar" | grep -q '65532/65532.* ./data/'
mkdir "$work/extracted"
tar -C "$work/extracted" -xf "$work/layer.tar"
setpriv --reuid 65532 --regid 65532 --clear-groups -- touch "$work/extracted/data/write-smoke"
[ -f "$work/extracted/data/write-smoke" ]
tar -tf "$work/image.oci.tar" | grep -q '^index.json$'
tar -tf "$work/image.oci.tar" | grep -q '^oci-layout$'
tar -xOf "$work/image.oci.tar" index.json | grep -q '"architecture":"amd64"'
python3 - "$work/image.oci.tar" <<'PY'
import gzip
import hashlib
import json
import sys
import tarfile

with tarfile.open(sys.argv[1]) as archive:
    def read(name):
        return archive.extractfile(name).read()

    index = json.loads(read("index.json"))
    descriptor = index["manifests"][0]
    assert descriptor["annotations"]["org.opencontainers.image.ref.name"] == "0.5.0"
    manifest_bytes = read(f"blobs/sha256/{descriptor['digest'][7:]}")
    assert hashlib.sha256(manifest_bytes).hexdigest() == descriptor["digest"][7:]
    manifest = json.loads(manifest_bytes)
    config_bytes = read(f"blobs/sha256/{manifest['config']['digest'][7:]}")
    assert hashlib.sha256(config_bytes).hexdigest() == manifest["config"]["digest"][7:]
    config = json.loads(config_bytes)
    assert config["config"]["User"] == "65532:65532"
    assert config["config"]["Entrypoint"] == ["/usr/local/bin/contextful"]
    layer = manifest["layers"][0]
    layer_bytes = read(f"blobs/sha256/{layer['digest'][7:]}")
    assert hashlib.sha256(layer_bytes).hexdigest() == layer["digest"][7:]
    assert hashlib.sha256(gzip.decompress(layer_bytes)).hexdigest() == config["rootfs"]["diff_ids"][0][7:]
PY
