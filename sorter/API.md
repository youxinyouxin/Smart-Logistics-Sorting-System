# 分拣系统 HTTP 接口文档

- 服务名称：`sorter-api`
- 版本：1.0
- 监听地址：`0.0.0.0:82`
- 局域网地址：`http://192.168.1.102:82`（板子 IP 可能变化，以实际为准）
- 数据格式：JSON（UTF-8）；日志接口为纯文本（UTF-8）
- 交互式文档：`http://192.168.1.102:82/docs`（Swagger UI）
- 服务管理：
  ```bash
  systemctl status sorter-api
  systemctl restart sorter-api
  journalctl -u sorter-api -f
  ```

> 接口无鉴权，仅建议在可信局域网内使用。若需公网访问，请在反向代理层加 Token / IP 白名单。

---

## 1. 数据来源

| 数据 | 位置 | 说明 |
|---|---|---|
| 快递记录 | `/root/sorter/Record/*.json` | 每件分拣完成后生成一个文件 |
| 运行日志 | `/root/sorter/sorter.log` | 分拣程序实时写入 |

接口每次请求都直接读取上述文件，无额外数据库。

### 记录 JSON 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `pid` | int | 分拣程序内部快递编号（程序重启后从 1 重新计数） |
| `time` | string | 完成时间，板子本地时间，格式 `YYYY-MM-DD HH:MM:SS` |
| `timestamp` | int | Unix 时间戳（秒） |
| `province` | string | 识别出的省份；失败件可能为空字符串 |
| `category` | string | `省内` / `货运` / `空运`；失败件可能为空 |
| `servo` | string | 触发的舵机编号 `1` / `2`；省内或失败件为空 |
| `result` | string | 完成/异常结果说明 |
| `ocr_calls` | int | 该件实际调用 OCR 的次数（1 或 2） |
| `_file` | string | 接口附加字段：记录文件名（不在磁盘 JSON 中） |

记录文件示例：
```json
{
  "pid": 12,
  "time": "2026-11-06 16:05:00",
  "timestamp": 1762416300,
  "province": "广东省",
  "category": "省内",
  "servo": "",
  "result": "省内直通完成（目标离开画面）",
  "ocr_calls": 1
}
```

---

## 2. 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 服务信息与接口列表 |
| GET | `/health` | 健康检查、记录数量 |
| GET | `/records` | 查询快递记录（倒序） |
| GET | `/records/latest` | 最近一条记录 |
| GET | `/logs` | 查询最近运行日志 |
| GET | `/docs` | Swagger 交互文档 |

所有接口均支持跨域（CORS `*`）。

---

## 3. 接口详情

### 3.1 `GET /`

返回服务基本信息和接口列表。

请求示例：
```bash
curl http://192.168.1.102:82/
```

响应示例：
```json
{
  "service": "sorter-api",
  "port": 82,
  "endpoints": ["/health", "/records", "/records/latest", "/logs", "/docs"],
  "record_dir": "/root/sorter/Record",
  "log_file": "/root/sorter/sorter.log"
}
```

---

### 3.2 `GET /health`

健康检查。`records` 为当前记录文件数量。

请求示例：
```bash
curl http://192.168.1.102:82/health
```

响应示例：
```json
{"ok": true, "records": 27}
```

---

### 3.3 `GET /records`

查询快递记录，按 `timestamp` 倒序返回。

查询参数：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `limit` | int | 否 | 100 | 返回数量，范围 1–5000 |
| `province` | string | 否 | 无 | 按省份精确筛选，如 `广东省` |

请求示例：
```bash
# 最近 100 条
curl "http://192.168.1.102:82/records?limit=100"

# 最近 20 条广东省记录
curl "http://192.168.1.102:82/records?limit=20&province=广东省"
```

响应示例：
```json
{
  "count": 1,
  "records": [
    {
      "pid": 12,
      "time": "2026-11-06 16:05:00",
      "timestamp": 1762416300,
      "province": "广东省",
      "category": "省内",
      "servo": "",
      "result": "省内直通完成（目标离开画面）",
      "ocr_calls": 1,
      "_file": "20261106_160500_P12.json"
    }
  ]
}
```

说明：
- 没有记录时返回 `{"count": 0, "records": []}`；
- `limit` 超出范围返回 HTTP 422；
- 筛选不存在的省份返回 `count: 0`。

---

### 3.4 `GET /records/latest`

返回最近一条记录。没有记录时返回空对象 `{}`。

请求示例：
```bash
curl http://192.168.1.102:82/records/latest
```

响应示例：
```json
{
  "pid": 12,
  "time": "2026-11-06 16:05:00",
  "timestamp": 1762416300,
  "province": "广东省",
  "category": "省内",
  "servo": "",
  "result": "省内直通完成（目标离开画面）",
  "ocr_calls": 1,
  "_file": "20261106_160500_P12.json"
}
```

---

### 3.5 `GET /logs`

返回 `sorter.log` 的最后 N 行，纯文本（`text/plain`）。

查询参数：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `lines` | int | 否 | 200 | 返回行数，范围 1–5000 |

请求示例：
```bash
curl "http://192.168.1.102:82/logs?lines=200"
```

响应示例（纯文本）：
```text
[16:05:00] P12 锁定为当前快递，提交 OCR（本件第 1/2 次）
[16:05:02] P12 OCR 截图: /root/sorter/captures/20261106_160500_P12.jpg 文本: '广东省'
[16:05:02] P12 省份=广东省，提交 LLM 分类
[16:05:03] P12 分类=省内
[16:05:03] 传送带启动（省内直通，启动传送带）
[16:05:08] P12 完成：省内直通完成（目标离开画面）｜OCR 1 次｜省份 广东省｜分类 省内｜舵机 None
[16:05:08] 传送带停止（流程结束）
```
- 日志文件不存在时返回空字符串；
- 接口为“尾部查询”，不是 WebSocket/SSE 流；需要实时日志请定时轮询。

---

### 3.6 `GET /docs`

FastAPI 自动生成的 Swagger UI，可在浏览器中直接调试以上接口：
```
http://192.168.1.102:82/docs
```

---

## 4. 云平台对接建议

云平台可定时拉取：

```bash
# 拉取最近 5000 条记录
curl -s "http://192.168.1.102:82/records?limit=5000"

# 拉取最近 1000 行日志
curl -s "http://192.168.1.102:82/logs?lines=1000"
```

- 记录按 `timestamp` 倒序；云平台可按 `timestamp` 去重增量入库；
- `pid` 在分拣程序重启后会重新计数，**不要单独用 pid 作为全局唯一键**，建议用 `timestamp + pid` 或 `_file`；
- 接口无分页游标，数据量大时请用 `limit` 控制单次拉取量；
- 板子处于内网时，需要在路由器上把 82 端口映射到板子，或使用内网穿透；
- 如需板子主动推送日志/记录到云平台，需要提供云平台的接收 URL 与鉴权方式，可另加推送程序。

---

## 5. 错误码

| HTTP 状态码 | 场景 |
|---|---|
| 200 | 请求成功 |
| 422 | 查询参数不合法（如 `limit=0`、`limit=99999`、`lines=0`） |
| 500 | 服务内部异常（查看 `journalctl -u sorter-api`） |

422 响应示例（Pydantic v1 格式）：
```json
{
  "detail": [
    {
      "loc": ["query", "limit"],
      "msg": "ensure this value is less than or equal to 5000",
      "type": "value_error.number.not_le",
      "ctx": {"limit_value": 5000}
    }
  ]
}
```

---

## 6. 运行环境

| 项目 | 说明 |
|---|---|
| Web 框架 | FastAPI 0.101.0 |
| ASGI 服务器 | Uvicorn 0.27.1 |
| Pydantic | 1.10.14 |
| Python | 3.12 |
| systemd 服务 | `sorter-api.service`（已开机自启） |
| 端口 | 82（需要 root 权限） |

重装依赖（如需）：
```bash
apt-get install -y python3-fastapi python3-uvicorn
```

---

## 7. 注意事项

1. 记录由**新版分拣程序**写入；旧版本运行期间 `/records` 会为空。
2. 记录写入采用 `.tmp` + 原子重命名，接口不会读到半截 JSON。
3. 接口无鉴权、无速率限制；公网暴露前务必加反向代理和访问控制。
4. 时间使用板子本地时区；如果板子时区不是东八区，请先校正 `timedatectl`。
