-- The model of the release path of class resolution (packages/profile/src/bindings.ts `resolveClassDetailed` step 1)
-- and of the reference profile's placement (packages/profile/src/placement.ts `eligibleKinds`, over the fold in
-- `FdFormal.Intake`) for the two recipes that must stay off devices: `worker-deploy` and a publishing `sandbox-image`
-- (packages/catalog/src/spec.ts), the FlareDispatch side of property S3 of specs/verification.md § Formal properties.
import FdFormal.Intake

namespace FdFormal.Placement

open FdFormal.Intake

/-- `RELEASE_ALLOWLIST`, the in-code `release` allowlist of step 1. -/
def releaseAllowlist : List String := ["release", "worker-deploy", "publish", "sandbox-image"]

/-- The `push` case of `isReleaseTrigger`: a push to a protected branch named by `workerDeploy.branch`. -/
def isReleasePush (branch : String) (protectedBranch : Bool) (deployBranch : Option String) : Bool :=
  protectedBranch && deployBranch == some branch

/-- `resolveClassDetailed` up to step 1: a re-run keeps its family's class, an allowlisted run on a release trigger
is `release`, and every other request takes the class `later` the remaining steps give, which is never `release`
(FD-PROF-012). -/
def resolveClass (run : String) (rerun : Option String) (releaseTrigger : Bool) (later : String) : String :=
  match rerun with
  | some c => c
  | none => if releaseAllowlist.contains run && releaseTrigger then "release" else later

/-- The reference profile's `cloud_pinned` predicate, class `release` except a request labelled `release-matrix`, or a
`cloud-pinned` constraint the run declares (`PlacementRequest.constraints`). -/
def cloudPinnedHolds (cls : String) (labels constraints : List String) : Bool :=
  constraints.contains "cloud-pinned" || (cls == "release" && !labels.contains "release-matrix")

/-- The reference profile's `cloud_pinned_kinds`. -/
def cloudPinnedKinds : List String := ["cloudflare"]

/-- The profile's eligible kinds for a request, with `cloud-pinned` decided by `cloudPinnedHolds`. -/
def eligible (classKinds : List String) (cls : String) (labels constraints : List String) (f : Facts)
    (kinds : List String) (declared : List (Bool × List String)) : List String :=
  profileEligible classKinds labels { f with cloudPinned := cloudPinnedHolds cls labels constraints } kinds
    cloudPinnedKinds declared

/-- The constraints `workerDeploySpec` declares. -/
def workerDeployConstraints : List String := ["cloud-pinned"]

/-- `sandboxImagePlacement(true)`: a publish runs at class `release`, `cloud-pinned`, labelled `container-artifact`. -/
structure SandboxPlacement where
  className : String
  constraints : List String
  labels : List String

def sandboxImagePublish : SandboxPlacement :=
  { className := "release", constraints := ["cloud-pinned"], labels := ["container-artifact"] }

theorem fold_keepOnly_subset (pre post : List Constraint) (l ks : List String) :
    ∀ k ∈ foldConstraints l (pre ++ Constraint.keepOnly ks :: post), k ∈ ks := by
  intro k h
  unfold foldConstraints at h
  rw [List.foldl_append, List.foldl_cons] at h
  have := fold_subset post _ _ h
  simp only [placementPolicy, List.mem_filter, List.contains_iff_mem] at this
  exact this.2

/-- A cloud-pinned request is eligible only for the profile's `cloud_pinned_kinds`, `cloudflare`, and never for
`device`. -/
theorem cloud_pinned_only_cloudflare (classKinds : List String) (cls : String) (labels constraints : List String)
    (f : Facts) (kinds : List String) (declared : List (Bool × List String))
    (h : cloudPinnedHolds cls labels constraints = true) :
    ∀ k ∈ eligible classKinds cls labels constraints f kinds declared, k = "cloudflare" := by
  intro k hk
  have hk := (List.mem_filter.mp hk).2
  simp only [List.contains_iff_mem] at hk
  unfold requestConstraints at hk
  simp only [h, ite_true, List.append_assoc, List.singleton_append] at hk
  have := fold_keepOnly_subset
    ((if labels.contains "untrusted-input" = true then [Constraint.removes ["device"]] else []) ++
      (if f.cloudOnly = true then [Constraint.removes ["device"]] else [])) _ kinds cloudPinnedKinds k
    (by simpa [List.append_assoc] using hk)
  simpa [cloudPinnedKinds] using this

/--
The control plane places every `worker-deploy` execution under the `cloud-pinned` constraint, whatever class its
trigger resolves to, so it is eligible only for executor kind `cloudflare` and never for an owned device
(FD-GATE-061).
-/
theorem worker_deploy_cloud_pinned (classKinds : List String) (cls : String) (labels : List String) (f : Facts)
    (kinds : List String) (declared : List (Bool × List String)) :
    cloudPinnedHolds cls labels workerDeployConstraints = true ∧
      "device" ∉ eligible classKinds cls labels workerDeployConstraints f kinds declared ∧
      ∀ k ∈ eligible classKinds cls labels workerDeployConstraints f kinds declared, k = "cloudflare" := by
  have hp : cloudPinnedHolds cls labels workerDeployConstraints = true := by
    simp [cloudPinnedHolds, workerDeployConstraints]
  have hk := cloud_pinned_only_cloudflare classKinds cls labels workerDeployConstraints f kinds declared hp
  exact ⟨hp, fun hd => by simpa using hk _ hd, hk⟩

/-- mameko's `unplaceable` rule: a kind places the request only when it is eligible and advertises every capability
label the run declares. -/
def placeable (eligibleKinds runLabels : List String) (advertised : String → List String) (k : String) : Prop :=
  k ∈ eligibleKinds ∧ ∀ l ∈ runLabels, l ∈ advertised k

/--
The control plane places a publishing `sandbox-image` execution at class `release` under the `cloud-pinned`
constraint on an executor that carries the label `container-artifact`: a first attempt on a push to the protected
deploy branch resolves to `release`, the publish declares `cloud-pinned`, and every kind that places it is `cloudflare`
and advertises `container-artifact` (FD-GATE-080).
-/
theorem sandbox_image_publish_placement (branch : String) (later : String) (classKinds : List String) (f : Facts)
    (kinds : List String) (declared : List (Bool × List String)) (advertised : String → List String) (k : String)
    (hk : placeable (eligible classKinds sandboxImagePublish.className sandboxImagePublish.labels
      sandboxImagePublish.constraints f kinds declared) sandboxImagePublish.labels advertised k) :
    resolveClass "sandbox-image" none (isReleasePush branch true (some branch)) later = "release" ∧
      resolveClass "sandbox-image" none true later = sandboxImagePublish.className ∧
      cloudPinnedHolds sandboxImagePublish.className sandboxImagePublish.labels sandboxImagePublish.constraints = true ∧
      k = "cloudflare" ∧ "container-artifact" ∈ advertised k := by
  have hp : cloudPinnedHolds sandboxImagePublish.className sandboxImagePublish.labels
      sandboxImagePublish.constraints = true := by
    simp [cloudPinnedHolds, sandboxImagePublish]
  refine ⟨by simp [resolveClass, releaseAllowlist, isReleasePush],
    by simp [resolveClass, releaseAllowlist, sandboxImagePublish], hp,
    cloud_pinned_only_cloudflare _ _ _ _ f kinds declared hp k hk.1, hk.2 _ (by simp [sandboxImagePublish])⟩

end FdFormal.Placement
