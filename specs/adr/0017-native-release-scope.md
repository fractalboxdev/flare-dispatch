# Native release scope binds one immutable source

**Status:** accepted

## Decision

The release-only `NativeExecution` adapter binds `base` to `head`. Release commands build one immutable revision and perform no differential gate comparison. Gate requests retain their independently supplied comparison base; a release handle grants no gate scope.

The configured runtime supplies repository, source revision, execution identity and native executor policy. The adapter binds mode, target, profile, literal command digest, executor revision and a deterministic nonce. Only the registered release-cell runtime receives this capability. Absent native policy or App configuration refuses admission. NativeWorkflow remains the sole dispatch and reconciliation owner.

A completed native Workflow projection grants no file authority. The reader requires controller-verified immutable evidence, authentic API job success and exact request identity. Its artifact importer checks the complete byte count and SHA-256 before committing a usable single or multipart object. Interrupted, truncated or mismatched streams cannot publish a new usable artifact.

Release fan-out, individual cell admission and formula completeness consume the same immutable source's authoritative plan. Supported executor types define dispatch grammar; they do not define a second profile/target matrix. Unknown executors, malformed or duplicate plan cells and missing or foreign cell metadata refuse publication.

## Cost

Each independently admitted release cell validates the source plan. Native evidence uses explicit configured executor authority and authenticated provider metadata. Recipe fixtures prove admission and byte-transfer semantics, while actual native build and packaging verdicts require execution on the declared hosts. Reviewed workload code shares its executor user; this adapter provides no hostile-workload isolation.
