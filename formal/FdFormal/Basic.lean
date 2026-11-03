-- The namespace every FlareDispatch model module opens. The staged-write gate (S8) and cache-namespace (S6) models
-- live beside it as `FdFormal/StagedWrite.lean` and `FdFormal/Cache.lean`.
namespace FdFormal

/-- The verdict of a pure gate over a whole input: one rejecting entry rejects all of it. -/
inductive Verdict where
  | accept
  | reject
  deriving DecidableEq, Repr

/-- A list of entry verdicts combines to `accept` only when every entry accepts. -/
def Verdict.all : List Verdict → Verdict
  | [] => .accept
  | .reject :: _ => .reject
  | .accept :: rest => Verdict.all rest

/-- One rejecting entry rejects the whole list. -/
theorem Verdict.all_reject_of_mem {vs : List Verdict} (h : Verdict.reject ∈ vs) :
    Verdict.all vs = .reject := by
  induction vs with
  | nil => cases h
  | cons v rest ih =>
    cases v with
    | reject => rfl
    | accept =>
      simp only [Verdict.all]
      cases h with
      | tail _ h' => exact ih h'

end FdFormal
