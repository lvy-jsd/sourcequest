# DSH rc.5 兼容勘验

核对对象为实际已部署的 DSH `0.2.2-rc.5` 和 Cordis `4.1.0`。以下检查读取发行包清单与类型声明，并在独立 Node 进程导入所列符号。本页记录接口依据与最小插件的隔离验收。

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

## 隔离 profile 验收

- 本地以锁定的 rc.5 类型编译，通过真实 Cordis 和 DSH 注册表验证作用域隔离与插件 fiber 释放。
- 推理机以独立 `DSH_HOME` 和仅监听回环的 Web profile 加载 tarball。诊断工具通过真实 `ctx.tools.execute` 返回 `{"plugin":"sourcequest","status":"loaded"}`。移除包后重新启动，注册表中已无诊断工具。
- tarball 只包含插件入口、bundle 补丁和包元数据等发布文件。隔离 profile 的依赖目录未安装第二份 DSH SDK。pnpm 会提示未安装 peer，当前 DSH 加载器使用宿主实例。
- 认证 RPC、持久目录、Artifact 读取与其他表中接口的业务行为随各自任务验证。[上游仓库](https://github.com/deepseek-ai/deepseek-harness)

在已安装 DSH 0.2.2-rc.5 的环境中复现，从项目根目录执行：

```sh
npm ci
npm run check
npm test
lab=$(mktemp -d)
tarball=$(npm pack --pack-destination "$lab" --silent)
cp test/fixtures/dsh-smoke.mjs "$lab/"
cat > "$lab/smoke.yml" <<'YAML'
- insert:
    - id: sourcequest-smoke
      name: ./dsh-smoke.mjs
YAML
export DSH_HOME="$lab/home"
dsh plugin --profile web add "$lab/$tarball"
SOURCEQUEST_SMOKE_STATE=installed dsh web --patch "$lab/smoke.yml" --host 127.0.0.1 --port 13097 --no-open
```

看到 `sourcequest-profile-smoke: installed OK` 后用 Ctrl+C 停止隔离实例，再在同一个 shell 中执行：

```sh
dsh plugin --profile web remove @lvy-jsd/dsh-sourcequest
SOURCEQUEST_SMOKE_STATE=removed dsh web --patch "$lab/smoke.yml" --host 127.0.0.1 --port 13097 --no-open
```

看到 `sourcequest-profile-smoke: removed OK` 后停止实例。


### 研究链路烟测

隔离 profile 用合成搜索源验证真实 DSH 执行，使用一个公开示例页面验证 HTTPS 读链路。搜索源模拟一条失败和一条成功，无需配置搜索凭据。

在上面的安装流程里，把 [dsh-research.mjs](../test/fixtures/dsh-research.mjs) 一同复制到隔离目录。在 `smoke.yml` 现有条目之后追加以下补丁，然后启动 Web profile：

```yaml
- id: web
  config:
    searchProvider: sourcequest-test
- insert:
    - id: sourcequest-research-smoke
      name: ./dsh-research.mjs
```

实测成功时日志含 `sourcequest-research-smoke: search partial success and public read OK`。移除插件后使用原诊断补丁启动，验证两个工具都已移除。运行此烟测会读取公开的示例页面；普通 CI 只使用固定测试数据。


### 快照重启验收

安装构建包后，把 [dsh-snapshot.mjs](../test/fixtures/dsh-snapshot.mjs) 复制到隔离目录。用独立补丁插入 fixture：

```yaml
- insert:
    - id: sourcequest-snapshot-smoke
      name: ./dsh-snapshot.mjs
```

用 `SOURCEQUEST_SNAPSHOT_STAGE=write` 启动，等待 `sourcequest-snapshot-smoke: saved <hash>`。停止进程后用同一个隔离 `DSH_HOME`、`SOURCEQUEST_SNAPSHOT_STAGE=read` 和 `SOURCEQUEST_SNAPSHOT_HASH=<hash>` 再启动。成功时日志为 `sourcequest-snapshot-smoke: restart retrieval and owner isolation OK`。fixture 以合成会话身份调用宿主注册的工具，验证工具层 owner 检查与跨进程持久性。客户端认证另行验证。


### 后台任务验收

把 [dsh-jobs.mjs](../test/fixtures/dsh-jobs.mjs) 放在隔离目录，在 Web profile 中用以下补丁启动：

```yaml
- id: web
  config:
    searchProvider: sourcequest-jobs-test
- insert:
    - id: sourcequest-jobs-smoke
      name: ./dsh-jobs.mjs
```

fixture 创建两个宿主 Agent，无需模型认证或模型请求。它通过 DSH 执行工具，验证原生作业提交、幂等键、结果与会话归属，再取消进行中的合成查询。成功日志为 `sourcequest-jobs-smoke: native submit, deduplication, result, ownership and cancellation OK`。任务存储重开及旧代际保护由 `npm test` 验证。
