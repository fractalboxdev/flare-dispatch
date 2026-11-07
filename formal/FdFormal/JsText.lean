-- The JavaScript string semantics the staged-write gate relies on, over `List Char`: `toLowerCase`, `split`, UTF-16
-- length, the regular expressions of `packages/agentic/src/staged-write/scan.ts` and the WHATWG host of an `http` or
-- `https` URL. A JavaScript string is a sequence of UTF-16 code units; every function here takes Unicode scalar
-- values and agrees with JavaScript on well-formed strings, except where a docstring names a narrower domain. The
-- differential generator (`packages/agentic/test/diff/`) draws its inputs from that domain.
namespace FdFormal.JsText

/-- ASCII `[A-Za-z0-9_]`, the `\w` and `\b` word characters of a regular expression without the `u` flag. -/
def isWord (c : Char) : Bool := c.isAlphanum || c == '_'

/-- JavaScript's `\s`: the white space and line terminator code points. -/
def isJsSpace (c : Char) : Bool :=
  let n := c.toNat
  n == 9 || n == 10 || n == 11 || n == 12 || n == 13 || n == 32 || n == 0xA0 || n == 0x1680 ||
    (0x2000 ≤ n && n ≤ 0x200A) || n == 0x2028 || n == 0x2029 || n == 0x202F || n == 0x205F ||
    n == 0x3000 || n == 0xFEFF

/-- A line terminator, which `.` in a regular expression without the `s` flag does not match. -/
def isLineTerminator (n : Nat) : Bool := n == 10 || n == 13 || n == 0x2028 || n == 0x2029

/--
`String.prototype.toLowerCase` of one code point, on ASCII and on the non-ASCII letters the generator draws:
`É`, `K` (KELVIN SIGN, lower-cased to ASCII `k`), `Å` (ANGSTROM SIGN) and `İ` (lower-cased to two code points).
Every other code point the generator draws (`é`, `ß`, `å`, an astral emoji) is its own lower case.
-/
def lowerChar (c : Char) : List Char :=
  if 'A' ≤ c ∧ c ≤ 'Z' then [Char.ofNat (c.toNat + 32)]
  else if c = 'É' then ['é']
  else if c = 'K' then ['k']
  else if c = 'Å' then ['å']
  else if c = 'İ' then ['i', '̇']
  else [c]

/-- `toLowerCase` of a string, code point by code point. -/
def lower (s : List Char) : List Char := s.flatMap lowerChar

/-- ASCII lower case, which the WHATWG host parser and the case-insensitive scheme match apply. -/
def lowerAscii (c : Char) : Char := if 'A' ≤ c ∧ c ≤ 'Z' then Char.ofNat (c.toNat + 32) else c

/-- `s.split(sep)` for a one-character separator. -/
def splitOn (sep : Char) : List Char → List (List Char)
  | [] => [[]]
  | c :: cs =>
    if c = sep then [] :: splitOn sep cs
    else match splitOn sep cs with
      | [] => [[c]]
      | s :: ss => (c :: s) :: ss

/-- The UTF-16 code units of a string. -/
def utf16 (s : List Char) : List Nat :=
  s.flatMap fun c =>
    let v := c.toNat
    if v < 0x10000 then [v] else [0xD800 + (v - 0x10000) / 0x400, 0xDC00 + (v - 0x10000) % 0x400]

/-- `.length` of a JavaScript string. -/
def jsLength (s : List Char) : Nat := (utf16 s).length

/-- The length of the longest prefix whose characters all satisfy `p`. -/
def runLen (p : Char → Bool) : List Char → Nat
  | [] => 0
  | c :: cs => if p c then runLen p cs + 1 else 0

/-- Whether a match starting after `prev` sits on a word boundary, for a pattern that starts with a word character. -/
def boundaryBefore : Option Char → Bool
  | none => true
  | some c => !isWord c

/-- Whether a match ending before `next` sits on a word boundary, for a pattern that ends with a word character. -/
def boundaryAfter : Option Char → Bool
  | none => true
  | some c => !isWord c

/-- `pattern.test(s)` for a pattern without the `g` flag: some start position, with its previous character, matches. -/
def existsAt (f : Option Char → List Char → Bool) : Option Char → List Char → Bool
  | prev, [] => f prev []
  | prev, c :: cs => f prev (c :: cs) || existsAt f (some c) cs

/-- `[A-Z0-9]`. -/
def isUpperDigit (c : Char) : Bool := c.isUpper || c.isDigit

/-- `\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}` at one position. -/
def ghToken (prev : Option Char) (s : List Char) : Bool :=
  boundaryBefore prev &&
    ["ghp_", "gho_", "ghs_", "ghu_", "ghr_"].any (fun p => p.toList.isPrefixOf s) &&
    decide (runLen Char.isAlphanum (s.drop 4) ≥ 20)

/-- `\bgithub_pat_[A-Za-z0-9_]{20,}` at one position. -/
def ghPat (prev : Option Char) (s : List Char) : Bool :=
  boundaryBefore prev && "github_pat_".toList.isPrefixOf s && decide (runLen isWord (s.drop 11) ≥ 20)

/-- `\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b` at one position. -/
def awsKey (prev : Option Char) (s : List Char) : Bool :=
  boundaryBefore prev && ["AKIA", "ASIA", "ABIA", "ACCA"].any (fun p => p.toList.isPrefixOf s) &&
    decide (runLen isUpperDigit (s.drop 4) ≥ 16) && boundaryAfter (s.drop 20).head?

/-- `(?:[A-Z0-9]+ )*PRIVATE KEY-----`: a run of `[A-Z0-9]` ends only where the next character is not one, so only the
whole run can be followed by the space. `fuel` bounds the groups by the input length. -/
def pkRest : Nat → List Char → Bool
  | 0, _ => false
  | fuel + 1, s =>
    "PRIVATE KEY-----".toList.isPrefixOf s ||
      (let n := runLen isUpperDigit s
       decide (n > 0) && (s.drop n).head? == some ' ' && pkRest fuel (s.drop (n + 1)))

/-- `-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----` at one position. -/
def privateKey (_prev : Option Char) (s : List Char) : Bool :=
  "-----BEGIN ".toList.isPrefixOf s && pkRest (s.length + 1) (s.drop 11)

/-- `\bxox[abposr]-[A-Za-z0-9-]{10,}` at one position. -/
def slackToken (prev : Option Char) (s : List Char) : Bool :=
  boundaryBefore prev && "xox".toList.isPrefixOf s &&
    match s.drop 3 with
    | c :: '-' :: rest => "abposr".toList.contains c &&
        decide (runLen (fun c => c.isAlphanum || c == '-') rest ≥ 10)
    | _ => false

/-- `[A-Za-z0-9_-]`. -/
def isJwtChar (c : Char) : Bool := c.isAlphanum || c == '_' || c == '-'

/-- `\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}` at one position; `.` is outside the class,
so each run is the whole run. -/
def jwt (prev : Option Char) (s : List Char) : Bool :=
  boundaryBefore prev && "eyJ".toList.isPrefixOf s &&
    (let a := s.drop 3
     let n1 := runLen isJwtChar a
     decide (n1 ≥ 8) &&
       match a.drop n1 with
       | '.' :: b => "eyJ".toList.isPrefixOf b &&
           (let b' := b.drop 3
            let n2 := runLen isJwtChar b'
            decide (n2 ≥ 8) &&
              match b'.drop n2 with
              | '.' :: c => decide (runLen isJwtChar c ≥ 8)
              | _ => false)
       | _ => false)

/-- Whether `needle` occurs in `s`, which is `s.includes(needle)` on well-formed strings. -/
def contains (s needle : List Char) : Bool :=
  existsAt (fun _ t => needle.isPrefixOf t) none s

/-- `credentialIn(line, issued)`: the name of the first credential pattern the line matches, then any issued
credential of at least 8 UTF-16 code units the line contains, else none (FD-AGT-029). -/
def credentialIn (line : List Char) (issued : List String) : Option String :=
  if existsAt ghToken none line then some "github-token"
  else if existsAt ghPat none line then some "github-token"
  else if existsAt awsKey none line then some "aws-access-key-id"
  else if existsAt privateKey none line then some "private-key"
  else if existsAt slackToken none line then some "slack-token"
  else if existsAt jwt none line then some "json-web-token"
  else if issued.any (fun c => decide (jsLength c.toList ≥ 8) && contains line c.toList) then
    some "issued-credential"
  else none

/-- `/[A-Za-z0-9+/_-]{64,}/.test(text)` (FD-AGT-033). -/
def hasEncodedRun (s : List Char) : Bool :=
  existsAt (fun _ t => decide (runLen (fun c => c.isAlphanum || c == '+' || c == '/' || c == '_' || c == '-') t ≥ 64))
    none s

/-- `text.split(/\r?\n/)`: split on LF, dropping the CR right before each LF. -/
def linesOf (s : List Char) : List (List Char) :=
  let segs := splitOn '\n' s
  let n := segs.length
  (segs.zipIdx.map fun (seg, i) => if i + 1 < n && seg.getLast? == some '\r' then seg.dropLast else seg)

/-- `addedLines(next, base)`: the 1-based numbers and texts of the lines of `next` that `base` does not hold, a
repeated line counting once per extra occurrence. -/
def addedLines (next : List Char) (base : Option (List Char)) : List (Nat × List Char) :=
  let rec go : List (List Char) → List (List Char) → Nat → List (Nat × List Char)
    | _, [], _ => []
    | remaining, l :: ls, i =>
      if remaining.contains l then go (remaining.erase l) ls (i + 1)
      else (i, l) :: go remaining ls (i + 1)
  go (match base with | none => [] | some b => linesOf b) (linesOf next) 1

/-! ### The host of a URL -/

/-- The `[^\s<>"'`)\]]` class of the URL pattern. -/
def urlChar (c : Char) : Bool := !(isJsSpace c || "<>\"'`)]".toList.contains c)

/-- The length of `https://` or `http://` at the start, matched without regard to ASCII case. -/
def schemeLen (s : List Char) : Option Nat :=
  let l := (s.take 8).map lowerAscii
  if "https://".toList.isPrefixOf l then some 8
  else if "http://".toList.isPrefixOf l then some 7
  else none

/-- `text.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]]+/gi)`: each match as its scheme length and its text, searching on from
the end of the previous match. `fuel` bounds the steps by the input length. -/
def urlMatches : Nat → Option Char → List Char → List (Nat × List Char)
  | 0, _, _ => []
  | _ + 1, _, [] => []
  | fuel + 1, prev, c :: cs =>
    let s := c :: cs
    match (if boundaryBefore prev then schemeLen s else none) with
    | some k =>
      let rest := s.drop k
      let n := runLen urlChar rest
      if n ≥ 1 then (k, s.take (k + n)) :: urlMatches fuel ((rest.take n).getLast?) (rest.drop n)
      else urlMatches fuel (some c) cs
    | none => urlMatches fuel (some c) cs

/-- The value of a string of digits in radix `r`, or none when a character is not a digit of that radix. -/
def parseRadix (r : Nat) (s : List Char) : Option Nat :=
  s.foldl (fun acc c =>
    acc.bind fun v =>
      let d := if c.isDigit then some (c.toNat - '0'.toNat)
        else if 'a' ≤ c ∧ c ≤ 'f' then some (c.toNat - 'a'.toNat + 10)
        else if 'A' ≤ c ∧ c ≤ 'F' then some (c.toNat - 'A'.toNat + 10)
        else none
      d.bind fun d => if d < r then some (v * r + d) else none) (some 0)

/-- The WHATWG IPv4 number parser. -/
def ipv4Number (s : List Char) : Option Nat :=
  if s.isEmpty then none
  else
    let (r, t) :=
      match s with
      | '0' :: x :: rest => if x = 'x' ∨ x = 'X' then (16, rest) else (8, x :: rest)
      | _ => (10, s)
    if t.isEmpty then some 0 else parseRadix r t

/-- The WHATWG ends-in-a-number check. -/
def endsInNumber (host : List Char) : Bool :=
  let parts := splitOn '.' host
  let parts := if parts.getLast? == some [] && parts.length > 1 then parts.dropLast else parts
  match parts.getLast? with
  | none => false
  | some last => (!last.isEmpty && last.all Char.isDigit) || (ipv4Number last).isSome

/-- Dotted-decimal serialization of an IPv4 address. -/
def ipv4Serialize (v : Nat) : List Char :=
  (toString (v / 16777216 % 256) ++ "." ++ toString (v / 65536 % 256) ++ "." ++ toString (v / 256 % 256) ++ "." ++
    toString (v % 256)).toList

/-- The WHATWG IPv4 parser, serialized. -/
def ipv4 (host : List Char) : Option (List Char) :=
  let parts := splitOn '.' host
  let parts := if parts.getLast? == some [] && parts.length > 1 then parts.dropLast else parts
  if parts.length > 4 then none
  else
    match parts.mapM ipv4Number with
    | none => none
    | some nums =>
      let n := nums.length
      let init := nums.dropLast
      let last := nums.getLast?.getD 0
      if init.any (· > 255) then none
      else if last ≥ 256 ^ (5 - n) then none
      else
        let v := (init.zipIdx.foldl (fun acc (x, i) => acc + x * 256 ^ (3 - i)) 0) + last
        some (ipv4Serialize v)

/-- A forbidden domain code point of the WHATWG URL standard, among ASCII. -/
def forbiddenDomain (c : Char) : Bool :=
  c.toNat ≤ 0x20 || c.toNat == 0x7F || "#%/:<>?@[\\]^|".toList.contains c

/--
`new URL(match).hostname`, or `""` where the constructor throws, for a match whose scheme is `scheme` characters long.
It equals the WHATWG parser on authorities whose host holds ASCII letters, digits, `-` and `.` only, after any
userinfo and before any port; a percent sign, a bracket or a non-ASCII code point in the host is outside the domain.
-/
def hostOf (scheme : Nat) (m : List Char) : List Char :=
  let m := (m.reverse.dropWhile (fun c => c.toNat ≤ 0x20)).reverse
  let r := (m.drop scheme).dropWhile (fun c => c == '/' || c == '\\')
  let auth := r.takeWhile (fun c => !(c == '/' || c == '\\' || c == '?' || c == '#'))
  let hasAt := auth.contains '@'
  let hp := if hasAt then (auth.reverse.takeWhile (· != '@')).reverse else auth
  if hasAt && hp.isEmpty then []
  else
    let h := hp.takeWhile (· != ':')
    let port := (hp.dropWhile (· != ':')).drop 1
    let hasPort := hp.contains ':'
    if h.isEmpty then []
    else if hasPort && !port.all Char.isDigit then []
    else if hasPort && !port.isEmpty && (parseRadix 10 port).getD 0 > 65535 then []
    else
      let l := h.map lowerAscii
      if l.any forbiddenDomain then []
      else if endsInNumber l then (ipv4 l).getD []
      else l

/-- `urlHostsIn(text)`: the lower-cased host of every URL match, `""` for one that does not parse. -/
def urlHostsIn (s : List Char) : List (List Char) :=
  (urlMatches (s.length + 1) none s).map fun (k, m) => hostOf k m

/-- `hostAllowed(host, allowlist)`: a non-empty host that is in the allowlist, compared lower-cased (FD-AGT-031,
FD-AGT-032). An empty entry admits no host. -/
def hostAllowed (host : List Char) (allowlist : List String) : Bool :=
  !host.isEmpty && allowlist.any fun e => host == lower e.toList

/-! ### Path globs -/

/-- One token of a path glob: a literal UTF-16 code unit, `*`, `?`, `**` or `**/`. -/
inductive GlobTok where
  | lit (u : Nat)
  | star
  | one
  | globstar
  | dirs
  deriving DecidableEq, Repr

/-- `globRegex`'s reading of a glob, over UTF-16 code units: `**/` is `(?:.*/)?`, `**` is `.*`, `*` is `[^/]*`, `?` is
`[^/]` and every other code unit is itself. -/
def compileGlob : List Nat → List GlobTok
  | 42 :: 42 :: 47 :: rest => .dirs :: compileGlob rest
  | 42 :: 42 :: rest => .globstar :: compileGlob rest
  | 42 :: rest => .star :: compileGlob rest
  | 63 :: rest => .one :: compileGlob rest
  | u :: rest => .lit u :: compileGlob rest
  | [] => []

/-- The weight that orders the matcher's recursion: `**/` unfolds into `.*` and `/`. -/
def globWeight : List GlobTok → Nat
  | [] => 0
  | .dirs :: ts => 3 + globWeight ts
  | _ :: ts => 1 + globWeight ts

/-- Whether the anchored regular expression of the tokens matches the whole sequence of code units. -/
def globMatch : List GlobTok → List Nat → Bool
  | [], s => s.isEmpty
  | .lit _ :: _, [] => false
  | .lit u :: ts, c :: s => c == u && globMatch ts s
  | .one :: _, [] => false
  | .one :: ts, c :: s => c != 47 && globMatch ts s
  | .star :: ts, [] => globMatch ts []
  | .star :: ts, c :: s => globMatch ts (c :: s) || (c != 47 && globMatch (.star :: ts) s)
  | .globstar :: ts, [] => globMatch ts []
  | .globstar :: ts, c :: s => globMatch ts (c :: s) || (!isLineTerminator c && globMatch (.globstar :: ts) s)
  | .dirs :: ts, s => globMatch ts s || globMatch (.globstar :: .lit 47 :: ts) s
termination_by ts s => s.length + globWeight ts
decreasing_by all_goals (simp only [globWeight, List.length_cons]; omega)

/-- `inAllowlist(path, allowlist)`: some glob of the allowlist matches the whole path. -/
def inAllowlist (path : List Char) (allowlist : List String) : Bool :=
  allowlist.any fun g => globMatch (compileGlob (utf16 g.toList)) (utf16 path)

end FdFormal.JsText
