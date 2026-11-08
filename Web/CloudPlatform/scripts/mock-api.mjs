import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT || 8091)
const doState = { DO1: false, DO2: false, DO3: false, DO4: false, DO5: false, DO6: false, DO7: false, DO8: false }
const control = { pm25_threshold: 75, light_threshold: 200, fan_do: 1, light_do: 2 }
const nowStamp = (date) => {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
const rfid = [
  { time: nowStamp(new Date(Date.now() - 1000 * 60 * 12)), name: '小明' },
  { time: nowStamp(new Date(Date.now() - 1000 * 60 * 28)), name: '小黄' },
  { time: nowStamp(new Date(Date.now() - 1000 * 60 * 57)), name: '小明' },
]

const sorterProvinces = ['广东省', '浙江省', '江苏省', '上海市', '北京市', '河北省', '四川省', '山东省']
const sorterRecords = Array.from({ length: 27 }, (_, index) => {
  const date = new Date(Date.now() - index * 95_000)
  const failed = index % 11 === 0
  const province = failed ? '' : sorterProvinces[index % sorterProvinces.length]
  const category = failed ? '' : province === '广东省' ? '省内' : index % 2 === 0 ? '货运' : '空运'
  const servo = category === '货运' ? '1' : category === '空运' ? '2' : ''
  return {
    pid: 27 - index,
    time: nowStamp(date),
    timestamp: Math.floor(date.getTime() / 1000),
    province,
    category,
    servo,
    result: failed
      ? 'OCR 识别失败，等待人工处理'
      : category === '省内'
        ? '省内直通完成（目标离开画面）'
        : `${category}分拣完成（舵机 ${servo}）`,
    ocr_calls: failed || index % 5 === 0 ? 2 : 1,
    _file: `${nowStamp(date).replace(/[-: ]/g, '').slice(0, 14)}_P${27 - index}.json`,
  }
})

let logSequence = 0

function sorterLogs() {
  logSequence += 1
  const now = Date.now()
  const messages = [
    '锁定为当前快递，提交 OCR（本件第 1/2 次）',
    "OCR 截图完成 文本: '广东省'",
    '省份=广东省，提交 LLM 分类',
    '分类=省内',
    '传送带启动（省内直通，启动传送带）',
    '完成：省内直通完成（目标离开画面）｜OCR 1 次｜省份 广东省｜分类 省内｜舵机 None',
    '传送带停止（流程结束）',
  ]
  const lines = []
  for (let index = 0; index < 60; index += 1) {
    const date = new Date(now - (60 - index) * 1800)
    const pid = 12 + Math.floor(index / 7)
    lines.push(`[${nowStamp(date).slice(11, 19)}] P${pid} ${messages[index % messages.length]}`)
  }
  lines.push(`[${nowStamp(new Date()).slice(11, 19)}] 等待下一件快递 · 心跳 #${logSequence}`)
  return lines.join('\n')
}

function values() {
  const t = Date.now() / 1000
  const temperature = 26.4 + Math.sin(t / 90) * 1.6
  const humidity = 54 + Math.sin(t / 130) * 5
  const illumination = 520 + Math.sin(t / 75) * 70
  const pm25 = 28 + Math.sin(t / 180) * 8
  const updated = nowStamp(new Date())
  return {
    iot: {
      updated_at: updated,
      source: 'live',
      values: {
        '0': 4000,
        '2': 12791,
        '4': 4433,
        temperature: Number((temperature + 2.2).toFixed(2)),
        illumination: Number(illumination.toFixed(1)),
        di: { '0': false },
      },
    },
    multi_in_one: {
      updated_at: updated,
      source: 'live',
      values: {
        co2: Math.round(555 + Math.sin(t / 200) * 35),
        tvoc: Math.round(33 + Math.sin(t / 160) * 6),
        temperature: Number(temperature.toFixed(1)),
        humidity: Number(humidity.toFixed(1)),
        body: Math.sin(t / 40) > -0.3,
        pm2_5: Math.round(pm25),
        pressure_hpa: Number((1002.3 + Math.sin(t / 300) * 1.2).toFixed(1)),
      },
    },
  }
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  res.end(JSON.stringify(body))
}

function sendText(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  res.end(body)
}

const historyUnits = { temperature: '℃', humidity: '%RH', illumination: 'lux' }
const historyGaps = new Set([20, 21, 22, 23, 24, 42, 43])

function historyRecords(metric) {
  const end = new Date()
  end.setSeconds(0, 0)
  const records = []
  for (let back = 59; back >= 0; back -= 1) {
    if (historyGaps.has(back)) continue
    const date = new Date(end.getTime() - back * 60_000)
    const minute = nowStamp(date).slice(0, 16)
    const phase = 59 - back
    if (metric === 'temperature') {
      const multi = 26 + Math.sin(phase / 10) * 2
      records.push({ minute, source: 'multi_in_one', value: Number(multi.toFixed(1)) })
      records.push({ minute, source: 'iot', value: Number((multi + 2.2).toFixed(1)) })
    } else if (metric === 'humidity') {
      records.push({ minute, source: 'multi_in_one', value: Number((55 + Math.sin(phase / 12) * 4).toFixed(1)) })
    } else {
      records.push({ minute, source: 'iot', value: Number((500 + Math.sin(phase / 8) * 80).toFixed(1)) })
    }
  }
  return records
}

function bodyJson(req, callback) {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    try {
      callback(null, JSON.parse(raw || '{}'))
    } catch {
      callback(new Error('请求体必须是 JSON'))
    }
  })
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 200, { ok: true })
    return
  }
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'GET' && url.pathname === '/api/data') {
    send(res, 200, values())
    return
  }

  if (req.method === 'GET' && url.pathname === '/records') {
    const limit = Number(url.searchParams.get('limit') || 100)
    const province = url.searchParams.get('province')
    const filtered = province
      ? sorterRecords.filter((record) => record.province === province)
      : sorterRecords
    const records = filtered.slice(0, Number.isFinite(limit) ? Math.max(1, Math.min(5000, limit)) : 100)
    send(res, 200, { count: records.length, records })
    return
  }

  if (req.method === 'GET' && url.pathname === '/records/latest') {
    send(res, 200, sorterRecords[0] ?? {})
    return
  }

  if (req.method === 'GET' && url.pathname === '/logs') {
    const lines = Number(url.searchParams.get('lines') || 200)
    const safeLines = Number.isFinite(lines) ? Math.max(1, Math.min(5000, lines)) : 200
    sendText(res, 200, sorterLogs().split('\n').slice(-safeLines).join('\n'))
    return
  }

  const historyMatch = /^\/api\/history\/(temperature|humidity|illumination)$/.exec(url.pathname)
  if (req.method === 'GET' && historyMatch) {
    const metric = historyMatch[1]
    const source = url.searchParams.get('source')
    let records = historyRecords(metric)
    if (source) records = records.filter((record) => record.source === source)
    send(res, 200, {
      metric,
      unit: historyUnits[metric],
      start: url.searchParams.get('start'),
      end: url.searchParams.get('end'),
      count: records.length,
      records,
    })
    return
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/history/')) {
    send(res, 404, { detail: 'metric 不支持' })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/rfid') {
    const start = Number(url.searchParams.get('start') || 1)
    const count = Number(url.searchParams.get('count') || 10)
    if (!Number.isInteger(start) || start < 1) {
      send(res, 400, { detail: 'start 从 1 开始' })
      return
    }
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      send(res, 400, { detail: 'count 必须在 1~100 之间' })
      return
    }
    send(res, 200, { total: rfid.length, start, count, records: rfid.slice(start - 1, start - 1 + count) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/rfid') {
    const record = { time: nowStamp(new Date()), name: Math.random() > 0.5 ? '小明' : '小黄' }
    rfid.unshift(record)
    send(res, 200, record)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/control') {
    send(res, 200, control)
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/control') {
    bodyJson(req, (error, body) => {
      if (error) {
        send(res, 400, { detail: error.message })
        return
      }
      if (typeof body.pm25_threshold === 'number') control.pm25_threshold = body.pm25_threshold
      if (typeof body.light_threshold === 'number') control.light_threshold = body.light_threshold
      send(res, 200, control)
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/do') {
    send(res, 200, doState)
    return
  }

  const match = /^\/api\/do\/([1-8])$/.exec(url.pathname)
  if (match && req.method === 'GET') {
    const channel = Number(match[1])
    send(res, 200, { channel, value: doState[`DO${channel}`] })
    return
  }
  if (match && req.method === 'POST') {
    bodyJson(req, (error, body) => {
      if (error) {
        send(res, 400, { detail: error.message })
        return
      }
      if (typeof body.value !== 'boolean') {
        send(res, 400, { detail: 'value 必须是 true 或 false' })
        return
      }
      const channel = Number(match[1])
      doState[`DO${channel}`] = body.value
      if (body.value && channel === 4) doState.DO5 = false
      if (body.value && channel === 5) doState.DO4 = false
      send(res, 200, { channel, value: body.value })
    })
    return
  }

  send(res, 200, { ok: true, service: 'mock-api', port: PORT })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`mock API listening on http://127.0.0.1:${PORT}`)
})
