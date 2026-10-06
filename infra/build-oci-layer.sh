#!/bin/sh
set -eu

binary=$1
root=$2
output=$3
image=$4
version=$5

file "$binary" | grep -q 'ELF 64-bit.*x86-64'
if readelf -l "$binary" | grep -q INTERP; then
  echo 'OCI release binary has a dynamic interpreter' >&2
  exit 1
fi

mkdir -p "$root/usr/local/bin" "$root/etc/ssl/certs" "$root/data"
cp "$binary" "$root/usr/local/bin/contextful"
cp /etc/ssl/certs/ca-certificates.crt "$root/etc/ssl/certs/ca-certificates.crt"
chown -R 0:0 "$root"
chown 65532:65532 "$root/data"
tar --sort=name --mtime=@0 --numeric-owner -C "$root" -cf "${output%.gz}" .
gzip -n -c "${output%.gz}" > "$output"
python3 /opt/build-oci-layout.py "$output" "${output%.gz}" "$image" "$version"
sha256sum "${output%.gz}" "$output"
stat -c %s "$output"
