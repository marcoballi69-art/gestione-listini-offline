"use strict";
const CACHE_NAME = "gestione-listini-v6";
const APP_FILES = ["./","./index.html","./app.js","./manifest.webmanifest"];
const EXTERNAL_FILES = [
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"
];
self.addEventListener("install", event => {
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE_NAME);
    await cache.addAll(APP_FILES);
    await Promise.allSettled(EXTERNAL_FILES.map(async url=>{
      try{
        const response=await fetch(url,{mode:"no-cors",cache:"reload"});
        if(response && (response.ok || response.type==="opaque")) await cache.put(url,response);
      }catch(e){}
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate",event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith("gestione-listini-")&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch",event=>{
  const request=event.request;if(request.method!=="GET")return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin){
    event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{
      if(response&&(response.ok||response.type==="opaque")){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy).catch(()=>{}));}
      return response;
    }).catch(()=>new Response("Risorsa non disponibile offline.",{status:503,statusText:"Offline"}))));
    return;
  }
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{
    if(response&&response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy).catch(()=>{}));}
    return response;
  }).catch(()=>request.mode==="navigate"?caches.match("./index.html"):new Response("File non disponibile offline.",{status:503,statusText:"Offline"}))));
});
