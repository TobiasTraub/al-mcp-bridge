# `/cs/` client-service protocol — COMPLETE (Task 1 spike, from live HAR)

Captured live against `https://docker.socitas.de:56565/bench-test-28-2` (BC 28.2, Performance Toolkit 28.2.50931.51034, company "CRONUS AG"). This is the implementation spec for Task 6 (`src/bc/clientSession.ts`).

## Connection sequence

1. **Forms login** (the web tier uses forms auth, NOT Basic): `POST /{instance}/SignIn` with the username/password form fields → sets an auth **cookie**. All subsequent requests + the WS must carry that cookie.
2. **CSRF:** `POST /{instance}/csrf` (with cookie) → `{ "csrfToken": "CfDJ8…" }`.
3. **WebSocket:** connect `wss://{host}/{instance}/csh?ackseqnb=-1&csrftoken=<csrfToken>` (carry the auth cookie in the WS handshake headers).

## Frames — JSON-RPC 2.0 over the WS

### OpenSession (first frame; opens the target page inline)
```json
{"jsonrpc":"2.0","id":"|undefined.<hex>","method":"OpenSession","params":[{
  "openFormIds":[], "sessionId":"", "sequenceNo":null, "lastClientAckSequenceNumber":-1,
  "navigationContext":{"applicationId":"NAV","deviceCategory":0,"spaInstanceId":"<spaId>"},
  "supportedExtensions":"[{\"Name\":\"Microsoft.Dynamics.Nav.Client.PageNotifier\"}, …]",
  "interactionsToInvoke":[{"interactionName":"OpenForm","namedParameters":"{\"query\":\"page=149002&runinframe=1\"}","callbackId":"0"}],
  "sessionKey":"sr<digits>",           // client-generated
  "company":null, "features":[ … ], "timeZoneInformation":{…},
  "disableResponseSequencing":true
}]}
```
- `spaInstanceId` — client-generated id (e.g. `mre75bt3`); reused in `sequenceNo`.
- The **response** (gzipped, see below) returns the real `sessionId` = `"<company>SR<digits>NAV"` (e.g. `"CRONUS AGSR6391924723529362616NAV"`) and `["FormToShow",{"ServerId":"55", …}]` — the opened form's id.

### Invoke (all later interactions)
```json
{"jsonrpc":"2.0","id":"|<hex>.<hex>","method":"Invoke","params":[{
  "openFormIds":["55"], "sessionId":"CRONUS AGSR…NAV", "sequenceNo":"<spaId>#<n>",
  "lastClientAckSequenceNumber":-1, "navigationContext":{…},
  "interactionsToInvoke":[ <interaction> ],
  "sessionKey":"sr<digits>", "company":"CRONUS AG",
  "secondaryOpenFormIds":["53","54"]   // optional
}]}
```
`sequenceNo` increments as `<spaId>#1`, `#2`, … per Invoke.

### Interaction shapes (the `interactionsToInvoke[]` objects)
- **OpenForm:** `{"interactionName":"OpenForm","namedParameters":"{\"query\":\"page=149002&runinframe=1\"}","callbackId":"0"}`
- **SaveValue** (set a field — used to set the suite code on "Select Code"):
  `{"interactionName":"SaveValue","namedParameters":"{\"value\":\"MCPPROBE\"}","controlPath":"server:c[1]/c[0]","formId":"55","callbackId":"n"}`
  (confirm the exact control path for "Select Code" from the form response; its `ControlId` is `1460278902`, and the field lookup uses `SystemAction:110`.)
- **InvokeAction** (click an action, e.g. "Start Next"):
  `{"interactionName":"InvokeAction","namedParameters":"{\"systemAction\":0,\"key\":null,\"repeaterControlTarget\":null}","controlPath":"server:c[1]/c[0]","formId":"55","callbackId":"n"}`
  (the "Start Next" action is `DesignName "StartNext"`, `DefinitionId 1408328076`; resolve its controlPath from the form response's action container.)
- **InvokeSessionAction:** `{"interactionName":"InvokeSessionAction","namedParameters":"{\"systemAction\":810,\"data\":{}}","callbackId":"n"}` (systemActions 810/670 seen at startup; likely not needed for a headless run).
- **KeepAlive:** `{"interactionName":"KeepAlive","namedParameters":"{}","skipExtendingSessionLifetime":true,"callbackId":"n"}` — send periodically for long runs.

## Responses — gzip + base64
Every server response frame: `{"jsonrpc":"2.0","compressedResult":"H4sI…","id":"<matching id>"}`.
Decode: `JSON.parse(zlib.gunzipSync(Buffer.from(compressedResult,"base64")).toString("utf8"))`.
The decoded payload is BC form metadata: look for `["FormToShow",{ServerId,Caption,…}]`, control defs (`{"t":"sc","Caption":"Select Code","ControlId":1460278902,…}`), action defs (`{"t":"ac","Caption":"Start Next","DesignName":"StartNext",…}`), and `PropertyChanges` (control-state updates → poll status here). Errors arrive as a dialog control with `"Message"` + `"SystemAction":650` and an AL call stack.

## Headless-run recipe for page 149002 (BCPT CommandLine Runner)
1. login → csrf → WS.
2. `OpenSession` with inline `OpenForm(page=149002)`; from the response read `sessionId` + `formId` (e.g. "55") + the "Select Code" control path + the "Start Next" action control path.
3. `Invoke` **SaveValue** to set "Select Code" = `<suiteCode>`.
4. `Invoke` **InvokeAction** on "Start Next".
5. Poll: the suite runs in background sessions; read completion from `BCPT Log Entry` via the **bcptLogEntries API** (§5.2 of the spec) filtered by suite + a start-time watermark — simpler and more robust than parsing form PropertyChanges. Bound by `timeoutSeconds`.
6. Close WS / dispose session (`POST /{instance}/disposeSession` beacon or a CloseSession frame).

## CAVEATS (verified live)
- **The suite must have ≥1 line** or Start errors **"There is nothing to run"** (`MCPPROBE` is empty). A real end-to-end validation needs a suite with a scenario codeunit line. Create one via the API (`bcptSuiteLines`) or the UI, pointing at a codeunit that exists in the target app.
- **Concurrency:** the PRT ("Single Run mode") path returned *"BCPT Header record … not up-to-date"* — prefer the plain **StartNext** action, and re-open the form fresh before running.
- **Cookie lifetime / KeepAlive:** long runs need KeepAlive frames or the session may expire.
