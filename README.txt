GESTIONE LISTINI 2.0 — PACCHETTO AGGIORNATO

Modifica principale:
- Lo scanner non dipende più dalla libreria html5-qrcode scaricata da Internet.
- Usa BarcodeDetector quando il browser lo supporta e un decoder locale per codici EAN-8 ed EAN-13 come alternativa.
- Richiede la fotocamera posteriore quando disponibile e tenta autofocus continuo/zoom solo se il dispositivo espone tali controlli.
- Mantiene beep, vibrazione, storico e gestione articoli già presenti nell'app.

Importante:
- La fotocamera richiede HTTPS (GitHub Pages lo fornisce) o localhost.
- Il decoder locale è pensato per codici EAN-8 ed EAN-13, con codice ben illuminato e orientato orizzontalmente.
- Non è stato possibile verificare la lettura con la fotocamera reale dell'iPhone in questa fase. Prima di considerare conclusa la verifica, va eseguita una sola prova sul telefono dopo la pubblicazione.
- Importazione PDF ed Excel: le librerie PDF.js e XLSX vengono precaricate nella cache quando possibile durante l’installazione del service worker. Se il precaricamento non riesce, le relative funzioni possono richiedere una prima connessione online.

I dati locali già presenti sul dispositivo non vengono cancellati da questo aggiornamento; dopo la pubblicazione, ricaricare l'app. Se il vecchio service worker resta attivo, chiudere e riaprire la pagina per consentire l'aggiornamento.
