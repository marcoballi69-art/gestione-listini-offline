const DB_NAME="gestione-listini-offline", DB_VERSION=1;
let db, articles=[], currentItems=[], scanner=null, currentChoiceId=null, lastScan="";
let pdfPreviewRows=[];
const $=id=>document.getElementById(id);

function openDb(){return new Promise((resolve,reject)=>{
  const req=indexedDB.open(DB_NAME,DB_VERSION);
  req.onupgradeneeded=()=>{const d=req.result;
    if(!d.objectStoreNames.contains("articles")) d.createObjectStore("articles",{keyPath:"code"});
    if(!d.objectStoreNames.contains("choices")) d.createObjectStore("choices",{keyPath:"id"});
    if(!d.objectStoreNames.contains("meta")) d.createObjectStore("meta",{keyPath:"key"});
  };
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
});}
function tx(store,mode="readonly"){return db.transaction(store,mode).objectStore(store);}
function all(store){return new Promise((res,rej)=>{const r=tx(store).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error);});}
function put(store,value){return new Promise((res,rej)=>{const r=tx(store,"readwrite").put(value);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
function clearStore(store){return new Promise((res,rej)=>{const r=tx(store,"readwrite").clear();r.onsuccess=()=>res();r.onerror=()=>rej(r.error);});}
function codeKey(v){return String(v||"").trim().replace(/^0+(?=\d)/,"");}
function norm(v){return String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();}
function priceText(a){return a.price===""||a.price==null?"Prezzo non indicato":`${a.currency||"EUR"} ${Number(a.price).toFixed(2).replace(".",",")}`;}
function status(){const online=navigator.onLine;$("connection").textContent=online?"Connesso — dati locali disponibili":"Offline — puoi lavorare sui dati già salvati";$("connection").className="status "+(online?"on":"off");}
function parseCsv(text){
  const lines=text.replace(/^\uFEFF/,"").split(/\r?\n/).filter(x=>x.trim());
  if(!lines.length)return [];
  const delimiter=(lines[0].match(/;/g)||[]).length>(lines[0].match(/,/g)||[]).length?";":",";
  const parseLine=line=>{let out=[],v="",q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'&&line[i+1]==='"'&&q){v+='"';i++;}else if(c==='"')q=!q;else if(c===delimiter&&!q){out.push(v.trim());v="";}else v+=c;}out.push(v.trim());return out;};
  const rows=lines.map(parseLine);const first=rows[0].map(norm);
  const hasHeader=first.some(x=>["codice","code","articolo","nome","descrizione","prezzo"].includes(x));
  const data=hasHeader?rows.slice(1):rows;
  return data.map(r=>({code:String(r[0]||"").trim(),name:String(r[1]||"").trim(),currency:String(r[2]||"EUR").trim()||"EUR",price:String(r[3]||"").replace(",",".").trim()})).filter(a=>a.code&&a.name);
}
async function refreshArticles(){articles=await all("articles");$("listinoInfo").textContent=`${articles.length} articoli salvati sul dispositivo.`;renderResults();}
function renderResults(){
 const q=norm($("search").value), found=articles.filter(a=>!q||norm(a.name).includes(q)||String(a.code).includes(q)).slice(0,60);
 const host=$("results");host.replaceChildren();
 if(!found.length){host.textContent="Nessun articolo trovato.";return;}
 found.forEach(a=>{const div=document.createElement("div");div.className="article";const b=document.createElement("strong");b.textContent=a.name;const s=document.createElement("div");s.className="price";s.textContent=`Codice ${a.code} · ${priceText(a)}`;const btn=document.createElement("button");btn.textContent="Aggiungi alla scelta";btn.onclick=()=>addArticle(a);div.append(b,s,btn);host.append(div);});
}
function renderChoice(){
 const host=$("choiceItems");host.replaceChildren();
 if(!currentItems.length){host.textContent="Nessun articolo nella scelta.";return;}
 currentItems.forEach((it,i)=>{const div=document.createElement("div");div.className="item";const b=document.createElement("strong");b.textContent=it.name;const meta=document.createElement("div");meta.className="muted";meta.textContent=it.code?`Codice ${it.code}`:"Articolo manuale";const grid=document.createElement("div");grid.className="itemgrid";const qty=document.createElement("input");qty.value=it.quantity||"1";qty.setAttribute("aria-label","Quantità");qty.onchange=()=>{it.quantity=qty.value;autosaveDraft();};const del=document.createElement("button");del.className="danger";del.textContent="Rimuovi";del.onclick=()=>{currentItems.splice(i,1);renderChoice();autosaveDraft();};const note=document.createElement("input");note.placeholder="Nota articolo";note.value=it.note||"";note.onchange=()=>{it.note=note.value;autosaveDraft();};grid.append(qty,del);div.append(b,meta,grid,note);host.append(div);});
}
function addArticle(a){if(currentItems.some(x=>x.code&&codeKey(x.code)===codeKey(a.code))){$("scanMessage").textContent="Articolo già presente nella scelta.";return;}currentItems.push({code:a.code,name:a.name,price:a.price,currency:a.currency,quantity:"1",note:"",manual:false});renderChoice();autosaveDraft();}
function findCode(code){return articles.find(a=>String(a.code).trim()===String(code).trim()||codeKey(a.code)===codeKey(code));}
async function onBarcode(code){const a=findCode(code);if(a){addArticle(a);$("scanMessage").textContent=`Trovato: ${a.name}`;}else{$("scanMessage").textContent=`Codice ${code}: non trovato. Inserisci il nome per aggiungerlo solo a questa scelta.`;$("manualAdd").classList.remove("hidden");$("manualName").value="";$("manualQty").value="";$("manualName").focus();}}
async function startScanner(){
 if(!window.isSecureContext){$("scanMessage").textContent="La fotocamera richiede una pagina HTTPS.";return;}
 if(typeof Html5Qrcode==="undefined"){$("scanMessage").textContent="Libreria scanner non disponibile. Apri una volta l'app con Internet per scaricarla.";return;}
 $("reader").classList.remove("hidden");
 try{scanner=new Html5Qrcode("reader");const F=window.Html5QrcodeSupportedFormats;const formats=F?[F.EAN_13,F.EAN_8,F.UPC_A,F.UPC_E,F.CODE_128,F.CODE_39,F.ITF]:undefined;await scanner.start({facingMode:"environment"},{fps:15,qrbox:{width:280,height:150},formatsToSupport:formats},code=>{if(code===lastScan)return;lastScan=code;onBarcode(code);setTimeout(()=>{if(lastScan===code)lastScan="";},1800);},()=>{});$("scanMessage").textContent="Fotocamera attiva.";}
 catch(e){$("scanMessage").textContent="Impossibile avviare la fotocamera: "+(e.message||e);}
}
async function stopScanner(){if(scanner){try{await scanner.stop();await scanner.clear();}catch(e){}scanner=null;}$("reader").classList.add("hidden");}
function newChoice(){currentChoiceId=crypto.randomUUID();currentItems=[];$("choiceDate").value=new Date().toISOString().slice(0,10);$("customer").value="";$("generalNote").value="";$("manualAdd").classList.add("hidden");renderChoice();}
function choicePayload(){return{id:currentChoiceId||crypto.randomUUID(),date:$("choiceDate").value,customer:$("customer").value.trim(),note:$("generalNote").value,items:currentItems,updatedAt:new Date().toISOString(),status:"locale"};}
async function autosaveDraft(){if(!currentChoiceId)return;await put("choices",choicePayload());}
async function saveChoice(){const c=choicePayload();if(!c.customer){alert("Inserisci il cliente.");return;}await put("choices",c);currentChoiceId=c.id;renderSaved();$("scanMessage").textContent="Scelta salvata su questo dispositivo.";}
async function renderSaved(){const host=$("savedChoices");const choices=(await all("choices")).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));host.replaceChildren();if(!choices.length){host.textContent="Nessuna scelta salvata.";return;}choices.forEach(c=>{const d=document.createElement("div");d.className="article";const b=document.createElement("strong");b.textContent=`${c.date||""} — ${c.customer||"Senza cliente"}`;const s=document.createElement("div");s.className="muted";s.textContent=`${(c.items||[]).length} articoli · salvata sul dispositivo`;const edit=document.createElement("button");edit.className="secondary";edit.textContent="Apri";edit.onclick=()=>{currentChoiceId=c.id;$("choiceDate").value=c.date||"";$("customer").value=c.customer||"";$("generalNote").value=c.note||"";currentItems=c.items||[];renderChoice();window.scrollTo({top:0,behavior:"smooth"});};d.append(b,s,edit);host.append(d);});}
async function importCsv(){const f=$("csvFile").files[0];if(!f){alert("Seleziona prima un file CSV.");return;}const rows=parseCsv(await f.text());if(!rows.length){alert("Non ho trovato righe valide. Formato atteso: codice,nome,valuta,prezzo.");return;}await clearStore("articles");for(const a of rows)await put("articles",a);await refreshArticles();$("scanMessage").textContent="Listino importato e salvato sul dispositivo.";}
async function exportData(){const payload={exportedAt:new Date().toISOString(),articles:await all("articles"),choices:await all("choices")};const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="backup-gestione-listini.json";a.click();URL.revokeObjectURL(a.href);}

/* PDF: legge il testo incorporato; per le scansioni usa OCR italiano con Tesseract.js.
   Il documento viene elaborato nel browser e non viene inviato a Google Drive. */
const TESSERACT_URL="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

function loadTesseract(){
 return new Promise((resolve,reject)=>{
   if(window.Tesseract){resolve(window.Tesseract);return;}
   let script=document.querySelector('script[data-tesseract="1"]');
   if(script){
     if(script.dataset.loaded==="1"){resolve(window.Tesseract);return;}
     script.addEventListener("load",()=>resolve(window.Tesseract),{once:true});
     script.addEventListener("error",()=>reject(new Error("Caricamento OCR non riuscito. Controlla la connessione Internet.")),{once:true});
     return;
   }
   script=document.createElement("script");
   script.src=TESSERACT_URL;
   script.async=true;
   script.dataset.tesseract="1";
   script.onload=()=>{script.dataset.loaded="1";window.Tesseract?resolve(window.Tesseract):reject(new Error("Motore OCR non disponibile."));};
   script.onerror=()=>reject(new Error("Non riesco a caricare il motore OCR. Apri l'app con Internet e riprova."));
   document.head.appendChild(script);
 });
}

async function extractPdfText(file){
 if(!window.pdfjsLib)throw new Error("Lettore PDF non disponibile. Apri l'app con Internet e riprova.");
 pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
 const bytes=new Uint8Array(await file.arrayBuffer());
 const pdf=await pdfjsLib.getDocument({data:bytes}).promise;
 const allLines=[];
 let ocr=null;
 for(let p=1;p<=pdf.numPages;p++){
   $("pdfMessage").textContent=`Lettura PDF: pagina ${p} di ${pdf.numPages}…`;
   const page=await pdf.getPage(p), content=await page.getTextContent();
   const rows=[];
   content.items.forEach(item=>{
     if(!item.str||!item.str.trim())return;
     const y=Math.round(item.transform[5]);
     let row=rows.find(r=>Math.abs(r.y-y)<=3);
     if(!row){row={y,parts:[]};rows.push(row);}
     row.parts.push({x:item.transform[4],text:item.str.trim()});
   });
   const pageLines=[];
   rows.sort((a,b)=>b.y-a.y).forEach(r=>{
     r.parts.sort((a,b)=>a.x-b.x);
     const line=r.parts.map(x=>x.text).join(" ").replace(/\s+/g," ").trim();
     if(line)pageLines.push(line);
   });

   // Le pagine con testo selezionabile restano sul percorso originale.
   if(pageLines.join(" ").replace(/\s/g,"").length>=25){
     allLines.push(...pageLines);
   }else{
     if(!ocr)ocr=await loadTesseract();
     $("pdfMessage").textContent=`OCR italiano: pagina ${p} di ${pdf.numPages}…`;
     const viewport=page.getViewport({scale:2});
     const canvas=document.createElement("canvas");
     const context=canvas.getContext("2d");
     canvas.width=Math.ceil(viewport.width);
     canvas.height=Math.ceil(viewport.height);
     await page.render({canvasContext:context,viewport}).promise;
     const result=await ocr.recognize(canvas,"ita",{
       logger:m=>{
         if(m.status==="recognizing text" && m.progress!=null){
           $("pdfMessage").textContent=`OCR italiano: pagina ${p} di ${pdf.numPages} — ${Math.round(m.progress*100)}%`;
         }
       }
     });
     allLines.push(...String(result.data.text||"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean));
     canvas.width=0;canvas.height=0;
   }
 }
 return allLines;
}
function parsePdfLines(lines){
 const out=[], seen=new Set();
 const clean=lines.map(x=>String(x).trim()).filter(Boolean);
 const priceRe=/(\d{1,6}(?:[.,]\d{2}))(?!\d)/;
 const codeRe=/^\d{1,8}$/;
 // Prima prova: struttura del listino originale (codice, nome, composizione %, prezzo).
 for(let i=0;i<clean.length;i++){
   const codeMatch=clean[i].match(/^\d{1,8}$/);
   if(!codeMatch)continue;
   const code=clean[i].padStart(8,"0");
   let name="",price=null,hasComposition=false;
   for(let j=i+1;j<Math.min(i+8,clean.length);j++){
     if(!name && clean[j] && !codeRe.test(clean[j]) && !priceRe.test(clean[j]))name=clean[j];
     if(clean[j].includes("%"))hasComposition=true;
     if(j>i+1){const m=clean[j].match(priceRe);if(m){price=Number(m[1].replace(",", "."));break;}}
   }
   if(name && price!==null && isFinite(price) && !seen.has(code) && hasComposition){
     out.push({code,name:name.replace(/\s+EURO\b/i,"").trim(),currency:"EUR",price:String(price)});
     seen.add(code);
   }
 }
 // Fallback per PDF con codice, descrizione e prezzo vicini ma senza riga composizione.
 if(!out.length){
   for(let i=0;i<clean.length;i++){
     if(!codeRe.test(clean[i]))continue;
     const code=clean[i].padStart(8,"0");
     let name="",price=null;
     for(let j=i+1;j<Math.min(i+6,clean.length);j++){
       if(!name && !codeRe.test(clean[j]) && !priceRe.test(clean[j]))name=clean[j];
       const m=clean[j].match(priceRe);
       if(m){price=Number(m[1].replace(",", "."));break;}
     }
     if(name && price!==null && isFinite(price) && !seen.has(code)){
       out.push({code,name,currency:"EUR",price:String(price)});seen.add(code);
     }
   }
 }
 return out;
}
function renderPdfPreview(rows){
 const host=$("pdfPreviewList");host.replaceChildren();
 rows.forEach((a,i)=>{
   const card=document.createElement("div");card.className="pdf-row";
   const info=document.createElement("div");
   const name=document.createElement("strong");name.textContent=a.name;
   const code=document.createElement("small");code.textContent=`Codice ${a.code}`;
   info.append(name,code);
   const price=document.createElement("b");price.className="pdf-price";price.textContent=`€ ${Number(a.price).toFixed(2).replace(".",",")}`;
   card.append(info,price);host.append(card);
 });
 $("pdfPreviewCount").textContent=`${rows.length} articoli riconosciuti`;
 $("pdfPreview").classList.remove("hidden");
}
async function readPdf(){
 const file=$("pdfFile").files[0];
 if(!file){alert("Seleziona prima un PDF.");return;}
 if(file.type!=="application/pdf" && !file.name.toLowerCase().endsWith(".pdf")){alert("Seleziona un file PDF.");return;}
 $("pdfMessage").textContent="Sto leggendo il PDF…";
 $("pdfPreview").classList.add("hidden");
 try{
   const lines=await extractPdfText(file);
   pdfPreviewRows=parsePdfLines(lines);
   if(!pdfPreviewRows.length){
     $("pdfMessage").textContent="Non ho riconosciuto articoli. Se il PDF è una scansione/immagine, questa versione non riesce ancora a leggerlo: serve OCR.";
     return;
   }
   renderPdfPreview(pdfPreviewRows);
   $("pdfMessage").textContent="Controlla l'elenco scorrendo la finestra. Il listino non è stato ancora modificato.";
 }catch(e){$("pdfMessage").textContent="Errore durante la lettura: "+(e.message||e);}
}
async function confirmPdfImport(){
 if(!pdfPreviewRows.length)return;
 if(!confirm(`Vuoi importare ${pdfPreviewRows.length} articoli dal PDF? Il listino attuale verrà sostituito.`))return;
 await clearStore("articles");
 for(const a of pdfPreviewRows)await put("articles",a);
 await refreshArticles();
 $("pdfMessage").textContent=`Importazione completata: ${pdfPreviewRows.length} articoli salvati sul dispositivo.`;
 $("pdfPreview").classList.add("hidden");
 pdfPreviewRows=[];
 $("pdfFile").value="";
}
async function exportData(){const payload={exportedAt:new Date().toISOString(),articles:await all("articles"),choices:await all("choices")};const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="backup-gestione-listini.json";a.click();URL.revokeObjectURL(a.href);}

$("importCsv").onclick=importCsv;$("readPdf").onclick=readPdf;$("confirmPdfImport").onclick=confirmPdfImport;
$("exportData").onclick=exportData;$("search").oninput=renderResults;$("startScan").onclick=startScanner;$("stopScan").onclick=stopScanner;$("newChoice").onclick=newChoice;$("saveChoice").onclick=saveChoice;
$("addManual").onclick=()=>{const name=$("manualName").value.trim();if(!name){alert("Scrivi il nome dell'articolo.");return;}currentItems.push({code:"",name,price:"",currency:"",quantity:$("manualQty").value.trim()||"1",note:"",manual:true});$("manualAdd").classList.add("hidden");renderChoice();autosaveDraft();};
window.addEventListener("online",status);window.addEventListener("offline",status);
(async()=>{db=await openDb();status();await refreshArticles();await renderSaved();newChoice();if("serviceWorker"in navigator){try{await navigator.serviceWorker.register("./sw.js");}catch(e){console.warn("Service worker non registrato",e);}}})();
