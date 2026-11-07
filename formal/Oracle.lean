-- The `oracle` executable `lake build oracle` produces (specs/verification.md § V-DIFF): it reads one staged-write
-- event per stdin line, as JSON, and writes the model's verdict for it as one JSON line on stdout. An event holds the
-- gate's four arguments: `manifest`, `spec`, `modelAuthored` and `evidence`, with the base commit's texts as a
-- `base` list of `{ path, text }`. A line that does not decode answers `{"_tag":"error","message":...}`.
import Lean.Data.Json
import FdFormal.StagedWrite

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

def answer (line : String) : Json :=
  let decoded : Except String Json := do
    let j ← Json.parse line
    let v := gate (← decodeManifest (← field j "manifest")) (← decodeSpec (← field j "spec"))
      (← getBool j "modelAuthored") (← decodeEvidence (← field j "evidence"))
    pure (encodeVerdict v)
  match decoded with
  | .ok v => v
  | .error e => Json.mkObj [("_tag", "error"), ("message", Json.str e)]

partial def loop (stdin : IO.FS.Stream) (stdout : IO.FS.Stream) : IO Unit := do
  let line ← stdin.getLine
  if line.isEmpty then return
  let line := String.ofList (line.toList.reverse.dropWhile Char.isWhitespace).reverse
  if line.isEmpty then loop stdin stdout
  else
    stdout.putStrLn (answer line).compress
    stdout.flush
    loop stdin stdout

def main : IO Unit := do
  loop (← IO.getStdin) (← IO.getStdout)
