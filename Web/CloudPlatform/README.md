# 物流分拣云平台（CloudPlatform）

物流分拣工厂的现场数据看板，按《物流分拣工厂云平台设计方案》实现。React 19 + TypeScript + Vite，图表使用 ECharts，图标使用 lucide-react。

## 页面

- `/dashboard` 数据看板：温度、湿度、光照当前值、车间环境趋势、PM2.5 仪表、中国地图分拣去向与地区排行、演示数据标识；温度/湿度柱按窗口聚合成最多 10 组，光照折线保留分钟点；环境趋势读取 `/api/history/{metric}` 最近 60 分钟记录，缺失分钟用前后相邻数据平均补齐；光照轴固定 0–700 lx；顶栏与面板时间取本机当前时间。
- `/devices` 设备传感器：传感器按数据项拆卡（温度、湿度、PM2.5、CO₂、TVOC、人体、光照、烟雾、气压）；执行器按负载合并为风扇、照明、烟雾报警、大门（DO4/DO5 开门/关门/停止）和三色灯（红灯 DO8、黄灯 DO7、绿灯 DO6），名称可本地修改；页面右下角“调整布局”可调卡片宽度、高度和卡间距；开关免确认，下发后延时核对，失败自动回退并用顶部提示反馈。
- `/operations` 运行数据：顶部黑色终端实时轮询 sorter.log（最近 200 行，每 2 秒）；快递记录读取 sorter-api `/records`（最近最多 500 条，前端分页）；员工签到读取 `/api/rfid` 的读卡器打卡记录，支持分页和刷新。
- `/rules` 规则设置：PM2.5 分级/显示量程与其他指标上限；可添加“传感器比较条件 + 与/或 + 执行器动作/弹窗提醒”的本地规则，支持启停。规则按边沿触发，同一轮持续满足只执行一次；服务端环境联动已关闭，由本页规则下发执行器动作。
- `/settings` 设置中心：外观与字号、数据轮询、规则采样间隔、连接诊断、采集服务地址、分拣服务地址；只保存在当前浏览器。

## 运行

需要 Node.js 20+（建议 22/24）。本机 PATH 中的 Node 版本较旧时，可使用已下载的便携版：

```bash
# 如果系统 Node 版本较旧，可把便携版目录加入 PATH
export PATH="/d/Youxin/.tools/node-v24.18.0-win-x64:$PATH"

npm install
npm run dev
```

默认打开 `http://localhost:5173`。Vite 会把 `/api` 代理到 `http://127.0.0.1:81`（采集服务与本项目同机运行）。

### 使用本地 mock API

```bash
# 终端 1
npm run mock

# 终端 2（Git Bash）
API_PROXY_TARGET=http://127.0.0.1:8091 npm run dev
```

mock 仅用于界面联调，不写入真实采集服务；生产构建不要启动 mock。mock 同时提供 `/records` 与 `/logs`。使用 mock 时启动 `SORTER_PROXY_TARGET=http://127.0.0.1:8091 npm run dev`，或在设置中心把“分拣服务地址”改为 `http://127.0.0.1:8091`。

### API 地址

- 采集服务运行在 K1 板子本机：`127.0.0.1:81/api`；分拣服务运行在板子本机：`127.0.0.1:82`。页面通过板子 nginx 同源代理 `/api` 和 `/sorter` 访问，平板只需访问 `http://192.168.1.102/`。
- 分拣服务（快递记录、运行日志）：默认 `/sorter`，Vite 开发代理转发到 `http://192.168.1.102:82`；也可在设置中心直接填该完整地址。`/sorter` 方式可避免平板直连板子和 HTTPS 混合内容问题。
- Vite 开发代理目标可用 `API_PROXY_TARGET` 和 `SORTER_PROXY_TARGET` 覆盖；也可复制 `.env.example` 为 `.env.local` 修改。
- 平板访问时，设置中心可改为对应主机的局域网地址；不能填 `localhost` / `127.0.0.1`，那会指向平板自身。
- 生产建议 nginx 同源反代 `/api` 到采集服务、`/sorter/` 到分拣服务；直连跨域需要后端开启 CORS，HTTPS 页面直连 HTTP 会被混合内容拦截。

## 构建

```bash
npm run build
npm run preview
```

构建产物在 `dist/`。部署时把 `dist/` 交给静态服务器，并把 `/api` 反代到采集服务。

## 部署到 K1（Bianbu / riscv64）

推荐在 PC 上构建后复制静态产物，板子只运行 nginx，不在 riscv64 上安装 Node/Vite：

```bash
# PC 上构建（Node 20+）
npm run build

# 复制到 K1
tar -C dist -cf - . | ssh bianbu "mkdir -p /var/www/cloudplatform && tar -xf - -C /var/www/cloudplatform"
```

板端 nginx 站点 `cloudplatform` 监听 80 端口，静态目录 `/var/www/cloudplatform`，并将：

- `/api/` 反代到板子本机 `127.0.0.1:81/api/`（环境、打卡、DO）。
- `/sorter/` 反代到板子本机 `127.0.0.1:82/`（快递记录、日志）。

当前 K1 访问地址为 `http://192.168.1.102/`。nginx 已设置开机启动；81/82 采集服务需自行保证开机启动。

Node 说明：Bianbu 仓库自带 Node 18.19，低于 Vite 8 要求；Node 24 的 riscv64 构建可从 `https://unofficial-builds.nodejs.org/download/release/` 或 `gounthar/unofficial-builds` 获取。但 Vite 8 的 Rolldown 当前没有 riscv64 原生绑定，**不建议在板子上直接 `npm install && npm run build`**；请继续在 PC 上构建并复制 `dist/`。

## 数据边界

- `/api/data` 返回 `iot` 与 `multi_in_one` 最新数据，每个源带 `source`：`live` 实时、`history` 最近一分钟平均、`stale` 过期回退；温度、湿度优先使用 `multi_in_one`，温度在多合一缺失时回退 `iot`。
- `/api/rfid?start=1&count=20` 提供读卡器打卡记录（姓名、签到时间，按时间倒序）；没有工号、班次和应到名单，不计算出勤率、迟到或缺勤。
- `/api/history/{metric}` 提供温度、湿度、光照的分钟历史（最近 60 分钟，温度同时返回 `multi_in_one` 与 `iot`，优先多合一）；曲线缺失分钟用前后相邻值按时间比例平均补齐。PM2.5 没有历史接口，只显示实时快照。
- sorter-api（默认经页面同源 `/sorter` 代理到 `http://192.168.1.102:82`，设置中心可改直连）提供 `GET /records?limit=500` 快递完成记录（字段：pid、time、province、category、servo、result、ocr_calls）和 `GET /logs?lines=200` 纯文本日志。日志是尾部查询，页面每 2 秒轮询；接口没有 SSE/WebSocket，也没有分页游标，快递记录一次读取最近 500 条后在前端分页。接口无鉴权，仅用于可信局域网。
- 执行器没有硬件回读：命令下发后不做二次确认，约 0.9 秒后逐路 GET 核对；核对一致才保留开关状态，失败或超时自动回退并弹出顶部提示；不自动重发。DO4/DO5 由服务端互锁。
- 设置、执行器名称、卡片布局和规则只写当前浏览器 `localStorage`；不改变服务端记录或物理负载。
- 地图、排行、合计使用固定演示数据（2026-11-03，合计 1,205 件），港澳不参与统计；接入真实统计接口后替换数据源。
- 有启用规则时，环境数据按“轮询间隔”和“规则采样间隔”中更快的一个刷新，规则采样可在设置中心设为 1/2/3/5 秒；无启用规则时恢复普通轮询间隔。规则只在本页打开时评估，且只在条件由不满足变为满足时触发一次。
- 页面不再展示百叶箱数据或“IoT 采集器/一体环境传感器”的分类标签。

## 设计文档

完整设计、信息架构、线框、视觉规范、组件状态、移动端检查与复盘：

`../CloudPlatform-设计方案.md`

## 目录

```
src/
  components/charts/   环境图、PM2.5 仪表、中国地图、排行
  components/devices/  传感器数据卡、执行器开关、大门与三色灯
  components/operations/ 实时日志终端、快递记录
  components/layout/   右侧导航、顶栏、状态条、抽屉
  components/ui/       按钮、徽章、弹层、表单、Toast
  lib/                 API、分拣服务客户端、设置、轮询、历史、阈值、执行器名称/布局/下发、演示数据、地图
  pages/               五个页面
scripts/mock-api.mjs   本地联调 mock（非生产）
```
