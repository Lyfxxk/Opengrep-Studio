# security 规则包（内置）

本目录是 Opengrep Studio 的内置安全规则集，随仓库分发，供扫描时通过 `--config` 传给 opengrep 引擎。

## 来源与许可

- **上游仓库**: https://github.com/opengrep/opengrep-rules （精选子集，非全量搬运）
- **许可**: LGPL 2.1 + Commons Clause。允许自由复用与再分发（须保留本出处声明），唯一限制是**不得将规则本身作为付费产品/服务出售**。
- 每条规则的 `metadata.opengrep-studio.upstream-path` 记录了它在上游仓库中的原始路径，可随时溯源。

## 文件与规模

合计 12 种语言 812 条规则（对应上游 12 种支持语言的全量收录）：

| 文件 | 语言 | 规则数 |
|---|---|---|
| python.yaml | Python | 305 |
| js-ts.yaml | JavaScript | 183 |
| java.yaml | Java | 102 |
| go.yaml | Go | 72 |
| php.yaml | PHP | 59 |
| dockerfile.yaml | Dockerfile | 32 |
| csharp.yaml | C# | 27 |
| c.yaml | C | 12 |
| rust.yaml | Rust | 10 |
| bash.yaml | Bash | 5 |
| swift.yaml | Swift | 4 |
| kotlin.yaml | Kotlin | 1 |

rust / kotlin / swift / bash 覆盖少是上游规则库现状，如需补充可自行手写规则放入 `server/rules/custom/`（建议每条规则配一个测试样本，用 `opengrep test` 验证）。

## 精选标准

1. 收录 ERROR / WARNING / INFO 全部级别；
2. 含 `cwe` / `owasp` 元数据的规则优先（严重度分级与合规报告依赖这些元数据）；
3. 默认全量收录；如需限量可用 `python server/scripts/curate-rules.py --cap 50` 按每语言 ≤ N 条精选（ERROR 优先）；
4. 剔除 `correctness`（正确性检查）目录与 `generic` 语言规则；
5. 规则 ID 统一加语言包前缀（`<包名>.<原始ID>`），避免跨包重名冲突，上游溯源见各规则的 `metadata.opengrep-studio`。

## 中文映射

`../messages-zh.json` 以规则 ID 为键提供 message 的中文翻译：后端经 `/api/messages-zh` 提供，前端按 checkId 查表展示，查不到时回退英文原文。规则更新产生新 ID 后，用 `server/scripts/sync-messages-zh.py` 导出缺失条目、翻译后合并入库（流程见脚本头部说明）。

## 验证与更新

```bash
# 语法校验（0 错误即通过）
opengrep validate server/rules/security

# 冒烟：对本目录规则扫描任意代码，确认有命中
opengrep scan --config server/rules/security/python.yaml --json <目标目录>
```

更新方式：同步上游仓库（`git clone --depth 1` 或 codeload tarball）后修改 `server/scripts/curate-rules.py` 顶部的 `SRC` 常量指向仓库位置并重跑，或手动增删规则文件。规则 ID 上线后请勿修改——基线对比（fingerprint）依赖 ID 稳定。

## 备注：规则 ID 前缀

引擎加载本地规则文件时会自动给规则 ID 加上路径前缀（如 `server.rules.security.<原始ID>`），这是 opengrep 对本地 `--config` 的默认行为，同一配置下前缀恒定，不影响基线对比与展示。
