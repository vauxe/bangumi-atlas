# bangumi-atlas

把 [bangumi/Archive](https://github.com/bangumi/Archive) 的每周 wiki dump 导入
[LadybugDB](https://ladybugdb.com)(Kuzu 的社区延续分叉,嵌入式图数据库)。
设计决策与架构详见 [docs/DESIGN.md](docs/DESIGN.md)。

## 使用

```bash
uv sync                                  # 安装依赖
uv run python scripts/fetch_dump.py      # 下载最新 dump 并校验 SHA256
uv run python scripts/build_db.py        # 全量重建 db/bangumi.lb,约 1 分钟
uv run python scripts/verify_db.py       # 对账验证(行级核对 + 冒烟查询)

# build_db.py --offline 断网构建(用本地映射表快照);--skip-parquet 只重跑导入
```

## 图模型

节点:`Subject`(条目 67 万)、`Person`(人物 10 万)、`Character`(角色 22 万)、`Episode`(章节 168 万)

| 边 | 方向 | 关键属性 | 规模 |
|---|---|---|---|
| `RELATES_TO` | Subject→Subject | relation(改编/续集/前传…) | 91 万 |
| `WORKED_ON` | Person→Subject | position_cn(导演/脚本/音乐…) | 210 万 |
| `APPEARS_IN` | Character→Subject | role_cn(主角/配角/客串/闲角/旁白/声库) | 44 万 |
| `VOICED` | Person→Character | subject_id(在哪部作品中配音) | 28 万 |
| `EPISODE_OF` | Episode→Subject | | 166 万 |
| `PERSON_REL` / `CHARACTER_REL` | 同类互联 | relation(家人/前传角色…) | 7 万 |

枚举码(relation_type、position、platform)在导入时已按
[bangumi/common](https://github.com/bangumi/common) 的映射表解码为中文;
映射表每次构建自动刷新到 `data/mappings/`,解码失配会在构建末尾
以 WARNING 汇总打印。

## 查询示例

```python
# uv run python ...
import ladybug as lb
conn = lb.Connection(lb.Database("db/bangumi.lb", read_only=True))

conn.execute("""
  MATCH (p:Person {name:'水樹奈々'})-[v:VOICED]->(c:Character)
  MATCH (s:Subject {id: v.subject_id})
  RETURN c.name, s.name_cn ORDER BY c.collects DESC LIMIT 5
""")
```

## 保真度

dump 中的字段全量入库,无删减:`infobox` 原始 wiki 文本、`Episode.description`、
`tags` 含投票数(`STRUCT(name STRING, count INT64)[]`)均保留。
`infobox` 仍是未解析的 wiki 语法,做结构化抽取需配合
[wiki-parser-py](https://github.com/bangumi/wiki-parser-py)。

唯一的例外:两端节点不存在于 dump 中的悬空边(指向已删除条目,
episode 约 1.5 万条、各关联表数千条)无法建边,导入时被过滤并打印计数。

- `person-characters` 是三元关系(人-角色-作品),`subject_id` 存为边属性

## 许可

代码以 [MIT](LICENSE) 许可发布。数据来自 [bangumi/Archive](https://github.com/bangumi/Archive),
其版权与使用条款以上游为准,本仓库不再分发数据本体。
