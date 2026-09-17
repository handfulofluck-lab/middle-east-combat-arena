# Single-file builder: walks the static import graph from src/main.js,
# converts every ES module into a registered factory in a tiny __require
# registry (CommonJS-style), inlines game.json + maps as literals, and emits
# dist/MCA.html by inlining the bundle into index.html's markup/CSS.
# Stdlib only. Fails loudly on any import/export form it doesn't understand.
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIENT = ROOT / "client"
DIST = ROOT / "dist"
ENTRY = "src/main.js"
# maps are discovered from client/maps/manifest.json (id list, in menu order);
# each id must have a matching client/maps/<id>.json
MAPS_DIR = CLIENT / "maps"

IMPORT_RE = re.compile(r"import\s+([\s\S]*?)\s+from\s+'([^']+)';")
DYNAMIC_RE = re.compile(r"\bimport\s*\(")
EXPORT_FROM_RE = re.compile(r"^export\s*\{([\s\S]*?)\}\s*from\s*'([^']+)';", re.M)
EXPORT_STAR_RE = re.compile(r"^export\s*\*\s*from\s*'([^']+)';", re.M)
EXPORT_DECL_RE = re.compile(r"^export\s+(async function|function|const|let|class)\s+([A-Za-z_$][\w$]*)", re.M)


def fail(msg):
    print("BUILD ERROR:", msg)
    sys.exit(1)


def resolve(spec: str, from_mod: str) -> str:
    if not spec.startswith("."):
        fail(f"bare/non-relative import '{spec}' in {from_mod}")
    base = Path(from_mod).parent
    tgt = (base / spec).as_posix()
    # normalize ./ and ../
    parts = []
    for p in tgt.split("/"):
        if p in ("", "."):
            continue
        if p == "..":
            if not parts:
                fail(f"import escapes client root: '{spec}' in {from_mod}")
            parts.pop()
        else:
            parts.append(p)
    return "/".join(parts)


def transform(path: str, src: str) -> str:
    """Convert one ES module to a factory body. Returns the body source."""
    if DYNAMIC_RE.search(src):
        fail(f"dynamic import() in {path}")
    exported = []

    def sub_import(m):
        clause, spec = m.group(1).strip(), m.group(2)
        tgt = resolve(spec, path)
        if clause.startswith("{") and clause.endswith("}"):
            inner = clause[1:-1].strip()
            if not inner:
                fail(f"empty import clause in {path}: {m.group(0)!r}")
            # support 'a as b' aliasing -> a: b
            names = ", ".join(
                re.sub(r"(\w+)\s+as\s+(\w+)", r"\1: \2", n.strip())
                for n in inner.split(",") if n.strip())
            return f"const {{ {names} }} = __require('{tgt}');"
        mo = re.fullmatch(r"\*\s+as\s+(\w+)", clause)
        if mo:
            return f"const {mo.group(1)} = __require('{tgt}');"
        fail(f"unsupported import form in {path}: {m.group(0)!r}")

    def sub_export_from(m):
        names, spec = m.group(1), m.group(2)
        tgt = resolve(spec, path)
        lines = [f"var __re = __require('{tgt}');"]
        for n in names.split(","):
            n = n.strip()
            if not n:
                continue
            mo = re.fullmatch(r"(\w+)\s+as\s+(\w+)", n)
            local, out = (mo.group(1), mo.group(2)) if mo else (n, n)
            lines.append(f"exports.{out} = __re.{local};")
        return "\n".join(lines)

    def sub_export_star(m):
        tgt = resolve(m.group(1), path)
        return f"Object.assign(exports, __require('{tgt}'));"

    def sub_export_decl(m):
        exported.append(m.group(2))
        return f"{m.group(1)} {m.group(2)}"

    src = IMPORT_RE.sub(sub_import, src)
    src = EXPORT_FROM_RE.sub(sub_export_from, src)
    src = EXPORT_STAR_RE.sub(sub_export_star, src)
    src = EXPORT_DECL_RE.sub(sub_export_decl, src)

    # anything still resembling import/export is an unhandled form
    leftovers = [ln for ln in src.splitlines()
                 if re.match(r"^\s*(import|export)\b", ln)]
    if leftovers:
        fail(f"unhandled import/export syntax in {path}: {leftovers[0].strip()!r}")
    if exported:
        src += "\n" + "\n".join(f"exports.{n} = {n};" for n in exported) + "\n"
    return src


def patch_inline_data(src: str) -> str:
    begin = "// BUILD-INLINE-DATA-BEGIN"
    end = "// BUILD-INLINE-DATA-END"
    i, j = src.find(begin), src.find(end)
    if i < 0 or j < 0 or j < i:
        fail("BUILD-INLINE-DATA markers missing in src/main.js")
    replacement = (
        begin + "\n"
        "  return { data: __INLINE_DATA, maps: __INLINE_MAPS,\n"
        "    art: (typeof __INLINE_ART !== 'undefined' ? __INLINE_ART : {}),\n"
        "    unitart: (typeof __INLINE_UNITART !== 'undefined' ? __INLINE_UNITART : {}) };\n  "
    )
    return src[:i] + replacement + src[j:]


def collect_modules() -> dict:
    """Walk the import graph from ENTRY; returns {path: transformed_source}."""
    mods, stack = {}, [ENTRY]
    while stack:
        path = stack.pop()
        if path in mods:
            continue
        f = CLIENT / path
        if not f.is_file():
            fail(f"module not found: {path}")
        raw = f.read_text(encoding="utf-8")
        body = transform(path, raw)
        if path == ENTRY:
            body = patch_inline_data(body)
        mods[path] = body
        for m in re.finditer(r"__require\('([^']+)'\)", body):
            stack.append(m.group(1))
    return mods


def js_literal(obj) -> str:
    s = json.dumps(obj, ensure_ascii=True)
    if "</script" in s.lower():
        fail("data literal contains </script>")
    return s


def build() -> Path:
    mods = collect_modules()
    data = json.loads((CLIENT / "data/game.json").read_text(encoding="utf-8"))
    manifest = json.loads((MAPS_DIR / "manifest.json").read_text(encoding="utf-8"))
    maps = {}
    for mid in manifest["maps"]:
        f = MAPS_DIR / f"{mid}.json"
        if not f.is_file():
            fail(f"manifest map '{mid}' has no {f.relative_to(CLIENT)}")
        maps[mid] = json.loads(f.read_text(encoding="utf-8"))
    # optional compressed artwork (tools/build_art.py): menu keyart, setup
    # backdrop, faction posters — base64 data-URIs
    art_file = CLIENT / "assets" / "art.json"
    art = json.loads(art_file.read_text(encoding="utf-8")) if art_file.is_file() else {}
    # optional unit/structure/FX sprite pack (tools/build_art.py)
    unitart_file = CLIENT / "assets" / "unitart.json"
    unitart = (json.loads(unitart_file.read_text(encoding="utf-8"))
               if unitart_file.is_file() else {})

    parts = [
        "// MCA single-file build — generated by tools/build_singlefile.py",
        "// Do not edit; rebuild instead. Source: client/src/.",
        f"const __INLINE_DATA = {js_literal(data)};",
        f"const __INLINE_MANIFEST = {js_literal(manifest)};",
        f"const __INLINE_MAPS = {js_literal(maps)};",
        f"const __INLINE_ART = {js_literal(art)};",
        f"const __INLINE_UNITART = {js_literal(unitart)};",
        "var __modules = {}; var __cache = {};",
        "function __require(p) {",
        "  if (__cache[p]) return __cache[p].exports;",
        "  var m = { exports: {} }; __cache[p] = m;",
        "  __modules[p](__require, m, m.exports);",
        "  return m.exports;",
        "}",
    ]
    for path in sorted(mods):
        parts.append(f"__modules[{json.dumps(path)}] = function (__require, module, exports) {{")
        parts.append(mods[path])
        parts.append("};")
    parts.append(f"__require('{ENTRY}');")
    bundle = "\n".join(parts)
    if "</script" in bundle.lower():
        fail("bundle contains </script>")
    if re.search(r"\bfetch\s*\(", bundle):
        fail("bundle still contains fetch()")
    if re.search(r"from '\.[^']*'", bundle):
        fail("bundle still contains relative import specifiers")

    html = (CLIENT / "index.html").read_text(encoding="utf-8")
    tag = '<script type="module" src="src/main.js"></script>'
    if tag not in html:
        fail("index.html module script tag not found")
    html = html.replace(tag, "<script>\n" + bundle + "\n</script>")
    # the game layer references no external assets; guard against any appearing
    for pat in ("<link", "<img", "url(", "@font-face", "http://", "https://"):
        if pat in html:
            fail(f"index.html references an external asset pattern: {pat!r}")

    DIST.mkdir(exist_ok=True)
    out = DIST / "MCA.html"
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size:,} bytes, {len(mods)} modules)")
    return out


if __name__ == "__main__":
    build()
