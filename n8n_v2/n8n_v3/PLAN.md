# PLAN.md — 美发店智能客服 Agent

> **用例**：Haircut business 的客服 agent——预约/改期、发型师匹配、发型与发质咨询、护发促销推荐。
> **路线**：先在 n8n Cloud 上做原型，再迁回本目录的自托管 stack（见 [CLAUDE.md](CLAUDE.md)）。
> **形态**：多步工具调用 agent（Tools Agent + 11 个工具），模型层可替换。

---

## 0. 可行性结论

能做。但有三处必须在动手前就改掉设计，否则是上线事故：

| 风险 | 为什么 | 设计对策 |
|---|---|---|
| **照片推断发质** | 卷度/密度/孔隙度从照片判断本身不可靠；且发质与族裔高度相关，自动分类踩公平性问题 | 改为**问卷自报为主**，照片仅作辅助建议，**必须由客户确认**后才写入档案 |
| **模型编造促销/价格** | 这类 agent 最典型的事故——编一个不存在的折扣，商家就得认 | 价格/促销/可用时段**只能来自工具返回**；加输出校验节点做二次核对（见 §5） |
| **把预约交给 LLM** | LLM 不是事务管理器，会重复下单、覆盖他人预约 | 拆成 `find_slots` / `hold_slot`（幂等 + TTL）/ `confirm_booking` 三步，冲突由后端裁决 |

**明确不做的事**（写进 system message 硬约束）：
- 不诊断头皮问题、脱发、过敏等健康相关问题 → 一律转专业人士
- 不承诺任何工具没返回的价格、折扣、时段
- 不基于照片对客户的族裔、年龄做任何推断
- 不处理退款/投诉赔偿 → 转人工

---

## 1. 范围与验收标准

| # | 能力 | 验收标准 |
|---|---|---|
| 1 | 预约全流程 | 新预约 / 改期 / 取消 三条路径都能走通，且无重复下单、无槽位冲突 |
| 2 | 发型师匹配 | 给出 top-3 候选 + 可解释理由；排序由**确定性打分**决定，不由 LLM 拍脑袋 |
| 3 | 发型分类 | 输出受控词表里的 taxonomy id，不自由发挥 |
| 4 | 发质档案 | 问卷驱动建档，客户确认后落库，可复用于后续推荐 |
| 5 | 促销推荐 | 只推真实在售且客户符合资格的促销；**幻觉率 = 0** |
| 6 | 越界处理 | 健康问题 / 投诉 / 议价 一律正确升级人工，不硬答 |
| 7 | 可评估 | 有对话数据集 + 指标，换模型或改 prompt 能量化比较 |
| 8 | 可移植 | 同一份 workflow JSON 在 Cloud 和自托管上都能跑 |

**非目标**（本轮不做）：支付/收款、会员积分体系、多门店库存、员工排班生成（只读取排班，不生成）。

---

## 2. 数据模型

Agent 的能力上限由这张表决定，不是由 prompt 决定。**Phase 0 先把它建好。**

| 表 | 关键字段 | 说明 |
|---|---|---|
| `customers` | id, name, 渠道 handle, 语言偏好, consent_flags, created_at | consent_flags 记录照片/数据留存授权 |
| `hair_profiles` | customer_id, texture, density, porosity, 化学史（染/烫/漂）, 自报 vs 推断标记, updated_at | **每个字段都要标是自报还是推断** |
| `stylists` | id, name, specialties[], seniority, languages[], price_tier | specialties 关联 style_taxonomy |
| `services` | id, name, duration_min, price, requires_consult, allowed_stylist_levels[] | 价格的**唯一权威来源** |
| `appointments` | id, customer_id, stylist_id, service_id, start, status, idempotency_key | status: held / confirmed / cancelled / no_show |
| `promotions` | id, title, eligibility(JSON), valid_from/to, stackable, channels[] | 促销的**唯一权威来源** |
| `style_taxonomy` | id, 中英文名, 适配发质, 预估时长, 维护难度 | 受控词表，防止模型自由发挥 |

存储选型见 §8 决策 4。早期用 Data Table 起步，数据关系复杂后再上 Postgres。

---

## 3. 工具契约

工具的 **description 是 planning 质量的主要杠杆**——比 system prompt 更重要。先定契约再实现。

### 只读工具（低风险，先做）

| 工具 | n8n 节点 | 职责 | 失败模式 |
|---|---|---|---|
| `service_catalog` | Call n8n Workflow Tool | 查服务、时长、价格 | 服务不存在 |
| `get_promotions` | Call n8n Workflow Tool | 按资格规则检索在售促销 | 无符合项（必须老实说没有） |
| `find_slots` | Call n8n Workflow Tool → 预约后端适配层 | 查可用时段（按服务时长 + 发型师筛选） | 后端超时、全满 |
| `match_stylist` | Custom Code Tool | 按发型/发质/语言/价位/档期**确定性打分**，返回 top-3 + 理由 | 无匹配 → 放宽条件重试 |
| `classify_style` | Call n8n Workflow Tool（文本或 vision → 受控词表） | 输出 taxonomy id + 置信度 | 低置信度 → 反问澄清 |
| `hair_profile_read` | Call n8n Workflow Tool | 读发质档案 | 新客户无档案 |

### 写操作工具（高风险，后做，必须幂等）

| 工具 | 职责 | 必须满足 |
|---|---|---|
| `hold_slot` | 占位，TTL 10 分钟 | 幂等键 = (customer, slot)；重复调用返回同一个 hold |
| `confirm_booking` | 把 hold 转成确认预约 | 校验 hold 未过期；发确认消息 |
| `cancel_reschedule` | 取消/改期 | 套取消政策；只能操作**本人**的预约 |
| `hair_profile_write` | 写发质档案 | 只在客户明确确认后调用；标记自报/推断 |
| `escalate_to_human` | 升级人工 | 带完整对话上下文；投诉/议价/健康问题强制走这条 |

> **工具描述模板**：一句话说"什么时候用"，一句话说"不要用在哪"，再给 1 个入参示例。
> 反例：`"查促销"`。
> 正例：`"当客户询问优惠、折扣、套餐时用。返回结果为空就是当前没有促销，不要自己编。不要用它查服务原价——原价用 service_catalog。入参：{\"customer_id\":\"c_123\",\"service_id\":\"svc_cut\"}"`

---

## 4. 架构

```
渠道触发（Chat Trigger / WhatsApp / IG Webhook）
        │
   [输入规范化 + 客户识别 Set]
        │
   ┌────▼──────────────────────────┐
   │       AI Agent (Tools)        │
   │  ├─ Chat Model ←── 可替换层（§6）
   │  ├─ Memory（多轮对话必需）
   │  ├─ Output Parser (Structured)
   │  └─ Tools ×11（§3）
   └────┬──────────────────────────┘
        │
   [护栏校验节点] ── 价格/促销/时段 与工具返回逐项比对
        │              ↓ 不一致
        │         [拦截 + 升级人工]
        │
   [Evaluation: Check if evaluating] ──是──► [Set Metrics]
        │否
   [回复投递 / Shadow 模式下先给人工复核]
```

三条设计原则：

1. **LLM 负责理解与表达，不负责决策与计算。** 发型师排序、促销资格、槽位冲突全部在工具里用确定性逻辑算好，LLM 只解释结果。
2. **只读工具和写工具分开建设。** Phase 1–3 全部只读，跑顺了再开写操作。
3. **护栏是独立节点，不是 prompt。** prompt 里写"不要编价格"只是降低概率；真正的保证是在 agent 输出后拿工具返回值逐项核对。

---

## 5. 护栏设计（这个用例的核心）

| 护栏 | 实现 |
|---|---|
| **禁止编造价格/促销/时段** | agent 输出走 Structured Output Parser，把提到的价格/促销 id/时段抽成字段；校验节点拿本轮工具返回值逐项比对，对不上就拦截 |
| **写操作幂等** | 每个写工具带 idempotency_key；重复调用返回同一结果而非新建 |
| **越权保护** | `cancel_reschedule` 只接受当前会话已识别客户的预约 id，不接受模型自由传入 |
| **健康话题拦截** | 关键词 + 模型分类双路检测，命中即走 `escalate_to_human`，不让 agent 自由发挥 |
| **照片处理** | 上传前显式征得同意；只用于当轮建议，默认不长期留存（保留需单独授权） |
| **兜底** | Max Iterations 耗尽、连续工具失败、低置信度 → 一律升级人工，不硬编答案 |

---

## 6. 分阶段执行

### Phase 0 — 数据与契约（1–2 天）
- [ ] 建 §2 的 7 张表，灌真实的服务/价格/发型师数据（假数据会让后面所有评估失真）
- [ ] 定 `style_taxonomy` 受控词表（建议 20–30 条起步，中英双语）
- [ ] 写 **golden 对话集 v0**：新预约 / 改期 / 取消 / 促销询问 / 发型咨询 / 投诉升级 各 3–5 条
- [ ] 写 **adversarial 集**：问不存在的促销、要求超低价、试图改别人的预约、问脱发怎么治
- 产出：数据表 + 两份数据集

> 先写用例再写流程。否则后面调 prompt 时无法判断是变好还是变坏。

### Phase 1 — 只读闭环（1–2 天）
- [ ] Chat Trigger → AI Agent → `service_catalog` + `get_promotions`
- [ ] 打开 **Return Intermediate Steps**，确认模型真在调工具而不是凭记忆瞎编
- 验收：问价格和促销，答案 100% 来自工具返回；问不存在的促销会老实说没有

### Phase 2 — 发型与发质咨询（2 天）
- [ ] `classify_style`：文本路径先做，vision 路径后加（AI Agent 的 **Automatically Passthrough Binary Images** 选项）
- [ ] `hair_profile_read/write`：问卷式建档，**客户确认后才落库**
- [ ] 低置信度时反问澄清，不猜
- 验收：分类结果全部落在受控词表内；发质字段正确标记自报/推断

### Phase 3 — 发型师匹配（1 天）
- [ ] `match_stylist` 用 Custom Code Tool 写确定性打分（发型专长 / 发质经验 / 语言 / 价位 / 档期）
- [ ] 返回 top-3 + 每条的匹配理由，由 LLM 组织成自然语言
- 验收：同样输入永远得到同样排序；无匹配时能自动放宽条件而非强推

### Phase 4 — 写操作与事务（2–3 天）
- [ ] `find_slots` → `hold_slot` → `confirm_booking` 三段式
- [ ] 幂等键 + TTL + 过期释放
- [ ] `cancel_reschedule` + 取消政策
- [ ] **并发测试**：两个会话抢同一槽位，必须只有一个成功
- 验收：无重复下单、无槽位冲突；重复点击不产生第二条预约

### Phase 5 — 护栏与越界（1–2 天）
- [ ] 实现 §5 全部护栏
- [ ] 跑 adversarial 集，逐条确认被正确拦截
- [ ] 故障注入：后端超时、返回非 JSON、槽位在确认瞬间被抢走
- 验收：adversarial 集 100% 拦截；故障注入下不崩、返回可解释的失败

### Phase 6 — 评估（2 天）
- [ ] **Light evaluations** 跑手选用例，开发期快速反馈
- [ ] **Metric-based evaluations**：Evaluation 节点 → Set Metrics
- [ ] 指标（本用例专属，比通用指标重要得多）：

| 指标 | 目标 |
|---|---|
| 价格/促销幻觉率 | **0** |
| 预约完成率（该成功的成功了） | ≥90% |
| 误升级率（不该转人工却转了） | ≤10% |
| 漏升级率（该转人工却硬答） | **0**（健康/投诉类） |
| 平均对话轮数 | 越低越好，但不以牺牲准确性为代价 |
| 槽位冲突次数 | **0** |
| 端到端延迟 / token 成本 | 记录基线，换模型时对比 |

- 验收：改 prompt 或换模型后，能用同一数据集给出可比的分数表

### Phase 7 — 模型可替换 + 多语言（1 天）
- [ ] 见 §7 的两种切换方案
- [ ] 多语言：至少中英；语言偏好存 `customers` 表，不靠模型每轮猜
- 验收：切换模型只改一处配置，agent 结构不动

### Phase 8 — 迁回自托管（1 天）
- [ ] 见 §9 迁移清单
- 验收：同一数据集在本地 stack 上跑出与 Cloud 可比的 metrics

### Phase 9 — 试运行（持续）
- [ ] **Shadow 模式**：agent 起草，人工过目后发送。攒真实对话，同时不冒险
- [ ] 按类别逐步放开自动发送：先只读咨询 → 再改期取消 → 最后新预约
- [ ] 用 2.0 的 **Save vs Publish** 分离草稿与线上版本
- [ ] 错误工作流（Error Trigger）+ 每日人工抽检
- [ ] 备份 `n8n-data` 卷（workflows + credentials + SQLite 全在里面）

**总计约 2–3 周**（按每天投入半天算）。

---

## 7. 模型可替换的两种做法

**方案 A：OpenAI-compatible 网关（推荐做默认切换点）**
用 OpenAI Chat Model 节点，凭证里改 **Base URL** 指向网关（OpenRouter / 自建 LiteLLM / Ollama 的 `/v1`）。换模型 = 改一个字符串，agent 图完全不动。

**方案 B：并排多个 Chat Model 节点 + Switch**
为评估横评服务：同一输入分别走 Anthropic / OpenAI / Ollama 三个分支，结果汇到同一个 Evaluation 节点出对比表。成本更高但一次跑完。

建议：**日常开发用 A，Phase 6 横评用 B。**

关于 Ollama：机器上已有 `~/.ollama`。本地模型省钱，但**工具调用能力明显弱于云端模型**——这个用例有 11 个工具、多轮状态、严格护栏，预期本地模型掉分严重。当成本下限的对照组，不要当主力。

---

## 8. 待定决策

开工前需要拍板：

1. **预约后端**：接现有系统（Fresha / Booksy / Square Appointments / Timely）还是自建（Google Calendar / Cal.com / Data Table）？
   → 计划里已把它包成**适配层子流程**，先用 Data Table 起步，后面换后端不用动 agent。但如果店里已有系统，Phase 0 就该确认它的 API 能力（尤其是**原子占位**，很多预约系统没有 hold 语义）。
2. **渠道**：Web 聊天 / WhatsApp / Instagram DM / 微信？美发店实际预约量大头常在 IG 和 WhatsApp。影响触发节点和消息格式，也影响能不能发图。
3. **语言**：只英文，还是中英双语？影响 `style_taxonomy` 词表和评估集规模。
4. **数据存储**：Data Table（本 stack 自足）还是 Postgres？
   → 本 stack **没有独立数据库服务**，n8n 用 SQLite。7 张表带关联查询，Data Table 可能吃力；真要 Postgres 得往 `compose.yml` 加服务。建议 Phase 0 先用 Data Table 验证，Phase 4 前评估是否迁移。
5. **隐私合规**：如果是澳洲实体运营，客户数据和照片受 Australian Privacy Principles 约束。留存期限、删除请求、照片是否长期保存——这几条建议在 Phase 0 就定死，不要等上线再补。

---

## 9. Cloud → 自托管 迁移清单

workflow JSON 可移植，环境不可移植。以下每条都可能在迁移时咬人：

| 项 | 差异 | 处理 |
|---|---|---|
| **凭证** | 不随 workflow JSON 导出 | 自托管上手动重建；提前记下每个凭证的类型和字段 |
| **Webhook 公网入口** | Cloud 自带托管 URL；自托管没有，且 **2.0 移除了 `--tunnel`** | 用 ngrok / cloudflared；本 stack 只有 5678 该对外。**WhatsApp/IG 渠道强依赖这个** |
| **Code node（Python）** | 2.0 起弃用 Pyodide，改走 task runner 原生 Python | 本 stack 已配好 `N8N_RUNNERS_MODE=external` + `runners` 容器，开箱可用 |
| **Execute Command / Local File Trigger** | 2.0 起默认禁用（安全） | 别让 agent 依赖它们 |
| **OAuth 回调** | `N8N_SKIP_AUTH_ON_OAUTH_CALLBACK` 默认从 true 改为 false | 走 OAuth 的凭证（如 Google Calendar）需确认回调可达 |
| **社区节点 / 外部 npm 包** | 自托管可自由安装，Cloud 受限 | **原型阶段只用内置节点**，保证双向可移植 |
| **企业功能** | projects / environments / external secrets / source control 在社区版自托管上没有 | 不要让流程逻辑依赖它们 |
| **数据库** | 本 stack 无独立 DB，n8n 用 SQLite | 见 §8 决策 4 |
| **客户数据迁移** | Cloud 上攒的测试数据要不要带走 | 真实客户数据迁移前先确认合规；建议 Cloud 阶段只用脱敏假数据 |

> **白拿的搜索工具**：`.env` 里的 `N8N_INSTANCE_AI_SEARXNG_URL` 是给 n8n **内置 AI 助手**用的，不是给你的 workflow。但两个容器在同一 compose 网络上，HTTP Request Tool 可以直接打 `http://searxng:8080/search?q=...&format=json`（json 格式 `searxng-settings.yml` 已开）。本用例用不太上，但做发型趋势/产品资料查询时是零成本选项。

---

## 10. 已知的坑

- **子节点里的表达式只取第一项**。tool / model 等 sub-node 中 `{{ $json.name }}` 永远解析成第一条数据，即使上游有 5 条。这是 sub-node 的固有行为——需要逐条处理时用子流程 tool。
- **工具描述写不好 = agent 不调用或乱调用**。debug 时先怀疑 description，再怀疑模型。
- **Max Iterations 默认 10**。11 个工具 + 多轮预约协商很容易撞上限并被静默截断。开 Return Intermediate Steps 才看得出来。
- **Streaming 默认开启**。护栏校验节点需要完整输出才能比对，这个用例**建议关掉**。
- **Memory 是必需的但也是风险**。多轮对话要记住上下文，但过长的历史会推高成本、也会让模型翻出早已作废的槽位信息。设窗口上限。
- **上下文成本随 tool call 线性增长**——每轮重发全部历史。Phase 6 的成本指标必须实测。
- **Agent 类型无需选择**——1.82.0 起 agent type 参数已废弃，全部按 `Tools Agent` 运行（v1 节点将在 n8n 3.0 移除）。

---

## 参考

- [n8n AI Agent 节点](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/) / [Tools Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent)
- [Call n8n Workflow Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolworkflow) / [Custom Code Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolcode) / [MCP Client Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp)
- [Evaluations 总览](https://docs.n8n.io/advanced-ai/evaluations/overview/) / [Light](https://docs.n8n.io/advanced-ai/evaluations/light-evaluations/) / [Metric-based](https://docs.n8n.io/advanced-ai/evaluations/metric-based-evaluations/) / [Evaluation 节点](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.evaluation)
- [v2.0 破坏性变更](https://docs.n8n.io/changelog/v20-breaking-changes)
- [版本对比](https://docs.n8n.io/deploy/host-n8n/community-edition-features)


