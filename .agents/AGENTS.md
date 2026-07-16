# 项目定制规则

## 异步任务设计原则
- 所有由 PC 端下发给移动端执行的任务，在 PC 端的 HTTP API 设计中必须且只能以**异步**方式提供。
- API 接收到请求后，必须立即在内存中创建任务，向 MQTT 队列中发送任务载荷，并立刻返回包含 `taskId` 和 `EXECUTING` 状态的响应。
- 严禁在 HTTP 路由处理器中通过 Promise 或事件监听等方式同步阻塞等待任务的执行回调。
- 调用方必须通过轮询 `GET /api/tasks/:taskId` 接口或等待回调通知来获取最终的执行状态和返回的数据。

## JSDoc 注释与 Swagger 自动生成规范
- 所有的函数、类、公共接口方法均必须且只能使用标准的 **JSDoc** 格式（即 `/** ... */`）进行注释，包含对方法功能、参数（`@param`）、返回值（`@returns`）的明确描述。严禁使用双斜线（`//`）作为函数的文档注释。
- 控制器（Controller）中的 HTTP 路由处理函数，必须在 JSDoc 注释中以 `@swagger` 或 `@openapi` 标签加 YAML 语法来编写接口规范定义。
- 系统启动时将自动通过 `swagger-jsdoc` 扫描这些注释并生成 OpenAPI 文档，严禁编写独立的 Swagger 配置文件。

## 接口响应出参规范
- 所有的 HTTP 接口响应报文，其根节点必须且只能使用统一的 `{ ok: boolean; message: string; data: Record<string, any> }` 结构。
- 严禁直接返回没有 ok/message/data 包裹的扁平响应结构，且 data 属性严禁为 null。
- 成功时，`ok` 设为 `true`，业务返回值置于 `data` 内部（若无返回数据则必须设为空对象 `{}`）；失败或异常时，`ok` 设为 `false`，异常报错信息写入 `message`，同时 `data` 置为空对象 `{}`。
