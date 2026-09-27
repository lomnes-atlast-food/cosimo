import { describe, expect, test } from "bun:test";
import { accountKeywords, filterOptions, type SearchOption } from "./search";

const acct = (code: string, name: string, group: string): SearchOption => ({
  value: code,
  label: `${code} · ${name}`,
  group,
  keywords: accountKeywords(name),
});

const CHART = [
  acct("1000", "Business Checking", "Assets"),
  acct("2100", "Business Credit Card", "Liabilities"),
  acct("2200", "Sales Tax Payable", "Liabilities"),
  acct("2400", "Due to Owner", "Liabilities"),
  acct("4000", "Sales", "Income"),
  acct("6010", "Car and Truck Expenses", "Expenses"),
  acct("6100", "Software and Subscriptions", "Expenses"),
  acct("6130", "Rent", "Expenses"),
  acct("6170", "Travel", "Expenses"),
  acct("6180", "Meals", "Expenses"),
  acct("6190", "Utilities", "Expenses"),
  acct("6195", "Telephone and Internet", "Expenses"),
  acct("6340", "Organization and Startup Costs", "Expenses"),
];
const codes = (q: string) => filterOptions(CHART, q).map((o) => o.value);

describe("filterOptions", () => {
  test("an empty query keeps every option in order", () => {
    expect(codes("  ")).toEqual(CHART.map((o) => o.value));
  });

  test("matches the start of words in the name, every typed word must match", () => {
    expect(codes("tel")).toEqual(["6195"]);
    expect(codes("soft sub")).toEqual(["6100"]);
    expect(codes("soft rent")).toEqual([]);
  });

  test("a code prefix ranks the account with that code first", () => {
    expect(codes("61")).toEqual(["6100", "6130", "6170", "6180", "6190", "6195"]);
    expect(codes("6180")[0]).toBe("6180");
  });

  test("among equal matches the closer name comes first", () => {
    expect(codes("sales")).toEqual(["4000", "2200"]);
  });

  test("everyday words find the account through synonyms", () => {
    expect(codes("coffee")).toEqual(["6180"]);
    expect(codes("adobe")).toEqual(["6100"]);
    expect(codes("wifi")).toEqual(["6195"]);
    expect(codes("uber")).toEqual(["6170"]);
    expect(codes("llc formation")).toEqual(["6340"]);
    expect(codes("registered agent")).toEqual(["6340"]);
    expect(codes("reimburse")).toEqual(["2400"]);
    expect(codes("out of pocket")).toEqual(["2400"]);
  });

  test("a name match outranks a synonym match", () => {
    // "gas" is a synonym for both Car and Utilities; "car" is in the Car account's name.
    expect(codes("gas").sort()).toEqual(["6010", "6190"]);
    expect(codes("car")[0]).toBe("6010");
  });

  test("synonyms don't leak into lookalike names", () => {
    // "Credit Card" is not a car, "Sales Tax Payable" is not income, "Current" is not rent.
    expect(accountKeywords("Business Credit Card")).not.toContain("fuel");
    expect(accountKeywords("Sales Tax Payable")).not.toContain("invoice");
    expect(accountKeywords("Other Current Assets")).not.toContain("lease");
  });

  test("case and accents are ignored", () => {
    expect(codes("TÉLÉPHONE")).toEqual(["6195"]);
  });
});
