// node --test tools/enrich/extract.test.mjs
// Fake windows shaped like the real pages (structures as seen on 29 Oct 2026).
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const extractListing = new Function(`${readFileSync(new URL("./extract.js", import.meta.url), "utf8")}; return extractListing;`)();
const emptyDoc = { scripts: [], querySelector: () => null, querySelectorAll: () => [], documentElement: { innerHTML: "" }, title: "" };

test("Rightmove: decodes the flattened page model", () => {
  // Same encoding as window.__PAGE_MODEL.data: objects map keys to array indices.
  const flat = [
    { propertyData: 1 },
    { bedrooms: 2, bathrooms: 2, lettings: 3, customer: 9, propertySubType: 11, images: 12, floorplans: 15, text: 17, keyFeatures: 19, sizings: 21, status: 22 },
    3,
    { deposit: 4, furnishType: 5, letAvailableDate: 6, letType: 7, minimumTermInMonths: 8 },
    4038, "Furnished or unfurnished, landlord is flexible", "19/11/2026", "Long term", -1,
    { branchDisplayName: 10 }, "Andrew Reeves, Bromley-Lettings",
    "House",
    [13, 14], { url: 23 }, { url: 24 },
    [16], { url: 25 },
    { description: 18 }, "Three double bedrooms.<br />Garden.",
    [20], "TWO BATHROOMS",
    [],
    { published: 26 },
    "https://media.rightmove.co.uk/property-photo/a/1/one.jpeg", "https://media.rightmove.co.uk/property-photo/a/1/two.jpeg",
    "https://media.rightmove.co.uk/property-floorplan/a/1/plan.jpeg",
    true,
  ];
  const r = extractListing({ document: emptyDoc, location: { hostname: "www.rightmove.co.uk" }, __PAGE_MODEL: { data: JSON.stringify(flat) } });
  assert.equal(r.portal, "rightmove");
  assert.equal(r.beds, 3);
  assert.equal(r.baths, 3);
  assert.equal(r.deposit, 4038);
  assert.equal(r.furnished, "either");
  assert.equal(r.availableFrom, "2026-11-19");
  assert.equal(r.letType, "periodic");
  assert.equal(r.agent, "Andrew Reeves, Bromley-Lettings");
  assert.equal(r.propertyType, "house");
  assert.equal(r.description, "Three double bedrooms.\nGarden.");
  assert.deepEqual(r.photos, ["https://media.rightmove.co.uk/property-photo/a/1/one.jpeg", "https://media.rightmove.co.uk/property-photo/a/1/two.jpeg"]);
  assert.deepEqual(r.floorplans, ["https://media.rightmove.co.uk/property-floorplan/a/1/plan.jpeg"]);
  assert.equal(r.letAgreed, null);
});

test("OnTheMarket: reads the Next.js property state", () => {
  const property = {
    bedrooms: 5, bathrooms: 2, minimumAreaSqM: 99, propertyTitle: "5 bedroom semi-detached house to rent",
    lettingDetails: { items: ["Furnished", "Long term let", "Available from 1st December 2026", "Deposit: £4,846"] },
    agent: { name: "Truuli - Croydon" }, description: "<p>A spacious five-bedroom home.</p>",
    features: [{ feature: "Large south-facing rear garden" }], epc: { rating: "D" },
    images: [{ largeUrl: "https://media.onthemarket.com/properties/1/2/image-0-1024x1024.jpg" }, { prefix: "https://media.onthemarket.com/properties/1/2/image-1", ext: "jpg" }],
    floorplans: [], propertyLabels: ["Let agreed"],
  };
  const r = extractListing({ document: emptyDoc, location: { hostname: "www.onthemarket.com" }, __NEXT_DATA__: { props: { pageProps: { initialReduxState: { property } } } } });
  assert.equal(r.portal, "onthemarket");
  assert.equal(r.furnished, "furnished");
  assert.equal(r.letType, "periodic");
  assert.equal(r.availableFrom, "2026-12-01");
  assert.equal(r.deposit, 4846);
  assert.equal(r.sizeSqm, 99);
  assert.equal(r.propertyType, "semi_detached");
  assert.equal(r.epc, "D");
  assert.deepEqual(r.photos, ["https://media.onthemarket.com/properties/1/2/image-0-1024x1024.jpg", "https://media.onthemarket.com/properties/1/2/image-1-1024x1024.jpg"]);
  assert.equal(r.letAgreed, true);
});

test("Zoopla: streamed page data plus visible text", () => {
  const flight = String.raw`self.__next_f.push([1,"{\"numBaths\":2,\"numBeds\":3,\"sizeSqft\":1292,\"furnishedState\":\"furnished_or_unfurnished\",\"listingStatus\":\"rented\",\"images\":[{\"caption\":\"Picture No. 17\",\"filename\":\"dbacdf37db60ae524c853f69a6674cb233e28db3.jpg\"},{\"caption\":null,\"filename\":\"113632e2b2465dc8ee3d1c166be7d133be172d6f.jpg\"},{\"caption\":\"Floorplan\",\"filename\":\"14435a5a67da01874c5568a517b83e5e902b3847.jpg\"}]}"])`;
  const main = "Let\n18 Photos\n£4,500 pcm\nAvailable from 14 December 2026\nFurnished or unfurnished\nWinkworth - Parsons Green\n\nView agent properties\nDeposit\n£5,192\n";
  const ld = JSON.stringify({ "@type": "RealEstateListing", description: "A beautifully presented flat." });
  const doc = {
    scripts: [{ textContent: flight }],
    querySelector: (s) => (s === "main" ? { innerText: main } : null),
    querySelectorAll: () => [{ textContent: ld }],
    documentElement: { innerHTML: "" },
    title: "Radipole Road, London SW6, 3 bed flat to rent, £4,500 pcm - Zoopla",
  };
  const r = extractListing({ document: doc, location: { hostname: "www.zoopla.co.uk" } });
  assert.equal(r.portal, "zoopla");
  assert.equal(r.baths, 2);
  assert.equal(r.sizeSqm, 120);
  assert.equal(r.furnished, "either");
  assert.equal(r.availableFrom, "2026-12-14");
  assert.equal(r.deposit, 5192);
  assert.equal(r.agent, "Winkworth - Parsons Green");
  assert.equal(r.propertyType, "flat");
  assert.equal(r.description, "A beautifully presented flat.");
  assert.deepEqual(r.photos, [
    "https://lid.zoocdn.com/u/1024/768/dbacdf37db60ae524c853f69a6674cb233e28db3.jpg",
    "https://lid.zoocdn.com/u/1024/768/113632e2b2465dc8ee3d1c166be7d133be172d6f.jpg",
  ]);
  assert.deepEqual(r.floorplans, ["https://lc.zoocdn.com/14435a5a67da01874c5568a517b83e5e902b3847.jpg"]);
  assert.equal(r.letAgreed, true);
});

test("unknown page", () => {
  assert.match(extractListing({ document: emptyDoc, location: { hostname: "example.com" } }).error, /unknown portal/);
});
