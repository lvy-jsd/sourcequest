# DSH rc.5 兼容勘验

核对对象为实际已部署的 DSH `0.2.2-rc.5` 和 Cordis `4.1.0`。以下检查读取发行包清单与类型声明，并在独立 Node 进程导入所列符号。本页记录接口依据，运行兼容仍待探原最小 bundle 的隔离验收。

| 接口 | rc.5 依据 | 探原首期用法 |
|---|---|---|
| 网页 | `@deepseek-ai/dsh-web` 导出 `WebError`。`ctx.web` 有 `search`、`fetch`、Provider 注册与释放接口。 | 复用宿主查询路径。多查询失败隔离由探原编排。可选 Provider 后续单独核验选择与卸载。 |
| 工具 | `@deepseek-ai/dsh-tools` 导出 `defineTool`。工具注册返回释放函数，`schemas` 支持 scope。 | 最小 bundle 验证注册、可见性和关闭后的清理，再接研究入口。 |
| 模型 | `@deepseek-ai/dsh-llm` 声明 `ctx.llm.prepareCall` 与 `stream`。 | 以宿主模式调用，验证实际模型身份、取消和结构化返回。 |
| 背景任务 | `@deepseek-ai/dsh-jobs` 声明 `start`、`attachController` 与按会话控制。 | 运行句柄与持久 taskId 分开。跨重启续跑依靠探原的检查点。 |
| 小型持久状态 | `@deepseek-ai/dsh-storage-domain` 导出 `defineDomain`、`domainTable`，服务有 `open`。 | 保存设置、任务元数据和检查点。 |
| 凭据 | `@deepseek-ai/dsh-credentials` 导出 `credentialRef`，服务有 `resolve`。 | 保存凭据引用。实际解析与访问范围在执行测试中验证。 |
| 大文本产物 | `@deepseek-ai/dsh-spill` 提供按会话保存文本的服务接口。 | 核对 profile 提供的实现、保留时间和读取权限。持久证据目录单独验证。 |
| 工作流 | `@deepseek-ai/dsh-workflow` 导出 `WorkflowEngine`，服务名为 `workflowEngine`。 | 研究核心使用自有状态契约。宿主 workflow 为可选适配。 |
| Web 与客户端 | `@deepseek-ai/dsh-host-webserver` 有返回释放函数的路由注册接口，Web profile 安装了 `dsh-client-ui-slots@0.2.2-rc.5`。 | 在隔离 profile 核对客户端挂载、认证、会话边界和重载。 |

已验证导入 `WebError`、`defineTool`、`defineDomain`、`domainTable`、`credentialRef`、`SpillStore` 与 `WorkflowEngine`。该检查验证模块入口与导出，服务是否在特定 profile 或 preset 里可用需要独立验证。

首个运行验收使用锁定发行包、干净 profile 和合成数据。最小 bundle 需能加载、注册诊断工具、调用并卸载，确认作用域与释放语义。随后编译针对实际发行类型的工具调用，确定认证 RPC、持久目录和 Artifact 读取的公开入口。[上游仓库](https://github.com/deepseek-ai/deepseek-harness)
