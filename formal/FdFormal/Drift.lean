-- The model of the drift check's profile step (packages/ops/src/drift.ts `profileCheck`, packages/ops/scripts/drift-check.ts)
-- over the answer of mameko's profile loader (vendor/mameko/packages/coordinator/src/profile-loader.ts `deliver`),
-- the FlareDispatch side of property S3 of specs/verification.md § Formal properties.
namespace FdFormal.Drift

/-- One rejection of mameko's profile validator. -/
structure Rejection where
  item : String
  path : String
  reason : String
  deriving DecidableEq, Repr

/-- The loader's answer to the document a deploy carries. -/
inductive LoadAnswer where
  | accepted
  | rejected (rejections : List Rejection)
  deriving Repr

/-- One drift-check finding. -/
structure Finding where
  check : String
  path : String
  detail : String
  failure : Bool
  deriving DecidableEq, Repr

/-- The finding `profileCheck` makes of one rejection: its path, or its item when the path is empty. -/
def toFinding (r : Rejection) : Finding :=
  { check := "profile", path := if r.path = "" then r.item else r.path, detail := r.reason, failure := true }

/-- `profileCheck`: no finding for an accepted document, one failure per rejection otherwise, in order. -/
def profileCheck : LoadAnswer → List Finding
  | .accepted => []
  | .rejected rs => rs.map toFinding

/-- The drift check's findings: the configuration checks, then the profile step. -/
def driftFindings (configFindings : List Finding) (answer : LoadAnswer) : List Finding :=
  configFindings ++ profileCheck answer

/-- The drift check fails when any finding is a failure. -/
def driftFails (findings : List Finding) : Bool := findings.any (·.failure)

/--
If mameko's profile validator rejects the profile document a deploy carries, the drift check fails, and it lists
every rejection the validator returns, in order, each with the validator's reason, whatever the configuration checks
found (FD-OPS-021). mameko's loader rejects only with at least one rejection (`profile-loader.ts`, `deliver`).
-/
theorem drift_fails_with_every_rejection (configFindings : List Finding) (rs : List Rejection) (hne : rs ≠ []) :
    driftFails (driftFindings configFindings (.rejected rs)) = true ∧
      rs.map toFinding <:+ driftFindings configFindings (.rejected rs) ∧
      ∀ r ∈ rs, ∃ f ∈ driftFindings configFindings (.rejected rs), f.detail = r.reason ∧ f.failure = true := by
  refine ⟨?_, List.suffix_append _ _, ?_⟩
  · obtain ⟨r, hr⟩ := List.exists_mem_of_ne_nil _ hne
    simp only [driftFails, driftFindings, profileCheck, List.any_append, List.any_map, Bool.or_eq_true,
      List.any_eq_true]
    exact Or.inr ⟨r, hr, rfl⟩
  · intro r hr
    exact ⟨toFinding r, List.mem_append_right _ (List.mem_map_of_mem hr), rfl, rfl⟩

/-- An accepted document adds no finding. -/
theorem accepted_adds_nothing (configFindings : List Finding) :
    driftFindings configFindings .accepted = configFindings := by
  simp [driftFindings, profileCheck]

end FdFormal.Drift
