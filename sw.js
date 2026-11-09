const CACHE="gestione-listini-shell-v2";
const APP=["./","./index.html","./app.js","./manifest.webmanifest"];
const SCANNER="https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js";
self.addEventListener("install",event=>event.waitUntil((async()=>{
 const c=await caches.open(CACHE);
 await c.addAll(APP);
 try{
   const response=await fetch(SCANNER,{mode:"no-cors",cache:"reload"});
   if(response && (response.ok||response.type==="opaque")) await c.put(SCANNER,response);
 }catch(e){console.warn("Scanner non ancora memorizzato offline",e);}
 await self.skipWaiting();
})()));
self.addEventListener("activate",event=>event.waitUntil((async()=>{
 const keys=await caches.keys();await Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)));await self.clients.claim();
})()));
self.addEventListener("fetch",event=>{
 const req=event.request;
 if(req.method!=="GET")return;
 const url=new URL(req.url);
 if(url.origin===location.origin || req.url===SCANNER){
   event.respondWith((async()=>{
     const cached=await caches.match(req,{ignoreSearch:false});
     if(cached)return cached;
     try{const response=await fetch(req);if(response.ok){const c=await caches.open(CACHE);c.put(req,response.clone());}return response;}
     catch(e){if(req.mode==="navigate")return caches.match("./index.html");throw e;}
   })());
 }
});
