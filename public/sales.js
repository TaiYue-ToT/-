let currentItem = null;

document.getElementById("btnSearch").onclick = async () => {
  const id = document.getElementById("searchId").value.trim();
  if (!id) return alert("请输入 ID");

  const res = await fetch("/api/get-item?id=" + id);
  const data = await res.json();

  if (!data.ok) {
    currentItem = null;
    alert("未找到商品");
    return;
  }

  currentItem = data.item;
  document.getElementById("itemName").innerText = currentItem.name;
  document.getElementById("itemPrice").innerText = currentItem.price;
  document.getElementById("itemStock").innerText = currentItem.stock;
};

document.getElementById("btnConfirm").onclick = async () => {
  if (!currentItem) return alert("请先搜索商品 ID");

  const qty = Number(document.getElementById("qty").value);
  const operator = document.getElementById("operator").value;
  const date = document.getElementById("date").value;

  if (!date) return alert("请选择日期");
  if (qty < 1) return alert("数量不正确");

  const res = await fetch("/api/confirm-sale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: currentItem.id,
      qty,
      operator,
      date
    })
  });

  const data = await res.json();
  if (!data.ok) {
    alert(data.error || "错误");
    return;
  }

  alert("销售成功");

  // 显示右侧记录
  const logDiv = document.getElementById("log");
  const row = data.record;

  const div = document.createElement("div");
  div.innerHTML = `
    <p>
      时间：${row.date}<br>
      操作员：${row.operator}<br>
      商品：${row.name}<br>
      流水号：${row.serial}
    </p>
    <hr>
  `;
  logDiv.prepend(div);
};
