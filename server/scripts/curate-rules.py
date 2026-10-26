import argparse
import os
import tempfile
import glob

import yaml

parser = argparse.ArgumentParser(description="从上游 opengrep-rules 精选/全量生成内置规则包")
parser.add_argument("--cap", type=int, default=0, help="每语言收录上限；0 或缺省 = 全量收录")
parser.add_argument("--dry-run", action="store_true", help="只打印各语言收录统计，不写规则文件")
ARGS = parser.parse_args()
# None 表示不限量；--cap N 时按 ERROR 优先截断到 N 条
CAP = ARGS.cap if ARGS.cap > 0 else None

SRC = os.environ.get("OPENGREP_RULES_SRC") or os.path.join(tempfile.gettempdir(), "opengrep-rules")
DST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rules", "security")

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

# 解析缓存：同一上游 YAML 会被 12 种语言各收集一遍，全量模式下可省 ~12 倍解析时间
_parsed = {}

def load_rules(path):
    if path in _parsed:
        return _parsed[path]
    try:
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
    except Exception as e:
        print(f"  [skip] {path}: {type(e).__name__}")
        data = None
    rules = [r for r in data["rules"] if isinstance(r, dict)] if isinstance(data, dict) and isinstance(data.get("rules"), list) else []
    _parsed[path] = rules
    return rules

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
            if (CAP is not None and len(picked) >= CAP) or rid in seen:
                continue
            picked.append((rid, pool[rid][0], pool[rid][1]))
            seen.add(rid)

    try_pick(t1)
    try_pick(t2)
    cap_note = f"精选 {len(picked)}" if CAP is not None else f"全量 {len(picked)}"
    print(f"{out_name}: 候选 {len(candidates)}（一档 {len(t1)}）-> {cap_note}")
    if ARGS.dry_run:
        continue

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

    cap_line = f"每语言 ≤ {CAP} 条（不足时全量收录，ERROR 优先）" if CAP is not None else "全量收录（ERROR 优先排序）"
    header = (
        "# Opengrep Studio 内置安全规则包（security）\n"
        "# 来源: https://github.com/opengrep/opengrep-rules （精选子集）\n"
        "# 许可: LGPL 2.1 + Commons Clause（不得将规则单独出售；保留本出处声明）\n"
        f"# 精选标准: 含 CWE/OWASP 安全元数据的一档优先、{cap_line}，剔除 correctness 目录\n"
        "# 校验: opengrep validate --config server/rules/security\n"
    )
    body = yaml.dump({"rules": rule_dicts}, allow_unicode=True, sort_keys=False,
                     default_flow_style=False, width=1000)
    with open(os.path.join(DST, out_name), "w", encoding="utf-8") as f:
        f.write(header + body)
    print(f"  写入 {out_name}（{len(rule_dicts)} 条）")
print("完成")
