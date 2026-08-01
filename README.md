# bangumi-atlas

将 [bangumi/Archive](https://github.com/bangumi/Archive) 的每周快照构建为
LadybugDB 图数据库和可静态部署的三维关系星图。

## 快速开始

需要 Python 3.12+、[uv](https://docs.astral.sh/uv/) 和 Node.js。

```bash
uv sync
uv run python scripts/fetch_dump.py
uv run python scripts/build_db.py
uv run python scripts/verify_db.py

# 本地预览使用快速随机布局；正式构建去掉 --stub
uv run python scripts/layout.py --stub
uv run python scripts/bake_site.py

npm --prefix web ci
npm --prefix web run dev
```

打开 <http://localhost:8300>。首次完整构建会下载上游快照并生成本地数据库；
数据库和站点数据不会写入 Git。

## 文档

- [数据管道与图模型](docs/DATA_ARCHITECTURE.md)：输入契约、图结构、字段转换和验证策略。
- [探索应用架构](docs/EXPLORER_ARCHITECTURE.md)：产品边界、浏览器架构、交互和发布门禁。

## 许可

代码以 [MIT](LICENSE) 许可发布。数据版权与使用条款以上游
[bangumi/Archive](https://github.com/bangumi/Archive) 为准。
