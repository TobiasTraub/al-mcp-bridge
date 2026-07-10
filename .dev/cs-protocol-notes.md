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

## LIVE VALIDATION RESULTS (against bench-test-28-2)

Proven working headlessly (Node + `ws`), end-to-end from a script:
- ✅ Forms login (`GET /SignIn` → parse `__RequestVerificationToken` + antiforgery cookie → `POST /SignIn` with `UserName`/`Password`/`returnUrl`/`fromView`/token → `.AspNetCore.Cookies` auth cookie).
- ✅ `POST /csrf` → token. ✅ WS `wss://…/{instance}/csh?ackseqnb=-1&csrftoken=…` with the auth cookie.
- ✅ `OpenSession` with the FULL payload (trimmed payload → `NullReferenceException`; the complete `supportedExtensions`/`features`/`timeZoneInformation`/`profileDescription` works). Client **chooses** `sessionKey:"sr<19 digits>"`; server accepts it and `sessionId = company + sessionKey.toUpperCase() + "NAV"` (verified: the response echoes `CRONUS AGSR…NAV`). No need to parse sessionId.
- ✅ Parse the OpenForm response: `findForm` → `ServerId` (formId, session-specific e.g. "5B"–"5F"); walk `Children` building `server:c[i]/c[j]` paths → **"Select Code"** field = `server:c[1]/c[0]` (ControlId 1460278902), **"StartNext"** action (`t:"ac"`) = `server:c[0]/c[1]/c[1]`.
- ✅ `Invoke` **SaveValue** (`namedParameters:{"value":"MCPPROBE"}`, controlPath=suite field) — accepted, no error.
- ⚠️ `Invoke` **InvokeAction** StartNext — the EXACT real-client interaction (`controlPath:"server:c[0]/c[1]/c[1]"`, `namedParameters:{"systemAction":0,"key":null,"data":{},"repeaterControlTarget":null}`, correlated from the HAR's "nothing to run" response) is **rejected with `InteractionParameterException`** from a fresh headless session, then `InvalidSessionException`. Same path + params + valid session as the browser, so the gap is **form-state / ack-sequencing**: the browser had prior interactions and tracked `lastClientAckSequenceNumber` (beacon showed 23); the script always sends `-1` with `disableResponseSequencing:true`. SaveValue's response is `PropertyChanges`-only (no full tree to re-parse).

### Ruled out (do NOT re-try — verified against the working browser frames)
- Interaction params: byte-identical to the real StartNext (`{systemAction:0,key:null,data:{},repeaterControlTarget:null}`).
- Control path: AC `server:c[0]/c[1]/c[1]` (real client used the AC, not the promoted arc).
- `sessionId`: derived `company+sessionKey.upper+NAV` — server accepts it (echoed in response); SaveValue works with it.
- `lastClientAckSequenceNumber:-1`: the real StartNext used `-1` too — ack-sequencing is NOT the cause.
- Form context: headless `OpenSession(OpenForm page=149002)` opens ONLY the card (no role-center 53/54), with or without `runinframe=1`; adding `secondaryOpenFormIds` didn't help.
- Startup `InvokeSessionAction` 810/670 handshake after OpenSession: sent (accepted), StartNext still fails.
- Still → `InteractionParameterException` then `InvalidSessionException`. Every observable frame field now matches the working browser; the cause is in the client's internal form-state model (control activation / PropertyChanges application / invokability), not any wire field we can copy.

### Remaining work to make StartNext land
The cause is a **form-interaction precondition** the browser satisfies implicitly. Next, port `ClientContext.ps1`'s model faithfully: apply the server's `PropertyChanges` to a local form-state model, `ActivateControl`/focus the field before `SaveValue`, honor callback acks, and possibly send the startup `InvokeSessionAction`s (810/670) the real client sent right after OpenSession before invoking page actions. This is methodical model-porting, not parameter guessing.
Implement proper response/ack sequencing: track the server's response sequence numbers and send a real `lastClientAckSequenceNumber` (don't hardcode -1), and/or apply the SaveValue `PropertyChanges` to a local form model so the action's control state is current. This is the machinery `ClientContext.ps1` (BcContainerHelper) implements — port that ack/state handling. Scripts: `scratchpad/run-bcpt.mjs` (works through SaveValue), `scratchpad/handshake.mjs`.

## CAVEATS (verified live)
- **The suite must have ≥1 line** or Start errors **"There is nothing to run"** (`MCPPROBE` is empty). A real end-to-end validation needs a suite with a scenario codeunit line. Create one via the API (`bcptSuiteLines`) or the UI, pointing at a codeunit that exists in the target app.
- **Concurrency:** the PRT ("Single Run mode") path returned *"BCPT Header record … not up-to-date"* — prefer the plain **StartNext** action, and re-open the form fresh before running.
- **Cookie lifetime / KeepAlive:** long runs need KeepAlive frames or the session may expire.
