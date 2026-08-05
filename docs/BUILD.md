# 构建

仓库只有一条构建路径，下列步骤与 `.github/workflows/weekly.yml` 的每周烘焙逐条
对应。生成产物均在 `.gitignore` 中，克隆后需完整构建一次。数据版本、产物体积和
耗时以构建日志和 `site/data/manifest.json` 为准。

## 1. 环境

Python、uv 和 Node 的版本以 `pyproject.toml` 与 `weekly.yml` 为准。构建需要联网
下载上游快照和 `bangumi/common` 枚举，磁盘预留 5 GB 以上。

```bash
uv sync --frozen
npm --prefix web ci
```

## 2. 代码门禁

与每次 push 的 CI 门禁相同，通过后再进入数据管道。

```bash
uv run python -m unittest discover -s tests
uv run ruff check scripts tests
uv run ruff format --check scripts tests
uv run mypy scripts
```

## 3. 数据管道

按顺序执行，任一步非零退出即停止。各脚本职责见
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §5。

```bash
uv run python scripts/fetch_dump.py
uv run python scripts/build_db.py
uv run python scripts/verify_db.py
uv run python scripts/layout.py
uv run python scripts/bake_site.py
uv run python scripts/verify_site.py
```

`layout.py` 默认启用本地缓存。它先计算 3 张节点 Parquet 与 6 张关系 Parquet 的逐文件
内容摘要，再核对完整 `layout.py`、`uv.lock`、`shape_digest`、`coords.parquet` 与
`report.json` 的摘要和坐标 schema。全部一致才直接复用布局，且不会加载图数据结构或
重写两份产物；任一项缺失、损坏或变化都视为未命中并完整重算。摘要检查会顺序读取
输入文件，但不会物化节点、边或 igraph，实测内存远低于完整布局。

`build_db.py` 发布 Parquet 与 `layout.py` 消费 Parquet 使用同一把跨进程锁，不能并发
观察到正在替换的九张表；Parquet 构建中断还会保留 `.build-in-progress` 标记，布局会
拒绝继续。布局在发布前再次核对输入与实现身份，缓存标记只在两份产物完整写出后原子
发布到 `data/layout/cache.json`。需要主动重算时使用：

```bash
uv run python scripts/layout.py --force
```

缓存是本机执行优化，不参与 SiteRelease，也不能替代 `verify_site.py`。全新 CI runner
没有缓存时仍执行完整布局。不要跨机器复制缓存；它刻意复用已经校验的产物字节，不尝试
证明不同 CPU、BLAS 或依赖二进制重新计算时会产生相同浮点结果。

三处会主动中断构建，均为设计内的报警：

- 快照 SHA-256 与上游 `aux/latest.json` 不符。
- 枚举异常超过 `build_db.py` 的 `ENUM_ANOMALY_BASELINES`，说明上游枚举漂移，需
  人工审计后更新基线。
- `data/layout/report.json` 缺失、并非三维，或 `shape_digest` 与当前整形代码算出
  的摘要不符（坐标出自另一套整形逻辑，重跑 `layout.py`）。

### 内存与临时空间

`layout.py` 以 `uint32` NumPy 数组保存边，并直接交给 igraph；最大分量和小分量拆开后
立即释放全图。`bake_site.py` 将 pack 成员直接写入目标文件，实体与长文本按有界批次
读取，事实排序段与 incidence 分片写入系统临时目录后逐段归并。因此内存不再随全部事实
与 incidence 行数线性累积，但构建期间会使用额外临时磁盘空间；这些临时目录在正常完成
或异常退出时自动清理。不要并行运行 `layout.py` 与 `bake_site.py`。

下表是 `dump-2026-07-28` 在 macOS arm64、Python 3.12.12 上的完整本地运行，最大 RSS
来自 `/usr/bin/time -l`。它用于记录本次优化量级，不是跨机器性能门禁：

| 阶段 | 优化前最大 RSS | 优化后最大 RSS | 变化 | 优化前耗时 | 优化后耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `layout.py` | 1,532 MiB | 947 MiB | -38% | 801 s | 831 s |
| `bake_site.py` | 2,323 MiB | 1,292 MiB | -44% | 354 s | 176 s |

内存分配器会让重复运行的 RSS 有波动；验收以完整运行、当前 `shape_digest`、行级对账和
`verify_site.py` 全部通过为准，不能用曾中断的旧产物作为正确性基线。

### 快速等价验证

#### 布局与烘焙改动

改动布局或烘焙逻辑时，可先在原始 Parquet 的确定性代表子集上比较旧提交与当前工作树，
无需信任可能中断过的旧产物：

```bash
BASELINE_REF=origin/main  # 或换成改动前的完整提交号
uv run python scripts/verify_build_equivalence.py \
  --baseline-ref "$BASELINE_REF" \
  --max-rss-mib 1024 \
  --min-available-mib 1024
```

默认选择 2,048 个条目、1,024 个人物和 2,048 个角色，覆盖媒体类型、长文本、关系闭包、
事实/剧集分页边界和高关联实体；超过 256 集的病理条目会被排除，避免小样本扭曲 P99
门禁。旧实现直接从指定 Git 提交提取脚本，新旧阶段严格串行，并分别重新生成布局和站点
数据。两份站点都先由当前独立校验器完整解码，再比较布局坐标、语义 manifest 与文件
摘要；只允许流式排序造成的 `facts.idx`、`facts.pack`、`pages.pack` 物理重排。

每个阶段限制计算线程、降低进程优先级并监控整个进程组；RSS 超过上限、系统可用内存
低于下限、无法读取内存指标或阶段超时都会终止该进程组。验证只写入忽略目录
`data/verifications/equivalence-*/`，不会覆盖当前 `data/layout` 或 `site/data`。进度、峰值
RSS、日志路径和最终差异保存在其中的 `report.json`；失败现场会保留，便于继续诊断。

`--max-rss-mib` 是验证进程组的硬上限，`--min-available-mib` 是为系统保留的可用内存
下限。任一门禁触发都应先减小 `--subjects`、`--people`、`--characters` 或停止其他构建，
不要关闭内存监控后重跑。实际峰值会随机器与上游数据变化。

#### 原始数据与数据库改动

上述命令从已经生成的 Parquet 开始，**不会运行 `build_db.py`**。因此修改 JSONL 解析、
字段投影、Parquet 写入或数据库导入时，仅运行上述命令或单元测试，不能据此声明
`build_db.py` 的产物与旧实现一致。此类改动的子集验收必须满足以下步骤：

1. 从同一份原始 dump 确定性选择 subject、person、character，并按关系闭包回投到全部
   9 个 JSONL 文件；两边必须使用同一份 `VERSION`、相同的 9 个子集文件摘要和同一份
   映射快照。
2. 子集应覆盖全部 5 种 subject 类型、全部事实表、剧集分页边界和高关联实体。关系闭包
   不会自然覆盖悬空关系、孤儿剧集或源数据中不存在的重复关系；报告必须说明这些路径的
   实际行数，缺失的异常路径由合成用例或全量独立校验补充，不能默认为已经覆盖。
3. 验证分批写入时，至少让受影响的表超过 `PARQUET_BATCH_ROWS`（当前为 10,000 行），
   不能只验证单个 row group。
4. 从 Git 基线提取旧版构建脚本，与当前版本分别写入两个隔离目录；禁止复用或覆盖
   `data/parquet`、`data/db` 和可能中断过的旧产物。两个构建必须严格串行，并使用与上节
   相同的 RSS、系统可用内存和超时门禁。
5. 对 11 张 Parquet 表逐一比较精确 schema、行数、顺序和每行字段值，并确认 DDL 与
   导入映射没有意外变化；再分别查询两份 LadybugDB，确认数据库内容与各自 Parquet
   一致。流式写入可能改变 row group，不能把 Parquet 文件是否逐字节一致作为逻辑等价
   条件。
6. 最后分别以旧、新 Parquet 继续运行同一版 `layout.py`、`bake_site.py` 和
   `verify_site.py`，再比较坐标、语义 manifest 和所有逻辑站点产物，防止物理分批差异
   传播到发布结果。

报告至少应保存基线完整提交号、dump 与映射版本、入选 ID 或其摘要、每个源文件和表的
行数、精确比较结果、各阶段峰值 RSS、退出原因及日志路径。只有这些步骤全部通过，才能
声明“该真实子集在旧、新 `build_db.py` 间逻辑等价”；它仍不等于全量等价证明。

分批写入的边界、空输入 schema 和中断时保留已发布文件由以下单元测试快速覆盖：

```bash
uv run python -m unittest tests.test_build_db.ParquetProjectionTests
```

单元测试不能替代真实子集差分。若当前 dump 的 `fact-summary` 全为空，真实子集只能覆盖
规范空 pack；非空摘要路径还必须由合成用例覆盖：

```bash
uv run python -m unittest \
  tests.test_bake_site.FactSummaryTests.test_emits_non_empty_text_addressed_by_fact_ref
```

子集验证用于快速回归；发布前仍须对当前实现执行完整数据管道和独立校验。旧全量产物
如果曾中断或不完整，只能作为故障现场，不能作为正确性基线。

## 4. 客户端

```bash
npm --prefix web run test
npm --prefix web run check
npm --prefix web run build
```

产出压缩后的 `site/app.js`。

## 5. 发布前验证

在完整的 staging `site/` 上做端到端冒烟，再核对体积门禁（阈值见 `weekly.yml`）。
通过后整个 `site/` 目录作为 Pages artifact 发布。

```bash
npm --prefix web run serve:smoke &
npm --prefix web run smoke
kill %1
```

## 6. 跨机器一致性

按顺序核对四项：

1. `data/dump/VERSION` —— 上游每周三滚动，`fetch_dump.py` 始终取最新版本。
2. `data/mappings/manifest.json` 的 commit 与逐文件 SHA-256。
3. `data/layout/report.json` —— `algo`、`seed` 与 `shape_digest` 描述整形算法；摘要由
   `layout.py` 从整形代码算出，改了几何就自动变。它不包含输入和数值运行时，因此不能
   单独作为整份坐标逐字节相同的证明。`depth_ratio`、邻距和 `edge_compactness` 由
   数据实测，随上游版本漂移，读作几何质量。
4. `site/data/manifest.json` 的 `version` —— 标识发布使用的源数据版本；需要证明整份
   发布逐字节相同时，仍应比较 SiteRelease 文件清单及内容摘要。

前两项相同时，后两项的数据版本和布局质量指标应一致。布局固定使用分量分区、Leiden
社区归并、UMAP 岛内拓扑和加权社区超图，`layout.py` 为 igraph 的随机源播种；但不同
平台的数值库仍可能产生浮点末位差异，逐字节结论必须由产物摘要给出。

## 7. 调试开关

以下开关供调试使用，发布路径只用 §3 的命令：

- 只重跑烘焙：`bake_site.py` + `verify_site.py` 复用现有 `data/parquet` 与
  `data/layout`，用于本地迭代烘焙逻辑。烘焙器核对 Parquet 与 dump 的 `VERSION`
  标记，不一致即失败——发布坐标的世界跨度归一等改动只影响这两步，无需重跑布局。
- `build_db.py --skip-parquet`：复用现有 Parquet，只重建数据库，受 `VERSION`
  一致性护栏约束。
- `build_db.py --offline`：改用本地枚举快照，校验其来源 commit 与逐文件 SHA-256。
  上游是否有更新仍需联网刷新阶段确认。
- `layout.py --force`：忽略已通过全部摘要与 schema 校验的布局缓存，强制重算坐标；
  正常构建无需使用。
- `npm --prefix web run dev`：写出未压缩的 `site/app.js`，发布前重跑 §4 的 build。
