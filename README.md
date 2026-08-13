# bangumi-atlas

将 [bangumi/Archive](https://github.com/bangumi/Archive) 的每周快照构建为
LadybugDB 图数据库和可静态部署的关系星图。

## 构建

需要 Python 3.12+、[uv](https://docs.astral.sh/uv/) 和 Node 24。仓库只有一条构建
路径，与每周发布相同，完整步骤见 [构建](docs/BUILD.md)。

上游快照、数据库、布局和站点数据都在 `.gitignore` 中，克隆后需完整构建一次。

## 文档

- [构建](docs/BUILD.md)：唯一构建路径、产物体积、发布门禁和跨机器一致性核对。
- [数据管道与图模型](docs/DATA_ARCHITECTURE.md)：输入契约、图结构、字段转换和验证策略。
- [探索应用架构](docs/EXPLORER_ARCHITECTURE.md)：产品边界、浏览器架构、交互和发布门禁。
- [结构化站点数据与按需长文本设计](docs/STRUCTURAL_SITE_DATA_DESIGN.md)：分层发布完整
  结构语义和可随机读取的长文本侧车（SiteRelease 格式契约）。
- [静态查询能力设计](docs/QUERY_CAPABILITY_DESIGN.md)：从用户问题反推统一查询合同、
  版本化静态发布、GitHub Pages 运行时边界及语义/容量门禁。
- [前端性能](docs/FRONTEND_PERFORMANCE.md)：长期有效的性能正确性边界、关键设计取舍、
  构建门禁和复现方式。

## 许可

代码以 [MIT](LICENSE) 许可发布。数据版权与使用条款以上游
[bangumi/Archive](https://github.com/bangumi/Archive) 为准。
