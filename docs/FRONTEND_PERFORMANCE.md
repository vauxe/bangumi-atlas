# 前端性能

本文只记录长期有效的性能边界和关键设计取舍，不保存某次 SiteRelease 的哈希、数据量、
机器耗时、请求数或测试计数。历史测量由 Git 记录；可重复的测量入口保留在 `web/bench/`。

查询结果语义见 [静态查询能力设计](QUERY_CAPABILITY_DESIGN.md)，发布格式与独立验证见
[结构化站点数据设计](STRUCTURAL_SITE_DATA_DESIGN.md)。性能优化不能改变这两份合同。

## 正确性边界

- 查询优化必须保持结果行、证据、顺序、总数、分页状态、发布身份和 Canvas 高亮一致。
  名称与全文索引只产生候选，最终结果仍由权威字段复核。
- 坐标是唯一允许有界误差的前端字段。manifest 声明逐轴 affine u16 解码参数，发布验证
  必须证明 rank 对齐、量化误差上限和解码后不重叠。
- 查询工作量与结果数没有隐藏配额。分页只限制传输，虚拟列表只限制 DOM；需要完整排序、
  聚合或集合运算时允许读取完整输入，并由用户显式取消。
- 本地墙钟时间只用于同一环境的 A/B，不能直接视为生产 CDN 或低端设备承诺。优先采用
  请求数、字节数、工作量和完整结果摘要等确定性证据。

## 关键设计取舍

### 静态发布按需读取

GitHub Pages 没有查询后端，因此 SiteRelease 同时提供稳定身份索引、名称/全文候选、
查询列投影、关系邻接和长文本成员目录。客户端用 HTTP Range 与有界缓存只读取当前操作
需要的成员；不支持 Range 时只能在同一缓存预算内回退，不能把整包下载当作性能保证。

前缀、子串和正文索引均按 manifest 声明分片。分片用于减少候选工作量，不是新的数据
权威；散列碰撞、别名和正文命中都必须读取规范字段确认。

### 主线程工作与可见结果有界

相机锚点、附近标签和名称建议使用确定性的有界候选选择，不为少量结果排序或扫描全部
节点。查询样式只更新实际着色的 rank；结果的“继续显示”只在新结果是旧结果不可变前缀
时追加 DOM，身份或列布局不一致时保守地完整重建。

这些优化的边界是选择结果、顺序、焦点和可访问性保持不变，而不是单纯减少循环次数。

### 非首屏运行时延后加载

查询工作台运行时使用动态 chunk，Canvas 启动不等待查询模块求值。构建同时门禁初始入口
和全部主线程 chunk，避免通过移动代码隐藏总包体增长。预算的唯一来源是
`web/build.mjs`，文档不复制具体阈值。

### 坐标压缩不冒充内存优化

`positions.bin` 使用逐轴 affine u16 降低传输和静态存储；浏览器仍解码为 Float32 工作集，
所以不能把传输收益表述为同等比例的运行时内存收益。

实体 key 继续使用 u32。曾评估三字节 `kind:2 + id:22` 编码，但它只节省少量发布字节，
不会降低解码后内存，还显著缩小每类源 ID 容量，因此不采用。若 VisualRank 或 EntityKey
接近当前位宽上限，应升级 SiteRelease schema，而不是依赖溢出或继续挤压位宽。

## 局部实验的处理原则

合并 scan/filter/project 异步流水线、跨全文分区共享候选 Promise 等实验曾在代表性数据上
表现不稳定或变慢，因此没有保留。这不是永久禁止：只有执行模型或数据布局发生变化，且
新的同条件 A/B 同时证明结果等价和稳定收益时，才值得重新引入。

## 验证与复现

前端门禁：

```sh
npm --prefix web test
npm --prefix web run check
npm --prefix web run build
```

真实 SiteRelease 冒烟需要先启动支持 Range 的本地服务：

```sh
npm --prefix web run serve:smoke
npm --prefix web run smoke
```

隔离基准：

```sh
npm --prefix web run bench:query -- lookup
npm --prefix web run bench:query -- scan
npm --prefix web run bench:query -- aggregate
npm --prefix web run bench:query -- fulltext
npm --prefix web run bench:frontend -- anchor
npm --prefix web run bench:frontend -- search-substring
```

比较前后版本时必须使用同一 SiteRelease、查询、缓存状态、运行次数和 CPU/网络条件，并先
确认完整结果摘要一致。发布数据合同另由下列命令验证：

```sh
UV_CACHE_DIR=/tmp/uv-cache NO_COLOR=1 uv run --frozen python -m scripts.verify_site
```

## 尚不能由本地基准证明的事项

- 生产 CDN 的 HTTP/2/3、缓存头和内容编码行为。
- 低端设备的 INP、长任务、峰值内存和 GPU 驱动差异。
- 真实用户查询分布；在具备 RUM 前，本地样本只能证明合同与相对工作量。
