import type { Locator } from "@playwright/test";

/** Choose an option in a SearchSelect: type `search`, then click the option named `option`. */
export async function pick(field: Locator, search: string, option: string = search) {
  await field.fill(search);
  await field.page().getByRole("option", { name: option, exact: true }).click();
}
