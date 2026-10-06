#!/usr/bin/env python3
"""Package one static Contextful layer as an OCI image layout archive."""

import hashlib
import json
import pathlib
import shutil
import sys
import tarfile
import tempfile

layer = pathlib.Path(sys.argv[1])
uncompressed = pathlib.Path(sys.argv[2])
output = pathlib.Path(sys.argv[3])
version = sys.argv[4]


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


layer_digest = sha256(layer)
diff_id = sha256(uncompressed)
config = encoded({
    "architecture": "amd64", "os": "linux",
    "config": {
        "User": "65532:65532", "WorkingDir": "/data",
        "Entrypoint": ["/usr/local/bin/contextful"], "Cmd": ["--version"],
        "Volumes": {"/data": {}},
    },
    "rootfs": {"type": "layers", "diff_ids": [f"sha256:{diff_id}"]},
    "history": [{"created_by": "contextful release"}],
})
config_digest = hashlib.sha256(config).hexdigest()
manifest = encoded({
    "schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
    "config": {"mediaType": "application/vnd.oci.image.config.v1+json",
               "digest": f"sha256:{config_digest}", "size": len(config)},
    "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                "digest": f"sha256:{layer_digest}", "size": layer.stat().st_size}],
})
manifest_digest = hashlib.sha256(manifest).hexdigest()
index = encoded({
    "schemaVersion": 2,
    "manifests": [{"mediaType": "application/vnd.oci.image.manifest.v1+json",
                   "digest": f"sha256:{manifest_digest}", "size": len(manifest),
                   "platform": {"architecture": "amd64", "os": "linux"},
                   "annotations": {"org.opencontainers.image.ref.name": version}}],
})

with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    blobs = root / "blobs" / "sha256"
    blobs.mkdir(parents=True)
    shutil.copyfile(layer, blobs / layer_digest)
    (blobs / config_digest).write_bytes(config)
    (blobs / manifest_digest).write_bytes(manifest)
    (root / "index.json").write_bytes(index)
    (root / "oci-layout").write_bytes(encoded({"imageLayoutVersion": "1.0.0"}))
    with tarfile.open(output, "w") as archive:
        for path in sorted(root.rglob("*")):
            info = archive.gettarinfo(str(path), arcname=str(path.relative_to(root)))
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ""
            if path.is_file():
                with path.open("rb") as stream:
                    archive.addfile(info, stream)
            else:
                archive.addfile(info)
