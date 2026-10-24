import os, tempfile, glob, yaml

SRC = os.environ.get("OPENGREP_RULES_SRC") or os.path.join(tempfile.gettempdir(), "opengrep-rules")
DST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rules", "security")
CAP = 50

TARGETS = {
    "python.yaml": ({"python"}, ["python"]),
    "js-ts.yaml": ({"javascript", "typescript"}, ["javascript", "typescript"]),
    "java.yaml": ({"java"}, ["java"]),
    "go.yaml": ({"go"}, ["go"]),
    "c.yaml": ({"c"}, ["c"]),
    "csharp.yaml": ({"csharp"}, ["csharp"]),
    "php.yaml": ({"php"}, ["php"]),
    "bash.yaml": ({"bash"}, ["bash"]),
    "kotlin.yaml": ({"kotlin"}, ["kotlin"]),
    "swift.yaml": ({"swift"}, ["swift"]),
    "rust.yaml": ({"rust"}, ["rust"]),
    "dockerfile.yaml": ({"dockerfile"}, ["dockerfile"]),
}

def load_rules(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
    except Exception as e:
        print(f"  [skip] {path}: {type(e).__name__}")
        return []
    if not isinstance(data, dict) or not isinstance(data.get("rules"), list):
        return []
    return [r for r in data["rules"] if isinstance(r, dict)]

def tier(rule):
    md = rule.get("metadata") or {}
    return 1 if (md.get("cwe") or md.get("owasp") or md.get("category") == "security") else 2

def collect(langs, top_dirs):
    candidates = {}
    paths = []
    for ext in ("yaml", "yml"):
        paths.extend(glob.glob(os.path.join(SRC, "**", f"*.{ext}"), recursive=True))
    for path in paths:
        rel = os.path.relpath(path, SRC).replace("\\", "/")
        if rel.split("/")[0] not in top_dirs or "/correctness/" in rel:
            continue
        for rule in load_rules(path):
            rl = set(rule.get("languages") or [])
            rid = rule.get("id")
            if not rid or not rl or not rl.issubset(langs):
                continue
            if rule.get("severity") not in ("ERROR", "WARNING", "INFO"):
                continue
            candidates.setdefault(rid, (rule, rel))
    return candidates

for out_name, (langs, top_dirs) in TARGETS.items():
    candidates = collect(langs, top_dirs)
    t1 = {k: v for k, v in candidates.items() if tier(v[0]) == 1}
    t2 = {k: v for k, v in candidates.items() if tier(v[0]) == 2}
    picked, seen = [], set()

    def try_pick(pool):
        for rid in sorted(pool, key=lambda k: (pool[k][0].get("severity") != "ERROR", k)):
            if len(picked) >= CAP or rid in seen:
                continue
            picked.append((rid, pool[rid][0], pool[rid][1]))
            seen.add(rid)

    try_pick(t1)
    try_pick(t2)
    print(f"{out_name}: 候选 {len(candidates)}（一档 {len(t1)}）-> 精选 {len(picked)}")

    rule_dicts = []
    pack = out_name.replace(".yaml", "")
    for rid, rule, rel in picked:
        r = dict(rule)
        r["id"] = f"{pack}.{rid}"
        md = dict(r.get("metadata") or {})
        md["opengrep-studio"] = {"source": "opengrep-rules", "upstream-path": rel, "upstream-id": rid}
        r["metadata"] = md
        try:
            yaml.safe_dump(r, allow_unicode=True, sort_keys=False)
            rule_dicts.append(r)
        except Exception as e:
            print(f"  [dump失败，跳过] {rid}: {type(e).__name__}")

    header = (
        "# Opengrep Studio 内置安全规则包（security）\n"
        "# 来源: https://github.com/opengrep/opengrep-rules （精选子集）\n"
        "# 许可: LGPL 2.1 + Commons Clause（不得将规则单独出售；保留本出处声明）\n"
        f"# 精选标准: 含安全元数据的优先、每语言 ≤ {CAP} 条（官方不足 50 条时全量收录），剔除 correctness 目录\n"
        "# 校验: opengrep validate --config server/rules/security\n"
    )
    body = yaml.dump({"rules": rule_dicts}, allow_unicode=True, sort_keys=False,
                     default_flow_style=False, width=1000)
    with open(os.path.join(DST, out_name), "w", encoding="utf-8") as f:
        f.write(header + body)
    print(f"  写入 {out_name}（{len(rule_dicts)} 条）")
print("完成")
