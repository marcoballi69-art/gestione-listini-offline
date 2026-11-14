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
  $("connection").textContent = online ? "Connesso — dati conservati sul dispositivo" : "Offline — puoi utilizzare i dati già salvati";
  $("connection").className = "status " + (online ? "on" : "off");
}
function message(id, text) { if ($(id)) $(id).textContent = text; }

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
  $("listinoInfo").textContent = articles.length + " articoli salvati sul dispositivo.";
  renderResults();
}
function renderResults() {
  const query = norm($("search").value), host = $("results");
  host.replaceChildren();
  const found = articles.filter(a => !query || norm(a.name).includes(query) || String(a.code).includes(query))
    .sort((a,b) => String(a.name || "").localeCompare(String(b.name || ""), "it", { sensitivity:"base", numeric:true }));
  if (!found.length) { host.textContent = "Nessun articolo trovato."; return; }
  found.forEach(a => {
    const div = document.createElement("div"); div.className = "article";
    const name = document.createElement("strong"); name.textContent = a.name;
    const details = document.createElement("div"); details.className = "price"; details.textContent = "Codice " + a.code + " · " + priceText(a);
    const button = document.createElement("button"); button.textContent = "Aggiungi alla scelta";
    button.onclick = async () => { if (await ensureCustomer()) addArticle(a); };
    div.append(name, details, button); host.append(div);
  });
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
  if (!currentItems.length) { host.textContent = "Nessun articolo selezionato."; renderRecentScans(); return; }
  currentItems.forEach((item,index) => {
    const div = document.createElement("div"); div.className = "item";
    const name = document.createElement("strong"); name.textContent = item.name;
    const details = document.createElement("div"); details.className = "muted";
    details.textContent = (item.code ? "Codice " + item.code + " · " : "") + priceText(item);
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
}
function choicePayload() {
  return { id:currentChoiceId || crypto.randomUUID(), date:$("choiceDate").value, number:$("choiceNumber").value,
    customer:$("customer").value.trim(), department:$("department").value, note:$("generalNote").value,
    conditions:$("commercialConditions").value, documentType:$("documentType").value,
    includeDetails:$("includeDetails").checked, items:currentItems, updatedAt:new Date().toISOString() };
}
async function autosaveDraft() { if (currentChoiceId) await put("choices", choicePayload()); }
function newChoice() {
  currentChoiceId = crypto.randomUUID(); currentItems = []; recentScans = [];
  $("choiceDate").value = new Date().toISOString().slice(0,10); $("choiceNumber").value = "";
  $("generalNote").value = ""; $("commercialConditions").value = ""; $("manualAdd").classList.add("hidden");
  renderChoice(); renderRecentScans();
}
async function saveChoice() {
  if (!await ensureCustomer()) return;
  const data = choicePayload(); await put("choices",data); currentChoiceId=data.id; await renderSaved();
  message("documentMessage","Scelta salvata sul dispositivo.");
}
async function renderSaved() {
  const host=$("savedChoices"), choices=(await all("choices")).sort((a,b)=>(b.updatedAt||"").localeCompare(a.updatedAt||""));
  host.replaceChildren(); if (!choices.length) { host.textContent="Nessuna scelta salvata."; return; }
  choices.forEach(c => {
    const div=document.createElement("div"); div.className="article";
    const title=document.createElement("strong"); title.textContent=(c.date||"")+" — "+(c.customer||"Senza cliente")+(c.department?" / "+c.department:"");
    const info=document.createElement("div"); info.className="muted"; info.textContent=(c.items||[]).length+" articoli";
    const open=document.createElement("button"); open.className="secondary"; open.textContent="Apri";
    open.onclick=async()=>{ currentChoiceId=c.id; $("choiceDate").value=c.date||""; $("choiceNumber").value=c.number||"";
      $("customer").value=c.customer||""; await refreshDepartments(); $("department").value=c.department||"";
      $("generalNote").value=c.note||""; $("commercialConditions").value=c.conditions||"";
      $("documentType").value=c.documentType||"summary"; $("includeDetails").checked=c.includeDetails!==false;
      currentItems=c.items||[]; recentScans=[]; renderChoice(); window.scrollTo({top:0,behavior:"smooth"}); };
    div.append(title,info,open); host.append(div);
  });
}

/* ULTIMI TRE SCANSIONATI */
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
  if(!localScanCanvas){localScanCanvas=document.createElement("canvas");localScanContext=localScanCanvas.getContext("2d",{willReadFrequently:true});}
  const w=video.videoWidth,h=video.videoHeight;if(!w||!h)return "";
  localScanCanvas.width=Math.min(w,1600);localScanCanvas.height=Math.min(h,900);
  localScanContext.drawImage(video,0,0,localScanCanvas.width,localScanCanvas.height);
  const cw=localScanCanvas.width,ch=localScanCanvas.height;
  for(const fraction of [.20,.28,.36,.44,.52,.60,.68,.76,.84]){
    const y=Math.min(ch-1,Math.floor(ch*fraction));
    const row=localScanContext.getImageData(0,y,cw,1);
    const found=decodeEanRow(row);if(found)return found;
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
    localScanStream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:"environment"},width:{ideal:1920},height:{ideal:1080}}});
    localScanVideo.srcObject=localScanStream;await localScanVideo.play();
    scanner={active:true};
    const track=localScanStream.getVideoTracks()[0];
    try{
      const caps=track.getCapabilities?track.getCapabilities():{};
      const advanced={};
      if(caps.focusMode&&caps.focusMode.includes("continuous"))advanced.focusMode="continuous";
      if(caps.zoom)advanced.zoom=Math.min(caps.zoom.max,Math.max(caps.zoom.min,1.2));
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
    message("scanMessage","Fotocamera attiva. Inquadra il codice EAN in orizzontale, con buona luce.");
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
  const c=choicePayload(),offer=c.documentType==="offer";let rows="";
  c.items.forEach(item=>{const f=item.originalFields||{},details=c.includeDetails?[f.composition,f.weight,f.height,f.fullDescription].filter((v,i,a)=>typeof v==="string"&&v.trim()&&a.indexOf(v)===i).join(" · "):"";
    rows+=`<tr><td>${escapeHtml(item.code||"—")}</td><td>${escapeHtml(item.name)}${details?`<br><small>${escapeHtml(details)}</small>`:""}${item.note?`<br><small>Nota: ${escapeHtml(item.note)}</small>`:""}</td><td>${escapeHtml(item.quantity||"1")}</td><td>${escapeHtml(priceText(item))}</td></tr>`;});
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Documento listino</title><style>body{font-family:Arial,sans-serif;padding:28px;color:#222}h1{color:#174f86;font-size:22px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #ccc;padding:9px;text-align:left;vertical-align:top}th{background:#edf3f8}small{color:#555}</style></head><body>
  <h1>${offer?"OFFERTA COMMERCIALE":"RIEPILOGO SCELTA ARTICOLI"}</h1><p><b>Data:</b> ${escapeHtml(c.date)}</p><p><b>Riferimento:</b> ${escapeHtml(c.number)}</p><p><b>Cliente:</b> ${escapeHtml(c.customer)}</p><p><b>Reparto:</b> ${escapeHtml(c.department||"—")}</p>
  <table><thead><tr><th>Codice</th><th>Articolo</th><th>Quantità</th><th>Prezzo</th></tr></thead><tbody>${rows}</tbody></table>
  <h3>Note</h3><p>${escapeHtml(c.note).replace(/\n/g,"<br>")}</p>${offer?`<h3>Condizioni commerciali</h3><p>${escapeHtml(c.conditions).replace(/\n/g,"<br>")}</p>`:""}</body></html>`;
}
function printDocument() {
  if(!currentItems.length){alert("Aggiungi almeno un articolo.");return;}
  const win=window.open("","_blank");if(!win){alert("Consenti i popup per generare il documento.");return;}
  win.document.open();win.document.write(buildDocumentHtml());win.document.close();win.onload=()=>win.print();
}
function emailDocument() {
  if(!currentItems.length){alert("Aggiungi almeno un articolo.");return;}
  const c=choicePayload(),subject=encodeURIComponent((c.documentType==="offer"?"Offerta":"Riepilogo")+" - "+c.customer);
  const body=encodeURIComponent("Cliente: "+c.customer+"\nReparto: "+(c.department||"—")+"\nData: "+c.date+"\n\nArticoli:\n"+
    c.items.map(i=>i.name+" - "+priceText(i)+" - Quantità: "+i.quantity).join("\n")+"\n\nNote: "+c.note+"\nCondizioni: "+c.conditions+"\n\nAllega il PDF generato dall'app.");
  window.location.href="mailto:?subject="+subject+"&body="+body;
}

/* BACKUP */
async function exportData() {
  const payload={exportedAt:new Date().toISOString(),articles:await all("articles"),choices:await all("choices"),customers:await customersData()};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="backup-gestione-listini.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message("backupMessage","Backup esportato.");
}
async function restoreData() {
  const file=$("restoreFile").files[0];if(!file){alert("Seleziona un file JSON.");return;}
  try{const p=JSON.parse(await file.text());if(Array.isArray(p.articles))await mergeArticles(p.articles);
    if(Array.isArray(p.choices))for(const c of p.choices)await put("choices",c);
    if(Array.isArray(p.customers))await saveCustomers(p.customers);
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
async function saveLanguage() {
  currentLanguage=$("language").value;await put("meta",{key:"language",value:currentLanguage});
  message("settingsMessage",currentLanguage==="en"?"Language preference saved. Full translation is not yet available.":"Preferenza lingua salvata.");
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
$("exportData").onclick=exportData;$("restoreData").onclick=restoreData;
$("saveSettings").onclick=saveSettings;$("changePassword").onclick=changePassword;$("lockApp").onclick=lockApp;$("language").onchange=saveLanguage;
window.addEventListener("online",status);window.addEventListener("offline",status);
["click","keydown","touchstart","mousemove"].forEach(eventName=>document.addEventListener(eventName,()=>{
  if(!$("appShell").classList.contains("hidden"))configureIdleLock();
},{passive:true}));
document.addEventListener("visibilitychange",async()=>{if(document.visibilityState==="visible"&&scanner&&"wakeLock"in navigator)await requestScreenWakeLock();});
(async function init(){
  try{
    db=await openDb();status();await loadSettings();
    const auth=await getValue("meta","auth");
    if(auth){
      const remember=await getValue("meta","rememberLogin");
      if(remember&&remember.value==="no"){await unlockInterface();}
      else{$("authGate").classList.remove("hidden");$("passwordLogin").classList.remove("hidden");}
    }else{$("authGate").classList.remove("hidden");$("passwordSetup").classList.remove("hidden");}
    newChoice();
    if("serviceWorker"in navigator){try{await navigator.serviceWorker.register("./sw.js?v=4");}catch(e){console.warn("Service worker non registrato",e);}}
  }catch(e){alert("Errore inizializzazione archivio: "+e.message);}
})();
