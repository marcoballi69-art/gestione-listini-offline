"use strict";

const DB_NAME = "gestione-listini-offline";
const DB_VERSION = 1;
let db, articles = [], currentItems = [], currentChoiceId = null;
let scanner = null, lastScan = "", pdfPreviewRows = [], idleTimer = null;
let currentLanguage = "it";
let recentScans = [], scanBusy = false, lastScanAt = 0, audioContext = null;
let screenWakeLock = null;
const $ = id => document.getElementById(id);

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const d = request.result;
      if (!d.objectStoreNames.contains("articles")) d.createObjectStore("articles", { keyPath: "code" });
      if (!d.objectStoreNames.contains("choices")) d.createObjectStore("choices", { keyPath: "id" });
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function store(name, mode = "readonly") { return db.transaction(name, mode).objectStore(name); }
function all(name) {
  return new Promise((resolve, reject) => {
    const r = store(name).getAll(); r.onsuccess = () => resolve(r.result || []); r.onerror = () => reject(r.error);
  });
}
function getValue(name, key) {
  return new Promise((resolve, reject) => {
    const r = store(name).get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
function put(name, value) {
  return new Promise((resolve, reject) => {
    const r = store(name, "readwrite").put(value); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
function removeRecord(name, key) {
  return new Promise((resolve, reject) => {
    const r = store(name, "readwrite").delete(key); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error);
  });
}
function norm(v) {
  return String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
function codeKey(v) { return String(v || "").trim().replace(/^0+(?=\d)/, ""); }
function priceText(a) {
  if (a.price === "" || a.price == null || !Number.isFinite(Number(a.price))) return "Prezzo non indicato";
  return "€ " + Number(a.price).toFixed(2).replace(".", ",");
}
function status() {
  const online = navigator.onLine;
  $("connection").textContent = online ? t("Connesso — dati conservati sul dispositivo") : t("Offline — puoi utilizzare i dati già salvati");
  $("connection").className = "status " + (online ? "on" : "off");
}
function message(id, text) { if ($(id)) $(id).textContent = t(text); }

/* CLIENTI: il reparto è facoltativo */
async function customersData() { const data = await getValue("meta", "customers"); return data ? data.value : []; }
async function saveCustomers(data) { await put("meta", { key: "customers", value: data }); }
async function refreshCustomers() {
  const data = await customersData(), options = $("customerOptions");
  options.replaceChildren();
  data.forEach(c => { const o = document.createElement("option"); o.value = c.name; options.append(o); });
  await refreshDepartments();
}
async function refreshDepartments() {
  const data = await customersData(), customer = norm($("customer").value), selected = $("department").value;
  const found = data.find(c => norm(c.name) === customer), select = $("department");
  select.replaceChildren();
  const first = document.createElement("option"); first.value = ""; first.textContent = "Nessun reparto / seleziona"; select.append(first);
  if (found) (found.departments || []).forEach(dep => { const o = document.createElement("option"); o.value = dep; o.textContent = dep; select.append(o); });
  if ([...select.options].some(o => o.value === selected)) select.value = selected;
}
async function saveCustomerDepartment() {
  const name = $("customer").value.trim(), department = $("newDepartment").value.trim();
  if (!name) { message("customerMessage", "Inserisci prima il cliente."); return; }
  if (!department) { message("customerMessage", "Scrivi il nome del reparto."); return; }
  const data = await customersData();
  let c = data.find(x => norm(x.name) === norm(name));
  if (!c) { c = { name, departments: [] }; data.push(c); }
  c.departments = c.departments || [];
  if (!c.departments.includes(department)) c.departments.push(department);
  await saveCustomers(data); $("newDepartment").value = "";
  await refreshCustomers(); $("department").value = department;
  message("customerMessage", "Cliente e reparto salvati.");
}
async function ensureCustomer() {
  const name = $("customer").value.trim(), department = $("department").value;
  if (!name) { message("customerMessage", "Seleziona o inserisci il cliente prima di aggiungere articoli."); $("customer").focus(); return false; }
  const data = await customersData();
  let c = data.find(x => norm(x.name) === norm(name));
  if (!c) { c = { name, departments: [] }; data.push(c); }
  c.departments = c.departments || [];
  if (department && !c.departments.includes(department)) c.departments.push(department);
  await saveCustomers(data);
  message("customerMessage", department ? "Cliente e reparto selezionati." : "Cliente selezionato. Reparto facoltativo.");
  return true;
}

/* ARCHIVIO E RICERCA */
async function refreshArticles() {
  articles = await all("articles");
  $("listinoInfo").textContent = articles.length + t(" articoli salvati sul dispositivo.");
  renderResults();
}
function renderResults() {
  const query = norm($("search").value), host = $("results");
  host.replaceChildren();
  const found = articles.filter(a => !query || norm(a.name).includes(query) || String(a.code).includes(query))
    .sort((a,b) => String(a.name || "").localeCompare(String(b.name || ""), "it", { sensitivity:"base", numeric:true }));
  if (!found.length) { host.textContent = t("Nessun articolo trovato."); applyLanguage(); return; }
  found.forEach(a => {
    const div = document.createElement("div"); div.className = "article";
    const name = document.createElement("strong"); name.textContent = a.name;
    const details = document.createElement("div"); details.className = "price"; details.textContent = t("Codice ") + a.code + " · " + priceText(a);
    const button = document.createElement("button"); button.textContent = "Aggiungi alla scelta";
    button.onclick = async () => { if (await ensureCustomer()) addArticle(a); };
    div.append(name, details, button); host.append(div);
  });
  applyLanguage();
}
function addArticle(a) {
  if (currentItems.some(x => x.code && codeKey(x.code) === codeKey(a.code))) {
    message("scanMessage", "Articolo già presente nella scelta: " + a.name + " — " + priceText(a));
    return false;
  }
  currentItems.push({ code:a.code, name:a.name, price:a.price, currency:a.currency || "EUR", quantity:"1", note:"", originalFields:a.originalFields || {}, manual:false });
  renderChoice(); autosaveDraft(); return true;
}

/* SCELTA ARTICOLI */
function renderChoice() {
  const host = $("choiceItems"); host.replaceChildren();
  if (!currentItems.length) { host.textContent = t("Nessun articolo selezionato."); renderRecentScans(); applyLanguage(); return; }
  currentItems.forEach((item,index) => {
    const div = document.createElement("div"); div.className = "item";
    const name = document.createElement("strong"); name.textContent = item.name;
    const details = document.createElement("div"); details.className = "muted";
    details.textContent = (item.code ? t("Codice ") + item.code + " · " : "") + priceText(item);
    const grid = document.createElement("div"); grid.className = "itemgrid";
    const qty = document.createElement("input"); qty.value = item.quantity || "1"; qty.placeholder = "Quantità / metri";
    qty.onchange = () => { item.quantity = qty.value; autosaveDraft(); };
    const remove = document.createElement("button"); remove.className = "danger"; remove.textContent = "Rimuovi";
    remove.onclick = () => {
      const removed = currentItems[index]; currentItems.splice(index,1);
      recentScans = recentScans.filter(x => !(x.code && removed.code && codeKey(x.code) === codeKey(removed.code)));
      renderChoice(); autosaveDraft(); renderRecentScans();
    };
    const note = document.createElement("textarea"); note.placeholder = "Nota articolo"; note.value = item.note || "";
    note.onchange = () => { item.note = note.value; autosaveDraft(); };
    grid.append(qty,remove); div.append(name,details,grid,note); host.append(div);
  });
  renderRecentScans();
  applyLanguage();
}
function choicePayload() {
  return {
    id:currentChoiceId || crypto.randomUUID(),
    date:$("choiceDate").value,
    number:$("choiceNumber").value.trim(),
    customer:$("customer").value.trim(),
    department:$("department").value,
    note:$("generalNote").value,
    conditions:$("commercialConditions").value,
    documentType:$("documentType").value,
    includeDetails:$("includeDetails").checked,
    includePrices:$("includePrices").checked,
    items:currentItems,
    updatedAt:new Date().toISOString()
  };
}


async function autosaveDraft() { if (currentChoiceId) await put("choices", choicePayload()); }
function newChoice() {
  currentChoiceId = crypto.randomUUID();
  currentItems = [];
  recentScans = [];
  $("choiceDate").value = new Date().toISOString().slice(0,10);
  $("choiceNumber").value = "";
  $("customer").value = "";
  $("department").value = "";
  $("newDepartment").value = "";
  $("search").value = "";
  $("generalNote").value = "";
  $("commercialConditions").value = "";
  $("documentType").value = "summary";
  $("includeDetails").checked = true;
  $("includePrices").checked = true;
  $("manualAdd").classList.add("hidden");
  $("reader").classList.add("hidden");
  $("results").classList.remove("hidden");
  renderChoice();
  renderRecentScans();
  refreshDepartments();
  window.scrollTo({top:0,behavior:"smooth"});
}


async function ensureSelectionNumber() {
  const existing = $("choiceNumber").value.trim();
  if (existing) return existing;
  const year = new Date().getFullYear();
  const key = "selectionSequence-" + year;
  const saved = await all("choices");
  const used = saved.map(c => {
    const m = String(c.number || "").match(/^(\d+)\/(\d{4})$/);
    return m && Number(m[2]) === year ? Number(m[1]) : 0;
  });
  const meta = await getValue("meta", key);
  const next = Math.max(Number(meta && meta.value) || 0, ...used) + 1;
  await put("meta", {key, value:next});
  $("choiceNumber").value = next + "/" + year;
  return $("choiceNumber").value;
}

async function saveChoice() {
  if (!await ensureCustomer()) return;
  if (!currentItems.length) {
    message("documentMessage", "Aggiungi almeno un articolo prima di salvare.");
    return;
  }
  await ensureSelectionNumber();
  const data = choicePayload();
  data.updatedAt = new Date().toISOString();
  await put("choices", data);
  await renderSaved();
  const savedNumber = data.number;
  newChoice();
  message("documentMessage", "Selezione " + savedNumber + " salvata. Inserisci il prossimo cliente.");
}


async function renderSaved() {
  const host = $("savedChoices");
  const query = norm($("savedSearch").value);
  const choices = (await all("choices"))
    .filter(c => !query || norm(c.customer).includes(query) || norm(c.number).includes(query))
    .sort((a,b) => (b.updatedAt||"").localeCompare(a.updatedAt||""));
  host.replaceChildren();
  if (!choices.length) {
    host.textContent = t(query ? "Nessuna selezione corrispondente." : "Nessuna scelta salvata.");
    applyLanguage();
    return;
  }
  choices.forEach(c => {
    const div = document.createElement("div");
    div.className = "article saved-choice";
    const title = document.createElement("strong");
    title.textContent = t("Selezione N.") + " " + (c.number || "—") + " · " + (c.customer || "Senza cliente");
    const info = document.createElement("div");
    info.className = "muted";
    info.textContent = (c.date || "") + (c.department ? " · " + c.department : "") + " · " + (c.items||[]).length + " " + t("articoli");
    const actions = document.createElement("div");
    actions.className = "row saved-actions";
    const open = document.createElement("button");
    open.className = "secondary";
    open.textContent = "Apri selezione";
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
      $("includePrices").checked = c.includePrices !== false;
      currentItems = c.items || [];
      recentScans = [];
      renderChoice();
      window.scrollTo({top:0,behavior:"smooth"});
    };
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Elimina selezione";
    del.onclick = async () => {
      if (!confirm("Eliminare definitivamente la selezione " + (c.number || "") + " di " + (c.customer || "") + "?")) return;
      await removeRecord("choices", c.id);
      if (currentChoiceId === c.id) newChoice();
      await renderSaved();
      message("documentMessage", "Selezione eliminata. Il numero progressivo non verrà riutilizzato.");
    };
    actions.append(open, del);
    div.append(title, info, actions);
    host.append(div);
  });
  applyLanguage();
}


function rememberRecentScan(a) {
  recentScans = recentScans.filter(x => codeKey(x.code) !== codeKey(a.code));
  recentScans.unshift({ code:a.code, name:a.name, price:a.price, currency:a.currency || "EUR" });
  recentScans = recentScans.slice(0,3); renderRecentScans();
}
function renderRecentScans() {
  const host=$("recentScanItems"); if (!host) return; host.replaceChildren();
  if (!recentScans.length) return;
  const heading=document.createElement("div"); heading.className="muted"; heading.textContent="Ultimi 3 articoli scansionati"; host.append(heading);
  recentScans.forEach(a=>{
    const row=document.createElement("div"); row.className="recent-scan";
    const info=document.createElement("div"); info.className="recent-scan-info";
    const name=document.createElement("strong"); name.textContent=a.name;
    const price=document.createElement("div"); price.className="price"; price.textContent=priceText(a);
    info.append(name,price);
    const del=document.createElement("button"); del.className="danger"; del.textContent="Cancella";
    del.onclick=()=>{ const i=currentItems.findIndex(x=>x.code && codeKey(x.code)===codeKey(a.code));
      if(i>=0) currentItems.splice(i,1);
      recentScans=recentScans.filter(x=>codeKey(x.code)!==codeKey(a.code));
      renderChoice(); autosaveDraft(); renderRecentScans(); };
    row.append(info,del); host.append(row);
  });
}

/* INSERIMENTO MANUALE */
async function addManual() {
  if (!await ensureCustomer()) return;
  const name=$("manualName").value.trim(); if(!name){alert("Inserisci il nome dell'articolo.");return;}
  currentItems.push({code:"",name,price:$("manualPrice").value||"",currency:"EUR",
    quantity:$("manualQty").value.trim()||"1",note:$("manualNote").value.trim(),originalFields:{},manual:true});
  $("manualName").value=""; $("manualPrice").value=""; $("manualQty").value=""; $("manualNote").value="";
  $("manualAdd").classList.add("hidden"); renderChoice(); autosaveDraft();
}

/* SUONO, VIBRAZIONE E WAKE LOCK */
async function prepareAudio() {
  try {
    const Ctx=window.AudioContext||window.webkitAudioContext;
    if(!Ctx) return;
    if(!audioContext) audioContext=new Ctx();
    if(audioContext.state==="suspended") await audioContext.resume();
  } catch(e) { /* audio non supportato o bloccato */ }
}
function beep() {
  try {
    if(!audioContext || audioContext.state!=="running") return;
    const osc=audioContext.createOscillator(), gain=audioContext.createGain();
    osc.type="sine"; osc.frequency.value=880; gain.gain.setValueAtTime(0.0001,audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18,audioContext.currentTime+0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001,audioContext.currentTime+0.19);
    osc.connect(gain); gain.connect(audioContext.destination); osc.start(); osc.stop(audioContext.currentTime+0.2);
  } catch(e) {}
}
function vibrateScan() { try { if(navigator.vibrate) navigator.vibrate(70); } catch(e) {} }
async function requestScreenWakeLock() {
  try { if("wakeLock" in navigator) screenWakeLock=await navigator.wakeLock.request("screen"); } catch(e) {}
}
async function releaseScreenWakeLock() {
  try { if(screenWakeLock) await screenWakeLock.release(); } catch(e) {}
  screenWakeLock=null;
}

/* SCANNER OFFLINE: BarcodeDetector quando disponibile + decoder EAN locale */
let localScanStream = null, localScanVideo = null, localScanFrame = 0;
let localScanCanvas = null, localScanContext = null, localScanBusy = false, localScanLastFrameAt = 0;
const EAN_L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const EAN_G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const EAN_R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
const EAN_PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];
function decodeEanRow(imageData) {
  const {data,width,height}=imageData, y=Math.max(0,Math.min(height-1,Math.floor(height/2)));
  const gray=new Uint8Array(width), hist=new Uint32Array(256);
  for(let x=0;x<width;x++){const k=(y*width+x)*4,v=(data[k]*0.299+data[k+1]*0.587+data[k+2]*0.114)|0;gray[x]=v;hist[v]++;}
  let sum=0;for(let i=0;i<256;i++)sum+=i*hist[i];
  let sumB=0,wB=0,max=-1,threshold=127;
  for(let i=0;i<256;i++){wB+=hist[i];if(!wB)continue;const wF=width-wB;if(!wF)break;sumB+=i*hist[i];const between=wB*wF*(sumB/wB-(sum-sumB)/wF)**2;if(between>max){max=between;threshold=i;}}
  const bits=gray.map(v=>v<=threshold?1:0), runs=[];
  let bit=bits[0],runStart=0;
  for(let x=1;x<=width;x++){if(x===width||bits[x]!==bit){runs.push({bit,start:runStart,len:x-runStart});if(x<width){bit=bits[x];runStart=x;}}}
  const near=(a,b,t)=>Math.abs(a-b)<=Math.max(1,b*t);
  for(let i=0;i<runs.length-2;i++){
    if(runs[i].bit!==1||runs[i+1].bit!==0||runs[i+2].bit!==1)continue;
    const module=(runs[i].len+runs[i+1].len+runs[i+2].len)/3;
    if(module<1.15||!near(runs[i].len,module,.48)||!near(runs[i+1].len,module,.48)||!near(runs[i+2].len,module,.48))continue;
    const x0=runs[i].start;

    // EAN-8: 67 moduli (101 + 4 cifre + 01010 + 4 cifre + 101).
    if(x0+67*module<=width){
      let p8="";
      for(let n=0;n<67;n++){const x=Math.min(width-1,Math.floor(x0+(n+.5)*module));p8+=bits[x]?"1":"0";}
      if(p8.slice(0,3)==="101"&&p8.slice(31,36)==="01010"&&p8.slice(64,67)==="101"){
        const digits8=[];let valid8=true;
        for(let d=0;d<4;d++){const n=EAN_L.indexOf(p8.slice(3+d*7,10+d*7));if(n<0){valid8=false;break;}digits8.push(n);}
        if(valid8){
          for(let d=0;d<4;d++){const n=EAN_R.indexOf(p8.slice(36+d*7,43+d*7));if(n<0){valid8=false;break;}digits8.push(n);}
        }
        if(valid8){
          const sum8=digits8.slice(0,7).reduce((s,v,i)=>s+v*(i%2===0?3:1),0);
          if((10-sum8%10)%10===digits8[7])return digits8.join("");
        }
      }
    }

    // EAN-13.
    const total=95*module;
    if(x0+total>width)continue;
    let pattern="";
    for(let n=0;n<95;n++){const x=Math.min(width-1,Math.floor(x0+(n+.5)*module));pattern+=bits[x]?"1":"0";}
    if(pattern.slice(0,3)!=="101"||pattern.slice(45,50)!=="01010"||pattern.slice(92,95)!=="101")continue;
    const left=[],right=[];let parity="";
    for(let d=0;d<6;d++){
      const p=pattern.slice(3+d*7,10+d*7);
      let found=-1,kind="";
      for(let n=0;n<10;n++){if(p===EAN_L[n]){found=n;kind="L";break;}if(p===EAN_G[n]){found=n;kind="G";break;}}
      if(found<0){left.length=0;break;}left.push(found);parity+=kind;
    }
    if(left.length!==6)continue;
    const first=EAN_PARITY.indexOf(parity);if(first<0)continue;
    for(let d=0;d<6;d++){const p=pattern.slice(50+d*7,57+d*7),n=EAN_R.indexOf(p);if(n<0){right.length=0;break;}right.push(n);}
    if(right.length!==6)continue;
    const digits=[first,...left,...right],sumCheck=digits.slice(0,12).reduce((s,v,i)=>s+v*(i%2===0?1:3),0),check=(10-sumCheck%10)%10;
    if(check===digits[12])return digits.join("");
  }
  return "";
}
function decodeLocalFrame(video) {
  if (!localScanCanvas) {
    localScanCanvas = document.createElement("canvas");
    localScanContext = localScanCanvas.getContext("2d", {willReadFrequently:true});
  }
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return "";
  const scale = Math.min(1, 1440 / w);
  localScanCanvas.width = Math.round(w * scale);
  localScanCanvas.height = Math.round(h * scale);
  localScanContext.drawImage(video, 0, 0, localScanCanvas.width, localScanCanvas.height);
  const cw = localScanCanvas.width, ch = localScanCanvas.height;
  // Campiona più fasce e media 5 righe per ridurre rumore, riflessi e sfocatura.
  for (const fraction of [.32,.37,.42,.47,.52,.57,.62,.67]) {
    const y = Math.max(2, Math.min(ch - 3, Math.floor(ch * fraction)));
    const sample = localScanContext.getImageData(0, y - 2, cw, 5);
    const averaged = new Uint8ClampedArray(cw * 4);
    for (let x = 0; x < cw; x++) {
      let r=0,g=0,b=0,a=0;
      for (let dy=0; dy<5; dy++) {
        const k=(dy*cw+x)*4;
        r+=sample.data[k]; g+=sample.data[k+1]; b+=sample.data[k+2]; a+=sample.data[k+3];
      }
      const k=x*4;
      averaged[k]=r/5; averaged[k+1]=g/5; averaged[k+2]=b/5; averaged[k+3]=a/5;
    }
    const found = decodeEanRow({data:averaged,width:cw,height:1});
    if (found) return found;
  }
  return "";
}


async function startScanner() {
  if(scanner){message("scanMessage","Scanner già attivo.");return;}
  await prepareAudio();
  if(!await ensureCustomer())return;
  if(!window.isSecureContext){message("scanMessage","La fotocamera richiede una pagina HTTPS.");return;}
  $("reader").classList.remove("hidden");$("results").classList.add("hidden");
  try{
    localScanVideo=document.createElement("video");
    localScanVideo.setAttribute("playsinline","");localScanVideo.setAttribute("autoplay","");localScanVideo.muted=true;
    $("reader").replaceChildren(localScanVideo);
    localScanStream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:"environment"},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:24,max:30}}});
    localScanVideo.srcObject=localScanStream;await localScanVideo.play();
    scanner={active:true};
    const track=localScanStream.getVideoTracks()[0];
    try{
      const caps=track.getCapabilities?track.getCapabilities():{};
      const advanced={};
      if(caps.focusMode&&caps.focusMode.includes("continuous"))advanced.focusMode="continuous";
      if(caps.zoom)advanced.zoom=Math.min(caps.zoom.max,Math.max(caps.zoom.min,1.35));
      if(Object.keys(advanced).length)await track.applyConstraints({advanced:[advanced]});
    }catch(e){}
    let detector=null;
    if("BarcodeDetector" in window){try{detector=new BarcodeDetector({formats:["ean_13","ean_8","upc_a","upc_e"]});}catch(e){}}
    const tick=async()=>{
      if(!scanner||!localScanVideo||localScanVideo.readyState<2){if(scanner)localScanFrame=requestAnimationFrame(tick);return;}
      const frameNow=performance.now();
      if(!localScanBusy && frameNow-localScanLastFrameAt>=120){
        localScanBusy=true;
        localScanLastFrameAt=frameNow;
        try{
          let code="";
          if(detector){try{const found=await detector.detect(localScanVideo);if(found.length)code=found[0].rawValue||"";}catch(e){}}
          if(!code)code=decodeLocalFrame(localScanVideo);
          if(code){
            const now=Date.now();
            if(!scanBusy&&!(code===lastScan&&now-lastScanAt<1600)){
              scanBusy=true;lastScan=code;lastScanAt=now;
              Promise.resolve(onBarcode(code)).finally(()=>setTimeout(()=>{scanBusy=false;},450));
            }
          }
        }catch(e){}
        finally{localScanBusy=false;}
      }
      if(scanner)localScanFrame=requestAnimationFrame(tick);
    };
    localScanFrame=requestAnimationFrame(tick);
    await requestScreenWakeLock();
    message("scanMessage","Scanner attivo: mantieni il codice intero nell'inquadratura, orizzontale e a fuoco. Avvicina o allontana lentamente il telefono.");
  }catch(e){
    await stopScanner();
    $("results").classList.remove("hidden");
    message("scanMessage","Errore fotocamera: "+(e&&e.message?e.message:"accesso non disponibile"));
  }
}
async function stopScanner(){
  if(localScanFrame)cancelAnimationFrame(localScanFrame);localScanFrame=0;
  if(localScanStream){localScanStream.getTracks().forEach(t=>{try{t.stop();}catch(e){}});localScanStream=null;}
  if(localScanVideo){try{localScanVideo.pause();localScanVideo.srcObject=null;}catch(e){}localScanVideo=null;}
  scanner=null;$("reader").classList.add("hidden");$("results").classList.remove("hidden");
  await releaseScreenWakeLock();message("scanMessage","Scanner fermato.");
}
function normalizeBarcodeCode(value) {
  return String(value==null?"":value).normalize("NFKC").trim().replace(/[\s-]/g,"").replace(/^0+(?=\d)/,"");
}
async function onBarcode(code) {
  const scanned=normalizeBarcodeCode(code);
  const a=articles.find(x=>normalizeBarcodeCode(x.code)===scanned && scanned!=="");
  if(a) {
    if(!await ensureCustomer()) return;
    const added=addArticle(a);
    if (added) rememberRecentScan(a);
    beep(); vibrateScan();
    message("scanMessage",(added?"TROVATO: ":"GIÀ PRESENTE: ")+a.name+" — "+priceText(a));
    return;
  }
  message("scanMessage","Codice non trovato. Inserisci manualmente l'articolo.");
  $("manualAdd").classList.remove("hidden");
  $("manualName").value=""; $("manualQty").value=""; $("manualName").focus();
}

/* CSV / EXCEL */
function parseCsv(text) {
  const lines=text.replace(/^\uFEFF/,"").split(/\r?\n/).filter(x=>x.trim()); if(!lines.length)return[];
  const delimiter=(lines[0].match(/;/g)||[]).length>(lines[0].match(/,/g)||[]).length?";":",";
  function parseLine(line){const out=[];let value="",quoted=false;for(let i=0;i<line.length;i++){const c=line[i];
    if(c==='"'&&line[i+1]==='"'&&quoted){value+='"';i++;}else if(c==='"')quoted=!quoted;
    else if(c===delimiter&&!quoted){out.push(value.trim());value="";}else value+=c;}out.push(value.trim());return out;}
  const rows=lines.map(parseLine), header=rows[0].map(norm);
  const hasHeader=header.some(x=>["codice","code","articolo","nome","descrizione"].includes(x));
  return rows.slice(hasHeader?1:0).map(r=>({code:String(r[0]||"").trim(),name:String(r[1]||"").trim(),currency:"EUR",
    price:String(r[3]||r[2]||"").replace(",",".").trim(),originalFields:{columns:r}})).filter(a=>a.code&&a.name);
}
async function mergeArticles(rows) {
  let count=0; for(const a of rows){if(!a.code||!a.name)continue;await put("articles",{...a,code:String(a.code).trim(),name:String(a.name).trim()});count++;}
  await refreshArticles(); return count;
}
async function importCsv() {
  const file=$("csvFile").files[0];if(!file){alert("Seleziona un file CSV.");return;}
  try{const rows=parseCsv(await file.text());if(!rows.length)throw new Error("Nessun articolo riconosciuto.");
    const n=await mergeArticles(rows);message("importMessage",n+" articoli importati o aggiornati.");}
  catch(e){message("importMessage","Errore CSV: "+e.message);}
}
async function importExcel() {
  const file=$("excelFile").files[0];if(!file){alert("Seleziona un file Excel.");return;}
  if(!window.XLSX){message("importMessage","Lettore Excel non disponibile. Apri l'app online una volta.");return;}
  try{const workbook=XLSX.read(await file.arrayBuffer(),{type:"array"}),sheet=workbook.Sheets[workbook.SheetNames[0]];
    const data=XLSX.utils.sheet_to_json(sheet,{header:1,defval:""});
    const rows=data.filter(r=>r.length>=2&&r[0]&&r[1]).map(r=>({code:String(r[0]).trim(),name:String(r[1]).trim(),currency:"EUR",
      price:String(r[3]||r[2]||"").replace(",", "."),originalFields:{columns:r}}));
    if(!rows.length)throw new Error("Nessun articolo riconosciuto.");const n=await mergeArticles(rows);
    message("importMessage",n+" articoli importati o aggiornati.");}
  catch(e){message("importMessage","Errore Excel: "+e.message);}
}

/* PDF / OCR */
async function loadTesseract() {
  if(window.Tesseract)return window.Tesseract;
  await new Promise((resolve,reject)=>{const s=document.createElement("script");s.src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.onload=resolve;s.onerror=()=>reject(new Error("Impossibile caricare il motore OCR."));document.head.append(s);});
  return window.Tesseract;
}
async function extractPdfText(file) {
  if(!window.pdfjsLib)throw new Error("Lettore PDF non disponibile.");
  pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const pdf=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
  const lines=[];let ocrWorker=null;
  for(let p=1;p<=pdf.numPages;p++){
    message("pdfMessage","Lettura pagina "+p+" di "+pdf.numPages);
    const page=await pdf.getPage(p),content=await page.getTextContent(),rows=[];
    content.items.forEach(item=>{if(!item.str||!item.str.trim())return;const y=Math.round(item.transform[5]);
      let row=rows.find(r=>Math.abs(r.y-y)<=3);if(!row){row={y,parts:[]};rows.push(row);}row.parts.push({x:item.transform[4],text:item.str.trim()});});
    const pageLines=rows.sort((a,b)=>b.y-a.y).map(r=>r.parts.sort((a,b)=>a.x-b.x).map(x=>x.text).join(" ").replace(/\s+/g," ").trim()).filter(Boolean);
    if(pageLines.join("").replace(/\s/g,"").length>25)lines.push(...pageLines);
    else{
      if(!ocrWorker){const T=await loadTesseract();ocrWorker=await T.createWorker("ita");}
      const viewport=page.getViewport({scale:2}),canvas=document.createElement("canvas");canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      await page.render({canvasContext:canvas.getContext("2d"),viewport}).promise;
      const result=await ocrWorker.recognize(canvas);lines.push(...String(result.data.text||"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean));
      canvas.width=0;canvas.height=0;
    }
  }
  if(ocrWorker)await ocrWorker.terminate();return lines;
}
function parsePdfLines(lines) {
  const out=[],seen=new Set(),text=lines.map(x=>String(x).trim()).filter(Boolean);
  const pricePattern=/(?:EURO|EUR|€)?\s*(\d{1,4}[,.]\d{2})(?!\d)/i,codePattern=/^\d{3,8}$/;
  for(let i=0;i<text.length;i++){
    const line=text[i],start=line.match(/^(\d{3,8})\s+(.+)$/);let code="",description="";
    if(start){code=start[1];description=start[2];}else if(codePattern.test(line))code=line;else continue;
    if(seen.has(code))continue;
    const collected=[description];let price=null,original=[];
    for(let j=i;j<Math.min(i+8,text.length);j++){const current=text[j];original.push(current);const m=current.match(pricePattern);
      if(m){price=Number(m[1].replace(",", "."));break;}if(j>i&&!codePattern.test(current))collected.push(current);}
    if(price===null||!Number.isFinite(price))continue;
    const combined=collected.join(" ").replace(/\s+/g," ").trim(),composition=combined.match(/(?:PL|WO|PA|PC|SE|CO|VI|LI|EA|AC|NY|WV|WS)\s*\d+\s*%.*$/i);
    let name=combined,compositionText="";if(composition){compositionText=composition[0].trim();name=combined.slice(0,composition.index).trim();}
    name=name.replace(/\bEURO\b.*$/i,"").trim();if(!name)continue;
    out.push({code,name,price:String(price),currency:"EUR",originalFields:{originalLines:original,composition:compositionText,fullDescription:combined}});seen.add(code);
  }return out;
}
function renderPdfPreview(rows) {
  const host=$("pdfPreviewList");host.replaceChildren();
  rows.forEach(a=>{const row=document.createElement("div");row.className="pdf-row";const info=document.createElement("div");
    const name=document.createElement("strong");name.textContent=a.name;const code=document.createElement("small");code.textContent="Codice "+a.code;
    info.append(name,code);const price=document.createElement("b");price.className="pdf-price";price.textContent=priceText(a);row.append(info,price);host.append(row);});
  $("pdfPreviewCount").textContent=rows.length+" articoli riconosciuti";$("pdfPreview").classList.remove("hidden");
}
async function readPdf() {
  const file=$("pdfFile").files[0];if(!file){alert("Seleziona prima un PDF.");return;}
  $("pdfPreview").classList.add("hidden");message("pdfMessage","Lettura del PDF in corso…");
  try{const lines=await extractPdfText(file);pdfPreviewRows=parsePdfLines(lines);
    if(!pdfPreviewRows.length){message("pdfMessage","Nessun articolo riconosciuto. Controlla il PDF e la qualità della scansione.");return;}
    renderPdfPreview(pdfPreviewRows);message("pdfMessage","Controlla l'anteprima prima di importare.");}
  catch(e){message("pdfMessage","Errore PDF: "+e.message);}
}
async function confirmPdfImport() {
  if(!pdfPreviewRows.length)return;
  if(!confirm("Importare o aggiornare "+pdfPreviewRows.length+" articoli? Gli altri articoli già presenti saranno conservati."))return;
  const n=await mergeArticles(pdfPreviewRows);message("pdfMessage",n+" articoli importati o aggiornati.");
  $("pdfPreview").classList.add("hidden");pdfPreviewRows=[];$("pdfFile").value="";
}
function cancelPdfImport(){pdfPreviewRows=[];$("pdfPreview").classList.add("hidden");message("pdfMessage","Importazione annullata.");}

/* DOCUMENTO */
function escapeHtml(value){return String(value==null?"":value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function buildDocumentHtml() {
  const c = choicePayload();
  let rows = "";
  c.items.forEach(item => {
    const f = item.originalFields || {};
    const detailsRaw = c.includeDetails
      ? [f.composition, f.weight, f.height, f.fullDescription]
      : [];
    const seen = new Set([norm(item.name)]);
    const details = detailsRaw.filter(v => {
      if (typeof v !== "string" || !v.trim()) return false;
      const key = norm(v);
      if (!key || seen.has(key) || (norm(item.name) && key.includes(norm(item.name)))) return false;
      seen.add(key);
      return true;
    }).join(" · ");
    rows += `<tr><td>${escapeHtml(item.name)}${details ? `<br><small>${escapeHtml(details)}</small>` : ""}${item.note ? `<br><small><b>${t("Nota:")}</b> ${escapeHtml(item.note)}</small>` : ""}</td><td>${escapeHtml(item.quantity || "1")}</td>${c.includePrices ? `<td>${escapeHtml(priceText(item))}</td>` : ""}</tr>`;
  });
  const title = t("SELEZIONE N.") + " " + (c.number || "—");
  return `<!doctype html><html lang="${currentLanguage}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
  <style>
  body{font-family:Arial,sans-serif;padding:24px;color:#222}h1{color:#174f86;font-size:22px;margin:0 0 18px}
  .meta{line-height:1.55}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #ccc;padding:9px;text-align:left;vertical-align:top}
  th{background:#edf3f8}small{color:#555}.notes{white-space:pre-wrap}
  @media print{body{padding:0}.no-print{display:none!important}}
  </style></head><body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta"><b>${t("Cliente:")}</b> ${escapeHtml(c.customer)}<br><b>${t("Data:")}</b> ${escapeHtml(c.date)}${c.department ? `<br><b>${t("Reparto:")}</b> ${escapeHtml(c.department)}` : ""}</div>
  <table><thead><tr><th>${t("Articolo")}</th><th>${t("Quantità")}</th>${c.includePrices ? `<th>${t("Prezzo")}</th>` : ""}</tr></thead><tbody>${rows}</tbody></table>
  ${c.note ? `<h3>${t("Note generali")}</h3><p class="notes">${escapeHtml(c.note)}</p>` : ""}
  </body></html>`;
}


async function printDocument() {
  if (!currentItems.length) { alert(t("Aggiungi almeno un articolo.")); return; }
  if (!$("customer").value.trim()) { alert(t("Seleziona prima il cliente.")); $("customer").focus(); return; }
  await ensureSelectionNumber();
  $("documentPreviewFrame").srcdoc = buildDocumentHtml();
  $("documentPreviewModal").classList.remove("hidden");
  $("documentPreviewModal").setAttribute("aria-hidden","false");
}


async function emailDocument() {
  if (!currentItems.length) { alert(t("Aggiungi almeno un articolo.")); return; }
  if (!$("customer").value.trim()) { alert(t("Seleziona prima il cliente.")); $("customer").focus(); return; }
  await ensureSelectionNumber();
  const c = choicePayload();
  const subject = encodeURIComponent(t("Selezione N. ") + c.number + " - " + c.customer);
  const lines = c.items.map(i => {
    const bits = [i.name, t("Quantità:") + " " + (i.quantity || "1")];
    if (c.includePrices) bits.push(priceText(i));
    if (i.note && i.note.trim()) bits.push(t("Nota:") + " " + i.note.trim());
    return bits.join(" | ");
  });
  const body = encodeURIComponent(
    t("Selezione N. ") + c.number +
    "\n" + t("Cliente:") + " " + c.customer +
    (c.department ? "\n" + t("Reparto:") + " " + c.department : "") +
    "\n" + t("Data:") + " " + c.date + "\n\n" + t("Articoli:") + "\n" + lines.join("\n") +
    (c.note ? "\n\n" + t("Note generali") + ": " + c.note : "") +
    "\n\n" + t("Per allegare il PDF, genera il documento e usa Condividi / Salva PDF.")
  );
  window.location.href = "mailto:?subject=" + subject + "&body=" + body;
}


async function exportData() {
  const metaRows = await all("meta");
  const selectionSequences = metaRows.filter(x => String(x.key || "").startsWith("selectionSequence-"));
  const payload={exportedAt:new Date().toISOString(),articles:await all("articles"),choices:await all("choices"),customers:await customersData(),selectionSequences};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="backup-gestione-listini.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message("backupMessage","Backup esportato.");
}
async function restoreData() {
  const file=$("restoreFile").files[0];if(!file){alert("Seleziona un file JSON.");return;}
  try{const p=JSON.parse(await file.text());if(Array.isArray(p.articles))await mergeArticles(p.articles);
    if(Array.isArray(p.choices))for(const c of p.choices)await put("choices",c);
    if(Array.isArray(p.customers))await saveCustomers(p.customers);
    if(Array.isArray(p.selectionSequences))for(const sequence of p.selectionSequences)if(sequence&&String(sequence.key||"").startsWith("selectionSequence-"))await put("meta",sequence);
    await refreshCustomers();await renderSaved();message("backupMessage","Backup ripristinato. I dati già presenti sono stati conservati.");}
  catch(e){message("backupMessage","Backup non valido: "+e.message);}
}

/* PASSWORD */
async function hashPassword(password,saltHex) {
  const encoder=new TextEncoder(),salt=saltHex?Uint8Array.from(saltHex.match(/.{2}/g),x=>parseInt(x,16)):crypto.getRandomValues(new Uint8Array(16));
  const key=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:150000,hash:"SHA-256"},key,256);
  return {hash:Array.from(new Uint8Array(bits),b=>b.toString(16).padStart(2,"0")).join(""),salt:Array.from(salt,b=>b.toString(16).padStart(2,"0")).join("")};
}
async function createPassword() {
  const first=$("newPassword").value,second=$("confirmPassword").value;
  if(first.length<6){message("authMessage","La password deve contenere almeno 6 caratteri.");return;}
  if(first!==second){message("authMessage","Le password non coincidono.");return;}
  const r=await hashPassword(first);await put("meta",{key:"auth",hash:r.hash,salt:r.salt});
  $("newPassword").value="";$("confirmPassword").value="";await unlockInterface();
}
async function unlockApp() {
  const auth=await getValue("meta","auth");if(!auth)return;
  const r=await hashPassword($("loginPassword").value,auth.salt);
  if(r.hash!==auth.hash){message("authMessage","Password non corretta.");return;}
  $("loginPassword").value="";await unlockInterface();
}
async function unlockInterface() {
  $("authGate").classList.add("hidden");$("appShell").classList.remove("hidden");
  await refreshArticles();await refreshCustomers();await renderSaved();renderRecentScans();configureIdleLock();
}
function lockApp() {
  if($("appShell").classList.contains("hidden"))return;
  $("appShell").classList.add("hidden");$("authGate").classList.remove("hidden");
  $("passwordSetup").classList.add("hidden");$("passwordLogin").classList.remove("hidden");$("loginPassword").value="";
}
async function changePassword() {
  const auth=await getValue("meta","auth"),old=$("oldPassword").value,next=$("newPasswordChange").value;
  if(!auth||next.length<6){message("settingsMessage","La nuova password deve avere almeno 6 caratteri.");return;}
  const oldHash=await hashPassword(old,auth.salt);if(oldHash.hash!==auth.hash){message("settingsMessage","Password attuale non corretta.");return;}
  const r=await hashPassword(next);await put("meta",{key:"auth",hash:r.hash,salt:r.salt});
  $("oldPassword").value="";$("newPasswordChange").value="";message("settingsMessage","Password aggiornata.");
}

/* IMPOSTAZIONI */
async function configureIdleLock() {
  if(idleTimer)clearTimeout(idleTimer);
  const setting=await getValue("meta","idleLock"),minutes=setting?Number(setting.value):0;
  if(!minutes)return;
  idleTimer=setTimeout(()=>{if(scanner)stopScanner();lockApp();},minutes*60*1000);
}
async function saveSettings() {
  await put("meta",{key:"idleLock",value:Number($("idleLock").value)});
  await put("meta",{key:"rememberLogin",value:$("rememberLogin").value});
  await configureIdleLock();message("settingsMessage","Impostazioni salvate.");
}
async function loadSettings() {
  const setting=await getValue("meta","idleLock");if(setting)$("idleLock").value=String(setting.value);
  const remember=await getValue("meta","rememberLogin");if(remember)$("rememberLogin").value=remember.value;
  const language=await getValue("meta","language");if(language){currentLanguage=language.value;$("language").value=currentLanguage;}
}

const EN = {
  "Gestione Listini 2.0":"Price List Manager 2.0",
  "Archivio e gestione offerte":"Selections and document manager",
  "Lingua":"Language",
  "Italiano":"Italian",
  "English":"English",
  "Connesso — dati conservati sul dispositivo":"Online — data stored on this device",
  "Offline — puoi utilizzare i dati già salvati":"Offline — saved data remains available",
  "1. Scegli cliente":"1. Choose customer",
  "Cliente e reparto":"Customer and department",
  "Cliente":"Customer",
  "Seleziona o inserisci il cliente":"Select or enter a customer",
  "Reparto (facoltativo)":"Department (optional)",
  "Nessun reparto / seleziona":"No department / select",
  "Nuovo reparto":"New department",
  "Nome reparto":"Department name",
  "Aggiungi reparto al cliente":"Add department to customer",
  "2. Cerca e aggiungi articoli":"2. Find and add items",
  "Ricerca e scansione articoli":"Item search and scanning",
  "Cerca per nome o codice":"Search by name or code",
  "Scrivi il nome o il codice articolo":"Enter item name or code",
  "Apri fotocamera e scansiona":"Open camera and scan",
  "Chiudi scanner":"Close scanner",
  "Usa la fotocamera posteriore. Tieni il codice EAN orizzontale, a fuoco e ben illuminato.":"Use the rear camera. Keep the EAN barcode horizontal, in focus and well lit.",
  "Scanner non avviato.":"Scanner not started.",
  "3. Controlla la selezione":"3. Review selection",
  "Scelta articoli":"Selected items",
  "Data":"Date",
  "Numero selezione (assegnato automaticamente)":"Selection number (assigned automatically)",
  "Automatico":"Automatic",
  "Articoli selezionati":"Selected items",
  "Nessun articolo selezionato.":"No items selected.",
  "Inserimento articolo manuale":"Add item manually",
  "L'articolo sarà inserito solo in questa scelta e non nel listino.":"This item will be added only to this selection, not to the price list.",
  "Nome articolo":"Item name",
  "Prezzo":"Price",
  "Quantità / metraggio":"Quantity / length",
  "Nota articolo":"Item note",
  "Aggiungi articolo manuale":"Add manual item",
  "Inserisci articolo non presente nel listino":"Add an item not in the price list",
  "Note generali della scelta":"Selection notes",
  "Note aggiuntive...":"Additional notes...",
  "4. Salva e crea documento":"4. Save and create document",
  "Documento finale":"Final document",
  "Tipo documento":"Document type",
  "Riepilogo semplice":"Simple summary",
  "Offerta commerciale":"Commercial offer",
  "Includi i prezzi nel documento e nell'email":"Include prices in the document and email",
  "Includi i dettagli originali degli articoli disponibili":"Include available original item details",
  "Condizioni commerciali":"Commercial terms",
  "Tempi, validità offerta, pagamento, consegna...":"Timing, offer validity, payment, delivery...",
  "Salva scelta":"Save selection",
  "Nuova scelta":"New selection",
  "Genera PDF / Stampa":"Create PDF / Print",
  "Prepara email":"Prepare email",
  "Archivio selezioni salvate":"Saved selections",
  "Cerca per cliente o numero selezione":"Search by customer or selection number",
  "Es. Rossi oppure 12/2026":"E.g. Smith or 12/2026",
  "Listini e importazione articoli":"Price lists and item import",
  "Importazione listino":"Import price list",
  "Importa il listino PDF, CSV oppure Excel. Gli articoli importati vengono conservati nell'archivio locale.":"Import a PDF, CSV or Excel price list. Imported items are stored locally.",
  "Listino PDF":"PDF price list",
  "Leggi PDF e mostra anteprima":"Read PDF and show preview",
  "Seleziona un PDF.":"Select a PDF.",
  "Articoli riconosciuti":"Recognized items",
  "Conferma importazione":"Confirm import",
  "Annulla":"Cancel",
  "Listino CSV":"CSV price list",
  "Importa CSV":"Import CSV",
  "Listino Excel":"Excel price list",
  "Importa Excel":"Import Excel",
  "Nessun listino caricato.":"No price list loaded.",
  "Backup e ripristino":"Backup and restore",
  "Esporta una copia dei dati o ripristina un backup precedente. Questa sezione è separata dalla gestione della password.":"Export a copy of your data or restore a previous backup. This section is separate from password management.",
  "Esporta backup JSON":"Export JSON backup",
  "File di backup":"Backup file",
  "Ripristina backup":"Restore backup",
  "Gestione password e sicurezza":"Password and security",
  "Richiedi password a ogni apertura":"Require password every time the app opens",
  "Sì, chiedi sempre la password":"Yes, always ask for password",
  "No, mantieni l'accesso su questo dispositivo":"No, keep me signed in on this device",
  "Se scegli di mantenere l'accesso, chiunque apra l'app su questo dispositivo potrà vedere i dati finché non la blocchi manualmente o interviene il blocco per inattività.":"If you stay signed in, anyone opening the app on this device can see its data until you lock it or the inactivity lock activates.",
  "Blocco automatico dell'app per inattività":"Automatically lock the app after inactivity",
  "Disattivato":"Disabled",
  "5 minuti":"5 minutes",
  "10 minuti":"10 minutes",
  "15 minuti":"15 minutes",
  "30 minuti":"30 minutes",
  "Salva impostazioni":"Save settings",
  "Cambia password":"Change password",
  "Password attuale":"Current password",
  "Nuova password":"New password",
  "Blocca applicazione adesso":"Lock app now",
  "I dati vengono conservati nel browser del dispositivo. Effettua regolarmente un backup JSON. Il blocco con password protegge l'accesso all'interfaccia; non equivale alla cifratura dell'archivio. La funzione di blocco dell'app è distinta dallo spegnimento automatico dello schermo dell'iPhone.":"Data is stored in this device's browser. Export JSON backups regularly. The password protects access to the interface; it does not encrypt the archive. App locking is separate from the iPhone's automatic screen lock.",
  "Anteprima selezione":"Selection preview",
  "Condividi / Salva PDF":"Share / Save PDF",
  "Torna all'app":"Back to app",
  "Su iPhone, nella schermata di stampa usa il pulsante di condivisione per inviare o salvare il PDF.":"On iPhone, use the share button in the print screen to send or save the PDF.",
  "Aggiungi alla scelta":"Add to selection",
  "Codice":"Code",
  "Quantità:":"Quantity:",
  "Nota:":"Note:",
  "Prezzo non indicato":"Price not specified",
  "Nessun articolo trovato.":"No items found.",
  "Nessuna scelta salvata.":"No saved selections.",
  "Nessuna selezione corrispondente.":"No matching selections.",
  "Apri selezione":"Open selection",
  "Elimina selezione":"Delete selection",
  "Selezione":"Selection",
  "Senza cliente":"No customer",
  "articoli":"items",
  "Aggiungi almeno un articolo.":"Add at least one item.",
  "Seleziona prima il cliente.":"Select a customer first.",
  "Aggiungi almeno un articolo prima di salvare.":"Add at least one item before saving.",
  "Inserisci prima il cliente.":"Enter the customer first.",
  "Scrivi il nome del reparto.":"Enter the department name.",
  "Cliente e reparto salvati.":"Customer and department saved.",
  "Seleziona o inserisci il cliente prima di aggiungere articoli.":"Select or enter a customer before adding items.",
  "Cliente selezionato. Reparto facoltativo.":"Customer selected. Department is optional.",
  "Cliente e reparto selezionati.":"Customer and department selected.",
  "Scelta salvata sul dispositivo.":"Selection saved on this device.",
  "Selezione eliminata. Il numero progressivo non verrà riutilizzato.":"Selection deleted. Its sequence number will not be reused.",
  "Selezione salvata. Inserisci il prossimo cliente.":"Selection saved. Enter the next customer.",
  "Accesso protetto all'archivio locale.":"Secure access to the local archive.",
  "Crea la password":"Create password",
  "Conferma password":"Confirm password",
  "Crea password":"Create password",
  "Accedi":"Sign in",
  "Archivio e gestione offerte":"Selections and document manager",
  "Controllo connessione…":"Checking connection…",
  "Nuovo reparto":"New department",
  "Aggiungi reparto al cliente":"Add department to customer",
  "Condizioni commerciali":"Commercial terms",
  "Tempi, validità offerta, pagamento, consegna...":"Timing, offer validity, payment, delivery...",
  "Rimuovi":"Remove",
  "Cancella":"Delete",
  "Ultimi 3 articoli scansionati":"Last 3 scanned items",
  "Nota articolo":"Item note",
  "Quantità / metri":"Quantity / length",
  "Prezzo non indicato":"Price not specified",
  "Scanner già attivo.":"Scanner already active.",
  "Scanner fermato.":"Scanner stopped.",
  "Fotocamera attiva. Inquadra il codice EAN in orizzontale, con buona luce.":"Camera active. Frame the EAN barcode horizontally in good light.",
  "Codice non trovato. Inserisci manualmente l'articolo.":"Code not found. Enter the item manually.",
  "Seleziona o inserisci il cliente prima di aggiungere articoli.":"Select or enter a customer before adding items.",
  "Articolo già presente nella scelta: ":"Item already in selection: ",
  "Selezione salvata sul dispositivo.":"Selection saved on this device.",
  "Impossibile aprire la stampa su questo browser.":"Unable to open printing on this browser.",
  "Importa il listino PDF, CSV oppure Excel. Gli articoli importati vengono conservati nell'archivio locale.":"Import a PDF, CSV or Excel price list. Imported items are stored locally.",
  "Esporta una copia dei dati o ripristina un backup precedente. Questa sezione è separata dalla gestione della password.":"Export a copy of your data or restore a previous backup. This section is separate from password management.",
  "Password":"Password",
  "Codice ":"Code ",
  "articoli importati o aggiornati.":"items imported or updated.",
  "articoli riconosciuti":"recognized items",
  "articoli salvati sul dispositivo.":"items stored on this device.",
  "Controlla l'anteprima prima di importare.":"Review the preview before importing.",
  "Importazione annullata.":"Import cancelled.",
  "Impossibile caricare il motore OCR.":"Unable to load the OCR engine.",
  "Inserisci il nome dell'articolo.":"Enter the item name.",
  "La fotocamera richiede una pagina HTTPS.":"The camera requires an HTTPS page.",
  "Lettore Excel non disponibile. Apri l'app online una volta.":"Excel reader unavailable. Open the app online once.",
  "Lettore PDF non disponibile.":"PDF reader unavailable.",
  "Lettura del PDF in corso…":"Reading PDF…",
  "Nessun articolo riconosciuto.":"No items recognized.",
  "Nessun articolo riconosciuto. Controlla il PDF e la qualità della scansione.":"No items recognized. Check the PDF and scan quality.",
  "Seleziona prima un PDF.":"Select a PDF first.",
  "Seleziona un file CSV.":"Select a CSV file.",
  "Seleziona un file Excel.":"Select an Excel file.",
  "Scanner attivo: mantieni il codice intero nell'inquadratura, orizzontale e a fuoco. Avvicina o allontana lentamente il telefono.":"Scanner active: keep the full barcode in frame, horizontal and in focus. Slowly move the phone closer or farther away.",
  "Selezione N.":"Selection No.",
  "items":"items",
  "articoli":"items",
  "Ultimi 3 articoli scansionati":"Last 3 scanned items",
  "Interfaccia italiana selezionata.":"Italian interface selected.",
  "English interface selected.":"English interface selected.",
  "Inserisci prima il cliente.":"Enter the customer first.",
  "Articolo già presente nella scelta: ":"Item already in selection: ",
  "Codice non trovato. Inserisci manualmente l'articolo.":"Code not found. Enter the item manually.",
  "accesso non disponibile":"access unavailable",
  "Backup esportato.":"Backup exported.",
  "Backup ripristinato. I dati già presenti sono stati conservati.":"Backup restored. Existing data has been preserved.",
  "Backup non valido: ":"Invalid backup: ",
  "La password deve contenere almeno 6 caratteri.":"Password must contain at least 6 characters.",
  "Le password non coincidono.":"Passwords do not match.",
  "Password non corretta.":"Incorrect password.",
  "La nuova password deve avere almeno 6 caratteri.":"The new password must contain at least 6 characters.",
  "Password attuale non corretta.":"Current password is incorrect.",
  "Password aggiornata.":"Password updated.",
  "Impostazioni salvate.":"Settings saved.",
  "articoli importati o aggiornati.":"items imported or updated.",
  "Errore inizializzazione archivio: ":"Archive initialization error: ",
  "Errore fotocamera: ":"Camera error: ",
  "Errore CSV: ":"CSV error: ",
  "Errore Excel: ":"Excel error: ",
  "Errore PDF: ":"PDF error: ",
  "Selezione ":"Selection ",
  " · ":" · ",
  " articoli salvati sul dispositivo.":" items stored on this device.",
  " salvata. Inserisci il prossimo cliente.":" saved. Enter the next customer.",
  "SELEZIONE N.":"SELECTION NO.",
  "Cliente:":"Customer:",
  "Data:":"Date:",
  "Reparto:":"Department:",
  "Articolo":"Item",
  "Quantità":"Quantity",
  "Note generali":"General notes",
  "Nota:":"Note:",
  "Prezzo":"Price",
  "Selezione N. ":"Selection No. ",
  "Articoli:":"Items:",
  "Per allegare il PDF, genera il documento e usa Condividi / Salva PDF.":"To attach the PDF, create it and use Share / Save PDF.",
  "Quantità:":"Quantity:",
  "Articoli:":"Items:",
};
function t(value) {
  if (currentLanguage !== "en") return value;
  if (EN[value]) return EN[value];
  const prefixes = [
    ["TROVATO: ", "FOUND: "],
    ["GIÀ PRESENTE: ", "ALREADY IN SELECTION: "],
    ["Errore fotocamera: ", "Camera error: "],
    ["Errore CSV: ", "CSV error: "],
    ["Errore Excel: ", "Excel error: "],
    ["Errore PDF: ", "PDF error: "],
    ["Lettura pagina ", "Reading page "],
    ["Importare o aggiornare ", "Import or update "],
    ["Codice ", "Code "],
    ["Selezione ", "Selection "],
    ["Articolo già presente nella scelta: ", "Item already in selection: "],
    ["n articoli", "n items"]
  ];
  for (const [from,to] of prefixes) if (String(value).startsWith(from)) return to + String(value).slice(from.length);
  const suffixes = [
    [" articoli salvati sul dispositivo.", " items stored on this device."],
    [" articoli importati o aggiornati.", " items imported or updated."],
    [" salvata. Inserisci il prossimo cliente.", " saved. Enter the next customer."]
  ];
  for (const [from,to] of suffixes) if (String(value).endsWith(from)) return String(value).slice(0,-from.length) + to;
  return value;
}
function applyLanguage() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.__italianText) node.__italianText = node.nodeValue;
    const original = node.__italianText;
    const trimmed = original.trim();
    if (!trimmed) continue;
    const translated = currentLanguage === "en" ? (EN[trimmed] || trimmed) : trimmed;
    const leading = original.match(/^\s*/)?.[0] || "";
    const trailing = original.match(/\s*$/)?.[0] || "";
    node.nodeValue = leading + translated + trailing;
  }
  const placeholders = {
    "Seleziona o inserisci il cliente":"Select or enter a customer",
    "Nome reparto":"Department name",
    "Scrivi il nome o il codice articolo":"Enter item name or code",
    "Automatico":"Automatic",
    "Note aggiuntive...":"Additional notes...",
    "Tempi, validità offerta, pagamento, consegna...":"Timing, offer validity, payment, delivery...",
    "Es. Rossi oppure 12/2026":"E.g. Smith or 12/2026"
  };
  document.querySelectorAll("[placeholder]").forEach(el => {
    if (!el.__italianPlaceholder) el.__italianPlaceholder = el.getAttribute("placeholder");
    const original = el.__italianPlaceholder;
    el.setAttribute("placeholder", currentLanguage === "en" ? (placeholders[original] || original) : original);
  });
}

async function saveLanguage() {
  currentLanguage = $("language").value;
  await put("meta", {key:"language",value:currentLanguage});
  applyLanguage();
  message("settingsMessage", currentLanguage === "en" ? "English interface selected." : "Interfaccia italiana selezionata.");
}


/* EVENTI E AVVIO */
$("createPassword").onclick=createPassword;$("unlockApp").onclick=unlockApp;
$("addDepartment").onclick=saveCustomerDepartment;
$("customer").onchange=async()=>{await refreshDepartments();if($("customer").value.trim())message("customerMessage","Cliente selezionato. Il reparto è facoltativo.");};
$("customer").oninput=refreshDepartments;
$("search").oninput=renderResults;$("startScan").onclick=startScanner;$("stopScan").onclick=stopScanner;
$("showManual").onclick=async()=>{if(await ensureCustomer())$("manualAdd").classList.remove("hidden");};
$("addManual").onclick=addManual;
$("readPdf").onclick=readPdf;$("confirmPdfImport").onclick=confirmPdfImport;$("cancelPdfImport").onclick=cancelPdfImport;
$("importCsv").onclick=importCsv;$("importExcel").onclick=importExcel;
$("saveChoice").onclick=saveChoice;$("newChoice").onclick=newChoice;$("printDocument").onclick=printDocument;$("emailDocument").onclick=emailDocument;
$("savedSearch").oninput=renderSaved;
$("previewClose").onclick=()=>{$("documentPreviewModal").classList.add("hidden");$("documentPreviewModal").setAttribute("aria-hidden","true");};
$("previewPrint").onclick=()=>{const frame=$("documentPreviewFrame");try{frame.contentWindow.focus();frame.contentWindow.print();}catch(e){message("documentMessage","Impossibile aprire la stampa su questo browser.");}};
$("exportData").onclick=exportData;$("restoreData").onclick=restoreData;
$("saveSettings").onclick=saveSettings;$("changePassword").onclick=changePassword;$("lockApp").onclick=lockApp;$("language").onchange=saveLanguage;
window.addEventListener("online",status);window.addEventListener("offline",status);
["click","keydown","touchstart","mousemove"].forEach(eventName=>document.addEventListener(eventName,()=>{
  if(!$("appShell").classList.contains("hidden"))configureIdleLock();
},{passive:true}));
document.addEventListener("visibilitychange",async()=>{if(document.visibilityState==="visible"&&scanner&&"wakeLock"in navigator)await requestScreenWakeLock();});
(async function init(){
  try{
    db=await openDb();status();await loadSettings();applyLanguage();
    const auth=await getValue("meta","auth");
    if(auth){
      const remember=await getValue("meta","rememberLogin");
      if(remember&&remember.value==="no"){await unlockInterface();}
      else{$("authGate").classList.remove("hidden");$("passwordLogin").classList.remove("hidden");}
    }else{$("authGate").classList.remove("hidden");$("passwordSetup").classList.remove("hidden");}
    newChoice();
    if("serviceWorker"in navigator){try{await navigator.serviceWorker.register("./sw.js?v=6");}catch(e){console.warn("Service worker non registrato",e);}}
  }catch(e){alert("Errore inizializzazione archivio: "+e.message);}
})();
