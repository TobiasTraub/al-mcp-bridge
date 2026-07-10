# `/cs/` client-service protocol notes (Task 1 spike)

Captured live against `https://docker.socitas.de:56565/bench-test-28-2` (BC 28.2, company "CRONUS AG") via Playwright. Page **149002 = "BCPT CommandLine Runner"** confirmed openable via `?page=149002`.

## Transport & endpoints

- Auth to the **web client** is **forms auth** (`POST /{instance}/SignIn`), not Basic — a login page with username/password. (The `-dev` tier uses Basic for `al_run_tests`; the web/`-rest` tiers differ.)
- CSRF: `POST /{instance}/csrf?...` → `{ "csrfToken": "CfDJ8…" }`. Token is passed back as `requestToken` in each Invoke.
- Client-service verbs are `POST /{instance}/<verb>` (observed: `disposeSession`; others include the session-open/invoke verbs).
- **The main interaction stream runs over a WebSocket inside a blob Web Worker** (`js/client.websocket-worker.chunk.js`). There is an HTTP-POST path too (the `disposeSession` beacon used POST). Client JS served at `/js/logicalclient.js`, `/js/client.js` (reverse-engineer interaction serialization there if needed).

## JSON-RPC envelope (captured verbatim from the disposeSession beacon)

```json
{"jsonrpc":"2.0","id":"|<guid>.beacon","method":"Invoke","params":[{
  "openFormIds":["30"],
  "sessionId":"CRONUS AGSR6391924679221193234NAV",
  "sequenceNo":null,
  "lastClientAckSequenceNumber":23,
  "telemetryClientActivityId":null,
  "navigationContext":{"applicationId":"NAV","deviceCategory":0,"spaInstanceId":"<id>"},
  "supportedExtensions":"[{\"Name\":\"Microsoft.Dynamics.Nav.Client.PageNotifier\"}, …]",
  "interactionsToInvoke":[],
  "tenantId":null,
  "sessionKey":"sr6391924679221193234",
  "company":"CRONUS AG",
  "features":["QueueInteractions","MetadataCache","CacheSession", …],
  "requestToken":"<csrfToken>",
  "disableResponseSequencing":true
}]}
```

Field notes:
- `method:"Invoke"`, single `params[0]` object. Matches the Frycos protocol writeup and `ClientContext.ps1`'s interaction model.
- `interactionsToInvoke[]` is where **OpenForm / SaveValue / InvokeAction** interaction objects go (empty in the beacon).
- `requestToken` = the `/csrf` token. `sessionId`/`sessionKey` are server-issued at session open. `sequenceNo`/`lastClientAckSequenceNumber` sequence the exchange.

## Still needed to finish Task 6 (`clientSession.ts`)

1. The **session-open** exchange (first Invoke: how `sessionId`/`sessionKey` are obtained) and the response shape.
2. The exact **`interactionsToInvoke` object shapes** for `OpenFormInteraction(149002)`, `SaveValueInteraction(control, value)`, `InvokeActionInteraction(action)` — the interaction type names + control-path fields.
3. How the response returns form/control state (to find the suite-code control + the Start action + poll status).

## How to get the last mile (pick one)

- **Chrome DevTools (easiest & reliable):** DevTools *does* show worker WebSocket frames. Open the web client with DevTools → Network → WS, open page 149002, set suite `MCPPROBE`, click Start; the `cs` WS entry's Messages tab has the `OpenForm`/`SaveValue`/`InvokeAction` frames → save/paste.
- **CDP auto-attach:** `Target.setAutoAttach({flatten:true})` + route `Network.webSocketFrame*` per attached worker session (fiddly through Playwright's CDP wrapper).
- **Read the served client JS** (`/js/logicalclient.js`) for the interaction serializer (minified; grep for `OpenForm`, `Interaction`, `controlId`).
