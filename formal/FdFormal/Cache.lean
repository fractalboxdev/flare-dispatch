-- The model of cache namespaces and cache tiers (packages/cache/src/namespaces.ts), the commit's namespace check
-- (packages/cache/src/manifest.ts `commitEntry`), the reader's lookup and the compile-cache route's namespace choice
-- (packages/cache/src/compile-cache.ts), property S6 of specs/verification.md § Formal properties.
--
-- `cacheNamespaces` takes the repository as `repoSlug(execution.repo)` returns it, so each theorem holds for every
-- slug the TypeScript validation can produce. A namespace is a constructor here and a string in TypeScript; `render`
-- is the TypeScript formatting, and the commit check and the store compare rendered strings, as TypeScript does.
namespace FdFormal.Cache

/-- What started the execution, as far as cache writes are concerned (`CacheTrigger`). -/
inductive Trigger where
  | pullRequest (number : Nat)
  | push (ref : String) (isProtected : Bool)
  | mergeGroup
  | other
  deriving DecidableEq, Repr

/-- The execution row's facts the binding reads (`CacheExecution`, its repository already a slug). -/
structure Execution where
  executionId : String
  cls : String
  constraints : List String
  trigger : Trigger
  rehearsal : Bool
  deriving Repr

/-- A cache namespace. -/
inductive Ns where
  | protectedCloud (repo : String)
  | protectedDevice (repo : String)
  | pr (repo : String) (number : Nat)
  | exec (repo : String) (executionId : String)
  | content
  deriving DecidableEq, Repr

/-- A namespace's cache tier. -/
inductive Tier where
  | protectedCloud
  | protectedDevice
  | pullRequest
  | execution
  | content
  deriving DecidableEq, Repr

def Ns.tier : Ns → Tier
  | .protectedCloud _ => .protectedCloud
  | .protectedDevice _ => .protectedDevice
  | .pr _ _ => .pullRequest
  | .exec _ _ => .execution
  | .content => .content

/-- The repository a namespace belongs to, none for the content tier. -/
def Ns.repo : Ns → Option String
  | .protectedCloud r | .protectedDevice r | .pr r _ | .exec r _ => some r
  | .content => none

/-- The namespace id TypeScript formats. -/
def Ns.render : Ns → String
  | .protectedCloud r => "protected/" ++ r ++ "/cloud"
  | .protectedDevice r => "protected/" ++ r ++ "/device"
  | .pr r n => "pr/" ++ r ++ "/" ++ toString n
  | .exec r id => "exec/" ++ r ++ "/" ++ id
  | .content => "cas"

/-- `isCloudKind`. -/
def isCloudKind (kind : String) : Bool := kind == "cloudflare" || kind == "aws"

/-- `isMergeQueueRef`: `refs/heads/` removed, the rest starts with `gh-readonly-queue/`. -/
def isMergeQueueRef (ref : String) : Bool :=
  let r := ref.toList
  let r := if "refs/heads/".toList.isPrefixOf r then r.drop 11 else r
  "gh-readonly-queue/".toList.isPrefixOf r

/-- `isProtectedTrigger`: a protected push that is not a merge-queue branch. -/
def isProtectedTrigger : Trigger → Bool
  | .push ref p => p && !isMergeQueueRef ref
  | _ => false

/-- `restoresNothing`: `release` builds cold and `cloud-only` restores nothing. -/
def restoresNothing (e : Execution) : Bool := e.cls == "release" || e.constraints.contains "cloud-only"

/-- `writable`. -/
def writable (e : Execution) (repo : String) (kind : String) : Option Ns :=
  if e.rehearsal || kind == "gha" then some (.exec repo e.executionId)
  else match e.trigger with
    | .pullRequest n => some (.pr repo n)
    | .push ref p =>
      if !isProtectedTrigger (.push ref p) then none
      else if isCloudKind kind then some (.protectedCloud repo)
      else if kind == "device" then some (.protectedDevice repo)
      else none
    | .mergeGroup => none
    | .other => none

/-- `readable`. -/
def readable (e : Execution) (repo : String) (kind : String) : List Ns :=
  if restoresNothing e then []
  else
    let protectedTiers := if kind == "device" then [.protectedCloud repo, .protectedDevice repo] else [.protectedCloud repo]
    let own := match e.trigger with | .pullRequest n => [Ns.pr repo n] | _ => []
    let exec := if e.rehearsal then [Ns.exec repo e.executionId] else []
    exec ++ own ++ protectedTiers ++ [.content]

/-- A lease's `cache_namespaces`. -/
structure Lease where
  read : List Ns
  write : Option Ns
  deriving Repr

/-- `cacheNamespaces(execution, kind)`, given `repoSlug(execution.repo)`. -/
def cacheNamespaces (slug : Option String) (e : Execution) (kind : String) : Lease :=
  match slug with
  | none => { read := [], write := none }
  | some r => { read := readable e r kind, write := writable e r kind }

/-- `capacityNamespaces(lease)`, given `repoSlug(lease.repo)`. -/
def capacityNamespaces (slug : Option String) (leaseId : String) : Lease :=
  match slug with
  | none => { read := [], write := none }
  | some r => { read := [.exec r leaseId, .protectedCloud r, .protectedDevice r, .content], write := some (.exec r leaseId) }

/-! ### FD-CACHE-017, FD-CACHE-019, FD-CACHE-022, FD-CACHE-023 -/

/-- Every writable namespace the binding assigns, by the reason it assigns it. -/
theorem writable_cases (e : Execution) (r kind : String) (ns : Ns) (h : writable e r kind = some ns) :
    ((e.rehearsal = true ∨ kind = "gha") ∧ ns = .exec r e.executionId) ∨
    (e.rehearsal = false ∧ kind ≠ "gha" ∧
      ((∃ n, e.trigger = .pullRequest n ∧ ns = .pr r n) ∨
       (isProtectedTrigger e.trigger = true ∧ (kind = "cloudflare" ∨ kind = "aws") ∧ ns = .protectedCloud r) ∨
       (isProtectedTrigger e.trigger = true ∧ kind = "device" ∧ ns = .protectedDevice r))) := by
  unfold writable at h
  by_cases h1 : (e.rehearsal || kind == "gha") = true
  · simp only [h1, ite_true, Option.some.injEq] at h
    left; exact ⟨by simpa using h1, h.symm⟩
  · simp only [h1, Bool.false_eq_true, ite_false] at h
    have hreh : e.rehearsal = false := by simp_all
    have hk : kind ≠ "gha" := by intro hk; simp_all
    right; refine ⟨hreh, hk, ?_⟩
    cases htr : e.trigger with
    | pullRequest n => simp only [htr, Option.some.injEq] at h; exact Or.inl ⟨n, rfl, h.symm⟩
    | mergeGroup => simp [htr] at h
    | other => simp [htr] at h
    | push ref p =>
      simp only [htr] at h
      by_cases hp : isProtectedTrigger (.push ref p) = true
      · simp only [hp, Bool.not_true, Bool.false_eq_true, ite_false] at h
        by_cases hc : isCloudKind kind = true
        · simp only [hc, ite_true, Option.some.injEq] at h
          simp only [isCloudKind, Bool.or_eq_true, beq_iff_eq] at hc
          exact Or.inr (Or.inl ⟨hp, hc, h.symm⟩)
        · simp only [hc, Bool.false_eq_true, ite_false] at h
          by_cases hd : kind = "device"
          · simp only [hd, beq_self_eq_true, ite_true, Option.some.injEq] at h
            exact Or.inr (Or.inr ⟨hp, hd, h.symm⟩)
          · have : (kind == "device") = false := by simpa using hd
            simp [this] at h
      · simp [hp] at h

/--
The control plane assigns a writable namespace of cache tier `protected-cloud` only to an execution of a protected
trigger on executor kind `cloudflare` or `aws` (FD-CACHE-017).
-/
theorem protected_cloud_writer (slug : Option String) (e : Execution) (kind : String) (ns : Ns)
    (h : (cacheNamespaces slug e kind).write = some ns) (ht : ns.tier = .protectedCloud) :
    isProtectedTrigger e.trigger = true ∧ (kind = "cloudflare" ∨ kind = "aws") := by
  cases slug with
  | none => simp [cacheNamespaces] at h
  | some r =>
    rcases writable_cases e r kind ns h with ⟨_, rfl⟩ | ⟨_, _, ⟨_, _, rfl⟩ | ⟨hp, hc, rfl⟩ | ⟨_, _, rfl⟩⟩ <;>
      first | exact ⟨hp, hc⟩ | simp [Ns.tier] at ht

/--
When a pull request triggers an execution of a repository, the control plane assigns it the writable namespace
`pr/<repo>/<number>` of that pull request, except that a rehearsal or an execution on executor kind `gha` takes its own
`exec/<repo>/<execution_id>` namespace under FD-CACHE-021 (FD-CACHE-019).
-/
theorem pull_request_writer (r : String) (e : Execution) (kind : String) (n : Nat)
    (ht : e.trigger = .pullRequest n) :
    (cacheNamespaces (some r) e kind).write =
      if e.rehearsal || kind == "gha" then some (.exec r e.executionId) else some (.pr r n) := by
  simp only [cacheNamespaces, writable, ht]

/-- Every namespace an execution reads, other than a rehearsal's own execution namespace, is of tier
`protected-cloud`, `protected-device`, `content` or the execution's own pull request. -/
theorem readable_tiers (r : String) (e : Execution) (kind : String) (ns : Ns) (h : ns ∈ readable e r kind) :
    ns = .exec r e.executionId ∧ e.rehearsal = true ∨ ns = .protectedCloud r ∨ ns = .protectedDevice r ∨
      ns = .content ∨ ∃ n, e.trigger = .pullRequest n ∧ ns = .pr r n := by
  unfold readable at h
  split at h
  · simp at h
  · simp only [List.mem_append, List.mem_cons, List.not_mem_nil, or_false] at h
    rcases h with ((hx | ho) | hp) | hc
    · split at hx
      · simp at hx; left; exact ⟨hx, by assumption⟩
      · simp at hx
    · split at ho
      · rename_i n hn; simp at ho; right; right; right; right; exact ⟨n, hn, ho⟩
      · simp at ho
    · split at hp <;> simp at hp <;> (try rcases hp with hp | hp) <;> simp_all
    · simp_all

/--
The control plane gives an execution of a protected trigger only readable namespaces of cache tiers
`protected-cloud`, `protected-device` and `content`. A rehearsal is a local run and never an execution of a protected
trigger (README.md § Glossary), so the statement covers the executions with `rehearsal` false (FD-CACHE-022).
-/
theorem protected_trigger_reads (slug : Option String) (e : Execution) (kind : String) (ns : Ns)
    (hp : isProtectedTrigger e.trigger = true) (hr : e.rehearsal = false)
    (h : ns ∈ (cacheNamespaces slug e kind).read) :
    ns.tier = .protectedCloud ∨ ns.tier = .protectedDevice ∨ ns.tier = .content := by
  cases slug with
  | none => simp [cacheNamespaces] at h
  | some r =>
    rcases readable_tiers r e kind ns h with ⟨_, h'⟩ | rfl | rfl | rfl | ⟨n, hn, _⟩
    · simp [hr] at h'
    · simp [Ns.tier]
    · simp [Ns.tier]
    · simp [Ns.tier]
    · simp [hn, isProtectedTrigger] at hp

/--
The control plane gives a pull-request execution only its own `pr/<repo>/<number>` namespace, the protected tiers of
the same repository and `content` as readable namespaces. A rehearsal is a local run and never a pull-request
execution (README.md § Glossary), so the statement covers the executions with `rehearsal` false (FD-CACHE-023).
-/
theorem pull_request_reads (r : String) (e : Execution) (kind : String) (n : Nat) (ns : Ns)
    (ht : e.trigger = .pullRequest n) (hr : e.rehearsal = false)
    (h : ns ∈ (cacheNamespaces (some r) e kind).read) :
    ns = .pr r n ∨ ns = .protectedCloud r ∨ ns = .protectedDevice r ∨ ns = .content := by
  rcases readable_tiers r e kind ns h with ⟨_, h'⟩ | h' | h' | h' | ⟨m, hm, h'⟩
  · simp [hr] at h'
  · exact Or.inr (Or.inl h')
  · exact Or.inr (Or.inr (Or.inl h'))
  · exact Or.inr (Or.inr (Or.inr h'))
  · rw [ht] at hm; cases hm; exact Or.inl h'

-- FD-CACHE-022 and FD-CACHE-023 as written fail for a row the type admits: `rehearsal` true on a protected push or a
-- pull request reads its own `exec/` namespace first. No current caller builds such a row.
theorem rehearsal_on_protected_push_reads_exec :
    Ns.exec "o/r" "e1" ∈
      (cacheNamespaces (some "o/r")
        { executionId := "e1", cls := "required", constraints := [], trigger := .push "refs/heads/main" true,
          rehearsal := true } "cloudflare").read := by
  decide

/-! ### FD-CACHE-029: the commit's namespace check -/

/-- Why the control plane refuses a commit before reading its objects. -/
inductive CommitRefusal where
  | namespaceDenied (nsId : String) (writable : Option String)
  deriving DecidableEq, Repr

/-- The first check of `commitEntry`: the request's namespace must be the lease's writable namespace. -/
def commitCheck (lease : Lease) (nsId : String) : Except CommitRefusal Unit :=
  if lease.write.map Ns.render = some nsId then .ok ()
  else .error (.namespaceDenied nsId (lease.write.map Ns.render))

/--
If an executor commits an entry to a namespace other than its execution's writable namespace, the control plane
refuses the commit with `CacheNamespaceDenied` (FD-CACHE-029).
-/
theorem commit_outside_writable_denied (lease : Lease) (nsId : String)
    (h : lease.write.map Ns.render ≠ some nsId) :
    commitCheck lease nsId = .error (.namespaceDenied nsId (lease.write.map Ns.render)) := by
  simp [commitCheck, h]

/-! ### S6: a pull-request writer cannot change what a protected-trigger reader restores -/

/-- Committed manifests by namespace id and key. -/
abbrev Store (α : Type) := String → String → Option α

/-- A commit: the store changes only when the namespace check passes. -/
def commit {α : Type} (lease : Lease) (s : Store α) (nsId key : String) (v : α) : Store α :=
  match commitCheck lease nsId with
  | .ok () => fun n k => if n = nsId ∧ k = key then some v else s n k
  | .error _ => s

/-- The reader's lookup: the first readable namespace, in lease order, holding a manifest for the key. -/
def restore {α : Type} (lease : Lease) (s : Store α) (key : String) : Option (Ns × α) :=
  lease.read.findSome? fun ns => (s ns.render key).map (ns, ·)

theorem render_pr_ne_protected (r r' : String) (n : Nat) :
    (Ns.pr r n).render ≠ (Ns.protectedCloud r').render ∧ (Ns.pr r n).render ≠ (Ns.protectedDevice r').render ∧
      (Ns.pr r n).render ≠ Ns.content.render := by
  refine ⟨?_, ?_, ?_⟩ <;> intro h <;> have := congrArg String.toList h <;> simp [Ns.render] at this

theorem render_exec_ne_protected (r r' id : String) :
    (Ns.exec r id).render ≠ (Ns.protectedCloud r').render ∧ (Ns.exec r id).render ≠ (Ns.protectedDevice r').render ∧
      (Ns.exec r id).render ≠ Ns.content.render := by
  refine ⟨?_, ?_, ?_⟩ <;> intro h <;> have := congrArg String.toList h <;> simp [Ns.render] at this

theorem render_exec_ne_exec (r id id' : String) (h : id ≠ id') : (Ns.exec r id).render ≠ (Ns.exec r id').render := by
  intro he
  apply h
  simpa [Ns.render] using he

/-- The writable namespace of an execution whose trigger is not protected is none, its pull request's or its own
execution namespace. -/
theorem unprotected_writer (r : String) (e : Execution) (kind : String) (hp : isProtectedTrigger e.trigger = false)
    (ns : Ns) (h : writable e r kind = some ns) :
    ns = .exec r e.executionId ∨ ∃ n, ns = .pr r n := by
  rcases writable_cases e r kind ns h with ⟨_, rfl⟩ | ⟨_, _, ⟨n, _, rfl⟩ | ⟨hp', _, _⟩ | ⟨hp', _, _⟩⟩
  · exact Or.inl rfl
  · exact Or.inr ⟨n, rfl⟩
  · simp [hp] at hp'
  · simp [hp] at hp'

theorem findSome_congr {α β : Type} (f g : α → Option β) :
    ∀ (xs : List α), (∀ x ∈ xs, f x = g x) → xs.findSome? f = xs.findSome? g
  | [], _ => rfl
  | x :: xs, h => by
    simp only [List.findSome?_cons, h x (by simp)]
    split
    · rfl
    · exact findSome_congr f g xs fun y hy => h y (by simp [hy])

/-- A commit that misses every namespace of a lease leaves that lease's lookup unchanged. -/
theorem restore_commit_disjoint {α : Type} (reader writer : Lease) (s : Store α) (nsId key k : String) (v : α)
    (h : ∀ ns ∈ reader.read, writer.write.map Ns.render = some nsId → ns.render ≠ nsId) :
    restore reader (commit writer s nsId key v) k = restore reader s k := by
  unfold commit
  split
  · rename_i hc
    have hw : writer.write.map Ns.render = some nsId := by
      unfold commitCheck at hc; split at hc
      · assumption
      · cases hc
    unfold restore
    exact findSome_congr _ _ _ fun ns hns => by simp [h ns hns hw]
  · rfl

/--
A pull-request-namespace writer cannot change what a protected-trigger reader restores: a commit by an execution whose
trigger is a pull request, on any executor kind, leaves every lookup of an execution of a protected trigger unchanged.
The writer reaches only its own pull request's namespace (FD-CACHE-019), or its own execution namespace on `gha`
(FD-CACHE-021), the commit check refuses every other namespace (FD-CACHE-029), and the reader reads only protected
tiers and `content` (FD-CACHE-022). The lease is the only source of namespaces (FD-CACHE-015, FD-CACHE-058). A
protected-trigger reader that is a rehearsal reads its own execution namespace, which another execution never writes.
-/
theorem pr_writer_noninterference {α : Type} (slugW slugR : Option String) (w rd : Execution) (kindW kindR : String)
    (n : Nat) (hw : w.trigger = .pullRequest n) (hr : isProtectedTrigger rd.trigger = true)
    (hids : rd.rehearsal = false ∨ (slugW = slugR ∧ w.executionId ≠ rd.executionId))
    (s : Store α) (nsId key k : String) (v : α) :
    restore (cacheNamespaces slugR rd kindR) (commit (cacheNamespaces slugW w kindW) s nsId key v) k =
      restore (cacheNamespaces slugR rd kindR) s k := by
  apply restore_commit_disjoint
  intro ns hns hwr
  cases slugW with
  | none => simp [cacheNamespaces] at hwr
  | some rw =>
    cases slugR with
    | none => simp [cacheNamespaces] at hns
    | some rr =>
      simp only [cacheNamespaces, Option.map_eq_some_iff] at hwr hns
      obtain ⟨wns, hwns, rfl⟩ := hwr
      have hwp : isProtectedTrigger w.trigger = false := by simp [hw, isProtectedTrigger]
      rcases unprotected_writer rw w kindW hwp wns hwns with rfl | ⟨m, rfl⟩
      · rcases readable_tiers rr rd kindR ns hns with ⟨rfl, hreh⟩ | rfl | rfl | rfl | ⟨m, hm, _⟩
        · rcases hids with h0 | ⟨hs, hne⟩
          · simp [h0] at hreh
          · cases hs; exact (render_exec_ne_exec rw _ _ hne).symm
        · exact fun h => (render_exec_ne_protected rw rr _).1 h.symm
        · exact fun h => (render_exec_ne_protected rw rr _).2.1 h.symm
        · exact fun h => (render_exec_ne_protected rw rr _).2.2 h.symm
        · simp [hm, isProtectedTrigger] at hr
      · rcases readable_tiers rr rd kindR ns hns with ⟨rfl, _⟩ | rfl | rfl | rfl | ⟨m', hm, _⟩
        · intro h; have := congrArg String.toList h; simp [Ns.render] at this
        · exact fun h => (render_pr_ne_protected rw rr m).1 h.symm
        · exact fun h => (render_pr_ne_protected rw rr m).2.1 h.symm
        · exact fun h => (render_pr_ne_protected rw rr m).2.2 h.symm
        · simp [hm, isProtectedTrigger] at hr

/-! ### FD-CACHE-015: the binding against FD-CACHE-017 to FD-CACHE-028 -/

/--
The profile's `cache_namespaces` binding returns an execution's namespaces from the execution and the claiming executor's
kind under FD-CACHE-017 to FD-CACHE-028, and the `capacity.grant` binding returns a capacity lease's namespaces under
FD-CACHE-021: a `protected-cloud` writer is a protected trigger on a cloud kind (FD-CACHE-017), a `protected-device`
writer one on a device (FD-CACHE-018), a pull request writes its own namespace unless FD-CACHE-021 applies
(FD-CACHE-019), a merge group or merge-queue push writes nothing (FD-CACHE-020), a rehearsal, `gha` execution or
capacity lease writes at most its own execution namespace (FD-CACHE-021), a protected trigger and a pull request read
only the tiers FD-CACHE-022 and FD-CACHE-023 allow, a pull request reads its own namespace first (FD-CACHE-024), a cloud
executor never reads the device tier (FD-CACHE-025), every namespace belongs to the execution's repository or to
`content` (FD-CACHE-026), and `release` or `cloud-only` reads nothing (FD-CACHE-028) (FD-CACHE-015).
-/
theorem cacheNamespaces_conforms (slug : Option String) (e : Execution) (kind : String) :
    let l := cacheNamespaces slug e kind
    (∀ ns, l.write = some ns → ns.tier = .protectedCloud →
      isProtectedTrigger e.trigger = true ∧ (kind = "cloudflare" ∨ kind = "aws")) ∧
    (∀ ns, l.write = some ns → ns.tier = .protectedDevice → isProtectedTrigger e.trigger = true ∧ kind = "device") ∧
    (∀ r n, slug = some r → e.trigger = .pullRequest n → e.rehearsal = false → kind ≠ "gha" →
      l.write = some (.pr r n)) ∧
    ((e.trigger = .mergeGroup ∨ ∃ ref p, e.trigger = .push ref p ∧ isMergeQueueRef ref = true) →
      e.rehearsal = false → kind ≠ "gha" → l.write = none) ∧
    (∀ r, slug = some r → (e.rehearsal = true ∨ kind = "gha") → l.write = some (.exec r e.executionId)) ∧
    (isProtectedTrigger e.trigger = true → e.rehearsal = false →
      ∀ ns ∈ l.read, ns.tier = .protectedCloud ∨ ns.tier = .protectedDevice ∨ ns.tier = .content) ∧
    (∀ r n, slug = some r → e.trigger = .pullRequest n → e.rehearsal = false →
      l.read.head? = some (.pr r n) ∨ l.read = []) ∧
    (kind ≠ "device" → ∀ ns ∈ l.read, ns.tier ≠ .protectedDevice) ∧
    (∀ ns, (ns ∈ l.read ∨ l.write = some ns) → ns.repo = slug ∨ ns = .content) ∧
    (restoresNothing e = true → l.read = []) ∧
    (∀ r id, (capacityNamespaces (some r) id).write = some (.exec r id)) := by
  intro l
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · exact protected_cloud_writer slug e kind
  · intro ns h ht
    cases slug with
    | none => simp [l, cacheNamespaces] at h
    | some r =>
      rcases writable_cases e r kind ns h with ⟨_, rfl⟩ | ⟨_, _, ⟨_, _, rfl⟩ | ⟨_, _, rfl⟩ | ⟨hp, hd, rfl⟩⟩ <;>
        first | exact ⟨hp, hd⟩ | simp [Ns.tier] at ht
  · intro r n hs ht hreh hk
    subst hs
    simp [l, cacheNamespaces, writable, ht, hreh, hk]
  · intro hm hreh hk
    cases slug with
    | none => rfl
    | some r =>
      simp only [l, cacheNamespaces, writable, hreh, Bool.false_or]
      have : (kind == "gha") = false := by simpa using hk
      simp only [this, Bool.false_eq_true, ite_false]
      rcases hm with hm | ⟨ref, p, hm, hq⟩
      · simp [hm]
      · simp [hm, isProtectedTrigger, hq]
  · intro r hs h
    subst hs
    have : (e.rehearsal || kind == "gha") = true := by rcases h with h | h <;> simp [h]
    simp [l, cacheNamespaces, writable, this]
  · intro hp hreh ns h
    exact protected_trigger_reads slug e kind ns hp hreh h
  · intro r n hs ht hreh
    subst hs
    simp only [l, cacheNamespaces, readable, ht, hreh, Bool.false_eq_true, ite_false, List.nil_append]
    split <;> simp
  · intro hk ns h
    cases slug with
    | none => simp [l, cacheNamespaces] at h
    | some r =>
      simp only [l, cacheNamespaces, readable] at h
      split at h
      · simp at h
      · have : (kind == "device") = false := by simpa using hk
        simp only [this, Bool.false_eq_true, ite_false, List.mem_append, List.mem_cons, List.not_mem_nil,
          or_false] at h
        rcases h with ((hx | ho) | hp) | hc
        · split at hx <;> simp at hx; subst hx; simp [Ns.tier]
        · split at ho <;> simp at ho; subst ho; simp [Ns.tier]
        · subst hp; simp [Ns.tier]
        · subst hc; simp [Ns.tier]
  · intro ns h
    cases slug with
    | none => simp [l, cacheNamespaces] at h
    | some r =>
      rcases h with h | h
      · rcases readable_tiers r e kind ns h with ⟨rfl, _⟩ | rfl | rfl | rfl | ⟨_, _, rfl⟩ <;> simp [Ns.repo]
      · rcases writable_cases e r kind ns h with ⟨_, rfl⟩ | ⟨_, _, ⟨_, _, rfl⟩ | ⟨_, _, rfl⟩ | ⟨_, _, rfl⟩⟩ <;>
          simp [Ns.repo]
  · intro h
    cases slug with
    | none => rfl
    | some r => simp [l, cacheNamespaces, readable, h]
  · intro r id
    rfl

/-! ### FD-CACHE-058: the compile-cache route's namespaces -/

/-- The methods the compile-cache route serves. -/
inductive Method where
  | get
  | head
  | put
  | propfind
  | mkcol
  | options
  | other
  deriving DecidableEq, Repr

/-- A verified compile-cache token's namespaces, as rendered ids. -/
structure TokenScope where
  read : List String
  write : Option String
  deriving Repr

/-- A compile-cache request after its path parses: the method, the key below the repository, whether it names a
collection, and its headers. The path's owner and name select the token's repository and nothing else. -/
structure Request where
  method : Method
  key : String
  collection : Bool
  headers : List (String × String)
  deriving Repr

/-- One R2 call the route makes, with the namespace of the object key `compile-cache/<namespace>/<key>`. -/
inductive Op where
  | read (nsId key : String)
  | write (nsId key : String)
  deriving DecidableEq, Repr

def Op.nsId : Op → String
  | .read n _ | .write n _ => n

/-- The header a request names, case-insensitively as `Headers.get` reads it. -/
def header (req : Request) (name : String) : Option String :=
  (req.headers.find? (fun (k, _) => k.toLower == name)).map (·.2)

/-- `/^[0-9]{1,16}$/` on the `content-length` header. -/
def lengthOk (v : String) : Bool := 1 ≤ v.length && v.length ≤ 16 && v.toList.all Char.isDigit

/-- The reads of a lookup: each namespace in order until the first hit. -/
def lookupOps (key : String) (hit : String → Bool) : List String → List Op
  | [] => []
  | n :: ns => .read n key :: (if hit n then [] else lookupOps key hit ns)

/--
The R2 calls `handleCompileCache` makes for a request under a verified token, with `hit ns` answering whether an
object exists under a namespace. A lookup tries the token's readable namespaces other than `cas` in token order and
stops at the first hit; a PUT that passes its checks writes the token's writable namespace. `admitted` stands for the
checks that do not involve a namespace: the length bound and the ledger reservation.
-/
def routeOps (scope : TokenScope) (req : Request) (hit : String → Bool) (admitted : Bool) : List Op :=
  match req.method with
  | .get | .head => if req.collection then [] else lookupOps req.key hit (scope.read.filter (· != "cas"))
  | .propfind =>
    match header req "depth" with
    | some d => if d.trimAscii.toString != "0" then [] else if req.collection then [] else lookupOps req.key hit (scope.read.filter (· != "cas"))
    | none => if req.collection then [] else lookupOps req.key hit (scope.read.filter (· != "cas"))
  | .put =>
    if req.collection then []
    else match header req "content-length" with
      | none => []
      | some v =>
        if !lengthOk v then []
        else match scope.write with
          | none => []
          | some w => if admitted then [.write w req.key] else []
  | .mkcol | .options | .other => []

theorem lookupOps_mem (key : String) (hit : String → Bool) :
    ∀ (rs : List String) (op : Op),
      op ∈ lookupOps key hit rs → ∃ n ∈ rs, op = .read n key := by
  intro rs
  induction rs with
  | nil => intro op h; simp [lookupOps] at h
  | cons n ns ih =>
    intro op h
    simp only [lookupOps, List.mem_cons] at h
    rcases h with rfl | h
    · exact ⟨n, by simp, rfl⟩
    · split at h
      · simp at h
      · obtain ⟨m, hm, rfl⟩ := ih op h
        exact ⟨m, List.mem_cons_of_mem _ hm, rfl⟩

/--
The compile-cache route takes the namespaces from the token and ignores any namespace in the request path or headers:
every object it reads lies under one of the token's readable namespaces and every object it writes under the token's
writable namespace, whatever the request's key and headers (FD-CACHE-058).
-/
theorem route_namespaces_from_token (scope : TokenScope) (req : Request) (hit : String → Bool) (admitted : Bool)
    (op : Op) (h : op ∈ routeOps scope req hit admitted) :
    (∃ n, op = .read n req.key ∧ n ∈ scope.read) ∨ (∃ w, op = .write w req.key ∧ scope.write = some w) := by
  have hl : ∀ op, op ∈ lookupOps req.key hit (scope.read.filter (· != "cas")) →
      ∃ n, op = .read n req.key ∧ n ∈ scope.read := by
    intro op h
    obtain ⟨n, hn, rfl⟩ := lookupOps_mem req.key hit _ op h
    exact ⟨n, rfl, (List.mem_filter.mp hn).1⟩
  unfold routeOps at h
  cases hm : req.method <;> simp only [hm] at h <;>
    repeat' (first
      | (simp at h; done)
      | exact Or.inl (hl op h)
      | (simp only [List.mem_singleton] at h; exact Or.inr ⟨_, h, by assumption⟩)
      | split at h)

end FdFormal.Cache
