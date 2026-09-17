# Static audit: every exported sim/game symbol used in a module must be
# imported or declared there. The inline smoke harness shares one scope and
# masks missing imports; real ES modules (and the single-file bundle's module
# registry) throw ReferenceError — this once bricked the shipped game loop
# (engine.js used cellOf without importing it).
# Usage: .venv/Scripts/python audit_imports.py  (exit 1 on suspects)
import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "client" / "src"


def audit() -> list:
    files = list(SRC.rglob("*.js"))
    exports = {}
    for f in files:
        src = f.read_text(encoding="utf-8")
        names = set(re.findall(r"export\s+(?:async\s+)?(?:function|const|let)\s+(\w+)", src))
        for block in re.findall(r"export\s*\{([^}]*)\}", src):
            for part in block.split(","):
                part = part.strip().split(" as ")[-1].strip()
                if part:
                    names.add(part)
        exports[f.stem] = names
    all_exports = set().union(*exports.values())

    problems = []
    for f in files:
        src = f.read_text(encoding="utf-8")
        imported = set()
        for block, _mod in re.findall(r"import\s*\{([^}]*)\}\s*from\s*'([^']*)'", src):
            for part in block.split(","):
                part = part.strip().split(" as ")[-1].strip()
                if part:
                    imported.add(part)
        declared = set(re.findall(
            r"^(?:export\s+)?(?:async\s+)?(?:function|const|let)\s+(\w+)", src, re.M))
        declared |= set(re.findall(r"^\s+(?:function|const|let)\s+(\w+)", src, re.M))
        body = re.sub(r"//[^\n]*", "", src)
        body = re.sub(r"/\*[\s\S]*?\*/", "", body)
        for name in sorted(all_exports):
            if name in imported or name in declared:
                continue
            for m in re.finditer(r"(?<![\w$.])" + re.escape(name) + r"\s*\(", body):
                line = body[:m.start()].count("\n") + 1
                problems.append(
                    f"{f.relative_to(SRC)}:{line}: uses {name}() but never imports/declares it")
                break
    return problems


def main() -> int:
    problems = audit()
    for p in problems:
        print(p)
    print("missing-import suspects:", len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
