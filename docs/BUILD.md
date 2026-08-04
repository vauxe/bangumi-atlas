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

三处会主动中断构建，均为设计内的报警：

- 快照 SHA-256 与上游 `aux/latest.json` 不符。
- 枚举异常超过 `build_db.py` 的 `ENUM_ANOMALY_BASELINES`，说明上游枚举漂移，需
  人工审计后更新基线。
- `data/layout/report.json` 缺失，或几何并非三维 `topology-3d`。

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
3. `data/layout/report.json` —— `algo`、`seed` 与 `depth_ratio` 构成布局身份；
   三者不同即几何形状不同，与上游版本无关。
4. `site/data/manifest.json` 的 `version` —— 相同即整份发布逐字节相同。

前两项相同时，后两项也应相同：布局固定用 UMAP，`layout.py` 播种 igraph 的随机源。
若前两项相同而第 4 项不同，属于管道故障。

## 7. 调试开关

以下开关供调试使用，发布路径只用 §3 的命令：

- 只重跑烘焙：`bake_site.py` + `verify_site.py` 复用现有 `data/parquet` 与
  `data/layout`，用于本地迭代烘焙逻辑。烘焙器核对 Parquet 与 dump 的 `VERSION`
  标记，不一致即失败——发布坐标的世界跨度归一等改动只影响这两步，无需重跑布局。
- `build_db.py --skip-parquet`：复用现有 Parquet，只重建数据库，受 `VERSION`
  一致性护栏约束。
- `build_db.py --offline`：改用本地枚举快照，校验其来源 commit 与逐文件 SHA-256。
  上游是否有更新仍需联网刷新阶段确认。
- `npm --prefix web run dev`：写出未压缩的 `site/app.js`，发布前重跑 §4 的 build。
