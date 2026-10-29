import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { htmlToText, isComplete, parseMail, sourceForSender, unwrapUrl } from "../src/parse.js";
import { fromParser, normalize } from "../src/normalize.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8");
const mail = (name, from) => ({ id: `msg-${name}`, from: { value: [{ address: from }] }, subject: "Alert", html: fixture(name) });

describe("unwrapUrl", () => {
  it("finds the portal URL inside a tracking link", () => {
    const u = unwrapUrl("https://links.zoopla.co.uk/ls/click?upn=x&url=https%3A%2F%2Fwww.zoopla.co.uk%2Fto-rent%2Fdetails%2F73843699%2F");
    expect(u).toMatchObject({ source: "zoopla", sourceId: "73843699" });
    expect(u.url).toBe("https://www.zoopla.co.uk/to-rent/details/73843699/");
  });
  it("decodes base64 parameters", () => {
    const target = btoa("https://www.rightmove.co.uk/properties/90814923");
    expect(unwrapUrl(`https://click.example.com/r?t=${target}`)).toMatchObject({ source: "rightmove", sourceId: "90814923" });
  });
  it("leaves unknown links alone", () => {
    expect(unwrapUrl("https://www.zoopla.co.uk/alerts/unsubscribe").sourceId).toBeNull();
  });
});

describe("sourceForSender", () => {
  it("maps portals and agencies", () => {
    expect(sourceForSender("alerts@email.zoopla.co.uk")).toBe("zoopla");
    expect(sourceForSender("Lettings <news@example-lettings.co.uk>")).toBe("agency:example-lettings.co.uk");
  });
});

describe("htmlToText", () => {
  it("drops styles, keeps link and image markers, decodes entities", () => {
    const t = htmlToText('<style>.a{}</style><p>&pound;1 <a href="https://x.y/?a=1&amp;b=2">go</a><img src="p.jpg"></p>');
    expect(t).toBe("£1 [[LINK:https://x.y/?a=1&b=2]] go [[IMG:p.jpg]]");
  });
});

describe("parseMail", () => {
  it("reads both Zoopla listings, including a weekly price", () => {
    const m = parseMail(mail("zoopla", "alerts@email.zoopla.co.uk"));
    expect(m.source).toBe("zoopla");
    expect(m.listings).toHaveLength(2);
    expect(m.needsLlm).toBe(false);
    const [forge, petersham] = m.listings;
    expect(forge).toMatchObject({ sourceId: "73843699", price: 4080, pricePeriod: "month", beds: 3, baths: 2, garden: true, parking: true });
    expect(forge.address).toBe("Forge Lane, Petersham, Richmond TW10");
    expect(forge.photos).toEqual(["https://lid.zoocdn.com/u/645/430/forge-lane-1.jpg"]);
    expect(petersham).toMatchObject({ sourceId: "74426560", price: 1584, pricePeriod: "week", billsIncluded: true, postcode: "TW10 7AH" });
  });

  it("reads Rightmove cards without mixing them up", () => {
    const m = parseMail(mail("rightmove", "noreply@rightmove.co.uk"));
    expect(m.listings.map((l) => [l.sourceId, l.price, l.beds])).toEqual([
      ["90814923", 5500, 5],
      ["90123456", 4600, 3],
    ]);
    expect(m.listings[1].postcode).toBe("SW14 8DS");
    expect(m.needsLlm).toBe(false);
  });

  it("reads OpenRent and counts repeated links once", () => {
    const m = parseMail(mail("openrent", "notifications@openrent.co.uk"));
    expect(m.listings).toHaveLength(1);
    expect(m.listings[0]).toMatchObject({ sourceId: "2345678", price: 6200, beds: 3, billsIncluded: true, availableText: "1st January 2028" });
  });

  it("reads OnTheMarket cards (real layout) without asking Gemini", () => {
    const m = parseMail(mail("onthemarket", "OnTheMarket Property Alerts <property-alerts@mail.onthemarket.com>"));
    expect(m.source).toBe("onthemarket");
    expect(m.needsLlm).toBe(false);
    expect(m.listings.map((l) => [l.sourceId, l.price, l.pricePeriod, l.beds, l.address, l.postcode])).toEqual([
      ["21000001", 4200, "month", 5, "Kings Road, Kingston Upon Thames, KT2", "KT2"],
      ["21000002", 8500, "month", 3, "Church Road, Wimbledon Village, London, SW19", "SW19"],
    ]);
    expect(m.listings[0].url).toBe("https://www.onthemarket.com/details/21000001/?r-alert-email-id=x&utm_source=property_alert");
    expect(m.listings[0].photos).toEqual(["http://media.onthemarket.com/properties/21000001/1/image-0-480x320.jpg"]);
  });

  it("sends agency newsletters to the Gemini fallback", () => {
    const m = parseMail(mail("agency", "news@example-lettings.co.uk"));
    expect(m.source).toBe("agency:example-lettings.co.uk");
    expect(m.needsLlm).toBe(true);
  });

  it("asks for Gemini when a portal listing is incomplete", () => {
    const html = '<p><a href="https://www.rightmove.co.uk/properties/90000001">Nice house</a></p>';
    const m = parseMail({ id: "x", from: { value: [{ address: "a@rightmove.co.uk" }] }, html });
    expect(isComplete(m.listings[0])).toBe(false);
    expect(m.needsLlm).toBe(true);
  });
});

describe("parser → normalize", () => {
  it("produces the listing fields of the data model", () => {
    const m = parseMail(mail("zoopla", "alerts@email.zoopla.co.uk"));
    const today = new Date("2026-11-08T12:00:00Z");
    const ctx = { source: m.source, messageId: m.messageId, extractedBy: "parser", criteria: { maxPriceMonthly: 6000, minBeds: 3 } };
    const [forge, petersham] = m.listings.map((l) => normalize(fromParser(l, today), ctx));
    expect(forge).toMatchObject({
      id: "zoopla-73843699",
      postcode: "TW10",
      area: "Richmond",
      priceMonthly: 4080,
      letType: "unknown",
      furnished: "either",
      availableFrom: "2026-09-17",
      flags: [],
    });
    expect(petersham).toMatchObject({
      id: "zoopla-74426560",
      postcode: "TW10 7",
      priceMonthly: 6864,
      letType: "short_let",
      minTermMonths: 2,
      maxTermMonths: 5,
      furnished: "furnished",
      availableFrom: "2026-11-08",
      flags: ["term_too_short", "over_budget"],
    });
  });
});
