# 构建

下列阶段与 `.github/workflows/weekly.yml` 的每周烘焙顺序一致。生成产物均在
`.gitignore` 中，克隆后需完整构建一次。本地命令写入 `site/`；workflow 使用隔离的
staging 目录。数据版本、体积和耗时以生成的 manifest 与构建日志为准。

## 1. 环境

Python、uv 和 Node 的版本以 `pyproject.toml` 与 `weekly.yml` 为准。构建需要联网下载
上游快照和 `bangumi/common` 枚举；期间会同时保留常驻产物和临时代际，磁盘需求以当前
文件系统占用为准。

```bash
uv sync --frozen
npm --prefix web ci
```

## 2. 代码与客户端门禁

以下命令对应 `main` 分支 push 和 Pull Request 共同运行的 Python/Web 门禁；Pull Request
还会运行 `dependency-review`，新增依赖出现 high 及以上漏洞时失败。通过后再进入数据管道。

```bash
uv run --frozen python -m unittest discover -s tests
uv run --frozen ruff check scripts tests
uv run --frozen ruff format --check scripts tests
uv run --frozen mypy scripts
npm --prefix web run test
npm --prefix web run check
npm --prefix web run build
```

客户端生产构建写入 `site/`，包体统计记录在构建日志中。

## 3. 数据管道

按顺序执行，任一步非零退出即停止。各脚本职责见
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) §5。

```bash
uv run --frozen python -m scripts.fetch_dump
uv run --frozen python -m scripts.build_db
uv run --frozen python -m scripts.verify_db
uv run --frozen python -m scripts.layout
uv run --frozen python -m scripts.bake_site
uv run --frozen python -m scripts.verify_site
```

各阶段对来源、schema、内容身份和布局身份采用失败关闭策略；详细合同见
[数据管道与图模型](DATA_ARCHITECTURE.md) 和
[结构化站点数据设计](STRUCTURAL_SITE_DATA_DESIGN.md)。`layout.py` 只复用身份与产物摘要
均匹配的本地缓存；需要主动重算时使用：

```bash
uv run --frozen python -m scripts.layout --force
```

不要跨机器复制布局缓存，也不要并行运行 `layout.py` 与 `bake_site.py`。资源占用以当前
完整构建日志为准。

## 4. 发布前验证

`verify_site.py` 在完整的 staging `site/` 上核对内容和体积门禁；随后通过 HTTP 做端到端
冒烟。smoke 要求其实际发出的每个 Range 请求得到精确 `206` 与 `Content-Range`。
`weekly.yml` 仅在站点接近托管上限时补充告警。两项都通过后，整个 `site/` 目录才作为
Pages artifact 发布。生产托管的传输语义不由本地 smoke 证明。

```bash
# 终端 A
npm --prefix web run serve:smoke
```

确认 <http://127.0.0.1:8391/data/manifest.json> 可访问后，在另一终端运行：

```bash
npm --prefix web run smoke
```

完成后在终端 A 停止静态服务器。不能用 `file://` 代替 HTTP 验证，因为客户端依赖
Range 响应。

## 5. 跨机器一致性

按顺序核对四项：

1. `data/dump/VERSION`：上游显示版本。
2. `data/parquet/generation.json`：原始归档、映射、Parquet 和语义 oracle 的完整身份。
3. `data/layout/cache.json` 与 `report.json`：布局输入/产物身份、算法和几何质量。
4. `site/data/manifest.json`：SiteRelease 来源、文件摘要和内容版本。

相同显示版本不代表内容相同；逐字节一致性必须由 generation、布局产物和 SiteRelease
文件摘要证明。不同平台的数值库仍可能产生浮点末位差异。

## 6. 调试开关

以下开关供调试使用，正式发布仍须依次通过 §2–§4：

- `verify_site.py --geometry-only`：只核对 manifest、rank 和最终几何，不能代替完整验证。
- 只重跑烘焙：运行 `bake_site.py` 和完整 `verify_site.py`，复用已通过身份核验的 Parquet
  与布局。
- `build_db.py --skip-parquet`：复用通过 generation 内容核验的 Parquet，只重建数据库。
- `build_db.py --offline`：显式改用本地枚举快照，校验其来源 commit 与逐文件 SHA-256。
  默认联网失败不会隐式退回旧快照。
- `layout.py --force`：忽略有效缓存并重算坐标。
- `npm --prefix web run dev`：写出未压缩的 `site/app.js`，发布前重跑 §2 的 build。
