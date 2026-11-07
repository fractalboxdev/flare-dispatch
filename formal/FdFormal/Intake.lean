-- The model of fork pull-request intake (packages/intake/src/event.ts `isForkPr`, packages/intake/src/webhook.ts), the
-- labels class resolution returns (packages/profile/src/bindings.ts `resolveClassDetailed`, packages/intake/src/layer.ts
-- `runDefaultClassResolver`) and the placement fold that turns them into eligible executor kinds
-- (packages/profile/src/placement.ts `eligibleKinds` over mameko's `requestConstraints` and `eligibleKinds`), the
-- FlareDispatch side of property S3 of specs/verification.md § Formal properties.
namespace FdFormal.Intake

/-- The repository names of a `pull_request` event: `head.repo.full_name`, `base.repo.full_name` and
`repository.full_name`, each absent when the payload omits it. -/
structure PullRequestNames where
  head : Option String
  base : Option String
  repository : Option String
  deriving Repr

/-- `isForkPr`: a pull request whose head repository is missing or differs from its base repository. -/
def isForkPr : Option PullRequestNames → Bool
  | none => false
  | some pr =>
    match pr.head, pr.base.or pr.repository with
    | some h, some b => h != b
    | _, _ => true

/-- The trigger the webhook route records. -/
def recordedTrigger (pr : Option PullRequestNames) : String := if isForkPr pr then "fork-pr" else "webhook"

/-- The path `resolveClassDetailed` takes: a re-run, step 1's `release`, or the later steps, where `decided` says
step 2 set a class and `ruleMatched` that a policy rule matched. -/
inductive ResolutionPath where
  | rerun
  | release
  | later (decided : Bool) (ruleMatched : Bool) (runDefaultLabels : List String)
  deriving Repr

/-- The labels `resolveClassDetailed` returns on each path. -/
def resolvedLabels (trigger : String) : ResolutionPath → List String
  | .rerun => if trigger == "fork-pr" then ["untrusted-input"] else []
  | .release => if trigger == "fork-pr" then ["untrusted-input"] else []
  | .later decided rule extra =>
    let labels := if trigger == "fork-pr" then ["untrusted-input"] else []
    if !decided && !rule then labels ++ extra else labels

/-- The labels intake's `runDefaultClassResolver` returns. -/
def defaultResolverLabels (trigger : String) : List String := if trigger == "fork-pr" then ["untrusted-input"] else []

/-- A placement constraint: it removes kinds or keeps only some. -/
inductive Constraint where
  | removes (kinds : List String)
  | keepOnly (kinds : List String)
  deriving Repr

/-- The request facts mameko's `requestConstraints` reads besides the labels. -/
structure Facts where
  runLabels : List String
  confidentialCompute : Bool
  cloudPinned : Bool
  cloudOnly : Bool
  localOnly : Bool
  deviceLocalInput : Bool
  needsLocalModel : Bool
  deriving Repr

/-- mameko's `requestConstraints`. -/
def requestConstraints (labels : List String) (f : Facts) (kinds cloudPinnedKinds : List String)
    (declared : List (Bool × List String)) : List Constraint :=
  let cloud := kinds.filter (· != "device")
  (if labels.contains "untrusted-input" then [.removes ["device"]] else []) ++
    (if f.cloudOnly then [.removes ["device"]] else []) ++
    (if f.cloudPinned then [.keepOnly cloudPinnedKinds] else []) ++
    (if f.runLabels.contains "expose-port" then [.keepOnly ["cloudflare"]] else []) ++
    (if f.confidentialCompute then [.removes cloud] else []) ++
    (if f.localOnly then [.removes cloud] else []) ++
    (if f.needsLocalModel then [.removes cloud] else []) ++
    (if f.deviceLocalInput then [.removes cloud] else []) ++
    (declared.filter (·.1)).map (fun d => .removes d.2)

/-- mameko's `placementPolicy`. -/
def placementPolicy (eligible : List String) : Constraint → List String
  | .removes ks => eligible.filter (fun k => !ks.contains k)
  | .keepOnly ks => eligible.filter (fun k => ks.contains k)

/-- mameko's `eligibleKinds`: the fold of the constraints. -/
def foldConstraints (full : List String) (cs : List Constraint) : List String := cs.foldl placementPolicy full

/-- The profile's `eligibleKinds`: the class's kinds that survive the fold. -/
def profileEligible (classKinds : List String) (labels : List String) (f : Facts) (kinds cloudPinnedKinds : List String)
    (declared : List (Bool × List String)) : List String :=
  let eligible := foldConstraints kinds (requestConstraints labels f kinds cloudPinnedKinds declared)
  classKinds.filter (fun k => eligible.contains k)

theorem placementPolicy_subset (l : List String) (c : Constraint) : ∀ k ∈ placementPolicy l c, k ∈ l := by
  intro k hk
  cases c <;> exact (List.mem_filter.mp hk).1

theorem fold_subset : ∀ (cs : List Constraint) (l : List String), ∀ k ∈ foldConstraints l cs, k ∈ l
  | [], _, _, h => h
  | c :: cs, l, k, h => placementPolicy_subset l c k (fold_subset cs (placementPolicy l c) k h)

theorem fold_removes_device (pre post : List Constraint) (l : List String) :
    "device" ∉ foldConstraints l (pre ++ Constraint.removes ["device"] :: post) := by
  intro h
  unfold foldConstraints at h
  rw [List.foldl_append, List.foldl_cons] at h
  have := fold_subset post _ _ h
  simp [placementPolicy] at this

/-- A request labelled `untrusted-input` is never eligible for executor kind `device`. -/
theorem untrusted_never_device (classKinds labels : List String) (f : Facts) (kinds cloudPinnedKinds : List String)
    (declared : List (Bool × List String)) (h : labels.contains "untrusted-input" = true) :
    "device" ∉ profileEligible classKinds labels f kinds cloudPinnedKinds declared := by
  intro hd
  have hd := (List.mem_filter.mp hd).2
  simp only [List.contains_iff_mem] at hd
  unfold requestConstraints at hd
  simp only [h, ite_true, List.append_assoc, List.singleton_append] at hd
  exact fold_removes_device [] _ kinds hd

/--
When a `pull_request` event's `head.repo.full_name` differs from its `base.repo.full_name`, the dispatcher Worker
records the trigger as `fork-pr`; class resolution returns the `untrusted-input` label for it on every path of
`resolveClassDetailed` and in intake's default resolver, and placement then never makes executor kind `device`
eligible, whatever the profile's other constraints (FD-INT-030).
-/
theorem fork_pr_untrusted (head base : String) (repository : Option String) (hne : head ≠ base)
    (path : ResolutionPath) (classKinds : List String) (f : Facts) (kinds cloudPinnedKinds : List String)
    (declared : List (Bool × List String)) :
    let trigger := recordedTrigger (some { head := some head, base := some base, repository })
    trigger = "fork-pr" ∧ "untrusted-input" ∈ resolvedLabels trigger path ∧
      "untrusted-input" ∈ defaultResolverLabels trigger ∧
      "device" ∉ profileEligible classKinds (resolvedLabels trigger path) f kinds cloudPinnedKinds declared := by
  intro trigger
  have ht : trigger = "fork-pr" := by
    simp [trigger, recordedTrigger, isForkPr, Option.or, hne]
  have hl : "untrusted-input" ∈ resolvedLabels trigger path := by
    rw [ht]; cases path with
    | rerun => simp [resolvedLabels]
    | release => simp [resolvedLabels]
    | later d r x => simp only [resolvedLabels]; split <;> simp
  refine ⟨ht, hl, by simp [ht, defaultResolverLabels], ?_⟩
  exact untrusted_never_device _ _ f kinds cloudPinnedKinds declared (List.contains_iff_mem.mpr hl)

end FdFormal.Intake
