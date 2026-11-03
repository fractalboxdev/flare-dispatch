-- The model of `stagedWriteGate` (packages/agentic/src/staged-write/gate.ts) and of the `pr.propose` applier's call
-- order (packages/agentic/src/writeback/applier.ts), property S8 of specs/verification.md § Formal properties. The
-- `oracle` executable (`formal/Oracle.lean`) answers each differential-test event with `gate`, so the TypeScript
-- gate and this model are compared on every generated trace.
import FdFormal.JsText

namespace FdFormal.StagedWrite

open FdFormal.JsText

/-- One file of a staged write. -/
structure Entry where
  path : String
  mode : String
  digest : String
  deriving Repr

/-- The fields of a manifest the gate reads. -/
structure Manifest where
  branch : String
  message : String
  title : String
  body : String
  entries : List Entry
  deriving Repr

/-- A recipe's `writeback` block; an absent `linkAllowlist` is the empty list. -/
structure Spec where
  allowlist : List String
  allowSensitivePaths : Bool
  allowWorkflows : Bool
  maxFiles : Option Nat
  maxBytes : Option Nat
  linkAllowlist : List String
  deriving Repr

/-- One blob read back from the artifact store; `text` is none for a binary blob. -/
structure Blob where
  path : String
  digest : String
  size : Nat
  text : Option String
  deriving Repr

/-- What the gate reads besides the manifest. `base` lists the base commit's file texts; the first entry for a path
answers `baseText`, and a path it lacks has none. -/
structure Evidence where
  blobs : List Blob
  base : List (String × Option String)
  issuedCredentials : List String
  githubHost : String
  deriving Repr

/-- One rejection reason; absent fields are absent keys in the JSON a verdict serializes to. -/
structure Reason where
  kind : String
  path : Option String := none
  line : Option Nat := none
  detail : Option String := none
  deriving DecidableEq, Repr

/-- The gate's verdict. -/
inductive Verdict where
  | accept
  | reject (reasons : List Reason)
  deriving DecidableEq, Repr

def branchPrefix : String := "flare-dispatch/"
def defaultMaxFiles : Nat := 200
def defaultMaxBytes : Nat := 5 * 1024 * 1024

/-- FD-AGT-019: absolute, over 1024 UTF-8 bytes, a `..`, `.` or empty segment, a `.git` segment in any letter case,
a backslash or a NUL byte. -/
def pathInvalid (path : String) : Bool :=
  let p := path.toList
  p.head? == some '/' || decide (path.utf8ByteSize > 1024) || p.contains '\\' || p.contains '\u0000' ||
    (splitOn '/' p).any fun seg =>
      seg.isEmpty || seg == ['.'] || seg == ['.', '.'] || lower seg == ".git".toList

/-- The lower-cased file name: the last `/` segment. -/
def fileName (path : String) : List Char := lower ((splitOn '/' path.toList).getLast?.getD [])

/-- Whether the lower-cased path starts with `pre`. -/
def under (path : String) (pre : String) : Bool := pre.toList.isPrefixOf (lower path.toList)

/-- FD-AGT-020, FD-AGT-021: the paths a model-authored write never touches. -/
def modelDenied (path : String) : Bool :=
  under path "runs/" || under path "infra/" || under path ".github/workflows/" ||
    ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].any (fun n => fileName path == n.toList)

def packageManifests : List String :=
  ["package.json", "cargo.toml", "pyproject.toml", "setup.py", "setup.cfg", "go.mod", "gemfile", "pom.xml",
    "build.gradle", "build.gradle.kts", "composer.json", "pipfile", "deno.json", "deno.jsonc"]

def lockfiles : List String :=
  ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb", "cargo.lock",
    "poetry.lock", "uv.lock", "pipfile.lock", "gemfile.lock", "go.sum", "composer.lock", "deno.lock"]

def registryConfigs : List String :=
  [".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", "pip.conf", "bunfig.toml", ".gemrc", "pnpm-workspace.yaml"]

def ciFiles : List String := [".gitlab-ci.yml", "jenkinsfile", "azure-pipelines.yml"]

/-- `/^requirements[\w.-]*\.txt$/` on a lower-cased file name. -/
def requirementsTxt (name : List Char) : Bool :=
  decide (name.length ≥ 16) && "requirements".toList.isPrefixOf name && ".txt".toList.isSuffixOf name &&
    ((name.drop 12).take (name.length - 16)).all (fun c => isWord c || c == '.' || c == '-')

/-- `/(^|\/)\.cargo\/config(\.toml)?$/` on the lower-cased path. -/
def cargoConfig (path : String) : Bool :=
  let p := lower path.toList
  [".cargo/config", ".cargo/config.toml"].any fun s =>
    s.toList == p || ('/' :: s.toList).isSuffixOf p

/-- FD-AGT-023: package manifests, lockfiles, registry configuration, Dockerfiles and CI definitions. -/
def sensitivePath (path : String) : Bool :=
  let name := fileName path
  let named (xs : List String) := xs.any (fun x => name == x.toList)
  named packageManifests || named lockfiles || requirementsTxt name || named registryConfigs || cargoConfig path ||
    name == "dockerfile".toList || name == "containerfile".toList || "dockerfile.".toList.isPrefixOf name ||
    ".dockerfile".toList.isSuffixOf name || under path ".github/actions/" || under path ".circleci/" || named ciFiles

/-- The blob a path names: the last blob with that path, as `new Map(blobs.map(...))` keeps. -/
def blobFor (ev : Evidence) (path : String) : Option Blob := ev.blobs.reverse.find? (·.path == path)

/-- `baseText(path)`. -/
def baseText (ev : Evidence) (path : String) : Option String :=
  (ev.base.find? (·.1 == path)).bind (·.2)

/-- The secret and URL reasons of an entry's added lines. -/
def lineReasons (spec : Spec) (modelAuthored : Bool) (ev : Evidence) (path : String) (text : String) :
    List Reason :=
  let links := ev.githubHost :: spec.linkAllowlist
  let base := baseText ev path
  let baseHosts := match base with | none => [] | some b => urlHostsIn b.toList
  (addedLines text.toList (base.map String.toList)).flatMap fun (line, t) =>
    (match credentialIn t ev.issuedCredentials with
      | some c => [{ kind := "secret-detected", path := some path, line := some line, detail := some c }]
      | none => []) ++
    (if modelAuthored && (urlHostsIn t).any (fun h => !hostAllowed h links && !baseHosts.contains h) then
      [{ kind := "url-not-allowed", path := some path, line := some line }]
    else [])

/-- The path checks of one entry, given the paths of the entries before it. -/
def pathReasons (spec : Spec) (modelAuthored : Bool) (seen : List String) (e : Entry) : List Reason :=
  let path := e.path
  let dup := seen.contains path
  (if pathInvalid path || dup then
    [{ kind := "path-invalid", path := some path, detail := if dup then some "duplicate" else none }]
  else []) ++
  (if modelAuthored && modelDenied path then [{ kind := "protected-path", path := some path }] else []) ++
  (if !modelAuthored && under path ".github/workflows/" && !spec.allowWorkflows then
    [{ kind := "workflows-not-opted-in", path := some path }]
  else []) ++
  (if sensitivePath path && !spec.allowSensitivePaths then [{ kind := "sensitive-not-opted-in", path := some path }]
  else []) ++
  (if !inAllowlist path.toList spec.allowlist then [{ kind := "outside-allowlist", path := some path }] else []) ++
  (if !(e.mode == "100644" || e.mode == "100755") then [{ kind := "mode-invalid", path := some path }] else [])

/-- Every reason of one entry: its path checks, then its blob, digest and line checks. -/
def entryReasons (spec : Spec) (modelAuthored : Bool) (ev : Evidence) (seen : List String) (e : Entry) :
    List Reason :=
  pathReasons spec modelAuthored seen e ++
    match blobFor ev e.path with
    | none => [{ kind := "blob-missing", path := some e.path }]
    | some b =>
      (if b.digest != e.digest then [{ kind := "digest-mismatch", path := some e.path }] else []) ++
        match b.text with
        | none => []
        | some t => lineReasons spec modelAuthored ev e.path t

/-- The reasons of the entries in order, each checked against the paths before it. -/
def entriesReasons (spec : Spec) (modelAuthored : Bool) (ev : Evidence) : List String → List Entry → List Reason
  | _, [] => []
  | seen, e :: es => entryReasons spec modelAuthored ev seen e ++ entriesReasons spec modelAuthored ev (seen ++ [e.path]) es

/-- The branch, file-count and byte-count reasons. -/
def manifestReasons (m : Manifest) (spec : Spec) (ev : Evidence) : List Reason :=
  let maxFiles := spec.maxFiles.getD defaultMaxFiles
  let maxBytes := spec.maxBytes.getD defaultMaxBytes
  let total := (m.entries.map fun e => ((blobFor ev e.path).map (·.size)).getD 0).sum
  (if !branchPrefix.toList.isPrefixOf m.branch.toList || m.branch == branchPrefix then [{ kind := "branch-invalid" }]
  else []) ++
  (if m.entries.length > maxFiles then
    [{ kind := "too-many-files", detail := some (toString m.entries.length ++ " > " ++ toString maxFiles) }]
  else []) ++
  (if total > maxBytes then [{ kind := "too-large", detail := some (toString total ++ " > " ++ toString maxBytes) }]
  else [])

/-- The secret, URL and encoded-run reasons of one text field. -/
def fieldReasons (spec : Spec) (modelAuthored : Bool) (ev : Evidence) (field : String) (text : String) :
    List Reason :=
  let links := ev.githubHost :: spec.linkAllowlist
  ((linesOf text.toList).zipIdx.filterMap fun (l, i) =>
    (credentialIn l ev.issuedCredentials).map fun c =>
      { kind := "secret-detected", path := some field, line := some (i + 1), detail := some c }) ++
  (if modelAuthored && (urlHostsIn text.toList).any (fun h => !hostAllowed h links) then
    [{ kind := "url-not-allowed", path := some field }]
  else []) ++
  (if modelAuthored && hasEncodedRun text.toList then [{ kind := "encoded-run", path := some field }] else [])

/-- The reasons of the commit message and the pull request's title and body. -/
def textReasons (m : Manifest) (spec : Spec) (modelAuthored : Bool) (ev : Evidence) : List Reason :=
  fieldReasons spec modelAuthored ev "message" m.message ++ fieldReasons spec modelAuthored ev "pr.title" m.title ++
    fieldReasons spec modelAuthored ev "pr.body" m.body

/-- Every reason of a staged write, in the order the TypeScript gate pushes them. -/
def reasons (m : Manifest) (spec : Spec) (modelAuthored : Bool) (ev : Evidence) : List Reason :=
  manifestReasons m spec ev ++ entriesReasons spec modelAuthored ev [] m.entries ++ textReasons m spec modelAuthored ev

/-- `stagedWriteGate(manifest, spec, modelAuthored, evidence)`. -/
def gate (m : Manifest) (spec : Spec) (modelAuthored : Bool) (ev : Evidence) : Verdict :=
  match reasons m spec modelAuthored ev with
  | [] => .accept
  | rs => .reject rs

/-! ### Theorems -/

theorem gate_eq (m : Manifest) (spec : Spec) (ma : Bool) (ev : Evidence) :
    gate m spec ma ev = if reasons m spec ma ev = [] then .accept else .reject (reasons m spec ma ev) := by
  unfold gate
  split <;> simp_all

/-- Every reason a staged write produces is in the gate's one result, and any reason rejects. -/
theorem reject_of_reason {m : Manifest} {spec : Spec} {ma : Bool} {ev : Evidence} {r : Reason}
    (h : r ∈ reasons m spec ma ev) : gate m spec ma ev = .reject (reasons m spec ma ev) := by
  rw [gate_eq]
  have : reasons m spec ma ev ≠ [] := List.ne_nil_of_mem h
  simp [this]

/-- The reasons of the entry at position `i`, checked against the paths before it, sit in order in the entries'
reasons. -/
theorem entryReasons_infix (spec : Spec) (ma : Bool) (ev : Evidence) :
    ∀ (entries : List Entry) (seen : List String) (i : Nat) (h : i < entries.length),
      entryReasons spec ma ev (seen ++ (entries.take i).map (·.path)) entries[i] <:+:
        entriesReasons spec ma ev seen entries
  | [], _, _, h => by simp at h
  | e :: es, seen, 0, _ => by
    simp only [entriesReasons, List.take_zero, List.map_nil, List.append_nil, List.getElem_cons_zero]
    exact (List.prefix_append _ _).isInfix
  | e :: es, seen, i + 1, h => by
    have ih := entryReasons_infix spec ma ev es (seen ++ [e.path]) i (by simpa using h)
    simp only [entriesReasons, List.take_succ_cons, List.map_cons, List.getElem_cons_succ]
    have heq : seen ++ e.path :: List.map (·.path) (List.take i es) =
        seen ++ [e.path] ++ List.map (·.path) (List.take i es) := by simp
    rw [heq]
    exact ih.trans (List.suffix_append _ _).isInfix

/--
If any entry fails any check, the staged-write gate rejects the whole manifest, and its one result holds every reason
of every entry, each entry's reasons in order (FD-AGT-017).
-/
theorem reject_whole_manifest (m : Manifest) (spec : Spec) (ma : Bool) (ev : Evidence) (i : Nat)
    (hi : i < m.entries.length)
    (hfail : entryReasons spec ma ev ((m.entries.take i).map (·.path)) m.entries[i] ≠ []) :
    ∃ rs, gate m spec ma ev = .reject rs ∧
      ∀ j (hj : j < m.entries.length),
        entryReasons spec ma ev ((m.entries.take j).map (·.path)) m.entries[j] <:+: rs := by
  have hall : ∀ j (hj : j < m.entries.length),
      entryReasons spec ma ev ((m.entries.take j).map (·.path)) m.entries[j] <:+: reasons m spec ma ev := by
    intro j hj
    have h := entryReasons_infix spec ma ev m.entries [] j hj
    simp only [List.nil_append] at h
    unfold reasons
    exact h.trans (List.infix_append _ _ _)
  obtain ⟨r, hr⟩ := List.exists_mem_of_ne_nil _ hfail
  exact ⟨_, reject_of_reason ((hall i hi).subset hr), hall⟩

/-- The gate accepts exactly when no check produces a reason. -/
theorem accept_iff (m : Manifest) (spec : Spec) (ma : Bool) (ev : Evidence) :
    gate m spec ma ev = .accept ↔ reasons m spec ma ev = [] := by
  rw [gate_eq]
  split <;> simp_all

/-- A path the spec protects from a model-authored write: under `runs/`, `infra/` or `.github/workflows/`, or with
file name `wrangler.jsonc`, comparing without regard to letter case. -/
def protectedBySpec (path : String) : Prop :=
  "runs/".toList <+: lower path.toList ∨ "infra/".toList <+: lower path.toList ∨
    ".github/workflows/".toList <+: lower path.toList ∨ fileName path = "wrangler.jsonc".toList

theorem modelDenied_of_protected {path : String} (h : protectedBySpec path) : modelDenied path = true := by
  unfold protectedBySpec at h
  unfold modelDenied under
  rcases h with h | h | h | h <;> simp_all [List.isPrefixOf_iff_prefix]

theorem protected_mem_pathReasons {spec : Spec} {seen : List String} {e : Entry} (h : modelDenied e.path = true) :
    ({ kind := "protected-path", path := some e.path } : Reason) ∈ pathReasons spec true seen e := by
  unfold pathReasons
  simp [h]

/--
A model-authored staged write that touches a path under `runs/`, `infra/` or `.github/workflows/`, or a file named
`wrangler.jsonc`, in any letter case, is rejected with a `protected-path` reason for that entry, whatever the recipe's
opt-ins (FD-AGT-020).
-/
theorem model_authored_protected_paths (m : Manifest) (spec : Spec) (ev : Evidence) (e : Entry)
    (he : e ∈ m.entries) (hp : protectedBySpec e.path) :
    ∃ rs, gate m spec true ev = .reject rs ∧ ({ kind := "protected-path", path := some e.path } : Reason) ∈ rs := by
  obtain ⟨i, hi, rfl⟩ := List.getElem_of_mem he
  have hmem := protected_mem_pathReasons (spec := spec) (seen := (m.entries.take i).map (·.path))
    (modelDenied_of_protected hp)
  have hin : ({ kind := "protected-path", path := some m.entries[i].path } : Reason) ∈
      entryReasons spec true ev ((m.entries.take i).map (·.path)) m.entries[i] := by
    unfold entryReasons
    exact List.mem_append_left _ hmem
  obtain ⟨rs, hg, hall⟩ := reject_whole_manifest m spec true ev i hi (List.ne_nil_of_mem hin)
  exact ⟨rs, hg, (hall i hi).subset hin⟩

/-- No accepted model-authored staged write touches a protected path (FD-AGT-020). -/
theorem accepted_model_authored_avoids_protected (m : Manifest) (spec : Spec) (ev : Evidence)
    (h : gate m spec true ev = .accept) : ∀ e ∈ m.entries, ¬ protectedBySpec e.path := by
  intro e he hp
  obtain ⟨rs, hg, _⟩ := model_authored_protected_paths m spec ev e he hp
  rw [h] at hg
  cases hg

/-! ### The applier's call order -/

/-- A call the `pr.propose` applier makes: a gate run, a read of the control plane's records, or a GitHub call. -/
inductive Call where
  | gate
  | records (name : String)
  | github (name : String) (writes : Bool)
  deriving DecidableEq, Repr

/-- Whether a call reaches GitHub. -/
def Call.isGithub : Call → Bool
  | .github _ _ => true
  | _ => false

/-- Whether a call writes to GitHub. -/
def Call.isGithubWrite : Call → Bool
  | .github _ w => w
  | _ => false

/-- What decides the applier's path: the payload decodes, the run has a `writeback` block, it declares a model call
site, the first and second gate verdicts, the line-scoped paths, the branch checks, the branch's existing head, human
commits on it, the entries and an open pull request. -/
structure ApplyFacts where
  decodes : Bool
  hasWriteback : Bool
  declaresModel : Bool
  first : Verdict
  lineScoped : List String
  second : Verdict
  branchPrefixed : Bool
  isDefaultBranch : Bool
  branchProtected : Bool
  existing : Bool
  humanCommits : Bool
  entries : Nat
  openPull : Bool

/-- The gate's final verdict: the first, or the second when the first rejects on a line of a manifest file. -/
def ApplyFacts.final (f : ApplyFacts) : Verdict :=
  match f.first with
  | .accept => .accept
  | .reject _ => if f.lineScoped.isEmpty then f.first else f.second

/-- The reads of the control plane's records, then the first gate run (applier.ts `modelAuthorship`,
`gateStagedWrite`). -/
def preCalls (f : ApplyFacts) : List Call :=
  (if f.declaresModel then [] else [.records "modelCalls"]) ++
    [.records "blobs", .records "issuedCredentials", .gate]

/-- The base-commit reads and the second gate run, when the first verdict rejects on a line of a manifest file. -/
def regateCalls (f : ApplyFacts) : List Call :=
  match f.first with
  | .accept => []
  | .reject _ => if f.lineScoped.isEmpty then [] else f.lineScoped.map (fun _ => .github "fileAt" false) ++ [.gate]

/-- The calls after a branch check passes: blobs, tree, commit, ref and pull request. -/
def writeCalls (f : ApplyFacts) : List Call :=
  [.github "refSha" false] ++
    (if f.existing then [.github "commitsSince" false] else []) ++
    (if f.existing && f.humanCommits then []
    else
      List.replicate f.entries (.github "createBlob" true) ++
        [.github "commit" false, .github "createTree" true, .github "createCommit" true,
          .github (if f.existing then "updateRef" else "createRef") true, .github "openPull" false] ++
        (if f.openPull then [.github "updatePull" true] else [.github "createPull" true]) ++
        [.github "addLabels" true])

/-- The calls once the final verdict is known: none on a rejection, else the branch checks and the writes. -/
def acceptedCalls (f : ApplyFacts) : List Call :=
  match f.final with
  | .reject _ => []
  | .accept =>
    [.github "defaultBranch" false] ++
      (if f.branchPrefixed && !f.isDefaultBranch then [.github "branchProtected" false] else []) ++
      (if !f.branchPrefixed || f.isDefaultBranch || f.branchProtected then [] else writeCalls f)

/-- The calls `applyPrPropose` makes on one `pr.propose` row, in order. -/
def applierCalls (f : ApplyFacts) : List Call :=
  if !f.decodes || !f.hasWriteback then [] else preCalls f ++ regateCalls f ++ acceptedCalls f

theorem preCalls_not_github (f : ApplyFacts) : ∀ c ∈ preCalls f, c.isGithub = false := by
  have h : (preCalls f).all (fun c => !c.isGithub) = true := by
    unfold preCalls; cases f.declaresModel <;> rfl
  intro c hc
  simpa using List.all_eq_true.mp h c hc

theorem gate_mem_preCalls (f : ApplyFacts) : Call.gate ∈ preCalls f := by
  unfold preCalls; cases f.declaresModel <;> simp

theorem regateCalls_not_write (f : ApplyFacts) : ∀ c ∈ regateCalls f, c.isGithubWrite = false := by
  intro c hc
  unfold regateCalls at hc
  split at hc
  · simp at hc
  · split at hc
    · simp at hc
    · simp only [List.mem_append, List.mem_map, List.mem_singleton] at hc
      rcases hc with ⟨_, _, rfl⟩ | rfl <;> rfl

/--
When the drainer calls `apply` on a `pr.propose` row, the applier runs `stagedWriteGate` on the row's manifest before
any GitHub call (FD-AGT-016).
-/
theorem applier_gates_before_github (f : ApplyFacts) (i : Nat) (c : Call)
    (hc : (applierCalls f)[i]? = some c) (hg : c.isGithub = true) :
    ∃ j < i, (applierCalls f)[j]? = some Call.gate := by
  by_cases hd : (!f.decodes || !f.hasWriteback) = true
  · simp [applierCalls, hd] at hc
  · have heq : applierCalls f = preCalls f ++ (regateCalls f ++ acceptedCalls f) := by
      simp only [applierCalls, hd, List.append_assoc]; rfl
    rw [heq] at hc ⊢
    obtain ⟨j, hj, hjv⟩ := List.getElem_of_mem (gate_mem_preCalls f)
    by_cases hi : i < (preCalls f).length
    · rw [List.getElem?_append_left hi] at hc
      have := preCalls_not_github f c (List.mem_of_getElem? hc)
      simp [this] at hg
    · refine ⟨j, by omega, ?_⟩
      rw [List.getElem?_append_left hj, List.getElem?_eq_getElem hj, hjv]

/-- The applier makes no GitHub write unless the gate's final verdict accepts (FD-AGT-016). -/
theorem applier_writes_only_on_accept (f : ApplyFacts) (c : Call) (hc : c ∈ applierCalls f)
    (hw : c.isGithubWrite = true) : f.final = .accept := by
  by_cases hd : (!f.decodes || !f.hasWriteback) = true
  · simp [applierCalls, hd] at hc
  · simp only [applierCalls, hd, Bool.false_eq_true, ite_false, List.mem_append] at hc
    rcases hc with (hc | hc) | hc
    · have := preCalls_not_github f c hc
      cases c <;> simp_all [Call.isGithub, Call.isGithubWrite]
    · simp [regateCalls_not_write f c hc] at hw
    · unfold acceptedCalls at hc
      cases hf : f.final with
      | accept => rfl
      | reject _ => simp [hf] at hc

end FdFormal.StagedWrite
