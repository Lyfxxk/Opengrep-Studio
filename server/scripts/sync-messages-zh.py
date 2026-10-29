"""内置规则中文映射维护脚本：覆盖 messages-zh.json 与规则包之间的差异。

用法（在仓库根执行）：
  python server/scripts/sync-messages-zh.py                    # 报告缺失/多余条目
  python server/scripts/sync-messages-zh.py --draft draft.json # 把缺失条目（id -> 英文原文）写成机翻初稿
  python server/scripts/sync-messages-zh.py --merge draft.json # 把已翻译的初稿条目合并进 messages-zh.json

流程：全量收录后先 --draft 导出缺失条目，翻译（人工或机翻初稿+人工抽查）后 --merge 入库。
--merge 只写简体 messages-zh.json；繁体 messages-zh-Hant.json 需按同键手工同步，npm run i18n:check 会校验简繁同键。
非内置包条目（自定义规则等）只报告、永不改动。规则 ID 上线后不可修改，基线对比依赖 ID 稳定。
"""

import argparse
import glob
import json
import os
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
DST = os.path.join(os.path.dirname(HERE), "rules", "security")
ZH_FILE = os.path.join(os.path.dirname(HERE), "rules", "messages-zh.json")


def builtin_ids():
    """收集内置包全部规则 ID 与英文 message。"""
    rules = {}
    for path in sorted(glob.glob(os.path.join(DST, "*.y*ml"))):
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
        for rule in (data or {}).get("rules") or []:
            rid = rule.get("id")
            if isinstance(rid, str) and rid not in rules:
                rules[rid] = rule.get("message") or ""
    return rules


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def main():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--draft", metavar="FILE", help="导出缺失条目（id -> 英文原文）到指定文件")
    parser.add_argument("--merge", metavar="FILE", help="合并已翻译的初稿到 messages-zh.json")
    args = parser.parse_args()

    rules = builtin_ids()
    zh = load_json(ZH_FILE)
    missing = sorted(rid for rid in rules if rid not in zh)
    stale = sorted(k for k in zh if k not in rules)

    if args.draft:
        draft = {rid: rules[rid] for rid in missing}
        with open(args.draft, "w", encoding="utf-8") as f:
            json.dump(draft, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print(f"初稿已写入 {args.draft}（{len(draft)} 条，值为英文原文，待翻译）")
        return

    if args.merge:
        patch = load_json(args.merge)
        added = 0
        for rid, message in patch.items():
            if rid not in rules:
                print(f"  [跳过] {rid}: 不是内置规则 ID")
                continue
            if not isinstance(message, str) or not message.strip():
                print(f"  [跳过] {rid}: 翻译为空（机翻未覆盖时请人工补译）")
                continue
            zh[rid] = message.strip()
            added += 1
        # 全量按 key 排序落盘，保证 diff 稳定
        with open(ZH_FILE, "w", encoding="utf-8") as f:
            json.dump(dict(sorted(zh.items())), f, ensure_ascii=False, indent=1)
            f.write("\n")
        print(f"已合并 {added} 条到 {ZH_FILE}")
        # 简繁两份必须同键（i18n-check.mjs 校验），本脚本只写简体，繁体须人工跟进
        if added:
            print("提示：请同步 server/rules/messages-zh-Hant.json 对应条目，npm run i18n:check 会拦截", file=sys.stderr)

    covered = len(rules) - len(missing)
    print(f"内置规则 {len(rules)} 条：中文映射 {covered} 条，缺失 {len(missing)} 条，非内置/已下线 {len(stale)} 条（保留不动）")
    if missing:
        print("缺失示例（最多 10 条）：" + "、".join(missing[:10]))
    if stale:
        print("非内置示例（最多 10 条）：" + "、".join(stale[:10]))
    if missing and not (args.draft or args.merge):
        print("提示：用 --draft 导出缺失条目，翻译后 --merge 入库", file=sys.stderr)
        print("提示：--merge 只写简体，请同步 server/rules/messages-zh-Hant.json 对应条目，npm run i18n:check 会拦截", file=sys.stderr)


if __name__ == "__main__":
    main()
