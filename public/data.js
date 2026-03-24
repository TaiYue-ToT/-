// 修改 data.js 文件
let excelData = null;
let fuse = null;

async function loadExcelData() {
  if (excelData) return excelData;

  // 从后端API获取数据，而不是直接加载Excel
  try {
    const resp = await fetch('/api/items');
    if (!resp.ok) throw new Error('API请求失败');
    excelData = await resp.json();
    
    fuse = new Fuse(excelData, {
      keys: ['name', '名称', 'Name'],
      includeScore: true,
      threshold: 0.45,
      shouldSort: true,
    });
    
    return excelData;
  } catch (error) {
    console.error('加载数据失败:', error);
    return [];
  }
}

async function searchFromExcel(text, topN = 20) {
  await loadExcelData();
  if (!text || !fuse) return [];
  const results = fuse.search(text, { limit: topN });

  return results.map(r => ({
    item: r.item,
    score: r.score
  }));
}