GESTIONE LISTINI 2.0 — PACCHETTO DI LAVORO AGGIORNATO

CONTENUTO
- index.html
- app.js
- sw.js
- README.txt
- manifest.webmanifest

MODIFICHE INCLUSE IN QUESTA REVISIONE
- Interfaccia riordinata per iniziare dalla scelta del cliente, con percorso guidato.
- Pulsanti e campi più grandi, finestra scanner più contenuta.
- Selezione numerata automaticamente in sequenza annuale (es. 1/2026).
- Ricerca archivio per nome cliente o numero selezione.
- Eliminazione della selezione completa con conferma; il progressivo eliminato non viene riutilizzato.
- Dopo il salvataggio, la schermata viene azzerata per inserire un nuovo cliente.
- Opzione per includere/escludere i prezzi in PDF ed email.
- PDF semplice con titolo "SELEZIONE N.", senza codice articolo e senza intestazioni/condizioni commerciali.
- Note del singolo articolo riportate nel PDF e nel testo dell'email.
- Email senza codici articolo.
- Anteprima PDF dentro l'app, con comando per tornare all'app e comando stampa/salvataggio.
- Interfaccia inglese per le etichette e le voci principali.
- Backup JSON conserva anche il contatore delle selezioni.
- Cache offline aggiornata.

SCANNER
- Usa BarcodeDetector quando disponibile e decoder locale EAN-8/EAN-13 come alternativa.
- Richiede la fotocamera posteriore quando disponibile e tenta autofocus/zoom se il dispositivo espone i relativi controlli.
- Il decoder campiona più righe e media più pixel per ridurre il rumore.
- NON è stato possibile eseguire una prova reale con la fotocamera di iPhone in questa sessione. La lettura su iPhone deve essere verificata sul dispositivo prima di considerare concluso il lavoro.

PDF E CONDIVISIONE SU IPHONE
- Il PDF viene mostrato in un'anteprima interna all'app.
- Il pulsante "Condividi / Salva PDF" apre la finestra di stampa del browser. Su iPhone, dalla schermata di stampa si usa il comando di condivisione/salvataggio di iOS.
- Il comando email prepara il testo dell'email, includendo le note articolo e applicando l'opzione prezzi. L'allegato PDF va condiviso dalla schermata di stampa.

DATI E COMPATIBILITÀ
- Il database locale mantiene lo stesso nome e la stessa versione IndexedDB del pacchetto precedente per conservare la compatibilità con i dati già presenti sul dispositivo.
- Prima di aggiornare un dispositivo con dati importanti, è consigliato esportare un backup JSON.
- Il pacchetto non cancella intenzionalmente gli archivi locali già presenti.
- Il servizio offline mantiene in cache la pagina e gli script dell'app.
- Le librerie di importazione PDF/Excel sono esterne e vengono memorizzate in cache quando possibile; la prima importazione può richiedere una connessione.

VERIFICHE E LIMITI
- Sintassi JavaScript verificata con Node.js.
- Collegamenti tra gli ID HTML e quelli richiamati dal codice controllati.
- Non è stato eseguito un test end-to-end in Safari/iPhone.
- Non è stato verificato il flusso reale di stampa/condivisione PDF su iPhone.
- Non dichiarare lo scanner verificato finché non viene provato su iPhone.


REVISIONE SCANNER OFFLINE v5
- Avvio della richiesta fotocamera immediatamente al tocco del pulsante, senza attendere altre operazioni asincrone.
- Richiesta della fotocamera posteriore con vincoli minimi, più compatibili con Safari su iPhone.
- Attesa del video pronto prima di avviare la scansione.
- Attributi playsinline e webkit-playsinline per mantenere la fotocamera nella pagina su iOS.
- Decoder EAN locale prioritario e indipendente dalla rete; BarcodeDetector è soltanto un ripiego opzionale.
- Mantenuta la decodifica EAN-8 ed EAN-13 con verifica della cifra di controllo.
- Conservati gli zeri iniziali dei codici EAN durante il confronto con l'archivio.
- Aggiornata la cache offline alla versione gestione-listini-v7 e il riferimento del service worker.
- Migliorata la gestione degli errori e la pulizia della fotocamera quando l'avvio non riesce.

VERIFICHE E LIMITI
Il decoder locale è stato provato con immagini sintetiche EAN-8 (96385074) ed EAN-13 (4006381333931), entrambe decodificate correttamente.
Il codice scanner non richiede servizi o librerie di decodifica esterne.
La lettura ottica reale e il comportamento della fotocamera devono comunque essere confermati su iPhone fisico; l'accesso alla fotocamera richiede HTTPS e il permesso del browser.
