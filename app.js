"use strict";

const DB_NAME = "gestione-listini-offline";
const DB_VERSION = 1;

let db;
let articles = [];
let currentItems = [];
let currentChoiceId = null;
let scanner = null;
let lastScan = "";
let pdfPreviewRows = [];
let idleTimer = null;
let currentLanguage = "it";

const $ = id => document.getElementById(id);

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const d = request.result;
      if (!d.objectStoreNames.contains("articles"))
        d.createObjectStore("articles", { keyPath: "code" });
      if (!d.objectStoreNames.contains("choices"))
        d.createObjectStore("choices", { keyPath: "id" });
      if (!d.objectStoreNames.contains("meta"))
        d.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function store(name, mode = "readonly") {
  return db.transaction(name, mode).objectStore(name);
}

function all(name) {
  return new Promise((resolve, reject) => {
    const r = store(name).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

function getValue(name, key) {
  return new Promise((resolve, reject) => {
    const r = store(name).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function put(name, value) {
  return new Promise((resolve, reject) => {
    const r = store(name, "readwrite").put(value);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function norm(v) {
  return String(v || "").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function codeKey(v) {
  return String(v || "").trim().replace(/^0+(?=\d)/, "");
}

function priceText(a) {
  if (a.price === "" || a.price == null) return "Prezzo non indicato";
  return "€ " + Number(a.price).toFixed(2).replace(".", ",");
}

function status() {
  const online = navigator.onLine;
  $("connection").textContent = online
    ? "Connesso — dati conservati sul dispositivo"
    : "Offline — puoi utilizzare i dati già salvati";
  $("connection").className = "status " + (online ? "on" : "off");
}

function message(id, text) {
  if ($(id)) $(id).textContent = text;
}

/* CLIENTI E REPARTI */

async function customersData() {
  const data = await getValue("meta", "customers");
  return data ? data.value : [];
}

async function saveCustomers(data) {
  await put("meta", { key: "customers", value: data });
}

async function refreshCustomers() {
  const data = await customersData();
  const options = $("customerOptions");
  options.replaceChildren();

  data.forEach(c => {
    const option = document.createElement("option");
    option.value = c.name;
    options.append(option);
  });

  await refreshDepartments();
}

async function refreshDepartments() {
  const data = await customersData();
  const customer = norm($("customer").value);
  const selected = $("department").value;
  const found = data.find(c => norm(c.name) === customer);
  const select = $("department");
  select.replaceChildren();

  const first = document.createElement("option");
  first.value = "";
  first.textContent = "Seleziona il reparto";
  select.append(first);

  if (found) {
    (found.departments || []).forEach(dep => {
      const option = document.createElement("option");
      option.value = dep;
      option.textContent = dep;
      select.append(option);
    });
  }

  if ([...select.options].some(o => o.value === selected))
    select.value = selected;
}

async function saveCustomerDepartment() {
  const name = $("customer").value.trim();
  const department = $("newDepartment").value.trim();

  if (!name) {
    message("customerMessage", "Inserisci prima il cliente.");
    return;
  }
  if (!department) {
    message("customerMessage", "Scrivi il nome del reparto.");
    return;
  }

  const data = await customersData();
  let customer = data.find(c => norm(c.name) === norm(name));

  if (!customer) {
    customer = { name, departments: [] };
    data.push(customer);
  }

  if (!customer.departments.includes(department))
    customer.departments.push(department);

  await saveCustomers(data);
  $("newDepartment").value = "";
  await refreshCustomers();
  $("department").value = department;
  message("customerMessage", "Cliente e reparto salvati.");
}

async function ensureCustomer() {
  const name = $("customer").value.trim();
  const department = $("department").value;

  if (!name || !department) {
    message("customerMessage", "Seleziona il cliente e il reparto prima di aggiungere articoli.");
    return false;
  }

  const data = await customersData();
  let c = data.find(x => norm(x.name) === norm(name));

  if (!c) {
    c = { name, departments: [department] };
    data.push(c);
  } else if (!c.departments.includes(department)) {
    c.departments.push(department);
  }

  await saveCustomers(data);
  return true;
}

/* ARCHIVIO ARTICOLI */

async function refreshArticles() {
  articles = await all("articles");
  $("listinoInfo").textContent =
    articles.length + " articoli salvati sul dispositivo.";
  renderResults();
}

function renderResults() {
  const query = norm($("search").value);
  const host = $("results");
  host.replaceChildren();

  const found = articles.filter(a =>
    !query ||
    norm(a.name).includes(query) ||
    String(a.code).includes(query)
  ).sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), "it", {
      sensitivity: "base",
      numeric: true
    })
  ).slice(0, 60);

  if (!found.length) {
    host.textContent = "Nessun articolo trovato.";
    return;
  }

  found.forEach(a => {
    const div = document.createElement("div");
    div.className = "article";

    const name = document.createElement("strong");
    name.textContent = a.name;

    const details = document.createElement("div");
    details.className = "price";
    details.textContent = "Codice " + a.code + " · " + priceText(a);

    const button = document.createElement("button");
    button.textContent = "Aggiungi alla scelta";
    button.onclick = async () => {
      if (!await ensureCustomer()) return;
      addArticle(a);
    };

    div.append(name, details, button);
    host.append(div);
  });
}

function addArticle(a) {
  if (currentItems.some(x => x.code &&
      codeKey(x.code) === codeKey(a.code))) {
    message("scanMessage", "Articolo già presente nella scelta.");
    return;
  }

  currentItems.push({
    code: a.code,
    name: a.name,
    price: a.price,
    currency: a.currency || "EUR",
    quantity: "1",
    note: "",
    originalFields: a.originalFields || {},
    manual: false
  });

  renderChoice();
  autosaveDraft();
}

/* SCELTA ARTICOLI */

function renderChoice() {
  const host = $("choiceItems");
  host.replaceChildren();

  if (!currentItems.length) {
    host.textContent = "Nessun articolo selezionato.";
    return;
  }

  currentItems.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "item";

    const name = document.createElement("strong");
    name.textContent = item.name;

    const details = document.createElement("div");
    details.className = "muted";
    details.textContent = item.code
      ? "Codice " + item.code + " · " + priceText(item)
      : priceText(item);

    const grid = document.createElement("div");
    grid.className = "itemgrid";

    const qty = document.createElement("input");
    qty.value = item.quantity || "1";
    qty.placeholder = "Quantità / metri";
    qty.onchange = () => {
      item.quantity = qty.value;
      autosaveDraft();
    };

    const remove = document.createElement("button");
    remove.className = "danger";
    remove.textContent = "Rimuovi";
    remove.onclick = () => {
      currentItems.splice(index, 1);
      renderChoice();
      autosaveDraft();
    };

    const note = document.createElement("textarea");
    note.placeholder = "Nota articolo";
    note.value = item.note || "";
    note.onchange = () => {
      item.note = note.value;
      autosaveDraft();
    };

    grid.append(qty, remove);
    div.append(name, details, grid, note);
    host.append(div);
  });
}

function choicePayload() {
  return {
    id: currentChoiceId || crypto.randomUUID(),
    date: $("choiceDate").value,
    number: $("choiceNumber").value,
    customer: $("customer").value.trim(),
    department: $("department").value,
    note: $("generalNote").value,
    conditions: $("commercialConditions").value,
    documentType: $("documentType").value,
    includeDetails: $("includeDetails").checked,
    items: currentItems,
    updatedAt: new Date().toISOString()
  };
}

async function autosaveDraft() {
  if (currentChoiceId) await put("choices", choicePayload());
}

function newChoice() {
  currentChoiceId = crypto.randomUUID();
  currentItems = [];
  $("choiceDate").value = new Date().toISOString().slice(0, 10);
  $("choiceNumber").value = "";
  $("generalNote").value = "";
  $("commercialConditions").value = "";
  $("manualAdd").classList.add("hidden");
  renderChoice();
}

async function saveChoice() {
  if (!await ensureCustomer()) return;

  const data = choicePayload();
  await put("choices", data);
  currentChoiceId = data.id;
  await renderSaved();
  message("documentMessage", "Scelta salvata sul dispositivo.");
}

async function renderSaved() {
  const host = $("savedChoices");
  const choices = (await all("choices"))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  host.replaceChildren();

  if (!choices.length) {
    host.textContent = "Nessuna scelta salvata.";
    return;
  }

  choices.forEach(c => {
    const div = document.createElement("div");
    div.className = "article";

    const title = document.createElement("strong");
    title.textContent = (c.date || "") + " — " +
      (c.customer || "Senza cliente") + " / " + (c.department || "");

    const info = document.createElement("div");
    info.className = "muted";
    info.textContent = (c.items || []).length + " articoli";

    const open = document.createElement("button");
    open.className = "secondary";
    open.textContent = "Apri";
    open.onclick = async () => {
      currentChoiceId = c.id;
      $("choiceDate").value = c.date || "";
      $("choiceNumber").value = c.number || "";
      $("customer").value = c.customer || "";
      await refreshDepartments();
      $("department").value = c.department || "";
      $("generalNote").value = c.note || "";
      $("commercialConditions").value = c.conditions || "";
      $("documentType").value = c.documentType || "summary";
      $("includeDetails").checked = c.includeDetails !== false;
      currentItems = c.items || [];
      renderChoice();
      window.scrollTo({ top: 0, behavior: "smooth" });
    };

    div.append(title, info, open);
    host.append(div);
  });
}

/* ARTICOLO MANUALE */

async function addManual() {
  if (!await ensureCustomer()) return;

  const name = $("manualName").value.trim();
  if (!name) {
    alert("Inserisci il nome dell'articolo.");
    return;
  }

  currentItems.push({
    code: "",
    name,
    price: $("manualPrice").value || "",
    currency: "EUR",
    quantity: $("manualQty").value.trim() || "1",
    note: $("manualNote").value.trim(),
    originalFields: {},
    manual: true
  });

  $("manualName").value = "";
  $("manualPrice").value = "";
  $("manualQty").value = "";
  $("manualNote").value = "";
  $("manualAdd").classList.add("hidden");

  renderChoice();
  autosaveDraft();
}

/* SCANNER */

async function startScanner() {
  if (!await ensureCustomer()) return;

  if (!window.isSecureContext) {
    message("scanMessage", "La fotocamera richiede una pagina HTTPS.");
    return;
  }

  if (typeof Html5Qrcode === "undefined") {
    message("scanMessage", "Libreria scanner non disponibile.");
    return;
  }

  $("reader").classList.remove("hidden");

  try {
    scanner = new Html5Qrcode("reader");
    await scanner.start(
      { facingMode: "environment" },
      { fps: 12, qrbox: { width: 280, height: 150 } },
      code => {
        if (code === lastScan) return;
        lastScan = code;
        onBarcode(code);
        setTimeout(() => { lastScan = ""; }, 1800);
      },
      () => {}
    );
    message("scanMessage", "Fotocamera attiva.");
  } catch (e) {
    message("scanMessage", "Errore fotocamera: " + e.message);
  }
}

async function stopScanner() {
  if (scanner) {
    try {
      await scanner.stop();
      await scanner.clear();
    } catch (e) {}
    scanner = null;
  }
  $("reader").classList.add("hidden");
}

function normalizeBarcodeCode(value) {
  return String(value == null ? "" : value)
    .normalize("NFKC")
    .trim()
    .replace(/[\s-]/g, "")
    .replace(/^0+(?=\d)/, "");
}

async function onBarcode(code) {
  const scanned = normalizeBarcodeCode(code);

  const a = articles.find(x =>
    normalizeBarcodeCode(x.code) === scanned && scanned !== ""
  );

  if (a) {
    if (!await ensureCustomer()) return;

    addArticle(a);
    message("scanMessage", a.name + " — " + priceText(a));
    return;
  }

  message("scanMessage", "Codice non trovato. Inserisci manualmente l'articolo.");
  $("manualAdd").classList.remove("hidden");
  $("manualName").value = "";
  $("manualQty").value = "";
  $("manualName").focus();
}

/* IMPORTAZIONE CSV ED EXCEL */

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(x => x.trim());
  if (!lines.length) return [];

  const delimiter =
    (lines[0].match(/;/g) || []).length >
    (lines[0].match(/,/g) || []).length ? ";" : ",";

  function parseLine(line) {
    const out = [];
    let value = "", quoted = false;

    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"' && line[i + 1] === '"' && quoted) {
        value += '"'; i++;
      } else if (c === '"') {
        quoted = !quoted;
      } else if (c === delimiter && !quoted) {
        out.push(value.trim()); value = "";
      } else value += c;
    }
    out.push(value.trim());
    return out;
  }

  const rows = lines.map(parseLine);
  const header = rows[0].map(norm);
  const hasHeader = header.some(x =>
    ["codice", "code", "articolo", "nome", "descrizione"].includes(x)
  );

  return rows.slice(hasHeader ? 1 : 0).map(r => ({
    code: String(r[0] || "").trim(),
    name: String(r[1] || "").trim(),
    currency: "EUR",
    price: String(r[3] || r[2] || "").replace(",", ".").trim(),
    originalFields: { columns: r }
  })).filter(a => a.code && a.name);
}

async function mergeArticles(rows) {
  let count = 0;
  for (const a of rows) {
    if (!a.code || !a.name) continue;
    await put("articles", {
      ...a,
      code: String(a.code).trim(),
      name: String(a.name).trim()
    });
    count++;
  }
  await refreshArticles();
  return count;
}

async function importCsv() {
  const file = $("csvFile").files[0];
  if (!file) {
    alert("Seleziona un file CSV.");
    return;
  }
  try {
    const rows = parseCsv(await file.text());
    if (!rows.length) throw new Error("Nessun articolo riconosciuto.");
    const n = await mergeArticles(rows);
    message("importMessage", n + " articoli importati o aggiornati.");
  } catch (e) {
    message("importMessage", "Errore CSV: " + e.message);
  }
}

async function importExcel() {
  const file = $("excelFile").files[0];
  if (!file) {
    alert("Seleziona un file Excel.");
    return;
  }
  if (!window.XLSX) {
    message("importMessage", "Lettore Excel non disponibile. Apri l'app online una volta.");
    return;
  }

  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    const rows = data.filter(r => r.length >= 2 && r[0] && r[1]).map(r => ({
      code: String(r[0]).trim(),
      name: String(r[1]).trim(),
      currency: "EUR",
      price: String(r[3] || r[2] || "").replace(",", "."),
      originalFields: { columns: r }
    }));
    if (!rows.length) throw new Error("Nessun articolo riconosciuto.");
    const n = await mergeArticles(rows);
    message("importMessage", n + " articoli importati o aggiornati.");
  } catch (e) {
    message("importMessage", "Errore Excel: " + e.message);
  }
}

/* LETTURA PDF E OCR */

async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Impossibile caricare il motore OCR."));
    document.head.append(script);
  });

  return window.Tesseract;
}

async function extractPdfText(file) {
  if (!window.pdfjsLib) throw new Error("Lettore PDF non disponibile.");

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(await file.arrayBuffer())
  }).promise;

  const lines = [];
  let ocrWorker = null;

  for (let p = 1; p <= pdf.numPages; p++) {
    message("pdfMessage", "Lettura pagina " + p + " di " + pdf.numPages);

    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const rows = [];

    content.items.forEach(item => {
      if (!item.str || !item.str.trim()) return;
      const y = Math.round(item.transform[5]);
      let row = rows.find(r => Math.abs(r.y - y) <= 3);
      if (!row) {
        row = { y, parts: [] };
        rows.push(row);
      }
      row.parts.push({ x: item.transform[4], text: item.str.trim() });
    });

    const pageLines = rows.sort((a, b) => b.y - a.y).map(r => {
      return r.parts.sort((a, b) => a.x - b.x)
        .map(x => x.text).join(" ").replace(/\s+/g, " ").trim();
    }).filter(Boolean);

    if (pageLines.join("").replace(/\s/g, "").length > 25) {
      lines.push(...pageLines);
    } else {
      if (!ocrWorker) {
        const T = await loadTesseract();
        ocrWorker = await T.createWorker("ita");
      }

      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport
      }).promise;

      const result = await ocrWorker.recognize(canvas);
      lines.push(...String(result.data.text || "")
        .split(/\r?\n/).map(x => x.trim()).filter(Boolean));

      canvas.width = 0;
      canvas.height = 0;
    }
  }

  if (ocrWorker) await ocrWorker.terminate();
  return lines;
}

function parsePdfLines(lines) {
  const out = [];
  const seen = new Set();
  const text = lines.map(x => String(x).trim()).filter(Boolean);

  const pricePattern = /(?:EURO|EUR|€)?\s*(\d{1,4}[,.]\d{2})(?!\d)/i;
  const codePattern = /^\d{3,8}$/;

  for (let i = 0; i < text.length; i++) {
    let line = text[i];

    // Codice e articolo possono trovarsi sulla stessa riga.
    const start = line.match(/^(\d{3,8})\s+(.+)$/);
    let code = "";
    let description = "";

    if (start) {
      code = start[1];
      description = start[2];
    } else if (codePattern.test(line)) {
      code = line;
    } else {
      continue;
    }

    if (seen.has(code)) continue;

    const collected = [description];
    let price = null;
    let original = [];

    for (let j = i; j < Math.min(i + 8, text.length); j++) {
      const current = text[j];
      original.push(current);

      const priceMatch = current.match(pricePattern);
      if (priceMatch) {
        price = Number(priceMatch[1].replace(",", "."));
        break;
      }

      if (j > i && !codePattern.test(current)) {
        collected.push(current);
      }
    }

    if (price === null || !Number.isFinite(price)) continue;

    const combined = collected.join(" ").replace(/\s+/g, " ").trim();
    const composition = combined.match(/(?:PL|WO|PA|PC|SE|CO|VI|LI|EA|AC|NY|WV|WS)\s*\d+\s*%.*$/i);
    let name = combined;
    let compositionText = "";

    if (composition) {
      compositionText = composition[0].trim();
      name = combined.slice(0, composition.index).trim();
    }

    name = name.replace(/\bEURO\b.*$/i, "").trim();
    if (!name) continue;

    out.push({
      code,
      name,
      price: String(price),
      currency: "EUR",
      originalFields: {
        originalLines: original,
        composition: compositionText,
        fullDescription: combined
      }
    });

    seen.add(code);
  }

  return out;
}

function renderPdfPreview(rows) {
  const host = $("pdfPreviewList");
  host.replaceChildren();

  rows.forEach(a => {
    const row = document.createElement("div");
    row.className = "pdf-row";

    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = a.name;

    const code = document.createElement("small");
    code.textContent = "Codice " + a.code;

    info.append(name, code);

    const price = document.createElement("b");
    price.className = "pdf-price";
    price.textContent = priceText(a);

    row.append(info, price);
    host.append(row);
  });

  $("pdfPreviewCount").textContent = rows.length + " articoli riconosciuti";
  $("pdfPreview").classList.remove("hidden");
}

async function readPdf() {
  const file = $("pdfFile").files[0];
  if (!file) {
    alert("Seleziona prima un PDF.");
    return;
  }

  $("pdfPreview").classList.add("hidden");
  message("pdfMessage", "Lettura del PDF in corso…");

  try {
    const lines = await extractPdfText(file);
    pdfPreviewRows = parsePdfLines(lines);

    if (!pdfPreviewRows.length) {
      message("pdfMessage", "Nessun articolo riconosciuto. Controlla il PDF e la qualità della scansione.");
      return;
    }

    renderPdfPreview(pdfPreviewRows);
    message("pdfMessage", "Controlla l'anteprima prima di importare.");
  } catch (e) {
    message("pdfMessage", "Errore PDF: " + e.message);
  }
}

async function confirmPdfImport() {
  if (!pdfPreviewRows.length) return;

  if (!confirm("Importare o aggiornare " + pdfPreviewRows.length +
      " articoli? Gli altri articoli già presenti saranno conservati.")) return;

  const n = await mergeArticles(pdfPreviewRows);
  message("pdfMessage", n + " articoli importati o aggiornati.");
  $("pdfPreview").classList.add("hidden");
  pdfPreviewRows = [];
  $("pdfFile").value = "";
}

function cancelPdfImport() {
  pdfPreviewRows = [];
  $("pdfPreview").classList.add("hidden");
  message("pdfMessage", "Importazione annullata.");
}

/* DOCUMENTO PDF E EMAIL */

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildDocumentHtml() {
  const c = choicePayload();
  const offer = c.documentType === "offer";

  let rows = "";
  c.items.forEach(item => {
    const fields = item.originalFields || {};
    const details = c.includeDetails
      ? [
          fields.composition,
          fields.weight,
          fields.height,
          fields.fullDescription
        ].filter((v, i, arr) =>
          typeof v === "string" && v.trim() &&
          arr.indexOf(v) === i
        ).join(" · ")
      : "";

    rows += `<tr>
      <td>${escapeHtml(item.code || "—")}</td>
      <td>${escapeHtml(item.name)}
      ${details ? `<br><small>${escapeHtml(details)}</small>` : ""}
      ${item.note ? `<br><small>Nota: ${escapeHtml(item.note)}</small>` : ""}
      </td>
      <td>${escapeHtml(item.quantity || "1")}</td>
      <td>${escapeHtml(priceText(item))}</td>
    </tr>`;
  });

  return `<!doctype html>
  <html lang="it"><head><meta charset="utf-8">
  <title>Documento listino</title>
  <style>
  body{font-family:Arial,sans-serif;padding:28px;color:#222}
  h1{color:#174f86;font-size:22px}
  table{width:100%;border-collapse:collapse;margin-top:20px}
  th,td{border:1px solid #ccc;padding:9px;text-align:left;vertical-align:top}
  th{background:#edf3f8}
  small{color:#555}
  </style></head><body>
  <h1>${offer ? "OFFERTA COMMERCIALE" : "RIEPILOGO SCELTA ARTICOLI"}</h1>
  <p><b>Data:</b> ${escapeHtml(c.date)}</p>
  <p><b>Riferimento:</b> ${escapeHtml(c.number)}</p>
  <p><b>Cliente:</b> ${escapeHtml(c.customer)}</p>
  <p><b>Reparto:</b> ${escapeHtml(c.department)}</p>
  <table><thead><tr><th>Codice</th><th>Articolo</th><th>Quantità</th><th>Prezzo</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <h3>Note</h3><p>${escapeHtml(c.note).replace(/\n/g, "<br>")}</p>
  ${offer ? `<h3>Condizioni commerciali</h3><p>${escapeHtml(c.conditions).replace(/\n/g, "<br>")}</p>` : ""}
  </body></html>`;
}

function printDocument() {
  if (!currentItems.length) {
    alert("Aggiungi almeno un articolo.");
    return;
  }

  const win = window.open("", "_blank");
  if (!win) {
    alert("Consenti i popup per generare il documento.");
    return;
  }

  win.document.open();
  win.document.write(buildDocumentHtml());
  win.document.close();
  win.onload = () => win.print();
}

function emailDocument() {
  if (!currentItems.length) {
    alert("Aggiungi almeno un articolo.");
    return;
  }

  const c = choicePayload();
  const subject = encodeURIComponent(
    (c.documentType === "offer" ? "Offerta" : "Riepilogo") +
    " - " + c.customer
  );
  const body = encodeURIComponent(
    "Cliente: " + c.customer +
    "\nReparto: " + c.department +
    "\nData: " + c.date +
    "\n\nArticoli:\n" +
    c.items.map(i => i.name + " - " + priceText(i) +
      " - Quantità: " + i.quantity).join("\n") +
    "\n\nNote: " + c.note +
    "\nCondizioni: " + c.conditions +
    "\n\nAllega il PDF generato dall'app."
  );

  window.location.href = "mailto:?subject=" + subject + "&body=" + body;
}

/* BACKUP E RIPRISTINO */

async function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    articles: await all("articles"),
    choices: await all("choices"),
    customers: await customersData()
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "backup-gestione-listini.json";
  a.click();
  URL.revokeObjectURL(url);
  message("backupMessage", "Backup esportato.");
}

async function restoreData() {
  const file = $("restoreFile").files[0];
  if (!file) {
    alert("Seleziona un file JSON.");
    return;
  }

  try {
    const payload = JSON.parse(await file.text());

    if (Array.isArray(payload.articles))
      await mergeArticles(payload.articles);

    if (Array.isArray(payload.choices)) {
      for (const c of payload.choices) await put("choices", c);
    }

    if (Array.isArray(payload.customers))
      await saveCustomers(payload.customers);

    await refreshCustomers();
    await renderSaved();

    message("backupMessage", "Backup ripristinato. I dati già presenti sono stati conservati.");
  } catch (e) {
    message("backupMessage", "Backup non valido: " + e.message);
  }
}

/* PASSWORD */

async function hashPassword(password, saltHex) {
  const encoder = new TextEncoder();
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/.{2}/g), x => parseInt(x, 16))
    : crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt,
    iterations: 150000,
    hash: "SHA-256"
  }, key, 256);

  return {
    hash: Array.from(new Uint8Array(bits), b =>
      b.toString(16).padStart(2, "0")).join(""),
    salt: Array.from(salt, b =>
      b.toString(16).padStart(2, "0")).join("")
  };
}

async function createPassword() {
  const first = $("newPassword").value;
  const second = $("confirmPassword").value;

  if (first.length < 6) {
    message("authMessage", "La password deve contenere almeno 6 caratteri.");
    return;
  }
  if (first !== second) {
    message("authMessage", "Le password non coincidono.");
    return;
  }

  const result = await hashPassword(first);
  await put("meta", {
    key: "auth",
    hash: result.hash,
    salt: result.salt
  });

  $("newPassword").value = "";
  $("confirmPassword").value = "";
  await unlockInterface();
}

async function unlockApp() {
  const auth = await getValue("meta", "auth");
  if (!auth) return;

  const result = await hashPassword(
    $("loginPassword").value, auth.salt
  );

  if (result.hash !== auth.hash) {
    message("authMessage", "Password non corretta.");
    return;
  }

  $("loginPassword").value = "";
  await unlockInterface();
}

async function unlockInterface() {
  $("authGate").classList.add("hidden");
  $("appShell").classList.remove("hidden");
  await refreshArticles();
  await refreshCustomers();
  await renderSaved();
  configureIdleLock();
}

function lockApp() {
  if ($("appShell").classList.contains("hidden")) return;
  $("appShell").classList.add("hidden");
  $("authGate").classList.remove("hidden");
  $("passwordSetup").classList.add("hidden");
  $("passwordLogin").classList.remove("hidden");
  $("loginPassword").value = "";
}

async function changePassword() {
  const auth = await getValue("meta", "auth");
  const old = $("oldPassword").value;
  const next = $("newPasswordChange").value;

  if (!auth || next.length < 6) {
    message("settingsMessage", "La nuova password deve avere almeno 6 caratteri.");
    return;
  }

  const oldHash = await hashPassword(old, auth.salt);
  if (oldHash.hash !== auth.hash) {
    message("settingsMessage", "Password attuale non corretta.");
    return;
  }

  const result = await hashPassword(next);
  await put("meta", {
    key: "auth",
    hash: result.hash,
    salt: result.salt
  });

  $("oldPassword").value = "";
  $("newPasswordChange").value = "";
  message("settingsMessage", "Password aggiornata.");
}

/* IMPOSTAZIONI */

async function configureIdleLock() {
  if (idleTimer) clearTimeout(idleTimer);

  const setting = await getValue("meta", "idleLock");
  const minutes = setting ? Number(setting.value) : 0;
  if (!minutes) return;

  idleTimer = setTimeout(lockApp, minutes * 60 * 1000);
}

async function saveSettings() {
  await put("meta", {
    key: "idleLock",
    value: Number($("idleLock").value)
  });
  await configureIdleLock();
  message("settingsMessage", "Impostazioni salvate.");
}

async function loadSettings() {
  const setting = await getValue("meta", "idleLock");
  if (setting) $("idleLock").value = String(setting.value);

  const language = await getValue("meta", "language");
  if (language) {
    currentLanguage = language.value;
    $("language").value = currentLanguage;
  }
}

async function saveLanguage() {
  currentLanguage = $("language").value;
  await put("meta", { key: "language", value: currentLanguage });
  message("settingsMessage",
    currentLanguage === "en"
      ? "Language preference saved. Full translation is not yet available."
      : "Preferenza lingua salvata.");
}

/* AVVIO E COLLEGAMENTI */

$("createPassword").onclick = createPassword;
$("unlockApp").onclick = unlockApp;
$("addDepartment").onclick = saveCustomerDepartment;
$("customer").onchange = refreshDepartments;
$("customer").oninput = refreshDepartments;

$("search").oninput = renderResults;
$("startScan").onclick = startScanner;
$("stopScan").onclick = stopScanner;

$("showManual").onclick = async () => {
  if (await ensureCustomer()) $("manualAdd").classList.remove("hidden");
};
$("addManual").onclick = addManual;

$("readPdf").onclick = readPdf;
$("confirmPdfImport").onclick = confirmPdfImport;
$("cancelPdfImport").onclick = cancelPdfImport;
$("importCsv").onclick = importCsv;
$("importExcel").onclick = importExcel;

$("saveChoice").onclick = saveChoice;
$("newChoice").onclick = newChoice;
$("printDocument").onclick = printDocument;
$("emailDocument").onclick = emailDocument;

$("exportData").onclick = exportData;
$("restoreData").onclick = restoreData;

$("saveSettings").onclick = saveSettings;
$("changePassword").onclick = changePassword;
$("lockApp").onclick = lockApp;
$("language").onchange = saveLanguage;

window.addEventListener("online", status);
window.addEventListener("offline", status);

["click", "keydown", "touchstart", "mousemove"].forEach(eventName => {
  document.addEventListener(eventName, () => {
    if (!$("appShell").classList.contains("hidden"))
      configureIdleLock();
  }, { passive: true });
});

(async function init() {
  try {
    db = await openDb();
    status();
    await loadSettings();

    const auth = await getValue("meta", "auth");

    if (auth) {
      $("authGate").classList.remove("hidden");
      $("passwordLogin").classList.remove("hidden");
    } else {
      $("authGate").classList.remove("hidden");
      $("passwordSetup").classList.remove("hidden");
    }

    newChoice();

    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("./sw.js");
      } catch (e) {
        console.warn("Service worker non registrato", e);
      }
    }
  } catch (e) {
    alert("Errore inizializzazione archivio: " + e.message);
  }
})();
