const ORDER = ["ウッド・アイアン", "パターグリップ", "パターカバー", "アクセサリー", "ちいかわ", "追加"];
const state = { products: [], moves: [], catalogNote: "", fetchedAt: "" };
let mode = "in";
let tab = "scan";
let filter = "すべて";
let scanner = null;
let running = false;
let paused = false;
let lastCode = "";
let lastAt = 0;
let toastTimer = 0;

const $ = (id) => document.getElementById(id);

function validJan(jan) {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(jan)) return false;
  const digits = jan.split("").map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((total, num, index) => total + num * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function janKeys(jan) {
  const keys = new Set([jan]);
  if (jan.length === 12) keys.add("0" + jan);
  if (jan.length === 13 && jan.startsWith("0")) keys.add(jan.slice(1));
  return keys;
}

function findByJan(jan) {
  const keys = janKeys(jan);
  return state.products.find((product) => product.jan && [...janKeys(product.jan)].some((key) => keys.has(key)));
}

function label(product) {
  const series = String(product.series || product.name).replace(/^【[^】]+】/, "");
  return product.color ? series + " " + product.color : product.name;
}

function yen(value) {
  if (value == null || value === "") return "";
  return "¥" + Number(value).toLocaleString("ja-JP");
}

function toast(message) {
  const el = $("toast");
  el.hidden = false;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2200);
}

function beep(ok) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = ok ? 880 : 220;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    setTimeout(() => ctx.close(), 300);
  } catch (error) {}
  if (navigator.vibrate) navigator.vibrate(ok ? 30 : [40, 40, 40]);
}

function gasRequest(payload) {
  return new Promise((resolve, reject) => {
    const cb = "nowonCb" + Date.now() + Math.floor(Math.random() * 100000);
    const script = document.createElement("script");
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("通信に失敗しました"));
    }, 25000);
    function cleanup() {
      clearTimeout(timer);
      try { delete window[cb]; } catch (error) { window[cb] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[cb] = (data) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("通信に失敗しました"));
    };
    script.src = window.NOWON_API + "?callback=" + cb + "&p=" + encodeURIComponent(JSON.stringify(payload));
    document.head.appendChild(script);
  });
}

async function api(pathname, body) {
  let data;
  if (window.NOWON_API) {
    data = await gasRequest({ pathname: pathname, body: body || null });
    if (data.error) throw new Error(data.detail ? data.error + "。 " + data.detail : data.error);
  } else {
  const res = await fetch(pathname, body
    ? { method: body.method || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body.payload || body) }
    : undefined);
  data = await res.json();
  if (!res.ok) throw new Error(data.detail ? data.error + "。 " + data.detail : data.error || "失敗しました");
  }
  if (data.products) {
    state.products = data.products;
    state.moves = data.moves;
    state.catalogNote = data.catalogNote || "";
    state.fetchedAt = data.fetchedAt || "";
  }
  return data;
}

function applyState(data) {
  state.products = data.products;
  state.moves = data.moves;
  state.catalogNote = data.catalogNote || "";
  state.fetchedAt = data.fetchedAt || "";
  paint();
}

function setMode(next) {
  mode = next;
  $("modeIn").className = "mode" + (mode === "in" ? " on-in" : "");
  $("modeOut").className = "mode" + (mode === "out" ? " on-out" : "");
  $("scanHint").textContent = mode === "in" ? "入庫。JANを枠の中へ" : "出庫。JANを枠の中へ";
}

function showTab(next) {
  tab = next;
  for (const name of ["scan", "stock", "log"]) $(name).hidden = name !== next;
  for (const button of document.querySelectorAll("nav button")) {
    button.classList.toggle("on", button.dataset.tab === next);
  }
  if (next === "scan") {
    if ($("openCam")) $("openCam").hidden = running;
  } else stopCamera();
  paint();
}

function paint() {
  const missing = state.products.filter((product) => !product.jan).length;
  $("count").textContent = state.products.length + "点\nJAN未設定 " + missing;
  $("catalogNote").textContent = state.catalogNote || "";
  paintFilters();
  paintList();
  paintMoves();
  const latest = state.moves[0];
  $("last").innerHTML = latest
    ? "直前 <strong>" + escapeHtml(latest.name) + "</strong> " + (latest.type === "in" ? "入庫 +" : "出庫 -") + latest.qty + "　残 " + latest.stockAfter
    : "最初の読み取りで残数が動きます";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function paintFilters() {
  const categories = [...new Set(state.products.map((product) => product.category))];
  categories.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  const chips = ["すべて", "JAN未設定", ...categories];
  $("filters").innerHTML = chips.map((name) =>
    '<button type="button" class="chip' + (filter === name ? " on" : "") + '" data-filter="' + escapeHtml(name) + '">' + escapeHtml(name) + "</button>"
  ).join("");
}

function visibleProducts() {
  const q = $("q").value.trim().toLowerCase();
  return state.products
    .filter((product) => {
      if (filter === "JAN未設定" && product.jan) return false;
      if (filter !== "すべて" && filter !== "JAN未設定" && product.category !== filter) return false;
      if (!q) return true;
      return (product.name + " " + product.jan + " " + product.category).toLowerCase().includes(q);
    })
    .sort((a, b) => label(a).localeCompare(label(b), "ja"));
}

function paintList() {
  const rows = visibleProducts();
  $("list").innerHTML = rows.length
    ? rows.map((product) => rowHtml(product)).join("")
    : '<p class="empty">該当する商品がありません</p>';
}

function rowHtml(product) {
  const jan = product.jan ? product.jan : '<span class="tag warn">JAN未設定</span>';
  const price = yen(product.price);
  return (
    '<button type="button" class="row" data-id="' + escapeHtml(product.id) + '">' +
    "<b>" + escapeHtml(label(product)) + "</b>" +
    '<span class="qty">' + product.stock + "<small>残</small></span>" +
    '<span class="meta"><span class="tag">' + escapeHtml(product.category) + "</span>" + jan + (price ? " " + price : "") + "</span>" +
    "</button>"
  );
}

function paintMoves() {
  $("undo").disabled = !state.moves.length;
  $("moves").innerHTML = state.moves.length
    ? state.moves.map((move) => {
      const when = new Date(move.at);
      const clock = when.getMonth() + 1 + "/" + when.getDate() + " " + String(when.getHours()).padStart(2, "0") + ":" + String(when.getMinutes()).padStart(2, "0");
      return (
        '<div class="row">' +
        "<b>" + escapeHtml(move.name) + "</b>" +
        '<span class="qty">' + (move.type === "in" ? "+" : "-") + move.qty + "</span>" +
        '<span class="meta"><span class="tag ' + move.type + '">' + (move.type === "in" ? "入庫" : "出庫") + "</span>" + clock + "　残 " + move.stockAfter + "</span>" +
        "</div>"
      );
    }).join("")
    : '<p class="empty">履歴はまだありません</p>';
}

function openSheet(html) {
  $("sheet").hidden = false;
  $("sheet").innerHTML = '<div class="panel">' + html + "</div>";
  pauseCamera();
}

function closeSheet() {
  $("sheet").hidden = true;
  $("sheet").innerHTML = "";
  if (tab === "scan") resumeCamera();
}

function qtyBlock(product) {
  return (
    '<div class="presets">' + [1, 5, 10, 20].map((n) => '<button type="button" data-set="' + n + '">' + n + "</button>").join("") + "</div>" +
    '<div class="stepper"><button type="button" data-step="-1">−</button><input id="qty" inputmode="numeric" value="1"><button type="button" data-step="1">＋</button></div>' +
    '<p class="note">いまの残 ' + product.stock + (yen(product.price) ? "　定価 " + yen(product.price) : "") + "</p>" +
    '<button type="button" class="go ' + mode + '" id="commit">' + (mode === "in" ? "入庫する" : "出庫する") + "</button>"
  );
}

function openMove(product) {
  openSheet(
    "<h3>" + escapeHtml(label(product)) + "</h3>" +
    '<p class="jan">' + escapeHtml(product.jan || "JAN未設定") + "</p>" +
    qtyBlock(product)
  );
  $("commit").onclick = () => commitMove(product.id);
  bindQty();
}

function bindQty() {
  const input = $("qty");
  $("sheet").querySelectorAll("[data-set]").forEach((button) => {
    button.onclick = () => { input.value = button.dataset.set; };
  });
  $("sheet").querySelectorAll("[data-step]").forEach((button) => {
    button.onclick = () => {
      const next = Math.max(1, Math.min(9999, Number(input.value || 1) + Number(button.dataset.step)));
      input.value = String(next);
    };
  });
}

async function commitMove(productId) {
  const qty = Number($("qty").value);
  try {
    await api("/api/moves", { productId, type: mode, qty });
    beep(true);
    toast((mode === "in" ? "入庫 " : "出庫 ") + qty);
    closeSheet();
    paint();
  } catch (error) {
    beep(false);
    toast(error.message);
  }
}

function openUnknown(jan) {
  openSheet(
    "<h3>未登録のJAN</h3>" +
    '<p class="jan">' + escapeHtml(jan) + "</p>" +
    '<div class="field">既存の商品に付ける<input id="bindQ" placeholder="名前・色"></div>' +
    '<div id="choices" class="list"></div>' +
    '<button type="button" class="solid" id="createNew">新しい商品として追加</button>'
  );
  const draw = () => {
    const q = $("bindQ").value.trim().toLowerCase();
    const rows = state.products.filter((product) => !product.jan && (!q || label(product).toLowerCase().includes(q))).slice(0, 30);
    $("choices").innerHTML = rows.map((product) =>
      '<button type="button" class="choice" data-id="' + escapeHtml(product.id) + '"><b>' + escapeHtml(label(product)) + '</b><span class="meta">' + escapeHtml(product.category) + "</span></button>"
    ).join("") || '<p class="empty">JAN未設定の商品がありません</p>';
    $("choices").querySelectorAll(".choice").forEach((button) => {
      button.onclick = () => bindJan(button.dataset.id, jan);
    });
  };
  $("bindQ").addEventListener("input", draw);
  $("createNew").onclick = () => openCreate(jan);
  draw();
}

async function bindJan(productId, jan) {
  try {
    await api("/api/products/" + encodeURIComponent(productId), { method: "PATCH", payload: { jan } });
    beep(true);
    const product = state.products.find((item) => item.id === productId);
    toast("JANを付けました");
    openMove(product);
    paint();
  } catch (error) {
    beep(false);
    toast(error.message);
  }
}

function openCreate(jan) {
  const categories = [...new Set([...ORDER, ...state.products.map((product) => product.category)])];
  openSheet(
    "<h3>商品を追加</h3>" +
    (jan ? '<p class="jan">' + escapeHtml(jan) + "</p>" : "") +
    '<div class="field">商品名<input id="newName" placeholder="例 限定モデル"></div>' +
    '<div class="field">色<input id="newColor" placeholder="無ければ空"></div>' +
    '<div class="field">分類<select id="newCategory">' + categories.map((name) => "<option>" + escapeHtml(name) + "</option>").join("") + "</select></div>" +
    '<div class="field">定価<input id="newPrice" inputmode="numeric" placeholder="空でもよい"></div>' +
    '<div class="field">最初の入庫数<input id="newStock" inputmode="numeric" value="0"></div>' +
    '<button type="button" class="go in" id="saveNew">追加する</button>'
  );
  $("newName").focus();
  $("saveNew").onclick = async () => {
    try {
      await api("/api/products", {
        name: $("newName").value,
        color: $("newColor").value,
        category: $("newCategory").value,
        price: $("newPrice").value,
        stock: Number($("newStock").value || 0),
        jan: jan || "",
      });
      beep(true);
      toast("追加しました");
      closeSheet();
      paint();
    } catch (error) {
      beep(false);
      toast(error.message);
    }
  };
}

function openDetail(product) {
  openSheet(
    "<h3>" + escapeHtml(label(product)) + "</h3>" +
    '<p class="jan">' + escapeHtml(product.jan || "JAN未設定") + "</p>" +
    "<p>残 <strong>" + product.stock + "</strong>" + (yen(product.price) ? "　定価 " + yen(product.price) : "") + "</p>" +
    '<div class="actions"><button type="button" class="go in" id="detailIn">入庫</button><button type="button" class="go out" id="detailOut">出庫</button></div>' +
    '<div class="field" style="margin-top:12px">JAN<input id="editJan" inputmode="numeric" value="' + escapeHtml(product.jan || "") + '"></div>' +
    '<button type="button" class="ghost" id="scanJan">カメラでJANを付ける</button>' +
    '<button type="button" class="solid" id="saveJan" style="margin-top:8px">JANを保存</button>'
  );
  $("detailIn").onclick = () => { setMode("in"); openMove(product); };
  $("detailOut").onclick = () => { setMode("out"); openMove(product); };
  $("scanJan").onclick = () => {
    closeSheet();
    showTab("scan");
    toast("次に読んだJANを、この商品に付けます");
    window.bindProductId = product.id;
  };
  $("saveJan").onclick = () => bindJan(product.id, $("editJan").value.trim());
}

async function onScan(text) {
  const jan = String(text || "").replace(/\D/g, "");
  const now = Date.now();
  if (!jan || (jan === lastCode && now - lastAt < 1500)) return;
  lastCode = jan;
  lastAt = now;
  if (!validJan(jan)) {
    beep(false);
    toast("JANとして読めませんでした");
    return;
  }
  if (window.bindProductId) {
    const id = window.bindProductId;
    window.bindProductId = "";
    await bindJan(id, jan);
    return;
  }
  const product = findByJan(jan);
  if (!product) {
    beep(false);
    openUnknown(jan);
    return;
  }
  if ($("continuous").checked) {
    try {
      await api("/api/moves", { productId: product.id, type: mode, qty: 1 });
      beep(true);
      toast(label(product) + (mode === "in" ? " +1" : " -1"));
      paint();
    } catch (error) {
      beep(false);
      toast(error.message);
    }
    return;
  }
  beep(true);
  openMove(product);
}

async function startCamera() {
  if (running || tab !== "scan" || !window.Html5Qrcode) return;
  const button = $("openCam");
  if (button) button.disabled = true;
  try {
    scanner = new Html5Qrcode("reader", {
      verbose: false,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
      ],
    });
    await scanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: (width) => ({ width: Math.floor(width * 0.86), height: Math.max(90, Math.floor(width * 0.34)) }),
      },
      onScan,
      () => {}
    );
    running = true;
    paused = false;
    if (button) button.hidden = true;
    $("scanHint").textContent = "JANを横長の枠に入れてください";
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.hidden = false;
    }
    $("scanHint").textContent = /Line/i.test(navigator.userAgent)
      ? "LINEの中ではカメラが止まります。右下の「…」から、ブラウザで開いてください"
      : "カメラが起動しませんでした。もう一度押すか、番号を打ってください";
  }
}

async function stopCamera() {
  if (!running || !scanner) return;
  try { await scanner.stop(); } catch (error) {}
  try { scanner.clear(); } catch (error) {}
  running = false;
  paused = false;
  scanner = null;
  const button = $("openCam");
  if (button && tab === "scan") {
    button.hidden = false;
    button.disabled = false;
  }
}

async function pauseCamera() {
  if (!running || paused || !scanner) return;
  try {
    scanner.pause(true);
    paused = true;
  } catch (error) {}
}

function resumeCamera() {
  if (!running || !paused || !scanner) return;
  try {
    scanner.resume();
    paused = false;
  } catch (error) {}
}

function openManual() {
  openSheet(
    "<h3>JANを打つ</h3>" +
    '<div class="field">8桁、12桁、13桁<input id="typed" inputmode="numeric" autocomplete="off"></div>' +
    '<button type="button" class="go in" id="useTyped">この番号で続ける</button>'
  );
  $("typed").focus();
  $("useTyped").onclick = () => {
    const jan = $("typed").value.trim();
    closeSheet();
    lastCode = "";
    onScan(jan);
  };
}

$("modeIn").onclick = () => setMode("in");
$("modeOut").onclick = () => setMode("out");
$("openCam").onclick = () => startCamera();
$("manual").onclick = openManual;
$("add").onclick = () => openCreate("");
$("undo").onclick = async () => {
  try {
    const data = await api("/api/undo", {});
    applyState(data);
    toast("取り消しました");
  } catch (error) {
    toast(error.message);
  }
};
$("q").addEventListener("input", paintList);
$("filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  filter = button.dataset.filter;
  paint();
});
$("list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-id]");
  if (!button) return;
  const product = state.products.find((item) => item.id === button.dataset.id);
  if (product) openDetail(product);
});
document.querySelector("nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-tab]");
  if (button) showTab(button.dataset.tab);
});
$("sheet").addEventListener("click", (event) => {
  if (event.target.id === "sheet") closeSheet();
});

api("/api/state").then(applyState).catch((error) => {
  toast(error.message);
});

if (!window.NOWON_API && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
