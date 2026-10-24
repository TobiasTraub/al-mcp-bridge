import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildCoverageReport,
  declaredObjects,
  loadAppSymbols,
} from "../../dist/bc/coverage.js";
import { RunTestsInput } from "../../dist/tools/runTests.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureApp = join(here, "..", "fixtures", "coverage-symbols", "Fixture.app");

const payload = {
  Tests: [
    {
      MethodId: -5,
      ApplicationObjectId: 95100,
      CoveredProcedures: [
        { ObjectType: 5, ObjectId: 50100, MethodId: 111 },
        { ObjectType: 5, ObjectId: 50100, MethodId: 999 },
        { ObjectType: 5, ObjectId: 80, MethodId: 1 },
      ],
    },
    {
      MethodId: -6,
      ApplicationObjectId: 95100,
      CoveredProcedures: [
        { ObjectType: 5, ObjectId: 50100, MethodId: 111 },
        { ObjectType: 5, ObjectId: 50100, MethodId: 333 },
      ],
    },
  ],
};

test("loadAppSymbols reads SymbolReference.json behind the NAVX header, across namespaces", () => {
  const app = loadAppSymbols(fixtureApp);
  assert.equal(app.appName, "Fixture App");
  const cu = app.objects.get("5:50100");
  assert.equal(cu.name, "Credit Mgt.");
  assert.equal(cu.methods.get(111), "CheckLimit");
  assert.equal(cu.methods.get(333), "Recalc(Code)");
  assert.equal(cu.methods.get(444), "Recalc(Record)");
  assert.equal(app.objects.get("15:50101").methods.get(555), "IsBlockedSOC");
});

test("declaredObjects finds every object header, quoted or bare names, any keyword case", () => {
  const src = [
    'codeunit 50100 "Credit Mgt."',
    "{",
    "}",
    'TableExtension 50101 "Customer Ext" extends Customer',
    "table 50102 CreditSetup",
  ].join("\n");
  const objs = declaredObjects("x.al", src);
  assert.deepEqual(
    objs.map((o) => [o.objectType, o.objectId, o.name]),
    [
      [5, 50100, "Credit Mgt."],
      [15, 50101, "Customer Ext"],
      [1, 50102, "CreditSetup"],
    ],
  );
});

test("report names public procedures, counts unmapped ones, attributes tests", () => {
  const app = loadAppSymbols(fixtureApp);
  const touched = declaredObjects("x.al", 'codeunit 50100 "Credit Mgt."\ntableextension 50101 "Customer Ext" extends Customer');
  const r = buildCoverageReport([payload], [app], touched, []);
  assert.equal(r.testsWithCoverage, 2);
  const cu = r.objects.find((o) => o.objectId === 50100);
  assert.equal(cu.entered, true);
  assert.deepEqual(cu.coveredProcedures, [
    { name: "CheckLimit", coveredBy: ["95100.LimitExceededErrors", "95100.WithinLimitPasses"] },
    { name: "Recalc(Code)", coveredBy: ["95100.WithinLimitPasses"] },
  ]);
  assert.deepEqual(cu.uncoveredProcedures, ["AvailableCredit", "Recalc(Record)"]);
  assert.equal(cu.unmappedExecuted, 1);
  const ext = r.objects.find((o) => o.objectId === 50101);
  assert.equal(ext.entered, false);
  assert.deepEqual(ext.uncoveredProcedures, ["IsBlockedSOC"]);
  assert.equal(r.otherObjectsEntered, 1);
});

test("without touched files, every entered object of the mapped apps is listed, test codeunits excluded", () => {
  const app = loadAppSymbols(fixtureApp);
  const r = buildCoverageReport([payload], [app], undefined, []);
  assert.deepEqual(r.objects.map((o) => o.objectId), [50100]);
});

test("a touched object missing from the symbols is reported, not silently dropped", () => {
  const app = loadAppSymbols(fixtureApp);
  const r = buildCoverageReport([payload], [app], declaredObjects("y.al", 'codeunit 50999 "Elsewhere"'), []);
  assert.equal(r.objects[0].entered, false);
  assert.match(r.warnings[0], /50999 "Elsewhere" is not in the mapped apps/);
});

test("without symbols nothing is named: no entered-object list, touched objects only count", () => {
  const r = buildCoverageReport([payload], [], undefined, []);
  assert.equal(r.objects.length, 0);
  const touched = buildCoverageReport([payload], [], declaredObjects("x.al", 'codeunit 50100 "Credit Mgt."'), []);
  assert.equal(touched.objects[0].entered, true);
  assert.deepEqual(touched.objects[0].coveredProcedures, []);
  assert.equal(touched.objects[0].unmappedExecuted, 3);
});

test("RunTestsInput accepts the coverage and suite options", () => {
  const ok = RunTestsInput.safeParse({
    codeunitId: 95100,
    additionalCodeunitIds: [95101],
    coverage: true,
    coverageApps: ["/x/app"],
    coverageFiles: ["/x/app/src/a.al"],
  });
  assert.equal(ok.success, true);
});
