-- The `oracle` executable `lake build oracle` produces (specs/verification.md § V-DIFF): it reads one event per stdin
-- line, as JSON, and writes the model's answer for it as one JSON line on stdout. A line that does not decode answers
-- `{"_tag":"error","message":...}`.
--
-- With no argument it answers staged-write events: the gate's four arguments `manifest`, `spec`, `modelAuthored` and
-- `evidence`, with the base commit's texts as a `base` list of `{ path, text }`, answered with the gate's verdict.
--
-- `oracle placement` answers placement events: a `run` (`worker-deploy` or `sandbox-image`), its `publish` input, the
-- `trigger` class resolution reads (`kind`, with `protectedTag` for a tag push and `branch` and `protectedBranch` for a
-- push), the `deployBranch`, a re-run's `rerun` class and the `classInput`, the request's `labels`, `declaresClass`,
-- `confidentiality`, `deviceLocalInput` and `needsLocalModel`, the `profile`'s classes, `cloudOnly` and `localOnly`
-- predicates, `launcherKinds` and declared `constraints`, and the labels each executor kind advertises. The answer
-- holds the class `resolveClass` gives the request, the declared constraints and the request's labels, whether
-- `cloud-pinned` holds at that class, the eligible kinds at that class and the eligible kinds that place the request
-- (FdFormal.Placement).
import Lean.Data.Json
import FdFormal.StagedWrite
import FdFormal.Placement

open Lean FdFormal.StagedWrite

def field (j : Json) (k : String) : Except String Json := j.getObjVal? k

def str (j : Json) (k : String) : Except String String := do (← field j k).getStr?

def getBool (j : Json) (k : String) : Except String Bool := do (← field j k).getBool?

def nat (j : Json) (k : String) : Except String Nat := do (← field j k).getNat?

def strs (j : Json) (k : String) : Except String (List String) := do
  let a ← (← field j k).getArr?
  a.toList.mapM Json.getStr?

/-- An optional key: absent and `null` are none. -/
def opt (j : Json) (k : String) : Option Json :=
  match j.getObjVal? k with
  | .ok .null => none
  | .ok v => some v
  | .error _ => none

def optStr (j : Json) (k : String) : Except String (Option String) :=
  match opt j k with
  | none => pure none
  | some v => some <$> v.getStr?

def decodeEntry (j : Json) : Except String Entry := do
  pure { path := ← str j "path", mode := ← str j "mode", digest := ← str j "digest" }

def decodeManifest (j : Json) : Except String Manifest := do
  let pr ← field j "pr"
  let entries ← (← field j "entries").getArr?
  pure {
    branch := ← str j "branch"
    message := ← str j "message"
    title := ← str pr "title"
    body := ← str pr "body"
    entries := ← entries.toList.mapM decodeEntry }

def decodeSpec (j : Json) : Except String Spec := do
  pure {
    allowlist := ← strs j "allowlist"
    allowSensitivePaths := ← getBool j "allowSensitivePaths"
    allowWorkflows := ← getBool j "allowWorkflows"
    maxFiles := ← (match opt j "maxFiles" with | none => pure none | some v => some <$> v.getNat?)
    maxBytes := ← (match opt j "maxBytes" with | none => pure none | some v => some <$> v.getNat?)
    linkAllowlist := ← (match opt j "linkAllowlist" with
      | none => pure []
      | some v => do (← v.getArr?).toList.mapM Json.getStr?) }

def decodeBlob (j : Json) : Except String Blob := do
  pure { path := ← str j "path", digest := ← str j "digest", size := ← nat j "size", text := ← optStr j "text" }

def decodeBase (j : Json) : Except String (String × Option String) := do
  pure (← str j "path", ← optStr j "text")

def decodeEvidence (j : Json) : Except String Evidence := do
  pure {
    blobs := ← (← (← field j "blobs").getArr?).toList.mapM decodeBlob
    base := ← (← (← field j "base").getArr?).toList.mapM decodeBase
    issuedCredentials := ← strs j "issuedCredentials"
    githubHost := ← str j "githubHost" }

def encodeReason (r : Reason) : Json :=
  Json.mkObj <|
    [("kind", Json.str r.kind)] ++
      (match r.path with | some p => [("path", Json.str p)] | none => []) ++
      (match r.line with | some l => [("line", (l : Json))] | none => []) ++
      (match r.detail with | some d => [("detail", Json.str d)] | none => [])

def encodeVerdict : Verdict → Json
  | .accept => Json.mkObj [("_tag", "accept")]
  | .reject rs => Json.mkObj [("_tag", "reject"), ("reasons", Json.arr (rs.map encodeReason).toArray)]

def stagedWriteAnswer (j : Json) : Except String Json := do
  let v := gate (← decodeManifest (← field j "manifest")) (← decodeSpec (← field j "spec"))
    (← getBool j "modelAuthored") (← decodeEvidence (← field j "evidence"))
  pure (encodeVerdict v)

open FdFormal.Placement in
/-- A profile predicate, its key tested in the order `holds` tests it. -/
partial def decodePred (j : Json) : Except String Pred :=
  match opt j "class", opt j "label", opt j "trigger", opt j "undeclared_class", opt j "not", opt j "all" with
  | some c, _, _, _, _, _ => .cls <$> c.getStr?
  | _, some l, _, _, _, _ => .label <$> l.getStr?
  | _, _, some t, _, _, _ => .trigger <$> t.getStr?
  | _, _, _, some _, _, _ => pure .undeclaredClass
  | _, _, _, _, some p, _ => .not <$> decodePred p
  | _, _, _, _, _, some ps => do .all <$> (← ps.getArr?).toList.mapM decodePred
  | _, _, _, _, _, none => do .any <$> (← (← field j "any").getArr?).toList.mapM decodePred

def optBool (j : Json) (k : String) : Except String (Option Bool) :=
  match opt j k with
  | none => pure none
  | some v => some <$> v.getBool?

open FdFormal.Placement in
def decodeProfilePlacement (j : Json) : Except String ProfilePlacement := do
  let classes ← (← (← field j "classes").getArr?).toList.mapM fun c => do
    pure (← str c "name", ← strs c "cloudKinds", ← optBool c "deviceEligible")
  let declared ← (← (← field j "constraints").getArr?).toList.mapM fun c => do
    pure (← decodePred (← field c "holdsFor"), ← strs c "removes")
  pure {
    classes
    cloudOnly := ← decodePred (← field j "cloudOnly")
    localOnly := ← decodePred (← field j "localOnly")
    launcherKinds := ← strs j "launcherKinds"
    declared }

def strArr (xs : List String) : Json := Json.arr (xs.map Json.str).toArray

open FdFormal.Placement in
def placementAnswer (j : Json) : Except String Json := do
  let run ← str j "run"
  let publish ← getBool j "publish"
  let t ← field j "trigger"
  let kind ← str t "kind"
  let releaseTrigger := isReleaseTrigger kind ((← optBool t "protectedTag").getD false)
    ((← optStr t "branch").getD "") ((← optBool t "protectedBranch").getD false) (← optStr j "deployBranch")
  let cls := resolveClass run (← optStr j "rerun") releaseTrigger (laterClass run (← optStr j "classInput"))
  let (constraints, declaredLabels) := requestPlacement run publish
  let r : Request := {
    cls
    labels := ((← strs j "labels") ++ declaredLabels).eraseDups
    trigger := if kind == "tag-push" then some "tag-push" else none
    declaresClass := ← optBool j "declaresClass" }
  let p ← decodeProfilePlacement (← field j "profile")
  let advertised ← (← (← field j "advertised").getArr?).toList.mapM fun a => do
    pure (← str a "kind", ← strs a "labels")
  let advertisedBy (k : String) : List String := ((advertised.find? (·.1 == k)).map (·.2)).getD []
  let f := p.facts r ((← optStr j "confidentiality").getD "unclassified") (← getBool j "deviceLocalInput")
    (← getBool j "needsLocalModel")
  let eligibleKinds := eligible (p.classKinds cls) cls r.labels constraints f p.kinds (p.held r)
  pure <| Json.mkObj [
    ("class", Json.str cls),
    ("constraints", strArr constraints),
    ("labels", strArr r.labels),
    ("cloudPinned", Json.bool (cloudPinnedHolds cls r.labels constraints)),
    ("eligible", strArr eligibleKinds),
    ("placeable", strArr (placeableKinds eligibleKinds r.labels advertisedBy))]

def answer (respond : Json → Except String Json) (line : String) : Json :=
  match Json.parse line >>= respond with
  | .ok v => v
  | .error e => Json.mkObj [("_tag", "error"), ("message", Json.str e)]

partial def loop (respond : Json → Except String Json) (stdin : IO.FS.Stream) (stdout : IO.FS.Stream) : IO Unit := do
  let line ← stdin.getLine
  if line.isEmpty then return
  let line := String.ofList (line.toList.reverse.dropWhile Char.isWhitespace).reverse
  if line.isEmpty then loop respond stdin stdout
  else
    stdout.putStrLn (answer respond line).compress
    stdout.flush
    loop respond stdin stdout

def main (args : List String) : IO UInt32 := do
  match args with
  | [] => loop stagedWriteAnswer (← IO.getStdin) (← IO.getStdout); pure 0
  | ["placement"] => loop placementAnswer (← IO.getStdin) (← IO.getStdout); pure 0
  | _ => IO.eprintln "usage: oracle [placement]"; pure 2
