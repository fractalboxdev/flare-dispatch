-- The model of the registry validator's agentic rules (packages/agentic/src/declaration.ts `validateDeclaration`) and
-- of the drift check's agentic step over a deploy's run catalogue (packages/ops/src/drift.ts `agenticRegistryCheck`),
-- property S5 · trifecta of specs/verification.md § Formal properties.
namespace FdFormal.Egress

/-- `DataClasses`: the three data classes a declaration sets. -/
structure DataClasses where
  privateData : Bool
  untrustedInput : Bool
  outbound : Bool
  deriving DecidableEq, Repr

/-- The trifecta: all three data classes set together. -/
def DataClasses.trifecta (c : DataClasses) : Bool := c.privateData && c.untrustedInput && c.outbound

/-- The fields of a decoded `AgenticDeclaration` the validator's rules read. -/
structure Declaration where
  callSites : Nat
  needsModel : Bool
  dataClasses : DataClasses
  intentKinds : List String
  hasWriteback : Bool
  deriving Repr

/-- One rejection of the registry validator. -/
structure Rejection where
  run : String
  reason : String
  deriving DecidableEq, Repr

/-- A catalogue entry's declaration as the validator reads it: `none` when it fails to decode as an
`AgenticDeclaration`, which covers a missing tier, data classes or intent kinds and an unknown intent kind. -/
abbrev Decoded := Option Declaration

/-- `validateDeclaration`: one `declaration:` rejection when the declaration fails to decode, otherwise the trifecta,
call-site and `pr.propose` rules in that order. -/
def validateDeclaration (run : String) : Decoded → List Rejection
  | none => [{ run, reason := "declaration: decode" }]
  | some d =>
    (if d.dataClasses.trifecta then [{ run, reason := "policy: trifecta" }] else []) ++
    (if d.needsModel && d.callSites == 0 then [{ run, reason := "declaration: needsModel without a call site" }]
    else []) ++
    (if d.intentKinds.contains "pr.propose" && !d.hasWriteback then
      [{ run, reason := "declaration: pr.propose without a writeback block" }]
    else [])

/-- One drift-check finding. -/
structure Finding where
  check : String
  path : String
  detail : String
  failure : Bool
  deriving DecidableEq, Repr

/-- The failure `agenticRegistryCheck` makes of one rejection, at `runs.<run>.declaration`. -/
def toFinding (r : Rejection) : Finding :=
  { check := "agentic-registry", path := "runs." ++ r.run ++ ".declaration", detail := r.reason, failure := true }

/-- `agenticRegistryCheck`: one failure per rejection of every catalogue entry. -/
def agenticRegistryCheck (registry : List (String × Decoded)) : List Finding :=
  registry.flatMap fun (run, decl) => (validateDeclaration run decl).map toFinding

/-- A deploy proceeds only when its drift check holds no failing finding. -/
def deployAccepts (findings : List Finding) : Bool := !findings.any (·.failure)

/-- The validator rejects a declaration that sets `privateData`, `untrustedInput` and `outbound` together with the
reason `policy: trifecta`, whatever its other fields (FD-AGT-004). -/
theorem trifecta_rejected (run : String) (d : Declaration) (h : d.dataClasses.trifecta = true) :
    { run, reason := "policy: trifecta" } ∈ validateDeclaration run (some d) := by
  simp [validateDeclaration, h]

/-- Every finding of the agentic step is a failure, so the step blocks a deploy exactly when it finds anything. -/
theorem registry_findings_fail (registry : List (String × Decoded)) :
    ∀ f ∈ agenticRegistryCheck registry, f.failure = true := by
  intro f hf
  simp only [agenticRegistryCheck, List.mem_flatMap, List.mem_map] at hf
  obtain ⟨_, _, _, _, rfl⟩ := hf
  rfl

/--
No run declaration a deploy accepts combines private data, untrusted input and outbound access: if the drift check's
findings, the agentic step's among them, block nothing, then every declaration of the catalogue decodes and none sets
`privateData`, `untrustedInput` and `outbound` together, whatever the other checks found (FD-AGT-004).
-/
theorem no_trifecta_declaration (other : List Finding) (registry : List (String × Decoded))
    (hacc : deployAccepts (other ++ agenticRegistryCheck registry) = true) :
    ∀ run decl, (run, decl) ∈ registry → ∃ d, decl = some d ∧ d.dataClasses.trifecta = false := by
  intro run decl hmem
  have hnone : ∀ f ∈ agenticRegistryCheck registry, f.failure = false := by
    intro f hf
    simp only [deployAccepts, List.any_append, Bool.not_or, Bool.and_eq_true, Bool.not_eq_true',
      List.any_eq_false] at hacc
    simpa using hacc.2 f hf
  have hempty : validateDeclaration run decl = [] := by
    cases hv : validateDeclaration run decl with
    | nil => rfl
    | cons r rs =>
      have hf : toFinding r ∈ agenticRegistryCheck registry := by
        simp only [agenticRegistryCheck, List.mem_flatMap, List.mem_map]
        exact ⟨(run, decl), hmem, r, by simp [hv], rfl⟩
      have := hnone _ hf; simp [toFinding] at this
  cases decl with
  | none => simp [validateDeclaration] at hempty
  | some d =>
    refine ⟨d, rfl, ?_⟩
    cases ht : d.dataClasses.trifecta with
    | false => rfl
    | true => simp [validateDeclaration, ht] at hempty

end FdFormal.Egress
