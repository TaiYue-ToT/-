// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const xlsx = require('xlsx');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(bodyParser.json());
// serve static files from "public" directory
app.use(express.static('public'));


// --- Config ---
const EXCEL_FILE = './五金工具库存表.xlsx'; // 把你的文件放在项目根
const SHELF_REGEX = /(\d+)\s*货架\s*(\d+)\s*层\s*(\d+)\s*格/; // 匹配位置格式

// Load excel into memory
function loadExcel() {
  if (!fs.existsSync(EXCEL_FILE)) return [];
  const wb = xlsx.readFile(EXCEL_FILE);
  const sheetName = wb.SheetNames[0];
  const data = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });

  return data.map((row) => ({
    id: Number(row['ID']), // ← 使用真正的 Excel ID
    name: row['名称'] || row['Name'] || "",
    stock: row['库存'],
    price: row['价格'],
    brand: row['品牌'],
    model: row['型号'],
    location: String(row['位置'] || row['Location'] || ""),
  }));
}

let items = loadExcel();

// Helper parse location
function parseLocation(locStr) {
  const m = locStr.match(SHELF_REGEX);
  if (!m) return null;
  return { shelf: parseInt(m[1], 10), layer: parseInt(m[2], 10), bin: parseInt(m[3], 10) };
}

// API: get items
app.get('/api/items', (req, res) => {
  res.json(items);

});

// 修改您的 /api/search 接口
app.get('/api/search', (req, res) => {
  const keyword = (req.query.keyword || '').trim().toLowerCase();
  if (!keyword) {
    return res.json([]); // 返回空数组而不是全部物品
  }

  // 在多个字段中进行模糊搜索
  const filtered = items.filter(item => {
    const searchableText = [
      item.name,
      item.brand,
      item.model,
      item.location
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return searchableText.includes(keyword);
  });

  // 返回前端直接可用的标签格式数组
  const resultTags = filtered.map(item => `${item.name}-${item.stock}`);
  
  res.json(resultTags); // 直接返回标签数组
});


// 📌 根据 ID 获取商品
app.get('/api/get-item', (req, res) => {
  const id = Number(req.query.id);
  const item = items.find(x => x.id === id);
  if (!item) return res.json({ ok: false });

  res.json({ ok: true, item });
});

// --------------------- 销售记录文件相关 ---------------------
const SALE_FILE = './流水记录.xlsx';

// 创建或读取销售记录文件
function loadSaleExcel() {
  if (!fs.existsSync(SALE_FILE)) {
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet([]);
    xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
    xlsx.writeFile(wb, SALE_FILE);
  }
  const wb = xlsx.readFile(SALE_FILE);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return { wb, sheet };
}

// 获取当天流水号
function getTodaySerial(rows, date) {
  const todayRows = rows.filter(r => r.date === date);
  return todayRows.length + 1;
}

// --------------------- 正确位置：确认销售接口 ---------------------
app.post('/api/confirm-sale', (req, res) => {
  const { id, qty, operator, date } = req.body;

  const item = items.find(x => x.id === id);
  if (!item) return res.json({ ok: false, error: "ID不存在" });

  const remain = Number(item.stock) - Number(qty);
  if (remain < 0) return res.json({ ok: false, error: "库存不足" });

  // 更新库存
  item.stock = remain;

  // 写入流水记录
  const { wb, sheet } = loadSaleExcel();
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

  const serial = getTodaySerial(rows, date);

  const newRecord = {
    date,
    operator,
    id: item.id,
    name: item.name,
    qty,
    price: item.price,
    remain,
    serial
  };

  rows.push(newRecord);

  const newWs = xlsx.utils.json_to_sheet(rows);
  wb.Sheets[wb.SheetNames[0]] = newWs;
  xlsx.writeFile(wb, SALE_FILE);

  res.json({ ok: true, record: newRecord });
});



// API: update item location (body: { id, newLocation })
app.post('/api/update', (req, res) => {
  // 📌 销售记录文件

















  const { id, newLocation } = req.body;
  const item = items.find(it => it.id === id);
  if (!item) return res.status(404).json({ error: 'item not found' });
  item.location = newLocation;
  // broadcast to connected clients
  io.emit('itemUpdated', { id: item.id, newLocation: item.location });
  res.json({ ok: true, item });
});

// Websocket connections
io.on('connection', (socket) => {
  console.log('client connected', socket.id);
  socket.on('disconnect', () => console.log('client disconnected', socket.id));
});

const PORT = 3000;

// ========== 新增：语义搜索接口（调用 OpenAI via 代理） ==========
app.post('/api/semantic-search', async (req, res) => {
  try {
    const { query, limit = 5 } = req.body || {};
    if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query required' });

    // 从已加载的 items 中提取名称列并去重（只取名称字符串）
    const names = Array.from(new Set(items.map(it => (it.name || '').trim()).filter(x => x)));

    // 防止 prompt 过长：如果条目太多，截断到前 500 个（通常你的名称列表很可能 < 500）
    const MAX_NAMES = 500;
    const namesToSend = names.slice(0, MAX_NAMES);

    // 构建 prompt：要求模型返回严格的 JSON 数组（name, score, reason, suggestion）
    const systemMsg = `
You are an assistant that maps a user's natural-language description to items from a given product list.
You will be given a user description and a list of product names (in Chinese).
Return a JSON array (not wrapped in any other text) of up to ${limit} objects sorted by relevance.
Each object must have these keys:
  - name: the product name exactly as in the provided list
  - score: a number between 0 and 1 representing confidence (1 highest). Optional if you prefer.
  - reason: one short sentence (in Chinese) explaining why the product matches the description (use the description context).
  - suggestion: one short practical suggestion about usage or model selection (Chinese).
If none match, return an empty JSON array: [].
Make sure the output is valid JSON and nothing else.
    `.trim();

    const userMsg = `
User description: "${query}"
Product list (only use these exact names when returning "name"): 
${namesToSend.join('\n')}
    `.trim();

    // Proxy/OpenAI endpoint (your provided URL)
    const OPENAI_URL = 'https://api.openai-proxy.org/v1/chat/completions';
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set in environment' });

    // Build request payload for chat completions
    const payload = {
      model: "gpt-4o-mini", // 或者使用你可用的模型名；若代理只支持某些模型，请调整
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: userMsg }
      ],
      temperature: 0.0,
      max_tokens: 700
    };

    // call the proxy endpoint
    const r = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify(payload),
      // timeout config may be added if needed
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error('OpenAI proxy error', r.status, txt);
      return res.status(502).json({ error: 'OpenAI proxy error', detail: txt });
    }

    const data = await r.json();

    // Extract assistant content (GPT Chat Completions)
    const assistantContent = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
      || (data.choices && data.choices[0] && data.choices[0].text) || "";

    // Try parse JSON directly from assistantContent.
    let parsed = [];
    try {
      // some proxies/models may wrap in markdown; try to extract JSON substring
      const jsonStart = assistantContent.indexOf('[');
      const jsonEnd = assistantContent.lastIndexOf(']');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const jsonStr = assistantContent.slice(jsonStart, jsonEnd + 1);
        parsed = JSON.parse(jsonStr);
      } else {
        parsed = JSON.parse(assistantContent);
      }
    } catch (e) {
      console.warn('Failed to parse JSON from model output. Returning raw content for debugging.', e);
      return res.status(200).json({ raw: assistantContent });
    }

    // Make sure each returned name exists in our names list; filter/trim and limit
    const valid = (parsed || []).filter(o => o && o.name && names.includes(o.name)).slice(0, limit);

    return res.json({
  ok: true,
  candidates: valid.map(v => v.name),   // 前端只需要名称列表
  detail: valid                         // 如果你前端要用理由、建议，也可以在这里继续传
});

  } catch (err) {
    console.error('semantic-search error', err);
    res.status(500).json({ error: 'internal error', detail: String(err) });
  }
});

server.listen(PORT, () => console.log(`Server listening at http://localhost:${PORT}`));