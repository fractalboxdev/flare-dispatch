-- The model of the release path of class resolution (packages/profile/src/bindings.ts `resolveClassDetailed` step 1)
-- and of the reference profile's placement (packages/profile/src/placement.ts `eligibleKinds`, over the fold in
-- `FdFormal.Intake`) for the two recipes that must stay off devices: `worker-deploy` and a publishing `sandbox-image`
-- (packages/catalog/src/spec.ts), the FlareDispatch side of property S3 of specs/verification.md § Formal properties.
-- The `placement` mode of the `oracle` executable answers placement events with `requestPlacement`, `eligible` and
-- `placeableKinds`, with the profile's predicates evaluated by `Pred.holds` (specs/verification.md § V-DIFF).
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

/-- Step 1's release triggers among those the placement events carry: a protected tag push, or a push to the
protected deploy branch (`isReleasePush`); a pull request and a cron trigger never are. -/
def isReleaseTrigger (kind : String) (protectedTag : Bool) (branch : String) (protectedBranch : Bool)
    (deployBranch : Option String) : Bool :=
  if kind == "tag-push" then protectedTag
  else if kind == "push" then isReleasePush branch protectedBranch deployBranch
  else false

/-- `CLASS_ORDER`, highest first; a class's rank is its index. -/
def classOrder : List String := ["release", "required", "interactive", "batch"]

/-- `lower`: the lower-ranked (less urgent) of two classes. -/
def lowerClass (a b : String) : String := if classOrder.idxOf a ≥ classOrder.idxOf b then a else b

/-- `limits.qosClass` and `limits.qosCeiling` of `workerDeploySpec` and `sandboxImageSpec`. -/
def runLimits (run : String) : String × String :=
  if run == "worker-deploy" then ("release", "release") else ("required", "release")

/-- Steps 2 to 6 for a run outside `GATING_RUNS` with no policy rule, no parent and no caller: the run's default,
`qosClass` capped at `qosCeiling` and at `required`, capped at the ceiling, then lowered by a class input, which
cannot raise it without a policy rule. Never `release`. -/
def laterClass (run : String) (classInput : Option String) : String :=
  let (qos, ceiling) := runLimits run
  let out := lowerClass (lowerClass (lowerClass qos ceiling) "required") ceiling
  match classInput with
  | some c => lowerClass out c
  | none => out

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

/-- `sandboxImagePlacement(publish)`: a publish is `sandboxImagePublish`; a pull request runs `required` and declares
no constraint and no label. -/
def sandboxImagePlacement (publish : Bool) : SandboxPlacement :=
  if publish then sandboxImagePublish else { className := "required", constraints := [], labels := [] }

/-- `requestPlacement` for `worker-deploy` and `sandbox-image`: the run's own constraints, then those of
`sandboxImagePlacement(true)` for a `sandbox-image` request whose input publishes, each list without repeats in
first-occurrence order. Neither run declares a label of its own. -/
def requestPlacement (run : String) (publish : Bool) : List String × List String :=
  let own := if run == "worker-deploy" then workerDeployConstraints else []
  let extra := if run == "sandbox-image" && publish then sandboxImagePublish.constraints else []
  let labels := if run == "sandbox-image" && publish then sandboxImagePublish.labels else []
  ((own ++ extra).eraseDups, labels.eraseDups)

/-- A profile placement predicate (mameko's `Predicate`): one single-key object, recursive through `not`, `all` and
`any`. -/
inductive Pred where
  | cls (name : String)
  | label (name : String)
  | trigger (name : String)
  | undeclaredClass
  | not (p : Pred)
  | all (ps : List Pred)
  | any (ps : List Pred)
  deriving Repr

/-- What a predicate reads of a request (`PlacementRequest` in packages/profile/src/placement.ts). -/
structure Request where
  cls : String
  labels : List String
  trigger : Option String
  declaresClass : Option Bool

mutual
/-- `holds` in packages/profile/src/placement.ts: `undeclared_class` holds only for a run that declares no class. -/
def Pred.holds (r : Request) : Pred → Bool
  | .cls c => r.cls == c
  | .label l => r.labels.contains l
  | .trigger t => r.trigger == some t
  | .undeclaredClass => r.declaresClass == some false
  | .not p => !p.holds r
  | .all ps => holdsAll r ps
  | .any ps => holdsAny r ps

def holdsAll (r : Request) : List Pred → Bool
  | [] => true
  | p :: ps => p.holds r && holdsAll r ps

def holdsAny (r : Request) : List Pred → Bool
  | [] => false
  | p :: ps => p.holds r || holdsAny r ps
end

/-- The parts of a profile placement reads besides `cloud_pinned` and `cloud_pinned_kinds`, which stay the reference
profile's (`cloudPinnedHolds`, `cloudPinnedKinds`). -/
structure ProfilePlacement where
  /-- Each class's name, cloud kinds and `device_eligible`. -/
  classes : List (String × List String × Option Bool)
  cloudOnly : Pred
  localOnly : Pred
  launcherKinds : List String
  /-- Each declared constraint's `holds_for` and `removes`. -/
  declared : List (Pred × List String)

/-- The class's cloud kinds, then `device` unless the class sets `device_eligible: false`; none for an unknown
class. -/
def ProfilePlacement.classKinds (p : ProfilePlacement) (cls : String) : List String :=
  match p.classes.find? (·.1 == cls) with
  | none => []
  | some (_, cloud, deviceEligible) => cloud ++ (if deviceEligible == some false then [] else ["device"])

/-- Every executor kind `placementInputs` folds over. -/
def ProfilePlacement.kinds (p : ProfilePlacement) : List String := ["cloudflare", "device", "aws"] ++ p.launcherKinds

/-- `placementInputs`' facts: a `cloud-only` or `local-only` label, or the profile's predicate, sets the fact. -/
def ProfilePlacement.facts (p : ProfilePlacement) (r : Request) (confidentiality : String)
    (deviceLocalInput needsLocalModel : Bool) : Facts :=
  { runLabels := r.labels
    confidentialCompute := confidentiality == "confidential-compute"
    cloudPinned := false
    cloudOnly := r.labels.contains "cloud-only" || p.cloudOnly.holds r
    localOnly := r.labels.contains "local-only" || p.localOnly.holds r
    deviceLocalInput
    needsLocalModel }

/-- Each declared constraint with whether its predicate holds for the request. -/
def ProfilePlacement.held (p : ProfilePlacement) (r : Request) : List (Bool × List String) :=
  p.declared.map (fun (q, ks) => (q.holds r, ks))

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

/-- The eligible kinds that place the request, in eligibility order: the list form of `placeable` the oracle
answers. -/
def placeableKinds (eligibleKinds runLabels : List String) (advertised : String → List String) : List String :=
  eligibleKinds.filter (fun k => runLabels.all (fun l => (advertised k).contains l))

theorem mem_placeableKinds (eligibleKinds runLabels : List String) (advertised : String → List String) (k : String) :
    k ∈ placeableKinds eligibleKinds runLabels advertised ↔ placeable eligibleKinds runLabels advertised k := by
  simp [placeableKinds, placeable, List.mem_filter, List.all_eq_true]

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
