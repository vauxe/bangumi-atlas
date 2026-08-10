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
uv run python -m scripts.fetch_dump
uv run python -m scripts.build_db
uv run python -m scripts.verify_db
uv run python -m scripts.layout
uv run python -m scripts.bake_site
uv run python -m scripts.verify_site
```

`layout.py` 默认启用本地缓存。Parquet generation 校验每个输入文件后，布局直接用清单中
已验证的摘要计算输入身份，不再重复读取相同文件。缓存另行核对完整布局实现、EntityKey
实现、关键数值库版本、`shape_digest`、`coords.parquet` 与 `report.json` 的摘要和坐标 schema。
全部一致才直接复用布局，且不会加载图数据结构或重写两份产物；任一项缺失、损坏或变化都
视为未命中并完整重算。完整实现摘要允许无害改动产生保守的缓存未命中，但不会让改变输出的
加载或编排逻辑误用旧坐标。

`build_db.py` 只在枚举门禁、独立 raw→Parquet 内容对账和制品清单全部通过后，才最后
发布 `data/parquet/generation.json`。该清单以 SHA-256 绑定 `dump.zip`、9 个 JSONL、
映射快照、11 张 Parquet、Arrow schema、原始/投影/筛选行数和语义指纹；同名 `VERSION`
不能替代内容身份。构建中断会保留 `.build-in-progress`，旧清单也不能让半代制品看起来
完整。
清单当前的内部格式标识是 `parquet-generation-v1`；它只用于兼容性门禁，不是产品或
站点的正式发布版本号。项目尚未正式发布，因此首个格式直接沿用 v1。
发布时还会逐成员解压 `dump.zip`，要求它只含这 9 个唯一顶层成员，并把每个成员的
SHA-256、字节数和行数与 `data/dump` 严格对齐；因此“新 zip + 旧 JSONL”不能组成一代。
语义 oracle 绑定实际参与投影的代码、EntityKey 实现与关键运行时版本；布局缓存绑定完整
`layout.py`、独立 EntityKey 实现和数值库版本，不因其他脚本或锁文件变化而失效。

下载先写入同目录临时归档，摘要通过后才替换；解压也先在同目录完成，失败时保留上一份
完整 dump，并拒绝归档、dump 目录或其数据根为符号链接。
下载、映射刷新、Parquet、LadybugDB、数据库核验、布局、烘焙和站点核验使用同一把
跨进程代际锁。消费者在锁内核对 generation 自身、当前归档、映射和 Parquet，不能观察到
正在替换的文件；解压 JSONL 的逐字节 lineage 证明只在 generation 发布时执行，
`verify_db.py` 另行重算其投影语义，避免布局、烘焙和站点核验反复扫描不参与其计算的
1.7GB 原始文件。
布局在发布前再次核对输入与实现身份，缓存标记只在两份产物完整写出后原子发布到
`data/layout/cache.json`。需要主动重算时使用：

```bash
uv run python -m scripts.layout --force
```

缓存中的坐标不直接复制进 SiteRelease，但其输入摘要、实现身份和两份布局产物摘要属于
发布来源身份；烘焙和 `verify_site.py` 都会精确核对。全新 CI runner 没有缓存时仍执行
完整布局。不要跨机器复制缓存；它刻意复用已经校验的产物字节，不尝试证明不同 CPU、
BLAS 或依赖二进制重新计算时会产生相同浮点结果。

以下来源身份不一致时会主动中断构建，均为设计内的报警：

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

内存和耗时以当前完整构建日志为准，不设置跨机器的静态数字。验收以当前
`shape_digest`、行级对账和 `verify_site.py` 全部通过为准，不能用曾中断的旧产物作为
正确性基线。

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

按顺序核对五项：

1. `data/dump/VERSION` —— 上游每周三滚动，`fetch_dump.py` 始终取最新版本。
2. `data/mappings/manifest.json` 的 commit 与逐文件 SHA-256。
3. `data/parquet/generation.json` —— 绑定原始归档、解压文件、映射、完整 Parquet 和
   独立语义 oracle；发布时完成全量 lineage 证明，日常消费者只复核它实际依赖的当前
   制品，`verify_db.py` 负责重新执行原始语义深度核验。
4. `data/layout/report.json` —— `algo`、`seed` 与 `shape_digest` 描述整形算法；摘要由
   `layout.py` 从整形代码算出，改了几何就自动变。它不包含输入和数值运行时，因此不能
   单独作为整份坐标逐字节相同的证明。`depth_ratio`、邻距和 `edge_compactness` 由
   数据实测，随上游版本漂移，读作几何质量。
5. `site/data/manifest.json` 的 `version` —— 标识发布使用的源数据版本；需要证明整份
   发布逐字节相同时，仍应比较 SiteRelease 文件清单及内容摘要。

前三项相同时，后两项的数据版本和布局质量指标应一致。布局固定使用分量分区、Leiden
社区归并、UMAP 岛内拓扑和加权社区超图，`layout.py` 为 igraph 的随机源播种；但不同
平台的数值库仍可能产生浮点末位差异，逐字节结论必须由产物摘要给出。

## 7. 调试开关

以下开关供调试使用，发布路径只用 §3 的命令：

- 只重跑烘焙：`bake_site.py` + `verify_site.py` 复用现有 `data/parquet` 与
  `data/layout`，用于本地迭代烘焙逻辑。两者核对完整 Parquet generation 与布局 cache；
  任一来源、schema、文件或实现身份不一致即失败。
- `build_db.py --skip-parquet`：复用现有 Parquet，只重建数据库，受 `VERSION`
  与完整 generation 内容护栏约束。
- `build_db.py --offline`：改用本地枚举快照，校验其来源 commit 与逐文件 SHA-256。
  上游是否有更新仍需联网刷新阶段确认。
- `layout.py --force`：忽略已通过全部摘要与 schema 校验的布局缓存，强制重算坐标；
  正常构建无需使用。
- `npm --prefix web run dev`：写出未压缩的 `site/app.js`，发布前重跑 §4 的 build。
